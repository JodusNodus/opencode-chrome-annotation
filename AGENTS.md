# AGENTS.md - OpenCode Browser

Guidelines for AI agents working on this codebase.

## Project Overview

OpenCode Chrome Annotation sends browser annotations into OpenCode via an OpenCode **plugin**, backed by a Chrome/Chromium **extension**.

Architecture:

```
Chrome Extension <-> Local HTTP server in each OpenCode Plugin instance
```

Components:

1. **Plugin** (`src/plugin.ts`) - OpenCode plugin that serves local HTTP endpoints for status/session/claim/annotation
2. **Extension** (`extension/`) - discovers plugin instances on localhost ports and sends annotation payloads

## Build & Run Commands

```bash
# Install dependencies
bun install

# Validate scripts
node --check extension/background.js
```

## Testing Changes

To test end-to-end you need:

1. The extension loaded in `chrome://extensions`
2. OpenCode configured with the plugin

Then verify manually in a fresh OpenCode process by connecting a tab from the extension popup and submitting an annotation.

## Code Style Guidelines

### TypeScript (src/)

- 2-space indentation
- Double quotes
- Semicolons required

### JavaScript (extension/)

- 2-space indentation
- Double quotes
- No semicolons

## Important Notes

- Plugin binds local HTTP on `127.0.0.1` over a bounded port range (`39240-39260`).
- Extension discovers active instances by probing `/status` and routes annotation requests directly to the selected instance.
