# html-long-answer

Pi extension that captures long assistant answers and makes them exportable as HTML.

## What it does
- captures long assistant replies into session state
- notifies the user that HTML export is available
- exports the latest captured answer via `/html-last`
- supports three render paths:
  - `local` — fast local HTML render
  - `pi` — designed HTML via the current Pi model
  - `gemini` — designed HTML via Gemini CLI when available
- opens generated HTML in the default browser after export

## Commands
- `/html-last` — choose a render mode
- `/html-last local` — force quick local HTML
- `/html-last pi` — force designed HTML via current Pi model
- `/html-last gemini` — force designed HTML via Gemini CLI
- `/html-last-version` — show the loaded extension version

## Install location
This repo is intended to live at:

`~/.omp/agent/extensions/html-long-answer`

Pi auto-discovers native extensions from `~/.omp/agent/extensions`.

## Notes
- Local HTML is a faithful renderer with a designed shell.
- Rich HTML paths depend on the model returning valid HTML.
- Gemini rendering requires the `gemini` CLI to be installed and authenticated.
