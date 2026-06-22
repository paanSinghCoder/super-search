import { ContentScriptApp } from "./app";

declare global {
  interface Window {
    __superSearchInjected?: boolean;
  }
}

if (!window.__superSearchInjected) {
  window.__superSearchInjected = true;
  const app = new ContentScriptApp();
  app.init();
}
