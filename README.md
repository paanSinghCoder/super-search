# SuperSearch

VS Code-style find for Chrome. Regex, whole word, match case, find-in-selection, and cross-iframe search on any page.

[Install from Chrome Web Store](https://chromewebstore.google.com/detail/supersearch-vs-code-find/afnekfeaaamnbohoejlkbhnfefngahdh)

## Features

- Floating find panel with match counter (`3/12`)
- Match case, whole word, and JavaScript regex
- Find in selection
- Searches DOM text, contenteditable, open shadow roots, and input/textarea values
- Cross-iframe match list ordered by on-screen position
- CSS Custom Highlight API with overlay fallback (Chrome 105+)
- `Cmd/Ctrl+F` override (toggle in extension options)

## Install

### Chrome Web Store

Install [SuperSearch from the Chrome Web Store](https://chromewebstore.google.com/detail/supersearch-vs-code-find/afnekfeaaamnbohoejlkbhnfefngahdh).

### Build from source

Requires Node.js 18+.

```bash
git clone https://github.com/paanSinghCoder/SuperSearch.git
cd SuperSearch
npm install
npm run build
```

For the landing page: `npm install --prefix website`.

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `dist/supersearch` folder.

## Development

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript and create `dist/supersearch.zip` |
| `npm run build:ext` | Compile to `dist/supersearch` only |
| `npm run typecheck` | Run `tsc` without emitting files |
| `npm run launch` | Launch Chrome with the built extension (Playwright) |
| `npm run dev:website` | Astro dev server for the landing page |
| `npm run build:website` | Build the landing page to `website/dist/` |
| `npm run preview:website` | Preview the built landing page |

Edit files under `src/`, then rebuild and reload the extension on `chrome://extensions`.

The landing page lives in `website/` (Astro). See [website/README.md](website/README.md).

## Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + F` | Open find (overrides Chrome's native bar by default; toggle in options) |
| `Enter` / `Shift + Enter` | Next / previous match |
| `Alt + C / W / R / L` | Match case / whole word / regex / find in selection |
| `Esc` | Close (works even when focus is on the page) |

You can also click the toolbar icon to open the panel.

## Limitations

- Find in selection applies to the top-level document only, not inside iframes.
- Open shadow roots are searched; closed shadow roots cannot be accessed.
- The `Cmd/Ctrl+F` override may not work on pages that block keydown events (e.g. some PDF viewers).
- Hidden or zero-size iframes are excluded from cross-frame counts.

## Project structure

```
src/
  background.ts          Service worker (toolbar click, frame relay)
  options.ts             Options page script
  shared/
    constants.ts         IDs, timings, shared config
    types.ts             Shared TypeScript types
  content/
    index.ts             Content script entry
    app.ts               ContentScriptApp orchestrator
    panel.ts             Find panel UI
    search.ts            Text indexing and local search
    highlights.ts        Highlight API and overlay fallback
    messaging.ts         Cross-frame search and navigation
    mutation.ts          DOM mutation re-search
    dom.ts               Visibility, frame order, scroll
    preferences.ts       Storage prefs and Cmd+F override

website/                 Astro landing page
scripts/build.sh         Build script (esbuild + zip)
```

Source is TypeScript. [esbuild](https://esbuild.github.io/) bundles each entry point into the JavaScript files referenced by `manifest.json`.

## Contributing

Issues and pull requests are welcome.

1. Fork the repo and create a branch from `main`.
2. Make your changes under `src/`.
3. Run `npm run typecheck` and `npm run build`.
4. Open a pull request with a short description of what changed and why.

Please keep changes focused. For larger features, open an issue first to discuss the approach.

## License

[MIT](LICENSE)
