# SuperSearch website

Astro landing page for the [SuperSearch](https://github.com/paanSinghCoder/super-search) Chrome extension.

**Live site:** [super-search-gamma.vercel.app](https://super-search-gamma.vercel.app)

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

Copy `website/.env.example` to `website/.env` to override `PUBLIC_SITE_URL`, `PUBLIC_GITHUB_URL`, or `PUBLIC_CHROME_STORE_URL`.
