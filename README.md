# SuperSearch

A Chrome extension that adds a VS Code–style find & replace overlay to any web page — with regex, whole-word, match-case, find-in-selection, cross-iframe match aggregation, and editable-field replace.

## Features

- **Find** in DOM text, contenteditable elements, `<input>`, and `<textarea>` values — all in one unified result list, in document order
- **Replace** in editable fields (inputs, textareas, contenteditable). Read-only page text is left alone.
- **Regex / Whole word / Match case / Find in selection** toggles, persisted globally like VS Code
- **Cross-frame search** — same-origin and cross-origin iframes are searched and counted in the global result total. Navigation cycles across frames.
- **Drag-to-move panel** with position persisted across pages
- **Configurable shortcuts** via `chrome://extensions/shortcuts`, plus an option to override Chrome's native `Cmd/Ctrl+F`

## Install

1. Clone or download this repo
2. Open `chrome://extensions`
3. Enable **Developer mode** (top-right)
4. Click **Load unpacked** → select the project folder
5. Pin SuperSearch from the toolbar puzzle-piece menu (optional)

## Default shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + Shift + F` | Open find panel |
| `Cmd/Ctrl + Shift + H` | Open with replace expanded |
| `Esc` | Close panel |
| `Enter` / `Shift + Enter` | Next / previous match |
| `Alt + C` / `Alt + W` / `Alt + R` / `Alt + L` | Match Case / Whole Word / Regex / In Selection |
| `Cmd/Ctrl + Alt + Enter` | Replace All |

Customize at `chrome://extensions/shortcuts` or via the extension's options page.

## Project structure

```
manifest.json     MV3 manifest, command bindings, icon refs
background.js     Cross-frame message relay + command routing
content.js        Search engine, panel UI, drag, replace logic
content.css       Chrome-style flat panel + Highlight API rules
options.html/js   Settings page (shortcut override, default toggles)
icons/            16/32/48/128 PNGs
```

## Implementation notes

- Highlights use the [CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API) (Chrome 105+) — zero DOM mutation
- Field matches (input/textarea) are outlined via `box-shadow` since the Highlight API can't reach text inside form controls
- Cross-frame coordination flows through the background service worker as a relay (`ss-broadcast`, `ss-to-top`, `ss-whoami`)
- Layout uses CSS subgrid so the find row and replace row share identical column widths

## License

MIT
