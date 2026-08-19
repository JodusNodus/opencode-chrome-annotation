# <img src="https://raw.githubusercontent.com/jodusnodus/opencode-chrome-annotation/main/icon.svg" width="60" align="center" /> OpenCode Chrome Annotation

[![version](https://img.shields.io/npm/v/opencode-chrome-annotation?style=flat&colorA=000000&colorB=000000)](https://npmjs.com/package/opencode-chrome-annotation)
[![license](https://img.shields.io/npm/l/opencode-chrome-annotation?style=flat&colorA=000000&colorB=000000)](https://github.com/jodusnodus/opencode-chrome-annotation/blob/main/LICENSE)

Annotate any page in Chrome and send the screenshot, selected element metadata, and your instruction directly into [OpenCode](https://opencode.ai).

https://github.com/user-attachments/assets/bdee8a15-6720-4e57-b28d-ee6440722b71


## Install

Add the plugin to your OpenCode V2 config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-chrome-annotation@latest"]
}
```

Install the Chrome extension from the Chrome Web Store:

https://chromewebstore.google.com/detail/abeihanpaeioklkhioiigklonbomhjfd

## How It Works

1. Start OpenCode V2 in your project.
2. Click the extension button in Chrome.
3. Connect the current tab to your OpenCode session from the in-page picker.
4. Click **Annotate** in the in-page pill.
5. Select an element, write your instruction, and submit.


### What Gets Sent

- Your written instruction.
- The current page URL and title.
- Selected element metadata such as selector, tag, text, role, aria label, and bounds.
- The visible-tab screenshot as a native OpenCode image attachment.


### Troubleshooting
The plugin runs a local HTTP server bound to `127.0.0.1` on ports `39240-39260`. The extension discovers the active OpenCode plugin instance over localhost.

- The extension can't start a new session, you need to be in an active OpenCode session to connect.
- OpenCode V2 does not expose persisted session listing to plugins. The picker shows real sessions observed after plugin activation, including a session selected in the TUI; restart OpenCode after installing the plugin so the current session is observed.
- If the extension can't find any session, ask your agent to run `chrome_status` that should give a detailed report.
- Make sure OpenCode and your Chromium browser exist in the same localhost network (not in separate containers).


## Development

### Plugin

The OpenCode plugin source lives in `src/plugin.ts`. The published package entrypoint is generated at `dist/plugin.js`.

Install dependencies:

```bash
bun install
```

Build the plugin:

```bash
bun run build
```

Run the unit and packed-plugin V2 integration tests:

```bash
bun test
bun run test:integration:v2
```

The integration test requires the `opencode2` beta CLI. It installs the packed
artifact into an isolated temporary project, starts a private V2 server, and
verifies session events, inline PNG admission, and listener cleanup without
calling a model.

### Extension

The Chrome extension source lives in `extension-src/`. The loadable extension output is generated into `extension/` and is not tracked by git.

```bash
bun run build:extension
```

Then load the generated `extension/` directory from `chrome://extensions`.

To create the Chrome Web Store upload zip:

```bash
bun run build:zip
```
