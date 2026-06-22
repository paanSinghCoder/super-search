import { PANEL_ID, TIMINGS } from "../shared/constants";
import type { PanelUI, ToggleKey } from "../shared/types";
import type { ContentScriptApp } from "./app";
import { broadcast, navigate, runDistributedSearch } from "./messaging";
import { clearHighlights } from "./highlights";

const PANEL_HTML = `
  <div class="ss-row">
    <div class="ss-input-wrap" data-role="find-wrap">
      <input class="ss-input" data-role="find" type="text" placeholder="Find" spellcheck="false" autocomplete="off" aria-label="Find"/>
      <span class="ss-counter" data-role="counter" aria-live="polite"></span>
      <button class="ss-clear-btn" data-action="clear-find" type="button" title="Clear" aria-label="Clear find">
        <svg viewBox="0 0 16 16"><path d="M4.7 3.3l3.3 3.3 3.3-3.3 1.4 1.4L9.4 8l3.3 3.3-1.4 1.4L8 9.4l-3.3 3.3-1.4-1.4L6.6 8 3.3 4.7z"/></svg>
      </button>
    </div>
    <div class="ss-toggles">
      <button class="ss-toggle ss-toggle-case" data-toggle="matchCase" type="button" title="Match Case (Alt+C)" aria-pressed="false">Aa</button>
      <button class="ss-toggle ss-toggle-ww" data-toggle="wholeWord" type="button" title="Match Whole Word (Alt+W)" aria-pressed="false">ab</button>
      <button class="ss-toggle ss-toggle-regex" data-toggle="regex" type="button" title="Use Regular Expression (Alt+R)" aria-pressed="false">.*</button>
      <button class="ss-toggle ss-toggle-sel" data-toggle="findInSelection" type="button" title="Find in Selection (Alt+L)" aria-pressed="false">
        <svg class="ss-icon" viewBox="0 0 16 16"><path d="M2 3h5v1H3v9h4v1H2V3zm12 11H9v-1h4V4H9V3h5v11z"/></svg>
      </button>
    </div>
    <button class="ss-btn" data-action="prev" type="button" title="Previous Match (Shift+Enter)" aria-label="Previous match">
      <svg class="ss-icon" viewBox="0 0 16 16"><path d="M8 5.5l-4.5 4.5 1 1L8 7.5l3.5 3.5 1-1z"/></svg>
    </button>
    <button class="ss-btn" data-action="next" type="button" title="Next Match (Enter)" aria-label="Next match">
      <svg class="ss-icon" viewBox="0 0 16 16"><path d="M8 10.5l-4.5-4.5 1-1L8 8.5l3.5-3.5 1 1z"/></svg>
    </button>
    <button class="ss-btn" data-action="close" type="button" title="Close (Escape)" aria-label="Close find">
      <svg class="ss-icon" viewBox="0 0 16 16"><path d="M4.7 3.3l3.3 3.3 3.3-3.3 1.4 1.4L9.4 8l3.3 3.3-1.4 1.4L8 9.4l-3.3 3.3-1.4-1.4L6.6 8 3.3 4.7z"/></svg>
    </button>
  </div>
  <div class="ss-notification" data-role="notification">
    <svg class="ss-icon ss-notification-icon" viewBox="0 0 16 16"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm0 1a5.5 5.5 0 110 11 5.5 5.5 0 010-11zm0 2.25a.75.75 0 110 1.5.75.75 0 010-1.5zM7.25 7.5h1.5v4.25h-1.5V7.5z"/></svg>
    <span class="ss-notification-text" data-role="notification-text"></span>
  </div>
`;

export function buildUI(app: ContentScriptApp): PanelUI | null {
  if (app.ui || !app.isTop) return app.ui;

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.setAttribute("data-super-search", "panel");
  panel.innerHTML = PANEL_HTML;
  document.documentElement.appendChild(panel);

  const findInput = panel.querySelector<HTMLInputElement>('[data-role="find"]')!;

  findInput.addEventListener("input", () => {
    app.state.query = findInput.value;
    if (app.searchInputTimer) clearTimeout(app.searchInputTimer);
    app.searchInputTimer = setTimeout(() => runDistributedSearch(app), TIMINGS.SEARCH_DEBOUNCE);
  });

  panel.addEventListener("click", (e) => {
    const t = (e.target as Element).closest<HTMLElement>("[data-action], [data-toggle]");
    if (!t) return;
    const act = t.dataset.action;
    const tog = t.dataset.toggle as ToggleKey | undefined;
    if (act === "close") closePanel(app);
    else if (act === "next") navigate(app, 1);
    else if (act === "prev") navigate(app, -1);
    else if (act === "clear-find" && app.ui) {
      if (app.searchInputTimer) clearTimeout(app.searchInputTimer);
      app.ui.findInput.value = "";
      app.state.query = "";
      runDistributedSearch(app);
      app.ui.findInput.focus();
    }
    if (tog) toggle(app, tog);
  });

  panel.addEventListener("keydown", (e) => onPanelKeydown(app, e), true);

  app.ui = {
    panel,
    findInput,
    counter: panel.querySelector('[data-role="counter"]')!,
    findWrap: panel.querySelector('[data-role="find-wrap"]')!,
    notification: panel.querySelector('[data-role="notification"]')!,
    notificationText: panel.querySelector('[data-role="notification-text"]')!,
    toggles: {
      matchCase: panel.querySelector(".ss-toggle-case"),
      wholeWord: panel.querySelector(".ss-toggle-ww"),
      regex: panel.querySelector(".ss-toggle-regex"),
      findInSelection: panel.querySelector(".ss-toggle-sel"),
    },
  };

  syncToggleUI(app);
  return app.ui;
}

export function syncToggleUI(app: ContentScriptApp): void {
  if (!app.ui) return;
  for (const [key, el] of Object.entries(app.ui.toggles) as [ToggleKey, HTMLButtonElement | null][]) {
    const on = !!app.state[key];
    el?.classList.toggle("active", on);
    el?.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

function onPanelKeydown(app: ContentScriptApp, e: KeyboardEvent): void {
  if (e.target === app.ui?.findInput && e.key === "Enter") {
    e.preventDefault();
    if (e.repeat) return;
    navigate(app, e.shiftKey ? -1 : 1);
    return;
  }
  if (e.altKey && !e.metaKey && !e.ctrlKey) {
    const k = e.key.toLowerCase();
    if (k === "c") {
      e.preventDefault();
      toggle(app, "matchCase");
      return;
    }
    if (k === "w") {
      e.preventDefault();
      toggle(app, "wholeWord");
      return;
    }
    if (k === "r") {
      e.preventDefault();
      toggle(app, "regex");
      return;
    }
    if (k === "l") {
      e.preventDefault();
      toggle(app, "findInSelection");
      return;
    }
  }
}

function attachDocumentKeydown(app: ContentScriptApp): void {
  if (app.onDocumentKeydownRef) return;
  app.onDocumentKeydownRef = (e: KeyboardEvent) => {
    if (!app.state.open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePanel(app);
    }
  };
  document.addEventListener("keydown", app.onDocumentKeydownRef, true);
}

function detachDocumentKeydown(app: ContentScriptApp): void {
  if (!app.onDocumentKeydownRef) return;
  document.removeEventListener("keydown", app.onDocumentKeydownRef, true);
  app.onDocumentKeydownRef = null;
}

function attachDocumentWheel(app: ContentScriptApp): void {
  if (app.onDocumentWheelRef) return;
  app.onDocumentWheelRef = (e: WheelEvent) => {
    if (!app.state.open || !app.ui) return;
    if (e.defaultPrevented || e.ctrlKey) return;
    if (document.activeElement !== app.ui.findInput) return;
    const target = e.target;
    if (!(target instanceof Element) || !target.closest(`#${PANEL_ID}`)) return;
    window.scrollBy({ top: e.deltaY, left: e.deltaX, behavior: "auto" });
  };
  document.addEventListener("wheel", app.onDocumentWheelRef, { passive: true, capture: true });
}

function detachDocumentWheel(app: ContentScriptApp): void {
  if (!app.onDocumentWheelRef) return;
  document.removeEventListener("wheel", app.onDocumentWheelRef, true);
  app.onDocumentWheelRef = null;
}

function persistTogglePrefs(app: ContentScriptApp): void {
  chrome.storage?.local.set({
    matchCase: app.state.matchCase,
    wholeWord: app.state.wholeWord,
    regex: app.state.regex,
  });
}

function pickSelectionRange(app: ContentScriptApp): Range | null {
  const sel = document.getSelection();
  if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0);
    const anchor = r.commonAncestorContainer;
    const el = anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement;
    if (el && !el.closest(`#${PANEL_ID}`)) {
      try {
        return r.cloneRange();
      } catch {
        // Selection may be invalid.
      }
    }
  }
  if (app.state.savedSelectionRange) {
    const r = app.state.savedSelectionRange;
    if (r.startContainer.isConnected && r.endContainer.isConnected) {
      try {
        return r.cloneRange();
      } catch {
        // Saved range may be invalid.
      }
    }
  }
  return null;
}

function toggle(app: ContentScriptApp, key: ToggleKey): void {
  if (key === "findInSelection") {
    if (!app.state.findInSelection) {
      const range = pickSelectionRange(app);
      if (!range) {
        showNotification(app, "Select text first");
        return;
      }
      app.state.selectionRange = range;
      app.state.findInSelection = true;
    } else {
      app.state.findInSelection = false;
      app.state.selectionRange = null;
    }
  } else {
    app.state[key] = !app.state[key];
    persistTogglePrefs(app);
  }
  syncToggleUI(app);
  if (app.searchInputTimer) clearTimeout(app.searchInputTimer);
  runDistributedSearch(app);
}

export function openPanel(app: ContentScriptApp): void {
  if (!app.isTop) return;
  buildUI(app);

  if (app.state.open && app.ui) {
    app.ui.findInput.focus();
    app.ui.findInput.select();
    return;
  }

  const sel = document.getSelection();
  const selStr = sel?.toString() ?? "";
  if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
    try {
      app.state.savedSelectionRange = sel.getRangeAt(0).cloneRange();
    } catch {
      // Selection may be invalid.
    }
  }

  app.state.open = true;
  app.ui!.panel.classList.add("open");
  attachDocumentKeydown(app);
  attachDocumentWheel(app);
  app.startMutationObserver();

  if (!app.supportsHighlights && !app.state.warnedNoHighlights) {
    app.state.warnedNoHighlights = true;
    showNotification(app, "Using overlay highlights (Highlight API unavailable)");
  }

  if (selStr.trim() && app.ui) {
    if (selStr.includes("\n")) {
      const range = pickSelectionRange(app);
      if (range) {
        app.state.selectionRange = range;
        app.state.findInSelection = true;
        syncToggleUI(app);
      }
    } else {
      app.ui.findInput.value = selStr;
      app.state.query = selStr;
    }
  }

  app.ui!.findInput.focus();
  app.ui!.findInput.select();
  runDistributedSearch(app);
}

export function closePanel(app: ContentScriptApp): void {
  app.state.open = false;
  detachDocumentKeydown(app);
  detachDocumentWheel(app);
  if (app.searchInputTimer) clearTimeout(app.searchInputTimer);
  if (app.ui) {
    app.ui.panel.classList.remove("open");
    app.ui.notification.classList.remove("visible");
    if (app.notificationTimer) clearTimeout(app.notificationTimer);
  }
  app.state.matches = [];
  app.state.currentLocalIndex = -1;
  app.state.totalGlobal = 0;
  app.state.currentGlobalIdx = -1;
  app.state.frameCounts.clear();
  app.state.frameOrder.clear();
  clearHighlights(app);
  if (app.state.findInSelection) {
    app.state.findInSelection = false;
    app.state.selectionRange = null;
    syncToggleUI(app);
  }
  broadcast({ cmd: "clear" });
  app.stopMutationObserver();
}

export function updateCounter(app: ContentScriptApp): void {
  if (!app.ui) return;
  const c = app.ui.counter;
  if (!app.state.query) {
    c.textContent = "";
    c.classList.remove("no-results");
    return;
  }
  if (app.state.totalGlobal === 0) {
    c.textContent = "0/0";
    c.classList.add("no-results");
  } else {
    c.textContent = `${app.state.currentGlobalIdx + 1}/${app.state.totalGlobal}`;
    c.classList.remove("no-results");
  }
}

export function showNotification(app: ContentScriptApp, msg: string): void {
  if (!app.ui) return;
  app.ui.notificationText.textContent = msg;
  app.ui.notification.classList.add("visible");
  if (app.notificationTimer) clearTimeout(app.notificationTimer);
  app.notificationTimer = setTimeout(() => {
    app.ui?.notification.classList.remove("visible");
  }, TIMINGS.NOTIFICATION_HIDE);
}
