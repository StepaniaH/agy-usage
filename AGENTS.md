# Development and Installation Guide

## Source Changes

- Edit modular renderer sources in `src/renderer/` (`main.js`, `topbar-dock.js`, `popover-router.js`, `quota-view.js`, `context-view.js`, `speed-view.js`, `tokens-view.js`, `i18n.js`, `colors.js`, `dropdown.js`, `heatmap.js`, `context-budget-engine.js`, `styles.css`, `template.html`), then run `npm run build:renderer`.
  `meter-renderer.js` is the generated bundle assembled by `scripts/build-renderer.js`; include it with renderer changes.
- Run `npm test` after source changes. Tests use isolated temporary directories for settings and usage data.
- Keep local transcripts, installation manifests, backups, and capture output outside the repository.
- Runtime uses Node.js built-ins and the bundled ASAR engine; no `npm install` is needed.

## Installation

Use Node.js `>= 22.4.0`. Python 3 is optional for Office / PDF attachment analysis.
Run installation commands only when installing or updating the local client is requested.

```sh
node cli.js check
node cli.js install
node cli.js status
```

- Pass `--path "<path-to-app.asar>"` for a custom client location.
- Check `asarPatched` and `liveWindow.active` separately in `status` output: a disk patch does not mean the running window has reloaded it.
- Do not terminate the Antigravity host process from inside an agent session. After `node cli.js install`, ask the user to quit and reopen Antigravity manually, then verify with `node cli.js status`. If `app.asar` is locked, report the failure and let the user close the client before retrying.
- Other commands:
  - `node cli.js live`: inject into a running CDP-enabled window without patching `app.asar` (updates renderer only; does not reload main-process IPC or preload changes).
  - `node cli.js watch`: diskless background daemon watching local CDP windows on macOS / Linux.
  - `node cli.js stop-watch`: stop the watch daemon and local bridge.
  - `node cli.js restore`: restore the recorded backup or strip injected tags in-place.

## UI Translation

Translate visible text in `src/renderer/template.html` and `src/renderer/i18n.js`. Keep DOM IDs, selectors, event handlers, and data structures intact. Build the renderer and run tests before installing.

## Project Scope & Invariants

- Platform scope: **macOS (`darwin`) and Linux (`linux`) only** — do not add Windows scripts, precompiled `.exe`/`.cs` helpers, or WSL scanning code.
- Architecture & safety invariants (enforced by `meter-safe-edition.test.js`):
  - Do not modify `language_server` or `agy` binaries.
  - Do not extract OAuth refresh tokens from `state.vscdb`/Keychain or call `cloudcode-pa.googleapis.com` / `oauth2.googleapis.com`.
  - Do not intercept or mutate `SendUserCascadeMessage` / `WebSocket` / `fetch` / `XHR` payloads; `Model Limits` is read-only. Do not add proxy injection or host DOM localization; only the plugin's Shadow DOM language switcher (`EN / 简 / 繁`, defaulting to `en`) is supported.
  - Keep runtime communication strictly local (`127.0.0.1` loopback); do not add remote update checks, external links in the UI, or telemetry.
  - UI & accounting layout: four 1-to-1 topbar popovers (Model Quota, Context Window, Output Speed, Cumulative Usage) + shared Settings view; dynamic SVG rings (`#quota-ring-svg`, `#ring-svg`) and monochrome linear SVG icons; isolated `all` / `desktop` / `cli` views; pure-USD monthly spend (`monthlySpendUSD`, supporting `0`); `Auto / Dark / Light` theme + 5 palettes + topbar pill visibility toggles; macOS CLI launcher prefers `/Applications/kitty.app` (falling back to `Terminal.app`).
- Attribution: Retain the MIT copyright notice in `LICENSE` and upstream attribution (`elviscjn-cjn/antigravity-context-viewer`) in `NOTICE` and `README.md`.
