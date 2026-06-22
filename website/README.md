# SuperSearch website

Astro landing page for the [SuperSearch](https://github.com/paanSinghCoder/SuperSearch) Chrome extension.

## Setup

From the repo root:

```bash
npm install --prefix website
```

## Commands

Run from the repo root:

| Command | Description |
|---|---|
| `npm run dev:website` | Dev server at `localhost:4321` |
| `npm run build:website` | Production build to `website/dist/` |
| `npm run preview:website` | Preview the production build |

Or from `website/` directly: `npm run dev`, `npm run build`, `npm run preview`.

## Environment

Copy `website/.env.example` to `website/.env` if you need to override the Chrome Web Store URL (`PUBLIC_CHROME_STORE_URL`).
