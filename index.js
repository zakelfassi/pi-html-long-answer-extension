const EXTENSION_VERSION = '2026-04-20e';

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const DEFAULT_EXPORT_ROOT = path.join(os.tmpdir(), 'pi-html-exports');
const PREF_ENTRY_TYPE = 'html-long-answer-pref';
const SOURCE_ENTRY_TYPE = 'html-long-answer-source';
const EXPORT_ENTRY_TYPE = 'html-long-answer-export';
const LONG_ANSWER_DEFAULTS = {
  minChars: 1800,
  minLines: 24,
  minParagraphs: 6,
};
const MAX_RICH_HTML_CHARS = 512 * 1024;
const MAX_RICH_HTML_TAGS = 2500;
const BLOCKED_RICH_TAGS = /<\s*\/?\s*(?:script|iframe|object|embed|link|base|form|input|button|textarea|select|option)\b/i;
const BLOCKED_META_REFRESH = /<\s*meta\b[^>]*http-equiv\s*=\s*(['"]?)refresh\1/i;
const EVENT_HANDLER_ATTR = /\s+on[a-z]+\s*=/i;
const JAVASCRIPT_URL_ATTR = /\s(?:href|src|xlink:href|action|formaction)\s*=\s*(['\"]?)\s*javascript:/i;
const EXTERNAL_ASSET_ATTR = /(?:\s(?:src|poster)\s*=\s*(['\"]?)\s*(?:https?:)?\/\/|\ssrcset\s*=\s*(['\"]?)[^'\">]*(?:https?:)?\/\/|<\s*(?:image|use|feimage)\b[^>]*\s(?:href|xlink:href)\s*=\s*(['\"]?)\s*(?:https?:)?\/\/)/i;
const EXTERNAL_CSS_URL = /(?:url\(\s*(['\"]?)\s*(?:https?:)?\/\/|@import\s+(?:url\(\s*)?(['\"]?)\s*(?:https?:)?\/\/)/i;
const OPEN_FAILURE_WINDOW_MS = 1000;


function sha(input) {
  return crypto.createHash('sha1').update(String(input || '')).digest('hex');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(value) {
  const normalized = String(value || 'export')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || 'export';
}

function countParagraphs(text) {
  return String(text || '')
    .split(/\n\s*\n/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .length;
}

function countLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .length;
}

function wordCount(text) {
  const matches = String(text || '').trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

function isSeparatorRow(line) {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line || '');
}

function splitTableRow(line) {
  return String(line || '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function formatInline(raw) {
  let text = escapeHtml(raw);
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  text = text.replace(/(?<!href=")(?<!">)(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noreferrer noopener">$1</a>');
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, '$1<em>$2</em>');
  return text;
}

function collectUntil(lines, start, predicate) {
  const collected = [];
  let index = start;
  while (index < lines.length && predicate(lines[index], index)) {
    collected.push(lines[index]);
    index += 1;
  }
  return { collected, nextIndex: index };
}

function renderMarkdownish(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim();
      const codeLines = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(`<pre class="code-block"><div class="code-meta">${escapeHtml(language || 'code')}</div><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length + 1);
      blocks.push(`<h${level}>${formatInline(headingMatch[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const { collected, nextIndex } = collectUntil(lines, i, (current) => /^>\s?/.test((current || '').trim()));
      const inner = collected
        .map((current) => current.trim().replace(/^>\s?/, ''))
        .join(' ');
      blocks.push(`<aside class="callout"><div class="callout-label">Callout</div><p>${formatInline(inner)}</p></aside>`);
      i = nextIndex;
      continue;
    }

    const nextLine = lines[i + 1] || '';
    if (trimmed.includes('|') && isSeparatorRow(nextLine)) {
      const header = splitTableRow(trimmed);
      i += 2;
      const body = [];
      while (i < lines.length && (lines[i] || '').trim().includes('|')) {
        body.push(splitTableRow(lines[i]));
        i += 1;
      }
      const thead = `<thead><tr>${header.map((cell) => `<th>${formatInline(cell)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${formatInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`;
      blocks.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }

    if (/^(?:[-*]|\d+\.)\s+/.test(trimmed)) {
      const ordered = /^\d+\.\s+/.test(trimmed);
      const pattern = ordered ? /^\d+\.\s+/ : /^(?:[-*])\s+/;
      const { collected, nextIndex } = collectUntil(lines, i, (current) => pattern.test((current || '').trim()));
      const tag = ordered ? 'ol' : 'ul';
      blocks.push(`<${tag}>${collected.map((current) => `<li>${formatInline(current.trim().replace(pattern, ''))}</li>`).join('')}</${tag}>`);
      i = nextIndex;
      continue;
    }

    const { collected, nextIndex } = collectUntil(lines, i, (current) => {
      const currentTrimmed = (current || '').trim();
      if (!currentTrimmed) return false;
      if (currentTrimmed.startsWith('```')) return false;
      if (/^(#{1,6})\s+/.test(currentTrimmed)) return false;
      if (/^(?:[-*]|\d+\.)\s+/.test(currentTrimmed)) return false;
      if (/^>\s?/.test(currentTrimmed)) return false;
      return true;
    });

    const paragraph = collected
      .map((current) => current.trim())
      .join(' ');
    blocks.push(`<p>${formatInline(paragraph)}</p>`);
    i = nextIndex;
  }

  return blocks.join('\n');
}

function extractTextPart(part) {
  if (!part) return '';
  if (typeof part === 'string') return part;
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  if (Array.isArray(part.parts)) return part.parts.map(extractTextPart).join('');
  if (Array.isArray(part.content)) return part.content.map(extractTextPart).join('');
  return '';
}

function normalizeRole(candidate) {
  if (!candidate) return null;
  const role = String(candidate).toLowerCase();
  if (role.includes('assistant') || role.includes('agent') || role.includes('model')) return 'assistant';
  if (role.includes('user')) return 'user';
  return role;
}

function extractMessageInfo(event) {
  const candidate = event && typeof event === 'object'
    ? (event.message || event.entry || event.payload || event.data || event)
    : null;
  if (!candidate || typeof candidate !== 'object') return null;

  const role = normalizeRole(candidate.role || candidate.author || candidate.kind || candidate.source);
  const id = candidate.id || candidate.messageId || candidate.entryId || null;
  const text = [
    typeof candidate.text === 'string' ? candidate.text : '',
    typeof candidate.content === 'string' ? candidate.content : '',
    Array.isArray(candidate.content) ? candidate.content.map(extractTextPart).join('') : '',
    Array.isArray(candidate.parts) ? candidate.parts.map(extractTextPart).join('') : '',
  ].find((value) => typeof value === 'string' && value.trim().length > 0) || '';

  if (!text.trim() || role !== 'assistant') return null;
  return {
    id: id || sha(text),
    role,
    text: text.trim(),
  };
}

function deriveTitle(text) {
  const source = String(text || '').trim();
  if (!source) return 'HTML Export';
  const firstHeading = source.split('\n').find((line) => /^#{1,6}\s+/.test(line.trim()));
  if (firstHeading) return firstHeading.replace(/^#{1,6}\s+/, '').trim().slice(0, 80);
  const firstSentence = source.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)[0] || source;
  return firstSentence.slice(0, 80);
}

function deriveExcerpt(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#{1,6}\s+/.test(trimmed)) continue;
    if (/^(?:[-*]|\d+\.)\s+/.test(trimmed)) continue;
    return trimmed.slice(0, 240);
  }
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function buildOutlineHtml(text) {
  const headings = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (match) headings.push({ level: match[1].length, label: match[2].trim() });
  }
  if (!headings.length) return '';
  return `<div class="aside-panel"><div class="aside-label">Outline</div><ul class="outline-list">${headings.map((item) => `<li class="outline-item outline-level-${Math.min(item.level, 4)}">${formatInline(item.label)}</li>`).join('')}</ul></div>`;
}

function buildLocalHtmlDocument(title, body, meta) {
  const exportedAt = new Date(meta.exportedAt).toLocaleString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7fb;
      --panel: #ffffff;
      --text: #162033;
      --muted: #5d6b82;
      --line: #d8deea;
      --brand: #1c7c72;
      --accent: #d7f0eb;
      --callout: #eef6ff;
      --code: #0f172a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 16px/1.65 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top right, rgba(28,124,114,0.08), transparent 26%), var(--bg);
      color: var(--text);
    }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 32px 20px 64px; }
    .hero, .content, .aside-panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 20px;
      box-shadow: 0 20px 45px -36px rgba(15, 23, 42, 0.35);
    }
    .hero { padding: 28px; margin-bottom: 20px; }
    .hero-copy { max-width: 780px; }
    .hero-excerpt { font-size: 18px; line-height: 1.6; color: var(--muted); margin: 0 0 18px; }
    .main-grid { display: grid; gap: 20px; grid-template-columns: minmax(0, 1fr) 280px; align-items: start; }
    .content { padding: 28px; min-width: 0; }
    .aside-stack { display: grid; gap: 16px; position: sticky; top: 20px; }
    .aside-panel { padding: 18px; }
    .aside-label { font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--brand); margin-bottom: 10px; }
    .aside-copy { color: var(--muted); font-size: 14px; line-height: 1.55; }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      padding: 6px 10px;
      border-radius: 999px;
      background: var(--accent);
      color: var(--brand);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 14px;
    }
    h1 { font-size: clamp(30px, 4vw, 42px); line-height: 1.08; margin: 0 0 12px; }
    h2, h3, h4, h5, h6 { line-height: 1.18; margin: 28px 0 10px; }
    p, li { color: var(--text); }
    p { margin: 0 0 14px; }
    .meta { display: flex; flex-wrap: wrap; gap: 12px; color: var(--muted); font-size: 14px; }
    .meta-chip {
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #fbfcfe;
    }
    .meta-chip strong { color: var(--text); }
    .outline-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .outline-item { color: var(--text); font-size: 14px; line-height: 1.4; }
    .outline-level-2 { padding-left: 10px; color: var(--muted); }
    .outline-level-3, .outline-level-4 { padding-left: 20px; color: var(--muted); font-size: 13px; }
    .content a { color: var(--brand); }
    .content ul, .content ol { margin: 0 0 18px 22px; }
    .content li { margin-bottom: 8px; }
    .content code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: #f2f5fb;
      border: 1px solid #e0e6f2;
      border-radius: 6px;
      padding: 0.12rem 0.35rem;
      font-size: 0.92em;
    }
    .code-block {
      margin: 18px 0 22px;
      overflow: hidden;
      border-radius: 16px;
      background: var(--code);
      color: #e5edf8;
      border: 1px solid #22304a;
    }
    .code-meta {
      padding: 10px 14px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #9bb0d1;
      border-bottom: 1px solid #22304a;
    }
    .code-block code {
      display: block;
      padding: 16px;
      border: 0;
      background: transparent;
      white-space: pre-wrap;
      overflow-x: auto;
      color: inherit;
    }
    .callout {
      margin: 20px 0;
      padding: 16px 18px;
      border-radius: 16px;
      border: 1px solid #d9e8ff;
      background: var(--callout);
    }
    .callout-label {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #3559a6;
      margin-bottom: 8px;
    }
    .table-wrap { overflow-x: auto; margin: 18px 0 22px; }
    table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid var(--line);
      border-radius: 14px;
      overflow: hidden;
      background: #fff;
    }
    th, td {
      padding: 12px 14px;
      text-align: left;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    th { background: #f8fafc; font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
    tr:last-child td { border-bottom: 0; }
    @media (max-width: 960px) {
      .main-grid { grid-template-columns: 1fr; }
      .aside-stack { position: static; }
    }
    @media print {
      body { background: #fff; }
      .wrap { max-width: none; padding: 0; }
      .hero, .content, .aside-panel { border: 0; box-shadow: none; }
      .main-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">Pi HTML export</div>
        <h1>${escapeHtml(title)}</h1>
        ${meta.excerpt ? `<p class="hero-excerpt">${escapeHtml(meta.excerpt)}</p>` : ''}
        <div class="meta">
          <div class="meta-chip"><strong>Exported</strong><br />${escapeHtml(exportedAt)}</div>
          <div class="meta-chip"><strong>Words</strong><br />${escapeHtml(String(meta.words))}</div>
          <div class="meta-chip"><strong>Characters</strong><br />${escapeHtml(String(meta.characters))}</div>
          <div class="meta-chip"><strong>Mode</strong><br />${escapeHtml(meta.mode)}</div>
        </div>
      </div>
    </section>
    <section class="main-grid">
      <article class="content">
        ${body}
      </article>
      <aside class="aside-stack">
        ${meta.outlineHtml || ''}
        <div class="aside-panel">
          <div class="aside-label">Export mode</div>
          <div class="aside-copy">
            ${meta.mode === 'local' ? 'Fast local render of the captured answer.' : 'Designed render produced from a richer HTML generation pass.'}
          </div>
        </div>
      </aside>
    </section>
  </main>
</body>
</html>`;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function getExportRoot() {
  return process.env.PI_HTML_LONG_ANSWER_EXPORT_ROOT || DEFAULT_EXPORT_ROOT;
}

async function writeHtmlArtifact({ title, bodyHtml, sourceText, mode }) {
  const exportRoot = getExportRoot();
  await ensureDir(exportRoot);
  const now = new Date();
  const iso = now.toISOString().replace(/[:.]/g, '-');
  const fileName = `${iso}-${slugify(title)}-${mode}.html`;
  const filePath = path.join(exportRoot, fileName);
  const html = buildLocalHtmlDocument(title, bodyHtml, {
    exportedAt: now.toISOString(),
    words: wordCount(sourceText),
    characters: String(sourceText || '').length,
    mode,
    excerpt: deriveExcerpt(sourceText),
    outlineHtml: buildOutlineHtml(sourceText),
  });
  await fs.writeFile(filePath, html, 'utf8');
  return filePath;
}

async function writeRichHtmlArtifact({ title, htmlText }) {
  const html = validateRichHtmlDocument(htmlText);
  const exportRoot = getExportRoot();
  await ensureDir(exportRoot);
  const now = new Date();
  const iso = now.toISOString().replace(/[:.]/g, '-');
  const fileName = `${iso}-${slugify(title)}-llm-enhanced.html`;
  const filePath = path.join(exportRoot, fileName);
  await fs.writeFile(filePath, html, 'utf8');
  return filePath;
}

function validateRichHtmlDocument(htmlText) {
  const html = String(htmlText || '').trim();
  if (!html) {
    throw new Error('Rich HTML output was empty.');
  }
  if (html.length > MAX_RICH_HTML_CHARS) {
    throw new Error(`Rich HTML output exceeded ${MAX_RICH_HTML_CHARS} characters.`);
  }
  const tagCount = (html.match(/<\/?[a-z][^>]*>/gi) || []).length;
  if (tagCount > MAX_RICH_HTML_TAGS) {
    throw new Error(`Rich HTML output exceeded ${MAX_RICH_HTML_TAGS} HTML tags.`);
  }
  if (!/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html)) {
    throw new Error('Rich HTML output must be a standalone document with <html> and <body>.');
  }
  if (BLOCKED_RICH_TAGS.test(html)) {
    throw new Error('Rich HTML output contained a blocked HTML tag.');
  }
  if (BLOCKED_META_REFRESH.test(html)) {
    throw new Error('Rich HTML output contained a meta refresh.');
  }
  if (EVENT_HANDLER_ATTR.test(html)) {
    throw new Error('Rich HTML output contained an event-handler attribute.');
  }
  if (JAVASCRIPT_URL_ATTR.test(html)) {
    throw new Error('Rich HTML output contained a javascript: URL.');
  }
  if (EXTERNAL_ASSET_ATTR.test(html) || EXTERNAL_CSS_URL.test(html)) {
    throw new Error('Rich HTML output referenced an external asset.');
  }
  return /^<!DOCTYPE html/i.test(html) ? html : `<!DOCTYPE html>\n${html}`;
}

function isLongAnswer(text, config) {
  const source = String(text || '').trim();
  if (!source) return false;
  return (
    source.length >= config.minChars ||
    countLines(source) >= config.minLines ||
    countParagraphs(source) >= config.minParagraphs
  );
}

function parseArgs(rawArgs) {
  if (Array.isArray(rawArgs)) return rawArgs.map((item) => String(item));
  if (typeof rawArgs === 'string') return rawArgs.trim().split(/\s+/).filter(Boolean);
  if (rawArgs && typeof rawArgs === 'object' && Array.isArray(rawArgs.args)) {
    return rawArgs.args.map((item) => String(item));
  }
  return [];
}

function parseHtmlLastInput(text) {
  const source = typeof text === 'string' ? text.trim() : '';
  if (/^\/html-last-version\s*$/i.test(source)) {
    return { command: 'version', args: '' };
  }

  const match = /^\/html-last(?:\s+([\s\S]*))?$/i.exec(source);
  if (!match) return null;
  return { command: 'export', args: match[1] || '' };
}

async function resolveOpenCommand(command) {
  if (!command) return null;
  if (path.isAbsolute(command)) {
    try {
      await fs.access(command, fs.constants.X_OK);
      return command;
    } catch (_) {
      return null;
    }
  }

  const searchPath = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const directory of searchPath) {
    const candidate = path.join(directory, command);
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) {
      // Keep searching PATH.
    }
  }
  return null;
}

function resolveForcedExportMode(rawArgs) {
  const parsedArgs = parseArgs(rawArgs);
  if (parsedArgs.some((arg) => /^(choose|chooser|menu)$/i.test(arg))) return 'choose';
  if (parsedArgs.some((arg) => /^(gemini)$/i.test(arg))) return 'rich-gemini';
  if (parsedArgs.some((arg) => /^(pi|claude|current)$/i.test(arg))) return 'rich-pi';
  if (parsedArgs.some((arg) => /^(local|quick)$/i.test(arg))) return 'local';
  if (parsedArgs.some((arg) => /^(rich|enhanced|designed)$/i.test(arg))) return 'rich-pi';
  return null;
}

function hasSelectableUi(ctx) {
  return Boolean(ctx && ctx.ui && typeof ctx.ui.select === 'function');
}

function extractHtmlDocument(text) {
  const source = String(text || '').trim();
  if (!source) return null;

  const fenced = source.match(/```html\s*([\s\S]*?)```/i);
  if (fenced && fenced[1] && fenced[1].trim()) return fenced[1].trim();

  if (/<!DOCTYPE html/i.test(source) || /<html[\s>]/i.test(source) || /<body[\s>]/i.test(source)) {
    return source;
  }

  return null;
}

function buildRichHtmlPrompt(lastEligible) {
  return [
    'Transform the following answer into a standalone HTML document.',
    'Return ONLY a single ```html fenced block and nothing else.',
    'Requirements:',
    '- Preserve the factual content and conclusions.',
    '- Improve structure and visual hierarchy.',
    '- Use inline CSS only. No external assets, scripts, CDNs, or fonts.',
    '- Make it responsive and print-friendly.',
    '- Add simple inline SVG diagrams only if they materially improve comprehension.',
    '- Do not mention that this was transformed from another answer.',
    '',
    `Title suggestion: ${lastEligible.title}`,
    '',
    'Source answer:',
    '```text',
    lastEligible.text,
    '```',
  ].join('\n');
}

module.exports = function htmlLongAnswerExtension(pi) {
  const state = {
    offerMode: 'ask',
    lastEligible: null,
    lastExport: null,
    pendingRichExport: null,
    lastPromptedSignature: null,
    geminiAvailable: null,
    config: { ...LONG_ANSWER_DEFAULTS },
  };

  function rememberFromEntry(entry) {
    if (!entry || entry.type !== 'custom') return;
    if (entry.customType === PREF_ENTRY_TYPE && entry.data && typeof entry.data.offerMode === 'string') {
      state.offerMode = entry.data.offerMode;
    }
    if (entry.customType === SOURCE_ENTRY_TYPE && entry.data && entry.data.text) {
      state.lastEligible = entry.data;
    }
    if (entry.customType === EXPORT_ENTRY_TYPE && entry.data && entry.data.path) {
      state.lastExport = entry.data;
    }
  }

  function hydrateLastEligibleFromBranch(branch) {
    if (!Array.isArray(branch) || state.lastEligible) return;
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const info = extractMessageInfo(branch[index]);
      if (info && info.text) {
        state.lastEligible = buildSourceRecord(info.text);
        return;
      }
    }
  }

  async function restoreSessionState(ctx) {
    try {
      const branch = ctx && ctx.sessionManager && typeof ctx.sessionManager.getBranch === 'function'
        ? ctx.sessionManager.getBranch()
        : [];
      if (!Array.isArray(branch)) return;
      for (const entry of branch) rememberFromEntry(entry);
      hydrateLastEligibleFromBranch(branch);
    } catch (_) {
      // Best effort only.
    }
  }

  async function appendCustomEntry(type, data) {
    if (typeof pi.appendEntry !== 'function') return;
    try {
      await pi.appendEntry(type, data);
    } catch (_) {
      // Do not fail the user flow on persistence issues.
    }
  }

  async function setOfferMode(mode) {
    state.offerMode = mode;
    await appendCustomEntry(PREF_ENTRY_TYPE, { offerMode: mode, savedAt: Date.now() });
  }

  async function rememberEligibleSource(source) {
    state.lastEligible = source;
    await appendCustomEntry(SOURCE_ENTRY_TYPE, source);
  }

  async function rememberExport(meta) {
    state.lastExport = meta;
    await appendCustomEntry(EXPORT_ENTRY_TYPE, meta);
  }

  function notify(ctx, message, level) {
    if (!ctx || !ctx.ui || typeof ctx.ui.notify !== 'function') return;
    try {
      const result = ctx.ui.notify(message, level || 'info');
      if (result && typeof result.then === 'function') {
        result.catch(() => {});
      }
    } catch (_) {
      // Ignore UI failures.
    }
  }

  function notifyCommandError(ctx, error) {
    notify(ctx, `Long Answer HTML command error: ${error && error.message ? error.message : String(error)} [html-long-answer ${EXTENSION_VERSION}]`, 'error');
  }

  async function isGeminiCliAvailable() {
    if (typeof state.geminiAvailable === 'boolean') return state.geminiAvailable;
    try {
      await execFileAsync('gemini', ['--help'], { timeout: 3000, maxBuffer: 512 * 1024 });
      state.geminiAvailable = true;
    } catch (_) {
      state.geminiAvailable = false;
    }
    return state.geminiAvailable;
  }

  async function openArtifact(filePath) {
    const command = process.platform === 'darwin'
      ? '/usr/bin/open'
      : process.platform === 'linux'
        ? 'xdg-open'
        : null;
    const executable = await resolveOpenCommand(command);
    if (!executable) return false;

    return new Promise((resolve) => {
      let child;
      let settled = false;
      let timer;

      const settle = (opened) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(opened);
      };

      try {
        child = spawn(executable, [filePath], {
          detached: true,
          stdio: 'ignore',
        });
      } catch (_) {
        settle(false);
        return;
      }

      child.once('error', () => settle(false));
      child.once('exit', (code) => settle(code === 0));
      child.unref();
      timer = setTimeout(() => settle(true), OPEN_FAILURE_WINDOW_MS);
    });
  }

  async function maybeOpenArtifact(ctx, filePath, mode) {
    const opened = await openArtifact(filePath);
    if (!opened) return false;
    notify(ctx, `${mode === 'local' ? 'Opened local HTML export' : 'Opened designed HTML export'} in your default browser. [html-long-answer ${EXTENSION_VERSION}]`, 'info');
    return true;
  }

  function buildSourceRecord(text) {
    const title = deriveTitle(text);
    return {
      id: sha(text),
      title,
      text,
      recordedAt: Date.now(),
      stats: {
        characters: text.length,
        lines: countLines(text),
        paragraphs: countParagraphs(text),
        words: wordCount(text),
      },
    };
  }

  async function exportLocalHtml(ctx, source, mode) {
    const bodyHtml = renderMarkdownish(source.text);
    const filePath = await writeHtmlArtifact({
      title: source.title,
      bodyHtml,
      sourceText: source.text,
      mode: mode || 'local',
    });
    const meta = {
      path: filePath,
      mode: mode || 'local',
      title: source.title,
      sourceId: source.id,
      exportedAt: Date.now(),
    };
    await rememberExport(meta);
    await notify(ctx, `HTML export written to ${filePath}. Use /html-last rich for a more designed HTML pass. [html-long-answer ${EXTENSION_VERSION}]`, 'info');
    await maybeOpenArtifact(ctx, filePath, 'local');
    return meta;
  }

  async function exportRichHtmlResult(ctx, source, htmlText) {
    const filePath = await writeRichHtmlArtifact({
      title: source.title,
      htmlText,
    });
    const meta = {
      path: filePath,
      mode: 'llm-enhanced',
      title: source.title,
      sourceId: source.id,
      exportedAt: Date.now(),
    };
    await rememberExport(meta);
    await notify(ctx, `Designed HTML export written to ${filePath}. [html-long-answer ${EXTENSION_VERSION}]`, 'info');
    await maybeOpenArtifact(ctx, filePath, 'designed');
    return meta;
  }

  function normalizeChoice(result, options) {
    if (typeof result === 'string') return result;
    if (typeof result === 'number') {
      if (Array.isArray(options) && options[result]) return options[result].value;
      return ['local', 'rich', 'inline', 'never'][result] || null;
    }
    if (result && typeof result === 'object') {
      return result.value || result.id || result.key || result.choice || null;
    }
    return null;
  }

  async function promptWithSelect(ui, summary) {
    const geminiAvailable = await isGeminiCliAvailable();
    const options = [
      { label: 'Designed HTML with Gemini CLI', value: 'rich-gemini' },
      { label: 'Designed HTML with current Pi model', value: 'rich-pi' },
      { label: 'Quick local HTML', value: 'local' },
      { label: 'Keep inline', value: 'inline' },
      { label: 'Stop asking this session', value: 'never' },
    ];
    if (!geminiAvailable) {
      options.shift();
    }

    const prompt = `Long answer detected — ${summary}`;
    try {
      const result = await ui.select(prompt, options);
      return normalizeChoice(result, options) || null;
    } catch (_) {
      return null;
    }
  }

  async function promptUserForExport(ctx, source) {
    if (!ctx || !ctx.ui || state.offerMode === 'never') return 'inline';
    const summary = [
      `${source.stats.words} words`,
      `${source.stats.paragraphs} paragraphs`,
      `${source.stats.lines} lines`,
    ].join(' · ');

    if (typeof ctx.ui.select === 'function') {
      const selected = await promptWithSelect(ctx.ui, summary);
      if (selected) return selected;
    }

    return 'inline';
  }

  async function queueRichExport(source, ctx, renderer) {
    if (renderer === 'gemini') {
      await notify(ctx, 'Generating designed HTML with Gemini CLI…', 'info');
      try {
        const html = await runGeminiRichExport(source);
        await exportRichHtmlResult(ctx, source, html);
      } catch (error) {
        await notify(ctx, `Gemini designed HTML failed: ${error && error.message ? error.message : String(error)}. Falling back to quick local HTML. [html-long-answer ${EXTENSION_VERSION}]`, 'warning');
        await exportLocalHtml(ctx, source, 'local');
      }
      return;
    }

    state.pendingRichExport = {
      requestedAt: Date.now(),
      source,
    };
    await notify(ctx, 'Queued richer HTML generation as a follow-up turn.', 'info');
    if (typeof pi.sendUserMessage === 'function') {
      await pi.sendUserMessage(buildRichHtmlPrompt(source), { deliverAs: 'followUp' });
      return;
    }
    if (typeof pi.sendMessage === 'function') {
      await pi.sendMessage(buildRichHtmlPrompt(source), { deliverAs: 'followUp', triggerTurn: true });
      return;
    }
    throw new Error('No runtime message API is available for richer HTML generation.');
  }

  async function runGeminiRichExport(source) {
    const { stdout } = await execFileAsync('gemini', [
      '--prompt', buildRichHtmlPrompt(source),
      '--output-format', 'text',
    ], {
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    });

    const output = String(stdout || '').trim();
    if (!output) {
      throw new Error('Gemini CLI returned no output.');
    }

    const html = extractHtmlDocument(output);
    if (!html) {
      throw new Error('Gemini CLI did not return HTML output.');
    }

    return html;
  }

  async function chooseCommandExportMode(ctx) {
    const geminiAvailable = await isGeminiCliAvailable();
    if (!ctx || !ctx.ui || typeof ctx.ui.select !== 'function') {
      return geminiAvailable ? 'rich-gemini' : 'rich-pi';
    }

    const options = [
      { label: 'Designed HTML with Gemini CLI', value: 'rich-gemini' },
      { label: 'Designed HTML with current Pi model', value: 'rich-pi' },
      { label: 'Quick local HTML', value: 'local' },
    ];
    if (!geminiAvailable) {
      options.shift();
    }

    try {
      const result = await ctx.ui.select('Choose HTML render mode', options);
      return normalizeChoice(result, options) || options[0].value;
    } catch (_) {
      return geminiAvailable ? 'rich-gemini' : 'rich-pi';
    }
  }

  function notifyLongAnswerAvailable(ctx, source) {
    notify(ctx, `Long answer captured for HTML export (${source.stats.words} words). Run /html-last for quick local HTML, /html-last choose for choices, /html-last gemini for Gemini, or /html-last pi for the current Pi model. [html-long-answer ${EXTENSION_VERSION}]`, 'info');
  }

  async function handleChoice(choice, ctx, source) {
    if (choice === 'never') {
      await setOfferMode('never');
      await notify(ctx, 'Long-answer HTML prompting disabled for this session.', 'info');
      return;
    }
    if (choice === 'inline' || !choice) return;
    if (choice === 'local') {
      await exportLocalHtml(ctx, source, 'local');
      return;
    }
    if (choice === 'rich') {
      await queueRichExport(source, ctx, 'pi');
      return;
    }
    if (choice === 'rich-gemini') {
      await queueRichExport(source, ctx, 'gemini');
      return;
    }
    if (choice === 'rich-pi') {
      await queueRichExport(source, ctx, 'pi');
    }
  }

  async function maybeHandlePendingRichExport(event, ctx) {
    if (!state.pendingRichExport) return false;
    const info = extractMessageInfo(event);
    if (!info) return false;

    const htmlDocument = extractHtmlDocument(info.text);
    if (htmlDocument) {
      try {
        await exportRichHtmlResult(ctx, state.pendingRichExport.source, htmlDocument);
      } catch (error) {
        await notify(ctx, `Richer HTML pass was unsafe or invalid: ${error && error.message ? error.message : String(error)}. Wrote a fallback HTML export instead. [html-long-answer ${EXTENSION_VERSION}]`, 'warning');
        await exportLocalHtml(ctx, state.pendingRichExport.source, 'llm-enhanced-fallback');
      }
    } else {
      await exportLocalHtml(ctx, {
        ...state.pendingRichExport.source,
        text: info.text,
      }, 'llm-enhanced-fallback');
      await notify(ctx, 'Richer HTML pass returned plain text; wrote a fallback HTML export instead.', 'warning');
    }
    state.pendingRichExport = null;
    return true;
  }

  async function handleAssistantMessage(event, ctx) {
    if (await maybeHandlePendingRichExport(event, ctx)) return;

    const info = extractMessageInfo(event);
    if (!info) return;

    const source = buildSourceRecord(info.text);
    const signature = source.id;
    if (signature === state.lastPromptedSignature) return;

    await rememberEligibleSource(source);

    if (!isLongAnswer(info.text, state.config)) return;
    if (!ctx || !ctx.hasUI) return;

    state.lastPromptedSignature = signature;
    notifyLongAnswerAvailable(ctx, source);
  }

  async function exportLatestFromCommand(args, ctx) {
    if (!state.lastEligible || !state.lastEligible.text) {
      try {
        const branch = ctx && ctx.sessionManager && typeof ctx.sessionManager.getBranch === 'function'
          ? ctx.sessionManager.getBranch()
          : [];
        hydrateLastEligibleFromBranch(branch);
      } catch (_) {
        // Ignore branch hydration failures here; warning below handles the miss.
      }
    }

    if (!state.lastEligible || !state.lastEligible.text) {
      notify(ctx, `No eligible assistant answer has been captured yet in this session. Ask for a long answer first, then run /html-last. [html-long-answer ${EXTENSION_VERSION}]`, 'warning');
      return;
    }

    const forcedMode = resolveForcedExportMode(args);
    let mode = forcedMode || 'local';
    if (mode === 'choose') {
      mode = hasSelectableUi(ctx) ? await chooseCommandExportMode(ctx) : 'local';
    }

    if (mode === 'rich-gemini') {
      await queueRichExport(state.lastEligible, ctx, 'gemini');
      return;
    }
    if (mode === 'rich-pi') {
      await queueRichExport(state.lastEligible, ctx, 'pi');
      return;
    }

    await exportLocalHtml(ctx, state.lastEligible, 'local');
  }

  if (typeof pi.setLabel === 'function') {
    try {
      pi.setLabel(`Long Answer HTML ${EXTENSION_VERSION}`);
    } catch (_) {
      // Some hosts reject action methods during extension loading.
    }
  }

  const restoreHandler = async (_event, ctx) => {
    await restoreSessionState(ctx);
  };

  if (typeof pi.on === 'function') {
    pi.on('session_start', restoreHandler);
    pi.on('session_branch', restoreHandler);
    pi.on('session_tree', restoreHandler);
    pi.on('input', async (event, ctx) => {
      const parsedInput = parseHtmlLastInput(event && event.text);
      if (!parsedInput) return undefined;

      try {
        if (parsedInput.command === 'version') {
          notify(ctx, `html-long-answer ${EXTENSION_VERSION}`, 'info');
        } else {
          await exportLatestFromCommand(parsedInput.args, ctx);
        }
      } catch (error) {
        notifyCommandError(ctx, error);
      }

      return { handled: true, action: 'handled' };
    });
    pi.on('message_end', async (event, ctx) => {
      try {
        await handleAssistantMessage(event, ctx);
      } catch (error) {
        await notify(ctx, `Long Answer HTML extension error: ${error && error.message ? error.message : String(error)}`, 'error');
      }
    });
  }

  if (typeof pi.registerCommand === 'function') {
    pi.registerCommand('html-last', {
      description: 'Export the latest eligible assistant answer as HTML. Use `choose`, `gemini`, `pi`, or `local` to force a render path.',
      handler: (args, ctx) => {
        void exportLatestFromCommand(args, ctx).catch((error) => {
          notifyCommandError(ctx, error);
        });
      },
    });

    pi.registerCommand('html-last-version', {
      description: 'Show the loaded Long Answer HTML extension version.',
      handler: (_args, ctx) => {
        notify(ctx, `html-long-answer ${EXTENSION_VERSION}`, 'info');
      },
    });
  }
};

module.exports._internals = {
  buildLocalHtmlDocument,
  buildRichHtmlPrompt,
  extractHtmlDocument,
  formatInline,
  getExportRoot,
  parseArgs,
  parseHtmlLastInput,
  resolveOpenCommand,
  hasSelectableUi,
  renderMarkdownish,
  resolveForcedExportMode,
  validateRichHtmlDocument,
  writeHtmlArtifact,
  writeRichHtmlArtifact,
};
