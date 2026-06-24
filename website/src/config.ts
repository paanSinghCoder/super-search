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
  version: "1.2.1",

  // SEO
  description:
    "SuperSearch is a free Chrome extension that adds a VS Code–style find bar to any web page — with regex, whole word, match case, find in selection, and cross-iframe search. Press Cmd/Ctrl+F to start.",
  ogImage: "/screenshot.png", // 1280×800, resolved to an absolute URL in the layout
  ogImageAlt: "The SuperSearch find panel open on a web page, showing the match counter and search toggles.",
  author: "paanSinghCoder",
  authorUrl: "https://github.com/paanSinghCoder",
  keywords: [
    "Chrome extension",
    "find in page",
    "VS Code find",
    "regex search",
    "Ctrl+F",
    "Cmd+F",
    "whole word search",
    "match case",
    "find in selection",
    "cross-iframe search",
    "browser find tool",
  ],
};
