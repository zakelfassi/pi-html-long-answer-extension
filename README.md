# html-long-answer

Make long assistant answers exportable as designed HTML in both Oh My Pi / OMP and legacy Pi.

<p>
  <img src="./assets/hero.svg" alt="Hero graphic showing a terminal chooser on the left and a designed HTML export preview on the right" width="100%" />
</p>

## Why this exists

Long answers are useful, but they are not always pleasant to read inside the terminal. This extension captures long assistant replies, keeps them available for later export, and lets you turn them into browser-opened HTML in one step.

It is built for two workflows:
- fast local HTML when you just want a readable artifact now
- richer designed HTML when you want a second-pass render via the current Pi model or Gemini CLI

## What users should look for

<p>
  <img src="./assets/flow.svg" alt="Flow diagram showing the extension behavior: long answer finishes, lightweight notice appears, user runs html-last, browser opens the export" width="100%" />
</p>

The extension does **not** interrupt the end of a long answer anymore.

Instead it:
1. captures the answer into session state
2. shows a lightweight notice that HTML export is available
3. waits for the user to run `/html-last`
4. writes and opens the HTML artifact in the default browser

## Render modes

<p>
  <img src="./assets/render-modes.svg" alt="Three render mode cards for quick local, current Pi model, and Gemini CLI" width="100%" />
</p>

| Mode | What it does | Best for |
|---|---|---|
| `local` | Fast local render with a designed shell, outline rail, excerpt hero, and clickable links | Speed and reliability |
| `pi` | Uses the current Pi model for a richer second-pass HTML render | Staying in the current session/model context |
| `gemini` | Uses Gemini CLI for a richer external render; falls back to local HTML if valid HTML is not returned | Maximum polish when Gemini is available |

## Commands

| Command | Result |
|---|---|
| `/html-last` | Opens a render-mode chooser |
| `/html-last local` | Forces quick local HTML |
| `/html-last pi` | Forces designed HTML via the current Pi model |
| `/html-last gemini` | Forces designed HTML via Gemini CLI |
| `/html-last-version` | Shows the loaded extension version |

## Installation

### Oh My Pi / OMP

OMP auto-discovers native extensions from `~/.omp/agent/extensions`.

Global install:

```bash
mkdir -p ~/.omp/agent/extensions
git clone https://github.com/zakelfassi/pi-html-long-answer-extension.git \
  ~/.omp/agent/extensions/html-long-answer
```

One-off test without installing globally:

```bash
omp -e /absolute/path/to/index.js
```

### Legacy Pi

Pi supports extension installation from git and also supports direct extension loading.

Install from git:

```bash
pi install git:https://github.com/zakelfassi/pi-html-long-answer-extension.git
```

Or place it manually in the legacy global extension root:

```bash
mkdir -p ~/.pi/agent/extensions
git clone https://github.com/zakelfassi/pi-html-long-answer-extension.git \
  ~/.pi/agent/extensions/html-long-answer
```

### Shipping support for both runtimes

This repo includes both extension manifest keys in `package.json`:
- `omp.extensions`
- `pi.extensions`

That keeps directory/package resolution compatible with both ecosystems.

## Runtime behavior

- Long answers are detected from message length / line / paragraph thresholds.
- Long answers are captured into session state so `/html-last` can work on prior assistant replies.
- Local and designed exports open automatically in the browser after the file is written.
- Raw URLs such as `https://example.com` are linkified in local exports.
- Gemini rich renders are validated for actual HTML; invalid output falls back to the local renderer.

## Repo layout

```text
html-long-answer/
├── assets/
│   ├── flow.svg
│   ├── hero.svg
│   └── render-modes.svg
├── index.js
├── package.json
├── README.md
└── .gitignore
```

## Development notes

The extension currently lives and runs as a single-file runtime module (`index.js`) so it is easy to install directly into an extension root.

If you modify it, re-test these flows:
- long answer -> lightweight notice only
- `/html-last` -> chooser appears
- `/html-last local` -> HTML writes and opens
- `/html-last pi` -> second-pass render path queues/runs
- `/html-last gemini` -> Gemini render path succeeds or cleanly falls back
- `/html-last-version` -> version shown in-session

## Trust and security

Extensions run with your user permissions. Only install from sources you trust.

## Compatibility notes

This repo is designed to ship to:
- Oh My Pi / OMP users through `~/.omp/agent/extensions`
- legacy Pi users through `pi install ...` or `~/.pi/agent/extensions`

The install paths and dual manifest strategy are based on the upstream Pi and OMP extension-loading models.
