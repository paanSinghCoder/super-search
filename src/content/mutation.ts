import { TIMINGS } from "../shared/constants";
import type { ContentScriptApp } from "./app";
import { getFrameOrderFromMatches, isThisFrameVisible } from "./dom";
import { clearHighlights } from "./highlights";
import { replyToTop, runDistributedSearch } from "./messaging";
import { runLocalSearch } from "./search";

export function handleMutationRefresh(app: ContentScriptApp): void {
  if (!app.state.query) return;
  if (!isThisFrameVisible(app)) {
    if (!app.isTop) {
      app.state.matches = [];
      app.state.currentLocalIndex = -1;
      clearHighlights(app);
    }
    return;
  }
  if (app.isTop && app.state.open) {
    runDistributedSearch(app, { preservePosition: true });
    return;
  }
  if (!app.isTop) {
    runLocalSearch(app, { preserveLocalIndex: true });
    const order = getFrameOrderFromMatches(app, app.state.matches);
    replyToTop({
      cmd: "count-update",
      count: app.state.matches.length,
      orderTop: order.top,
      orderLeft: order.left,
    });
  }
}

export function startMutationObserver(app: ContentScriptApp): void {
  if (app.mutationObserver) return;
  app.mutationObserver = new MutationObserver(() => {
    if (!app.state.query) return;
    if (app.mutationTimer) clearTimeout(app.mutationTimer);
    app.mutationTimer = setTimeout(() => handleMutationRefresh(app), TIMINGS.MUTATION_DEBOUNCE);
  });
  app.mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

export function stopMutationObserver(app: ContentScriptApp): void {
  if (!app.mutationObserver) return;
  app.mutationObserver.disconnect();
  app.mutationObserver = null;
  if (app.mutationTimer) clearTimeout(app.mutationTimer);
  app.mutationTimer = null;
}

// Subframes observe mutations even when the panel is closed.
export function initSubframeMutationObserver(app: ContentScriptApp): void {
  if (!app.isTop) startMutationObserver(app);
}
