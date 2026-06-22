const CHROME_STORE_URL =
  "https://chromewebstore.google.com/detail/supersearch-vs-code-find/afnekfeaaamnbohoejlkbhnfefngahdh";
const SITE_URL = "https://super-search-gamma.vercel.app";
const GITHUB_REPO_URL = "https://github.com/paanSinghCoder/super-search";

export const site = {
  name: "SuperSearch",
  tagline: "VS Code find, in Chrome.",
  siteUrl: import.meta.env.PUBLIC_SITE_URL ?? SITE_URL,
  chromeStoreUrl: import.meta.env.PUBLIC_CHROME_STORE_URL ?? CHROME_STORE_URL,
  githubUrl: import.meta.env.PUBLIC_GITHUB_URL ?? GITHUB_REPO_URL,
  version: "1.1.0",
};
