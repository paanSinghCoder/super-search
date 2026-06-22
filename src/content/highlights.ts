import { HL_ALL, HL_CUR, HL_OVERLAY_ID, HL_SCOPE, TIMINGS } from "../shared/constants";
import type { ContentScriptApp } from "./app";

function ensureOverlayRoot(app: ContentScriptApp): HTMLDivElement {
  if (app.overlayRoot?.isConnected) return app.overlayRoot;
  const root = document.createElement("div");
  root.id = HL_OVERLAY_ID;
  root.setAttribute("data-super-search", "overlay");
  document.documentElement.appendChild(root);
  app.overlayRoot = root;
  return root;
}

function clearOverlayHighlights(app: ContentScriptApp): void {
  if (app.overlayRoot) app.overlayRoot.replaceChildren();
  if (app.overlayScrollHandler) {
    window.removeEventListener("scroll", app.overlayScrollHandler, true);
    window.removeEventListener("resize", app.overlayScrollHandler);
    app.overlayScrollHandler = null;
  }
  if (app.overlayRefreshTimer) clearTimeout(app.overlayRefreshTimer);
  app.overlayRefreshTimer = null;
}

function addOverlayRects(root: HTMLDivElement, range: Range | null, className: string): void {
  if (!range) return;
  let rects: DOMRectList;
  try {
    rects = range.getClientRects();
  } catch {
    return;
  }
  for (const rect of rects) {
    if (rect.width === 0 && rect.height === 0) continue;
    const div = document.createElement("div");
    div.className = className;
    div.style.top = `${rect.top}px`;
    div.style.left = `${rect.left}px`;
    div.style.width = `${rect.width}px`;
    div.style.height = `${rect.height}px`;
    root.appendChild(div);
  }
}

function renderOverlayHighlights(
  app: ContentScriptApp,
  allRanges: Range[],
  currentRange: Range | null,
  scopeRange: Range | null,
): void {
  clearOverlayHighlights(app);
  if (!allRanges.length && !currentRange && !scopeRange) return;

  const root = ensureOverlayRoot(app);
  if (scopeRange) addOverlayRects(root, scopeRange, "ss-overlay-scope");
  for (const r of allRanges) addOverlayRects(root, r, "ss-overlay-match");
  addOverlayRects(root, currentRange, "ss-overlay-current");

  app.overlayScrollHandler = () => {
    if (app.overlayRefreshTimer) clearTimeout(app.overlayRefreshTimer);
    app.overlayRefreshTimer = setTimeout(() => {
      if (app.supportsHighlights || !app.state.query) return;
      applyHighlights(app);
    }, TIMINGS.OVERLAY_REFRESH);
  };
  window.addEventListener("scroll", app.overlayScrollHandler, true);
  window.addEventListener("resize", app.overlayScrollHandler);
}

function clearFieldOutlines(app: ContentScriptApp): void {
  for (const el of app.state.fieldMatchEls) {
    el.classList.remove("ss-field-match", "ss-field-match-current");
  }
  app.state.fieldMatchEls.clear();
}

export function applyHighlights(app: ContentScriptApp): void {
  clearFieldOutlines(app);

  if (app.supportsHighlights) {
    CSS.highlights.delete(HL_ALL);
    CSS.highlights.delete(HL_CUR);
    clearOverlayHighlights(app);
  }

  const allRanges: Range[] = [];
  let currentRange: Range | null = null;
  for (let i = 0; i < app.state.matches.length; i++) {
    const m = app.state.matches[i];
    const isCurrent = i === app.state.currentLocalIndex;
    if (m.type === "range") {
      if (isCurrent) currentRange = m.range;
      else allRanges.push(m.range);
    } else {
      m.element.classList.add("ss-field-match");
      if (isCurrent) m.element.classList.add("ss-field-match-current");
      app.state.fieldMatchEls.add(m.element);
    }
  }

  const scopeRange =
    app.state.findInSelection && app.state.selectionRange ? app.state.selectionRange : null;

  if (app.supportsHighlights) {
    if (allRanges.length) {
      try {
        const h = new Highlight(...allRanges);
        h.priority = 1;
        CSS.highlights.set(HL_ALL, h);
      } catch {
        // Highlight API may reject some ranges.
      }
    }
    if (currentRange) {
      try {
        const h = new Highlight(currentRange);
        h.priority = 2;
        CSS.highlights.set(HL_CUR, h);
      } catch {
        // Highlight API may reject some ranges.
      }
    }
    if (scopeRange) {
      try {
        const h = new Highlight(scopeRange);
        h.priority = 0;
        CSS.highlights.set(HL_SCOPE, h);
      } catch {
        // Highlight API may reject some ranges.
      }
    } else {
      CSS.highlights.delete(HL_SCOPE);
    }
  } else {
    renderOverlayHighlights(app, allRanges, currentRange, scopeRange);
  }
}

export function clearHighlights(app: ContentScriptApp): void {
  if (app.supportsHighlights) {
    CSS.highlights.delete(HL_ALL);
    CSS.highlights.delete(HL_CUR);
    CSS.highlights.delete(HL_SCOPE);
  }
  clearOverlayHighlights(app);
  clearFieldOutlines(app);
}
