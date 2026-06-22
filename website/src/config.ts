const CHROME_STORE_URL =
  "https://chromewebstore.google.com/detail/supersearch-vs-code-find/afnekfeaaamnbohoejlkbhnfefngahdh";

export const site = {
  name: "SuperSearch",
  tagline: "VS Code find, in Chrome.",
  chromeStoreUrl: import.meta.env.PUBLIC_CHROME_STORE_URL ?? CHROME_STORE_URL,
  githubUrl: "https://github.com/paanSinghCoder",
  version: "1.1.0",
};
