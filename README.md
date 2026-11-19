# agy-usage

**English** · [简体中文](README.zh-CN.md)

A lightweight, local topbar overlay for the Antigravity desktop client on macOS and Linux. It adds four dedicated popovers for model quota, context window usage, generation speed, and cumulative token usage—built with zero npm dependencies and no outbound network requests.

## Features

Four topbar indicators, each opening a focused popover:

1. **Model Quota**
   - Topbar progress ring for the active model's remaining quota; popover shows subscription tier, Prompt / Flow credits, shared quota pools, and reset countdowns.
2. **Context Window**
   - Live window occupancy, budget limit, remaining tokens, and latest-call summary (input, cache read ratio, output, latency) with an expandable turn timeline and local attachment scan.
   - Includes a **Model Limits** tab to inspect per-model context and output limits.
3. **Output Speed**
   - Streaming throughput (`tok/s`), time-to-first-token (TTFT), total duration, and output count for the latest response, plus a cross-model median comparison chart and per-model trend view.
4. **Cumulative Usage**
   - Isolated **All / Desktop / CLI** views covering total, today, monthly, and yearly tokens along with weighted cache hit ratio.
   - 52-week activity heatmap (daily / weekly / monthly / yearly / cumulative), stacked per-model and per-effort breakdown, and API-equivalent cost estimation with optional USD monthly spend comparison.

Additional utilities:

- **One-click CLI launcher**: Opens `agy` directly in the current workspace directory (uses `Kitty.app` on macOS if installed, otherwise `Terminal.app`).
- **Appearance & language**: Supports `EN / 简 / 繁` panel languages (defaults to English), `Auto / Dark / Light` themes, 5 color palettes, and individual topbar indicator toggles.

## How It Works

- Runs locally on **macOS and Linux** using only local conversation transcripts, archives, and the loopback (`127.0.0.1`) Antigravity host interface.
- Does not patch `language_server` or `agy` binaries, does not intercept or modify chat requests, does not read OAuth tokens or Keychain credentials, and makes no external network calls.

## Requirements

- Node.js `>= 22.4.0` (includes a native ASAR engine; no `npm install` required)
- Python 3 (optional, for Office / PDF attachment token estimation)
- Antigravity desktop client on macOS or Linux

## Installation

### Option 1: Let an AI Agent Install It

Copy and send the following prompt to your AI coding assistant (Antigravity, Claude Code, Codex, Cursor, etc.):

```text
Clone https://github.com/StepaniaH/agy-usage (or open my local copy), read AGENTS.md, run `node cli.js check` and `node cli.js install`, and then walk me through restarting Antigravity and verifying with `node cli.js status`. Do not kill the running Antigravity process automatically.
```

### Option 2: Manual Installation

```bash
git clone https://github.com/StepaniaH/agy-usage.git
cd agy-usage

# 1. Check local environment (Node.js version, Antigravity app.asar path, Python)
node cli.js check

# 2. Install into app.asar (automatically backs up the original file with SHA-256 verification)
node cli.js install

# 3. Fully quit and reopen Antigravity, then verify status
node cli.js status
```

Convenience wrapper scripts are also included:

```bash
./install.sh     # install or update
./uninstall.sh   # restore the original app.asar
```

### Other CLI Commands

```bash
node cli.js install --path "<path-to-app.asar>"  # target a custom app.asar location
node cli.js restore                               # restore original backup or strip injected tags in-place
node cli.js live                                  # inject into a running CDP-enabled window without patching app.asar
node cli.js watch                                 # background daemon for diskless CDP injection
node cli.js stop-watch                            # stop the watch daemon and local bridge
```

> When Antigravity updates to a new version, it replaces `app.asar`. Re-run `node cli.js install` (or `./install.sh`) and restart the client to re-enable the overlay.

## Development & Testing

Modular renderer sources live under `src/renderer/`; `meter-renderer.js` is the generated single-file bundle:

```bash
# Rebuild meter-renderer.js from src/renderer/
npm run build:renderer

# Run the full Node.js test suite
npm test

# Run Python attachment scanner tests
python3 -m unittest attachment_scan_test.py

# Verify release manifest and build macOS / Linux zip packages
node scripts/check-release-manifest.js
npm run pack
```

## Project Structure

```text
.
├── cli.js                        # CLI entry point (check / install / status / restore / live / watch)
├── install.js / restore.js       # ASAR installation and lossless restore orchestration
├── modular-installer.js          # Minimal mount code generation and legacy tag cleanup
├── asar-engine.js                # Native Node.js ASAR unpack/pack engine
├── meter-main.js                 # Electron main-process IPC bridge
├── live-host.js / local-api.js   # Local 127.0.0.1 CDP discovery and diskless runtime bridge
├── meter-core.js                 # Context estimation, cache stats, speed scoring, and pricing core
├── meter-collector.js            # Local transcript.jsonl, SQLite, and archive collector
├── meter-storage.js              # Atomic JSON storage and recovery
├── meter-cli-launcher.js         # macOS / Linux terminal and agy CLI launcher
├── attachment_scan.py            # Optional Python attachment analyzer
├── src/renderer/                 # Modular renderer source (domain views, styles, template, i18n)
├── meter-renderer.js             # Generated renderer bundle built by scripts/build-renderer.js
├── scripts/                      # Renderer builder, manifest check, packager, and scan benchmark
├── LICENSE                       # MIT License
└── NOTICE                        # Upstream attribution and modification summary
```

## License & Attribution

Licensed under the [MIT License](LICENSE).

Derived from [elviscjn-cjn/antigravity-context-viewer](https://github.com/elviscjn-cjn/antigravity-context-viewer) (MIT License, Copyright (c) 2026 Antigravity Context Viewer Contributors), trimmed and re-architected for macOS and Linux. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for details.
