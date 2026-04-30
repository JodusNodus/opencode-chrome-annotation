# OpenCode Chrome Annotation

Annotate any page in Chrome and send that context directly into [OpenCode](https://opencode.ai).

OpenCode Chrome Annotation lets you select a UI element on a live website, add a short instruction, and send:
- your comment,
- selected element metadata,
- and a screenshot

to your active OpenCode session through your local OpenCode setup so you can implement the change faster.


https://github.com/user-attachments/assets/bdee8a15-6720-4e57-b28d-ee6440722b71



## Install

1. Install the plugin package in your OpenCode environment.
2. Add it to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-chrome-annotation"]
}
```

3. Install the Chrome extension from the Chrome Web Store:
   - https://chromewebstore.google.com/detail/abeihanpaeioklkhioiigklonbomhjfd

## How It Works

1. Start OpenCode in your project.
2. Click the extension button in Chrome.
3. Connect the current tab to your OpenCode session from the in-page picker.
4. Click **Annotate** in the in-page pill.
5. Select an element, write your instruction, and submit.

## In-Page UX

- The pill is draggable and snaps to top or bottom.
- The session picker expands from the same pill.
- Keyboard shortcuts in picker:
  - `Escape` close
  - `ArrowUp` / `ArrowDown` navigate
  - `Enter` select

## Development

The Chrome extension source lives in `extension-src/`. The loadable extension output is generated into `extension/` and is not tracked by git.

```bash
npm run build:extension
```

Then load the generated `extension/` directory from `chrome://extensions`.

To create the Chrome Web Store upload zip:

```bash
npm run build:zip
```

## Uninstall

- Remove the extension from `chrome://extensions`.
- Remove the plugin entry from your OpenCode config.
