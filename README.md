# SuperSearch

A Chrome extension that adds a VS Code–style find overlay to any web page — with regex, whole-word, match-case, find-in-selection, and cross-iframe match aggregation. Searches DOM text, contenteditable elements, open shadow roots, and `<input>` / `<textarea>` values.

## Install

1. Clone this repo
2. Open `chrome://extensions` → enable **Developer mode**
3. **Load unpacked** → select the project folder

## Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + F` | Open find (overrides Chrome's native bar by default; toggle in options) |
| `Enter` / `Shift + Enter` | Next / previous |
| `Alt + C / W / R / L` | Match Case / Whole Word / Regex / In Selection |
| `Esc` | Close (works even when focus is on the page) |

You can also click the toolbar icon to open the panel.

## Notes

- **Find in Selection** applies to the top-level document only (not inside iframes).
- **Shadow DOM**: open shadow roots are searched; closed shadow roots cannot be accessed.
- **Highlights**: uses the CSS Custom Highlight API when available (Chrome 105+); otherwise falls back to positioned overlay rectangles.
- **Cross-frame order**: matches are ordered by visual position on screen, not by internal frame ID.
- The `Cmd/Ctrl+F` override may not work on pages that block keydown events (e.g. some PDF viewers).

## License

MIT
