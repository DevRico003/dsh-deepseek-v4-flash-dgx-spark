# dsh-plugin-browser

Browser pane inside the DeepSeek Harness web UI and DSH Desktop, plus three tools for the model: `open_preview(url, label?)`, `read_preview(start?, count?)`, `close_preview(url?)`. Web pages open in a real Chrome driven over the Chrome DevTools Protocol with its own persistent profile (`~/.dsh/browser-profile`), so logins stick; the pane streams its frames and forwards clicks and keys. Local files are rendered instead of linked: markdown as a document, HTML as the page, images, PDFs as page images with a text layer, code with line numbers. Clicking a link or a file path in the chat opens it in the pane.

Adapted from [tonyd2wild/DeepSeek-Harness-Browser](https://github.com/tonyd2wild/DeepSeek-Harness-Browser) (MIT, see `LICENSE`). The upstream README explains the design and the measurements.

## What this copy changes

- `package.json`: `peerDependencies` plus `link:` dev dependencies on the harness source checkout (`../deepseek-harness`), instead of the upstream Windows path; `dsh.bundle.patch` so the profile bundles list is enough, no hand-written profile patch.
- `cordis.patch.yml`: the loader entry with config `count` (characters per `read_preview` page) and `headless`.
- `cdpbrowser.js`: `configure({ headless })`, default `true`. Chrome starts with `--headless=new`; it paints, streams screencast frames and takes CDP input like a windowed Chrome. Upstream moves a real window off-screen, which macOS clamps back onto the desktop as a second visible Chrome window. `headless: false` in the plugin config restores that.
- `index.js`: passes `config.headless` through. Nothing else touched.

## Requirements

Node 24, Google Chrome (`/Applications/Google Chrome.app`) or `/usr/bin/google-chrome`, and for PDF page rendering a Python with PyMuPDF on `PATH` or at `~/.dsh/venv/bin/python` (`uv venv ~/.dsh/venv && uv pip install --python ~/.dsh/venv/bin/python pymupdf`). Without PyMuPDF, PDFs fall back to the browser's own viewer.

## Install

```sh
pnpm install
dsh plugin --profile web add /abs/path/to/dsh-plugin-browser
dsh plugin --profile desktop add /abs/path/to/dsh-plugin-browser
```

Web and desktop profiles only: the host half needs `ctx.webServer`, which a headless profile does not have. Restart the host afterwards.

## Security

The pane can hold logged-in sessions and the agent drives it. The rule in `~/.dsh/AGENTS.md` of this setup applies: before anything that spends money, sends, submits, deletes or changes account settings, the agent stops and asks. That is guidance, not enforcement.
