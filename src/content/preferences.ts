import { PANEL_ID, PREF_KEYS } from "../shared/constants";
import type { ContentScriptApp } from "./app";
import { applySetCurrent } from "./messaging";
import { syncToggleUI } from "./panel";

export function initPreferences(app: ContentScriptApp): void {
  chrome.storage?.local.get(PREF_KEYS, (prefs) => {
    if (!prefs) return;
    app.state.matchCase = !!prefs.matchCase;
    app.state.wholeWord = !!prefs.wholeWord;
    app.state.regex = !!prefs.regex;
    app.state.overrideNativeFind = prefs.overrideNativeFind !== false;
    syncToggleUI(app);
  });

  chrome.storage?.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.matchCase) app.state.matchCase = !!changes.matchCase.newValue;
    if (changes.wholeWord) app.state.wholeWord = !!changes.wholeWord.newValue;
    if (changes.regex) app.state.regex = !!changes.regex.newValue;
    if (changes.overrideNativeFind) {
      app.state.overrideNativeFind = changes.overrideNativeFind.newValue !== false;
    }
    syncToggleUI(app);
  });
}

export function initNativeFindOverride(app: ContentScriptApp): void {
  if (!app.isTop) return;

  window.addEventListener(
    "keydown",
    (e) => {
      if (!app.state.overrideNativeFind) return;
      const cmdKey = e.metaKey || e.ctrlKey;
      if (cmdKey && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        e.stopPropagation();
        app.openPanel();
      }
    },
    true,
  );

  document.addEventListener("selectionchange", () => {
    if (app.state.findInSelection) return;
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const el = anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement;
    if (!el || el.closest(`#${PANEL_ID}`)) return;
    try {
      app.state.savedSelectionRange = range.cloneRange();
    } catch {
      // Selection may be invalid.
    }
  });
}

export function initFrameIdentity(app: ContentScriptApp): void {
  if (app.isTop) return;
  try {
    chrome.runtime.sendMessage({ type: "ss-whoami" }, (reply) => {
      if (chrome.runtime.lastError) return;
      if (typeof reply?.frameId !== "number") return;
      app.state.myFrameId = reply.frameId;
      if (app.pendingSetCurrent) {
        applySetCurrent(app, app.pendingSetCurrent);
        app.pendingSetCurrent = null;
      }
    });
  } catch {
    // Extension context may be unavailable.
  }
}
