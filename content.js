(() => {
  if (window.__superSearchInjected) return;
  window.__superSearchInjected = true;

  const PANEL_ID = "super-search-panel";
  const HL_OVERLAY_ID = "super-search-overlay-root";
  const HL_ALL = "super-search-match";
  const HL_CUR = "super-search-current";
  const HL_SCOPE = "super-search-scope";
  const IS_TOP = window === window.top;
  const supportsHighlights = typeof CSS !== "undefined" && !!CSS.highlights;

  const TIMINGS = {
    AGGREGATE_FALLBACK: 300,
    AGGREGATE_REPLY: 50,
    MUTATION_DEBOUNCE: 250,
    SEARCH_DEBOUNCE: 80,
    NOTIFICATION_HIDE: 2000,
    OVERLAY_REFRESH: 16,
  };

  const state = {
    matchCase: false,
    wholeWord: false,
    regex: false,
    findInSelection: false,
    selectionRange: null,
    savedSelectionRange: null,

    query: "",
    matches: [],
    currentLocalIndex: -1,
    fieldMatchEls: new Set(),

    open: false,
    overrideNativeFind: true,
    myFrameId: IS_TOP ? 0 : -1,
    frameCounts: new Map(),
    frameOrder: new Map(),
    totalGlobal: 0,
    currentGlobalIdx: -1,
    currentFrameId: -1,
    searchNonce: 0,
    aggregateTimer: null,
    preserveGlobalIdx: -1,
    warnedNoHighlights: false,
  };

  let ui = null;
  let visibilityCache = new WeakMap();
  let overlayRoot = null;
  let overlayScrollHandler = null;
  let overlayRefreshTimer = null;
  let pendingSetCurrent = null;
  let searchInputTimer = null;
  let onDocumentKeydownRef = null;

  const PREF_KEYS = ["matchCase", "wholeWord", "regex", "overrideNativeFind"];
  chrome.storage?.local.get(PREF_KEYS, (prefs) => {
    if (!prefs) return;
    state.matchCase = !!prefs.matchCase;
    state.wholeWord = !!prefs.wholeWord;
    state.regex = !!prefs.regex;
    state.overrideNativeFind = prefs.overrideNativeFind !== false;
    if (ui) syncToggleUI();
  });

  chrome.storage?.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.matchCase) state.matchCase = !!changes.matchCase.newValue;
    if (changes.wholeWord) state.wholeWord = !!changes.wholeWord.newValue;
    if (changes.regex) state.regex = !!changes.regex.newValue;
    if (changes.overrideNativeFind) state.overrideNativeFind = changes.overrideNativeFind.newValue !== false;
    if (ui) syncToggleUI();
  });

  function persistTogglePrefs() {
    chrome.storage?.local.set({
      matchCase: state.matchCase,
      wholeWord: state.wholeWord,
      regex: state.regex,
    });
  }

  if (!IS_TOP) {
    try {
      chrome.runtime.sendMessage({ type: "ss-whoami" }, (reply) => {
        if (chrome.runtime.lastError) return;
        if (typeof reply?.frameId !== "number") return;
        state.myFrameId = reply.frameId;
        if (pendingSetCurrent) {
          applySetCurrent(pendingSetCurrent);
          pendingSetCurrent = null;
        }
      });
    } catch {}
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (IS_TOP && msg.type === "super-search" && msg.action === "open") {
      openPanel();
      return;
    }
    if (msg.type === "ss-relay") {
      if (IS_TOP && msg.fromFrameId === 0) return;
      handleBroadcast(msg.payload);
      return;
    }
    if (msg.type === "ss-relay-from-frame" && IS_TOP) {
      handleSubframeReply(msg.payload, msg.fromFrameId);
    }
  });

  if (IS_TOP) {
    window.addEventListener(
      "keydown",
      (e) => {
        if (!state.overrideNativeFind) return;
        const cmdKey = e.metaKey || e.ctrlKey;
        if (cmdKey && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F")) {
          e.preventDefault();
          e.stopPropagation();
          openPanel();
        }
      },
      true
    );

    document.addEventListener("selectionchange", () => {
      if (state.findInSelection) return;
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const anchor = range.commonAncestorContainer;
      const el = anchor.nodeType === 1 ? anchor : anchor.parentElement;
      if (!el || el.closest(`#${PANEL_ID}`)) return;
      try {
        state.savedSelectionRange = range.cloneRange();
      } catch {}
    });
  }

  function broadcast(payload) {
    chrome.runtime.sendMessage({ type: "ss-broadcast", payload }).catch(() => {});
  }

  function replyToTop(payload) {
    chrome.runtime.sendMessage({ type: "ss-to-top", payload }).catch(() => {});
  }

  function applySetCurrent(payload) {
    if (payload.frameId === state.myFrameId) {
      state.currentLocalIndex = payload.indexInFrame;
      applyHighlights();
      if (state.matches[payload.indexInFrame]) scrollIntoView(state.matches[payload.indexInFrame]);
    } else {
      state.currentLocalIndex = -1;
      applyHighlights();
    }
  }

  function handleSetCurrent(payload) {
    if (state.myFrameId < 0) {
      pendingSetCurrent = payload;
      return;
    }
    applySetCurrent(payload);
  }

  function handleBroadcast(payload) {
    if (payload.cmd === "search") {
      state.query = payload.query;
      state.matchCase = !!payload.opts.matchCase;
      state.wholeWord = !!payload.opts.wholeWord;
      state.regex = !!payload.opts.regex;
      state.findInSelection = false;
      state.selectionRange = null;
      runLocalSearch();
      const order = getFrameOrderFromMatches(state.matches);
      replyToTop({
        cmd: "count",
        nonce: payload.nonce,
        count: state.matches.length,
        orderTop: order.top,
        orderLeft: order.left,
      });
    } else if (payload.cmd === "set-current") {
      handleSetCurrent(payload);
    } else if (payload.cmd === "clear") {
      state.query = "";
      state.matches = [];
      state.currentLocalIndex = -1;
      clearHighlights();
    }
  }

  function storeFrameOrder(frameId, orderTop, orderLeft) {
    if (orderTop === undefined) return;
    state.frameOrder.set(frameId, { top: orderTop, left: orderLeft });
  }

  function handleSubframeReply(payload, fromFrameId) {
    if (payload.cmd !== "count" && payload.cmd !== "count-update") return;
    if (payload.cmd === "count" && payload.nonce !== state.searchNonce) return;

    const prevGlobal = state.currentGlobalIdx;
    state.frameCounts.set(fromFrameId, payload.count);
    storeFrameOrder(fromFrameId, payload.orderTop, payload.orderLeft);

    if (payload.cmd === "count") {
      clearTimeout(state.aggregateTimer);
      state.aggregateTimer = setTimeout(() => finalizeSearch(payload.nonce), TIMINGS.AGGREGATE_REPLY);
      return;
    }

    const total = sumFrameCounts();
    state.totalGlobal = total;
    if (total === 0) {
      state.currentGlobalIdx = -1;
      state.currentFrameId = -1;
    } else if (prevGlobal >= 0) {
      setCurrentGlobal(Math.min(prevGlobal, total - 1));
    }
    updateCounter();
  }

  function sumFrameCounts() {
    return [...state.frameCounts.values()].reduce((a, b) => a + b, 0);
  }

  function sortedFrameIds() {
    return [...state.frameCounts.keys()].sort((a, b) => {
      const oa = state.frameOrder.get(a) ?? { top: a * 1e6, left: 0 };
      const ob = state.frameOrder.get(b) ?? { top: b * 1e6, left: 0 };
      if (oa.top !== ob.top) return oa.top - ob.top;
      if (oa.left !== ob.left) return oa.left - ob.left;
      return a - b;
    });
  }

  function buildUI() {
    if (ui || !IS_TOP) return ui;
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.setAttribute("data-super-search", "panel");
    panel.innerHTML = `
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
    document.documentElement.appendChild(panel);

    const findInput = panel.querySelector('[data-role="find"]');

    findInput.addEventListener("input", () => {
      state.query = findInput.value;
      clearTimeout(searchInputTimer);
      searchInputTimer = setTimeout(() => runDistributedSearch(), TIMINGS.SEARCH_DEBOUNCE);
    });

    panel.addEventListener("click", (e) => {
      const t = e.target.closest("[data-action], [data-toggle]");
      if (!t) return;
      const act = t.dataset.action;
      const tog = t.dataset.toggle;
      if (act === "close") closePanel();
      else if (act === "next") navigate(1);
      else if (act === "prev") navigate(-1);
      else if (act === "clear-find") {
        clearTimeout(searchInputTimer);
        ui.findInput.value = "";
        state.query = "";
        runDistributedSearch();
        ui.findInput.focus();
      }
      if (tog) toggle(tog);
    });

    panel.addEventListener("keydown", onPanelKeydown, true);

    ui = {
      panel,
      findInput,
      counter: panel.querySelector('[data-role="counter"]'),
      findWrap: panel.querySelector('[data-role="find-wrap"]'),
      notification: panel.querySelector('[data-role="notification"]'),
      notificationText: panel.querySelector('[data-role="notification-text"]'),
      toggles: {
        matchCase: panel.querySelector(".ss-toggle-case"),
        wholeWord: panel.querySelector(".ss-toggle-ww"),
        regex: panel.querySelector(".ss-toggle-regex"),
        findInSelection: panel.querySelector(".ss-toggle-sel"),
      },
    };

    syncToggleUI();
    return ui;
  }

  function syncToggleUI() {
    if (!ui) return;
    for (const [key, el] of Object.entries(ui.toggles)) {
      const on = !!state[key];
      el?.classList.toggle("active", on);
      el?.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function onPanelKeydown(e) {
    if (e.target === ui.findInput && e.key === "Enter") {
      e.preventDefault();
      navigate(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (k === "c") { e.preventDefault(); toggle("matchCase"); return; }
      if (k === "w") { e.preventDefault(); toggle("wholeWord"); return; }
      if (k === "r") { e.preventDefault(); toggle("regex"); return; }
      if (k === "l") { e.preventDefault(); toggle("findInSelection"); return; }
    }
  }

  function attachDocumentKeydown() {
    if (onDocumentKeydownRef) return;
    onDocumentKeydownRef = (e) => {
      if (!state.open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePanel();
      }
    };
    document.addEventListener("keydown", onDocumentKeydownRef, true);
  }

  function detachDocumentKeydown() {
    if (!onDocumentKeydownRef) return;
    document.removeEventListener("keydown", onDocumentKeydownRef, true);
    onDocumentKeydownRef = null;
  }

  function toggle(key) {
    if (key === "findInSelection") {
      if (!state.findInSelection) {
        const range = pickSelectionRange();
        if (!range) {
          showNotification("Select text first");
          return;
        }
        state.selectionRange = range;
        state.findInSelection = true;
      } else {
        state.findInSelection = false;
        state.selectionRange = null;
      }
    } else {
      state[key] = !state[key];
      persistTogglePrefs();
    }
    syncToggleUI();
    clearTimeout(searchInputTimer);
    runDistributedSearch();
  }

  function pickSelectionRange() {
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      const anchor = r.commonAncestorContainer;
      const el = anchor.nodeType === 1 ? anchor : anchor.parentElement;
      if (el && !el.closest(`#${PANEL_ID}`)) {
        try { return r.cloneRange(); } catch {}
      }
    }
    if (state.savedSelectionRange) {
      const r = state.savedSelectionRange;
      if (r.startContainer.isConnected && r.endContainer.isConnected) {
        try { return r.cloneRange(); } catch {}
      }
    }
    return null;
  }

  function openPanel() {
    if (!IS_TOP) return;
    buildUI();

    if (state.open) {
      ui.findInput.focus();
      ui.findInput.select();
      return;
    }

    const sel = document.getSelection();
    const selStr = sel?.toString() ?? "";
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      try { state.savedSelectionRange = sel.getRangeAt(0).cloneRange(); } catch {}
    }

    state.open = true;
    ui.panel.classList.add("open");
    attachDocumentKeydown();
    startMutationObserver();

    if (!supportsHighlights && !state.warnedNoHighlights) {
      state.warnedNoHighlights = true;
      showNotification("Using overlay highlights (Highlight API unavailable)");
    }

    if (selStr.trim()) {
      if (selStr.includes("\n")) {
        const range = pickSelectionRange();
        if (range) {
          state.selectionRange = range;
          state.findInSelection = true;
          syncToggleUI();
        }
      } else {
        ui.findInput.value = selStr;
        state.query = selStr;
      }
    }

    ui.findInput.focus();
    ui.findInput.select();
    runDistributedSearch();
  }

  function closePanel() {
    state.open = false;
    detachDocumentKeydown();
    clearTimeout(searchInputTimer);
    if (ui) {
      ui.panel.classList.remove("open");
      ui.notification.classList.remove("visible");
      clearTimeout(showNotification._t);
    }
    state.matches = [];
    state.currentLocalIndex = -1;
    state.totalGlobal = 0;
    state.currentGlobalIdx = -1;
    state.frameCounts.clear();
    state.frameOrder.clear();
    clearHighlights();
    if (state.findInSelection) {
      state.findInSelection = false;
      state.selectionRange = null;
      syncToggleUI();
    }
    broadcast({ cmd: "clear" });
    stopMutationObserver();
  }

  function runDistributedSearch(opts = {}) {
    if (!IS_TOP) return;

    clearTimeout(state.aggregateTimer);
    state.searchNonce++;
    const nonce = state.searchNonce;
    state.preserveGlobalIdx = opts.preservePosition ? state.currentGlobalIdx : -1;

    if (!state.query) {
      state.matches = [];
      state.currentLocalIndex = -1;
      state.totalGlobal = 0;
      state.currentGlobalIdx = -1;
      state.frameCounts.clear();
      state.frameOrder.clear();
      applyHighlights();
      broadcast({ cmd: "clear" });
      updateCounter();
      return;
    }

    runLocalSearch({ preserveLocalIndex: opts.preservePosition });
    state.frameCounts = new Map();
    state.frameOrder = new Map();
    state.frameCounts.set(0, state.matches.length);
    state.frameOrder.set(0, getFrameOrderFromMatches(state.matches));

    broadcast({
      cmd: "search",
      query: state.query,
      opts: { matchCase: state.matchCase, wholeWord: state.wholeWord, regex: state.regex },
      nonce,
    });

    state.aggregateTimer = setTimeout(() => finalizeSearch(nonce), TIMINGS.AGGREGATE_FALLBACK);

    if (!opts.preservePosition) {
      if (state.matches.length) {
        state.currentLocalIndex = 0;
        applyHighlights();
        scrollIntoView(state.matches[0]);
        state.currentGlobalIdx = 0;
        state.currentFrameId = 0;
      } else {
        state.currentLocalIndex = -1;
        applyHighlights();
        state.currentGlobalIdx = -1;
        state.currentFrameId = -1;
      }
      state.totalGlobal = state.matches.length;
      updateCounter();
    }
  }

  function finalizeSearch(nonce) {
    if (nonce !== state.searchNonce) return;
    const total = sumFrameCounts();
    state.totalGlobal = total;
    const preserve = state.preserveGlobalIdx;
    state.preserveGlobalIdx = -1;

    if (total === 0) {
      state.currentGlobalIdx = -1;
      state.currentFrameId = -1;
      updateCounter();
      return;
    }

    if (preserve >= 0 && preserve < total) {
      setCurrentGlobal(preserve);
    } else if (state.currentGlobalIdx < 0 || state.currentGlobalIdx >= total) {
      setCurrentGlobal(0);
    } else {
      setCurrentGlobal(state.currentGlobalIdx);
    }
  }

  function setCurrentGlobal(globalIdx) {
    let acc = 0;
    let targetFrame = -1;
    let localIdx = -1;
    for (const fid of sortedFrameIds()) {
      const count = state.frameCounts.get(fid);
      if (globalIdx < acc + count) {
        targetFrame = fid;
        localIdx = globalIdx - acc;
        break;
      }
      acc += count;
    }
    if (targetFrame < 0) return;
    state.currentGlobalIdx = globalIdx;
    state.currentFrameId = targetFrame;

    if (targetFrame === 0) {
      state.currentLocalIndex = localIdx;
      applyHighlights();
      if (state.matches[localIdx]) scrollIntoView(state.matches[localIdx]);
    } else {
      state.currentLocalIndex = -1;
      applyHighlights();
    }
    broadcast({ cmd: "set-current", frameId: targetFrame, indexInFrame: localIdx });
    updateCounter();
  }

  function navigate(dir) {
    if (state.totalGlobal === 0) return;
    const next = (state.currentGlobalIdx + dir + state.totalGlobal) % state.totalGlobal;
    setCurrentGlobal(next);
  }

  function updateCounter() {
    if (!ui) return;
    const c = ui.counter;
    if (!state.query) {
      c.textContent = "";
      c.classList.remove("no-results");
      return;
    }
    if (state.totalGlobal === 0) {
      c.textContent = "0/0";
      c.classList.add("no-results");
    } else {
      c.textContent = `${state.currentGlobalIdx + 1}/${state.totalGlobal}`;
      c.classList.remove("no-results");
    }
  }

  function showNotification(msg) {
    if (!ui) return;
    ui.notificationText.textContent = msg;
    ui.notification.classList.add("visible");
    clearTimeout(showNotification._t);
    showNotification._t = setTimeout(() => {
      ui.notification.classList.remove("visible");
    }, TIMINGS.NOTIFICATION_HIDE);
  }

  function clientRectInTopViewport(rect) {
    let top = rect.top;
    let left = rect.left;
    let w = window;
    while (w !== w.top) {
      const fe = w.frameElement;
      if (!fe) break;
      const r = fe.getBoundingClientRect();
      top += r.top;
      left += r.left;
      w = w.parent;
    }
    return { top, left };
  }

  function getFrameElementOrder() {
    if (IS_TOP) return { top: 0, left: 0 };
    let top = 0;
    let left = 0;
    let w = window;
    while (w !== w.top) {
      const fe = w.frameElement;
      if (!fe) return { top: Infinity, left: Infinity };
      const r = fe.getBoundingClientRect();
      top += r.top;
      left += r.left;
      w = w.parent;
    }
    return { top, left };
  }

  function getFrameOrderFromMatches(matches) {
    if (!matches.length) return getFrameElementOrder();
    const m = matches[0];
    let rect;
    try {
      rect = m.type === "range" ? m.range.getBoundingClientRect() : m.element.getBoundingClientRect();
    } catch {
      return getFrameElementOrder();
    }
    return clientRectInTopViewport(rect);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const cached = visibilityCache.get(el);
    if (cached !== undefined) return cached;

    let visible = true;
    if (el.closest(`#${PANEL_ID}, #${HL_OVERLAY_ID}`)) {
      visible = false;
    } else {
      let node = el;
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

    visibilityCache.set(el, visible);
    return visible;
  }

  function collectShadowRoots(root, roots) {
    if (!root || root.nodeType !== 1) return;
    if (root.shadowRoot) {
      roots.add(root.shadowRoot);
      for (const child of root.shadowRoot.children) collectShadowRoots(child, roots);
    }
    for (const child of root.children) collectShadowRoots(child, roots);
  }

  function collectSearchRoots(scopeRange) {
    const roots = new Set();
    const base = scopeRange
      ? (scopeRange.commonAncestorContainer.nodeType === 1
          ? scopeRange.commonAncestorContainer
          : scopeRange.commonAncestorContainer.parentElement)
      : document.body;
    if (base) {
      roots.add(base);
      if (base.nodeType === 1) collectShadowRoots(base, roots);
    }
    if (!scopeRange && document.body) {
      roots.add(document.body);
      collectShadowRoots(document.body, roots);
    }
    return [...roots];
  }

  function rangeIntersects(a, b) {
    return (
      a.compareBoundaryPoints(Range.END_TO_START, b) < 0 &&
      a.compareBoundaryPoints(Range.START_TO_END, b) > 0
    );
  }

  function collectTextNodes(scopeRange) {
    const nodes = [];
    for (const root of collectSearchRoots(scopeRange)) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const parent = n.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA") {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.closest(`#${PANEL_ID}, #${HL_OVERLAY_ID}`)) return NodeFilter.FILTER_REJECT;
          if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
          if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      let n;
      while ((n = walker.nextNode())) {
        if (scopeRange) {
          const r = document.createRange();
          try { r.selectNode(n); } catch { continue; }
          if (!rangeIntersects(r, scopeRange)) continue;
        }
        nodes.push(n);
      }
    }
    return nodes;
  }

  function buildSearchIndex(scopeRange) {
    const nodes = collectTextNodes(scopeRange);
    const segments = [];
    let full = "";
    for (const node of nodes) {
      let start = 0;
      let end = node.nodeValue.length;
      if (scopeRange) {
        if (node === scopeRange.startContainer) start = scopeRange.startOffset;
        if (node === scopeRange.endContainer) end = scopeRange.endOffset;
      }
      const text = node.nodeValue.slice(start, end);
      if (!text) continue;
      segments.push({
        node,
        nodeStart: start,
        startInFull: full.length,
        endInFull: full.length + text.length,
      });
      full += text;
    }
    return { full, segments };
  }

  function buildRegex(query, opts) {
    if (!query) return null;
    let pattern = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (opts.wholeWord) pattern = `(?:^|\\b)(?:${pattern})(?:\\b|$)`;
    const flags = opts.matchCase ? "g" : "gi";
    try {
      return new RegExp(pattern, flags);
    } catch {
      return null;
    }
  }

  function findRangesWithRegex(regex) {
    const scope = state.findInSelection && state.selectionRange ? state.selectionRange : null;
    const { full, segments } = buildSearchIndex(scope);
    if (!full) return [];

    const ranges = [];
    let m;
    let segPtr = 0;
    while ((m = regex.exec(full)) !== null) {
      if (m[0].length === 0) {
        regex.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      while (segPtr < segments.length && segments[segPtr].endInFull <= start) segPtr++;
      const startSeg = segments[segPtr];
      let endSegIdx = segPtr;
      while (endSegIdx < segments.length && segments[endSegIdx].endInFull < end) endSegIdx++;
      const endSeg = segments[endSegIdx];
      if (!startSeg || !endSeg) break;
      try {
        const r = document.createRange();
        r.setStart(startSeg.node, startSeg.nodeStart + (start - startSeg.startInFull));
        r.setEnd(endSeg.node, endSeg.nodeStart + (end - endSeg.startInFull));
        ranges.push(r);
      } catch {}
    }
    return ranges;
  }

  const SKIP_INPUT_TYPES = new Set([
    "password", "hidden", "checkbox", "radio", "submit", "reset",
    "button", "file", "image", "color", "range",
  ]);

  function collectFields(scopeRange) {
    const fields = [];
    const seen = new Set();
    for (const root of collectSearchRoots(scopeRange)) {
      if (!root.querySelectorAll) continue;
      for (const el of root.querySelectorAll("input, textarea")) {
        if (!seen.has(el)) {
          seen.add(el);
          fields.push(el);
        }
      }
    }
    return fields;
  }

  function findFieldMatchesWithRegex(regex) {
    if (state.findInSelection) return [];
    const out = [];
    for (const el of collectFields(null)) {
      if (el.tagName === "INPUT" && SKIP_INPUT_TYPES.has(el.type)) continue;
      if (el.closest(`#${PANEL_ID}, #${HL_OVERLAY_ID}`)) continue;
      if (!isVisible(el)) continue;
      const value = el.value;
      if (!value) continue;
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(value)) !== null) {
        if (m[0].length === 0) {
          regex.lastIndex++;
          continue;
        }
        let anchorRange = null;
        try {
          anchorRange = document.createRange();
          anchorRange.selectNode(el);
        } catch {}
        out.push({
          type: "field",
          element: el,
          start: m.index,
          end: m.index + m[0].length,
          anchorRange,
        });
      }
    }
    return out;
  }

  function ensureOverlayRoot() {
    if (overlayRoot?.isConnected) return overlayRoot;
    overlayRoot = document.createElement("div");
    overlayRoot.id = HL_OVERLAY_ID;
    overlayRoot.setAttribute("data-super-search", "overlay");
    document.documentElement.appendChild(overlayRoot);
    return overlayRoot;
  }

  function clearOverlayHighlights() {
    if (overlayRoot) overlayRoot.replaceChildren();
    if (overlayScrollHandler) {
      window.removeEventListener("scroll", overlayScrollHandler, true);
      window.removeEventListener("resize", overlayScrollHandler);
      overlayScrollHandler = null;
    }
    clearTimeout(overlayRefreshTimer);
  }

  function addOverlayRects(root, range, className) {
    if (!range) return;
    let rects;
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

  function renderOverlayHighlights(allRanges, currentRange, scopeRange) {
    clearOverlayHighlights();
    if (!allRanges.length && !currentRange && !scopeRange) return;

    const root = ensureOverlayRoot();
    if (scopeRange) addOverlayRects(root, scopeRange, "ss-overlay-scope");
    for (const r of allRanges) addOverlayRects(root, r, "ss-overlay-match");
    addOverlayRects(root, currentRange, "ss-overlay-current");

    overlayScrollHandler = () => {
      clearTimeout(overlayRefreshTimer);
      overlayRefreshTimer = setTimeout(() => {
        if (supportsHighlights || !state.query) return;
        applyHighlights();
      }, TIMINGS.OVERLAY_REFRESH);
    };
    window.addEventListener("scroll", overlayScrollHandler, true);
    window.addEventListener("resize", overlayScrollHandler);
  }

  function applyHighlights() {
    clearFieldOutlines();

    if (supportsHighlights) {
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CUR);
      clearOverlayHighlights();
    }

    const allRanges = [];
    let currentRange = null;
    for (let i = 0; i < state.matches.length; i++) {
      const m = state.matches[i];
      const isCurrent = i === state.currentLocalIndex;
      if (m.type === "range") {
        if (isCurrent) currentRange = m.range;
        else allRanges.push(m.range);
      } else if (m.type === "field") {
        m.element.classList.add("ss-field-match");
        if (isCurrent) m.element.classList.add("ss-field-match-current");
        state.fieldMatchEls.add(m.element);
      }
    }

    const scopeRange = state.findInSelection && state.selectionRange ? state.selectionRange : null;

    if (supportsHighlights) {
      if (allRanges.length) {
        try {
          const h = new Highlight(...allRanges);
          h.priority = 1;
          CSS.highlights.set(HL_ALL, h);
        } catch {}
      }
      if (currentRange) {
        try {
          const h = new Highlight(currentRange);
          h.priority = 2;
          CSS.highlights.set(HL_CUR, h);
        } catch {}
      }
      if (scopeRange) {
        try {
          const h = new Highlight(scopeRange);
          h.priority = 0;
          CSS.highlights.set(HL_SCOPE, h);
        } catch {}
      } else {
        CSS.highlights.delete(HL_SCOPE);
      }
    } else {
      renderOverlayHighlights(allRanges, currentRange, scopeRange);
    }
  }

  function clearFieldOutlines() {
    for (const el of state.fieldMatchEls) {
      el.classList.remove("ss-field-match", "ss-field-match-current");
    }
    state.fieldMatchEls.clear();
  }

  function clearHighlights() {
    if (supportsHighlights) {
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CUR);
      CSS.highlights.delete(HL_SCOPE);
    }
    clearOverlayHighlights();
    clearFieldOutlines();
  }

  function runLocalSearch(opts = {}) {
    visibilityCache = new WeakMap();
    const prevLocal = opts.preserveLocalIndex ? state.currentLocalIndex : -1;

    const regex = buildRegex(state.query, state);
    if (!regex) {
      if (state.query) ui?.findWrap.classList.add("invalid");
      state.matches = [];
      state.currentLocalIndex = -1;
      applyHighlights();
      return;
    }
    ui?.findWrap.classList.remove("invalid");

    const ranges = findRangesWithRegex(regex);
    const fields = findFieldMatchesWithRegex(regex);

    const out = ranges.map((r) => ({ type: "range", range: r }));
    out.push(...fields);
    out.sort(compareMatchPosition);

    state.matches = out;
    if (opts.preserveLocalIndex && prevLocal >= 0 && out.length) {
      state.currentLocalIndex = Math.min(prevLocal, out.length - 1);
    } else {
      state.currentLocalIndex = out.length ? 0 : -1;
    }
    applyHighlights();
  }

  function compareMatchPosition(a, b) {
    const ra = a.type === "range" ? a.range : a.anchorRange;
    const rb = b.type === "range" ? b.range : b.anchorRange;
    if (!ra || !rb) return 0;
    try {
      return ra.compareBoundaryPoints(Range.START_TO_START, rb);
    } catch {
      return 0;
    }
  }

  function scrollIntoView(match) {
    if (!match) return;
    if (match.type === "range") {
      const rect = match.range.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > window.innerHeight || rect.left < 0 || rect.right > window.innerWidth) {
        const el = match.range.startContainer.parentElement;
        el?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
      }
    } else if (match.type === "field") {
      const rect = match.element.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > window.innerHeight || rect.left < 0 || rect.right > window.innerWidth) {
        match.element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
      }
      const active = document.activeElement;
      if (active === match.element || active === ui?.findInput) {
        try { match.element.setSelectionRange(match.start, match.end); } catch {}
      }
    }
  }

  function handleMutationRefresh() {
    if (!state.query) return;
    if (IS_TOP && state.open) {
      runDistributedSearch({ preservePosition: true });
      return;
    }
    if (!IS_TOP) {
      runLocalSearch({ preserveLocalIndex: true });
      const order = getFrameOrderFromMatches(state.matches);
      replyToTop({
        cmd: "count-update",
        count: state.matches.length,
        orderTop: order.top,
        orderLeft: order.left,
      });
      if (state.currentLocalIndex >= 0 && state.matches[state.currentLocalIndex]) {
        scrollIntoView(state.matches[state.currentLocalIndex]);
      }
    }
  }

  let mutationTimer = null;
  let mutationObserver = null;

  function startMutationObserver() {
    if (mutationObserver) return;
    mutationObserver = new MutationObserver(() => {
      if (!state.query) return;
      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(handleMutationRefresh, TIMINGS.MUTATION_DEBOUNCE);
    });
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function stopMutationObserver() {
    if (!mutationObserver) return;
    mutationObserver.disconnect();
    mutationObserver = null;
    clearTimeout(mutationTimer);
  }

  if (!IS_TOP) startMutationObserver();
})();
