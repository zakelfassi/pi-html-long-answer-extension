const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const packageJson = require('../package.json');
const extension = require('../index.js');
const internals = extension._internals;

function richDocument(body, head = '<meta charset="utf-8" /><style>body{font-family:system-ui}</style>') {
  return `<!DOCTYPE html>
<html lang="en">
<head>${head}</head>
<body>${body}</body>
</html>`;
}

async function withTempExportRoot(fn) {
  const previous = process.env.PI_HTML_LONG_ANSWER_EXPORT_ROOT;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'html-long-answer-test-'));
  process.env.PI_HTML_LONG_ANSWER_EXPORT_ROOT = tempDir;
  try {
    return await fn(tempDir);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_HTML_LONG_ANSWER_EXPORT_ROOT;
    } else {
      process.env.PI_HTML_LONG_ANSWER_EXPORT_ROOT = previous;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test('package metadata preserves npm Pi and OMP entry contracts', () => {
  assert.equal(packageJson.private, false);
  assert.equal(packageJson.type, 'commonjs');
  assert.equal(packageJson.main, 'index.js');
  assert.equal(packageJson.engines.node, '>=20');
  assert.equal(packageJson.pi.extensions[0], './index.js');
  assert.equal(packageJson.omp.extensions[0], './index.js');
  assert.ok(packageJson.keywords.includes('pi-package'));
  assert.ok(packageJson.keywords.includes('pi-extension'));
  assert.deepEqual(packageJson.files, ['index.js', 'README.md', 'assets/']);
  assert.ok(packageJson.scripts.test.includes('node --test'));

  for (const entry of [packageJson.main, packageJson.pi.extensions[0], packageJson.omp.extensions[0]]) {
    const resolved = path.resolve(repoRoot, entry);
    assert.equal(resolved, path.join(repoRoot, 'index.js'));
  }
});

test('manifest entries load the same extension factory shape', () => {
  const byMain = require(path.join(repoRoot, packageJson.main));
  const byPi = require(path.resolve(repoRoot, packageJson.pi.extensions[0]));
  const byOmp = require(path.resolve(repoRoot, packageJson.omp.extensions[0]));

  assert.equal(typeof byMain, 'function');
  assert.equal(byMain, byPi);
  assert.equal(byMain, byOmp);
  assert.equal(typeof byMain._internals.validateRichHtmlDocument, 'function');
});

test('extension registers commands/events and handles long assistant messages', async () => {
  assert.doesNotThrow(() => extension({}));
  assert.doesNotThrow(() => extension({ setLabel: () => { throw new Error('not initialized'); } }));

  const labels = [];
  const events = new Map();
  const commands = new Map();
  const entries = [];
  const notifications = [];
  extension({
    setLabel: (label) => labels.push(label),
    on: (eventName, handler) => events.set(eventName, handler),
    registerCommand: (name, definition) => commands.set(name, definition),
    appendEntry: async (type, data) => entries.push({ type, data }),
  });

  assert.match(labels[0], /^Long Answer HTML /);
  assert.equal(typeof events.get('session_start'), 'function');
  assert.equal(typeof events.get('session_branch'), 'function');
  assert.equal(typeof events.get('session_tree'), 'function');
  assert.equal(typeof events.get('message_end'), 'function');
  assert.equal(typeof events.get('input'), 'function');
  assert.equal(typeof commands.get('html-last').handler, 'function');
  assert.equal(typeof commands.get('html-last-version').handler, 'function');

  const inputResult = await events.get('input')({ text: '/html-last' }, {
    ui: { notify: (message) => notifications.push(message) },
  });
  assert.deepEqual(inputResult, { handled: true, action: 'handled' });

  const commandResult = commands.get('html-last').handler('', {
    ui: { notify: (message) => notifications.push(message) },
  });
  assert.equal(commandResult, undefined);
  await Promise.resolve();
  assert.equal(notifications.some((message) => message.includes('No eligible assistant answer')), true);

  const longText = `# Captured Answer\n\n${'This answer is long enough to trigger capture. '.repeat(80)}`;
  await events.get('message_end')({ message: { role: 'assistant', text: longText } }, {
    hasUI: true,
    ui: { notify: (message) => notifications.push(message) },
  });

  assert.equal(entries.some((entry) => entry.type === 'html-long-answer-source'), true);
  assert.equal(notifications.some((message) => message.includes('Long answer captured for HTML export')), true);
});

test('local export preserves shell and representative markdown-ish rendering', async () => {
  await withTempExportRoot(async () => {
    const sourceText = [
      '# Local Export Title',
      '',
      'Paragraph with https://example.com and `inlineCode`.',
      '',
      '- first item',
      '- second item',
      '',
      '| Name | Value |',
      '|---|---|',
      '| alpha | beta |',
    ].join('\n');
    const bodyHtml = internals.renderMarkdownish(sourceText);
    const filePath = await internals.writeHtmlArtifact({
      title: 'Local Export Title',
      bodyHtml,
      sourceText,
      mode: 'local',
    });
    const html = await fs.readFile(filePath, 'utf8');

    assert.match(html, /<div class="eyebrow">Pi HTML export<\/div>/);
    assert.match(html, /<strong>Mode<\/strong><br \/>local/);
    assert.match(html, /<h2>Local Export Title<\/h2>/);
    assert.match(html, /href="https:\/\/example\.com"/);
    assert.match(html, /<code>inlineCode<\/code>/);
    assert.match(html, /<ul><li>first item<\/li><li>second item<\/li><\/ul>/);
    assert.match(html, /<table>/);
    assert.doesNotMatch(html, /<script/i);
  });
});

test('rich export writes one standalone document instead of nesting it in the local shell', async () => {
  await withTempExportRoot(async () => {
    const richHtml = richDocument('<main><h1>Designed Export</h1><p>Safe body.</p></main>');
    const filePath = await internals.writeRichHtmlArtifact({
      title: 'Designed Export',
      htmlText: richHtml,
    });
    const html = await fs.readFile(filePath, 'utf8');

    assert.equal((html.match(/<!DOCTYPE html/gi) || []).length, 1);
    assert.equal((html.match(/<html\b/gi) || []).length, 1);
    assert.equal((html.match(/<body\b/gi) || []).length, 1);
    assert.doesNotMatch(html, /<article class="content">[\s\S]*<!DOCTYPE html/i);
    assert.doesNotMatch(html, /<div class="eyebrow">Pi HTML export<\/div>/);
    assert.match(html, /<h1>Designed Export<\/h1>/);
  });
});

test('rich validation rejects dangerous or over-large HTML', () => {
  const invalidCases = [
    richDocument('<script>alert(1)</script>'),
    richDocument('<main onclick="alert(1)">bad</main>'),
    richDocument('<a href="javascript:alert(1)">bad</a>'),
    richDocument('<img src="https://example.com/a.png" alt="bad" />'),
    richDocument('<main style="background:url(https://example.com/a.png)">bad</main>'),
    richDocument('<img src="data:image/png;base64,abc" srcset="https://example.com/a.png 1x" alt="bad" />'),
    richDocument('<svg><image href="https://example.com/a.png" /></svg>'),
    richDocument('<svg><use xlink:href="https://example.com/s.svg#icon" /></svg>'),
    richDocument('<style>@import "https://example.com/x.css"; body { color: red; }</style><main>bad</main>'),
    richDocument('<p>refresh</p>', '<meta http-equiv="refresh" content="0; url=https://example.com" />'),
    '<!DOCTYPE html><body>missing html wrapper</body>',
    richDocument('x'.repeat(513 * 1024)),
  ];

  for (const html of invalidCases) {
    assert.throws(() => internals.validateRichHtmlDocument(html), /Rich HTML output|blocked|event-handler|javascript|external|meta refresh|exceeded|standalone/);
  }
});

test('open command resolution refuses missing launchers', async () => {
  await withTempExportRoot(async (tempDir) => {
    const previousPath = process.env.PATH;
    const launcher = path.join(tempDir, 'fake-open');
    await fs.writeFile(launcher, '#!/bin/sh\nexit 0\n', 'utf8');
    await fs.chmod(launcher, 0o755);
    process.env.PATH = tempDir;

    try {
      assert.equal(await internals.resolveOpenCommand('missing-open'), null);
      assert.equal(await internals.resolveOpenCommand('fake-open'), launcher);
      assert.equal(await internals.resolveOpenCommand(launcher), launcher);
      assert.equal(await internals.resolveOpenCommand(path.join(tempDir, 'not-executable')), null);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });
});

test('rich extraction and command mode parsing are deterministic', () => {
  const fenced = 'prefix\n```html\n<html><body><p>ok</p></body></html>\n```\nsuffix';
  assert.equal(internals.extractHtmlDocument(fenced), '<html><body><p>ok</p></body></html>');
  assert.equal(internals.extractHtmlDocument('plain text'), null);

  assert.deepEqual(internals.parseArgs({ args: ['gemini'] }), ['gemini']);
  assert.equal(internals.resolveForcedExportMode('gemini'), 'rich-gemini');
  assert.equal(internals.resolveForcedExportMode(['pi']), 'rich-pi');
  assert.equal(internals.resolveForcedExportMode({ args: ['quick'] }), 'local');
  assert.equal(internals.resolveForcedExportMode('choose'), 'choose');
  assert.equal(internals.hasSelectableUi({ ui: { select: () => 'local' } }), true);
  assert.equal(internals.hasSelectableUi({ hasUI: true, ui: {} }), false);
  assert.deepEqual(internals.parseHtmlLastInput('/html-last quick'), { command: 'export', args: 'quick' });
  assert.deepEqual(internals.parseHtmlLastInput(' /html-last-version '), { command: 'version', args: '' });
  assert.equal(internals.parseHtmlLastInput('/html-lastly'), null);
  assert.equal(internals.resolveForcedExportMode('designed'), 'rich-pi');
  assert.equal(internals.resolveForcedExportMode(''), null);
});
