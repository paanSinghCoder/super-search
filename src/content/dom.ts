import { HL_OVERLAY_ID, PANEL_ID } from "../shared/constants";
import type { ContentScriptApp } from "./app";

export function isVisible(app: ContentScriptApp, el: Element | null): boolean {
  if (!el || !el.isConnected) return false;
  const cached = app.visibilityCache.get(el);
  if (cached !== undefined) return cached;

  let visible = true;
  if (el.closest(`#${PANEL_ID}, #${HL_OVERLAY_ID}`)) {
    visible = false;
  } else {
    let node: Element | null = el;
    while (node && node.nodeType === 1) {
      if (node.getAttribute("aria-hidden") === "true") {
        visible = false;
        break;
      }
      const cs = node.ownerDocument?.defaultView?.getComputedStyle(node);
      if (cs) {
        if (cs.display === "none" || cs.visibility === "hidden") {
          visible = false;
          break;
        }
        if (parseFloat(cs.opacity) === 0) {
          visible = false;
          break;
        }
      }
      node = node.parentElement;
    }
  }

  app.visibilityCache.set(el, visible);
  return visible;
}

export function isThisFrameVisible(app: ContentScriptApp): boolean {
  if (app.isTop) return true;
  try {
    const fe = window.frameElement;
    if (!fe) return true;
    if (!isVisible(app, fe)) return false;
    const rect = fe.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  } catch {
    return false;
  }
}

function clientRectInTopViewport(rect: DOMRect): { top: number; left: number } {
  let top = rect.top;
  let left = rect.left;
  let w: Window = window;
  while (w !== w.top) {
    const fe = w.frameElement;
    if (!fe) break;
    const r = fe.getBoundingClientRect();
    top += r.top;
    left += r.left;
    w = w.parent as Window;
  }
  return { top, left };
}

export function getFrameElementOrder(app: ContentScriptApp): { top: number; left: number } {
  if (app.isTop) return { top: 0, left: 0 };
  let top = 0;
  let left = 0;
  let w: Window = window;
  while (w !== w.top) {
    const fe = w.frameElement;
    if (!fe) return { top: Infinity, left: Infinity };
    const r = fe.getBoundingClientRect();
    top += r.top;
    left += r.left;
    w = w.parent as Window;
  }
  return { top, left };
}

export function getFrameOrderFromMatches(
  app: ContentScriptApp,
  matches: ContentScriptApp["state"]["matches"],
): { top: number; left: number } {
  if (!matches.length) return getFrameElementOrder(app);
  const m = matches[0];
  let rect: DOMRect;
  try {
    rect = m.type === "range" ? m.range.getBoundingClientRect() : m.element.getBoundingClientRect();
  } catch {
    return getFrameElementOrder(app);
  }
  return clientRectInTopViewport(rect);
}

export function scrollMatchIntoView(app: ContentScriptApp, match: ContentScriptApp["state"]["matches"][number]): void {
  if (!match) return;
  if (match.type === "range") {
    const rect = match.range.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight || rect.left < 0 || rect.right > window.innerWidth) {
      const el = match.range.startContainer.parentElement;
      el?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    }
  } else {
    const rect = match.element.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight || rect.left < 0 || rect.right > window.innerWidth) {
      match.element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    }
    const active = document.activeElement;
    if (active === match.element || active === app.ui?.findInput) {
      try {
        match.element.setSelectionRange(match.start, match.end);
      } catch {
        // Input may not support selection.
      }
    }
  }
}
