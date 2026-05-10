(() => {
  if (window.__superSearchInjected) return;
  window.__superSearchInjected = true;

  const PANEL_ID = "super-search-panel";
  const HL_ALL = "super-search-match";
  const HL_CUR = "super-search-current";
  const HL_SCOPE = "super-search-scope";
  const IS_TOP = window === window.top;

  // ---------- shared state ----------
  const state = {
    // toggles (persisted in top frame, broadcast to subframes per-search)
    matchCase: false,
    wholeWord: false,
    regex: false,
    findInSelection: false,
    selectionRange: null,
    // Last non-collapsed selection on the page (captured before panel takes focus)
    savedSelectionRange: null,

    // local search state (per frame)
    query: "",
    // Unified match list. Each entry is one of:
    //   { type: "range", range: Range }                       — page DOM text / contenteditable
    //   { type: "field", element, start, end, isField }       — input / textarea value
    matches: [],
    currentLocalIndex: -1, // index into matches (-1 = none current here)
    fieldMatchEls: new Set(), // currently outlined field elements (for cleanup)

    // top-frame-only state
    open: false,
    overrideNativeFind: true, // Cmd/Ctrl+F opens SuperSearch by default; user can disable in options
    // Top frame is always 0. Subframes start at -1 until ss-whoami resolves —
    // commands targeted at a specific frameId are ignored until then to avoid
    // a race where an uninitialized subframe wrongly matches frameId 0.
    myFrameId: IS_TOP ? 0 : -1,
    frameCounts: new Map(), // frameId → count
    totalGlobal: 0,
    currentGlobalIdx: -1,
    currentFrameId: -1,
    searchNonce: 0,
    aggregateTimer: null,
  };

  let ui = null;

  // ---------- preferences ----------
  const PREF_KEYS = ["matchCase", "wholeWord", "regex", "overrideNativeFind"];
  chrome.storage?.local.get(PREF_KEYS, (prefs) => {
    if (!prefs) return;
    state.matchCase = !!prefs.matchCase;
    state.wholeWord = !!prefs.wholeWord;
    state.regex = !!prefs.regex;
    // Default ON unless explicitly disabled (undefined means user never touched it).
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

  // ---------- discover own frameId ----------
  // Subframes need this to recognize set-current commands targeted at them.
  // Top frame is always frameId 0.
  if (!IS_TOP) {
    try {
      chrome.runtime.sendMessage({ type: "ss-whoami" }, (reply) => {
        if (chrome.runtime.lastError) return;
        state.myFrameId = reply?.frameId ?? 0;
      });
    } catch {}
  }

  // ---------- top-frame: command listener (from background) ----------
  if (IS_TOP) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type !== "super-search") return;
      if (msg.action === "open") openPanel();
      else if (msg.action === "close") closePanel();
    });

    // Override Cmd/Ctrl+F if enabled
    window.addEventListener(
      "keydown",
      (e) => {
        if (!state.overrideNativeFind) return;
        const isMac = navigator.platform.toUpperCase().includes("MAC");
        const cmdKey = isMac ? e.metaKey : e.ctrlKey;
        if (cmdKey && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F")) {
          e.preventDefault();
          e.stopPropagation();
          openPanel(false);
        }
      },
      true
    );

    // Continuously capture the user's selection on the page so we still have it
    // after focus moves into the panel. Selections inside the panel itself or
    // collapsed selections are ignored.
    document.addEventListener("selectionchange", () => {
      // Don't clobber the saved scope while find-in-selection is active.
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

  // ---------- cross-frame relay listener (every frame) ----------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "ss-relay") {
      // Broadcast received. Skip if we sent it.
      if (IS_TOP && msg.fromFrameId === 0) return;
      handleBroadcast(msg.payload, msg.fromFrameId);
    } else if (msg?.type === "ss-relay-from-frame" && IS_TOP) {
      handleSubframeReply(msg.payload, msg.fromFrameId);
    }
  });

  function broadcast(payload) {
    chrome.runtime.sendMessage({ type: "ss-broadcast", payload }).catch(() => {});
  }

  function replyToTop(payload) {
    chrome.runtime.sendMessage({ type: "ss-to-top", payload }).catch(() => {});
  }

  function handleBroadcast(payload, fromFrameId) {
    if (payload.cmd === "search") {
      // sync our toggles with the broadcast and run local search
      state.query = payload.query;
      state.matchCase = !!payload.opts.matchCase;
      state.wholeWord = !!payload.opts.wholeWord;
      state.regex = !!payload.opts.regex;
      // findInSelection only applies to whichever frame initiated; subframes ignore
      state.findInSelection = false;
      state.selectionRange = null;
      runLocalSearch();
      replyToTop({ cmd: "count", nonce: payload.nonce, count: state.matches.length });
    } else if (payload.cmd === "set-current") {
      if (state.myFrameId < 0) return; // not yet identified
      if (payload.frameId === state.myFrameId) {
        state.currentLocalIndex = payload.indexInFrame;
        applyHighlights();
        if (state.matches[payload.indexInFrame]) scrollIntoView(state.matches[payload.indexInFrame]);
      } else {
        state.currentLocalIndex = -1;
        applyHighlights();
      }
    } else if (payload.cmd === "clear") {
      state.query = "";
      state.matches = [];
      state.currentLocalIndex = -1;
      clearHighlights();
    }
  }

  function handleSubframeReply(payload, fromFrameId) {
    if (payload.cmd === "count") {
      if (payload.nonce !== state.searchNonce) return; // stale
      state.frameCounts.set(fromFrameId, payload.count);
      // Reset the aggregate timer so late replies are still picked up.
      clearTimeout(state.aggregateTimer);
      state.aggregateTimer = setTimeout(() => finalizeSearch(payload.nonce), 50);
    }
  }

  // ---------- panel UI (top frame only) ----------
  function buildUI() {
    if (ui || !IS_TOP) return ui;
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.setAttribute("data-super-search", "panel");
    panel.innerHTML = `
      <div class="ss-row">
        <div class="ss-input-wrap" data-role="find-wrap">
          <input class="ss-input" data-role="find" type="text" placeholder="Find" spellcheck="false" autocomplete="off"/>
          <span class="ss-counter" data-role="counter"></span>
          <button class="ss-clear-btn" data-action="clear-find" type="button" title="Clear" aria-label="Clear find">
            <svg viewBox="0 0 16 16"><path d="M4.7 3.3l3.3 3.3 3.3-3.3 1.4 1.4L9.4 8l3.3 3.3-1.4 1.4L8 9.4l-3.3 3.3-1.4-1.4L6.6 8 3.3 4.7z"/></svg>
          </button>
        </div>
        <div class="ss-toggles">
          <button class="ss-toggle ss-toggle-case" data-toggle="matchCase" title="Match Case (Alt+C)">Aa</button>
          <button class="ss-toggle ss-toggle-ww" data-toggle="wholeWord" title="Match Whole Word (Alt+W)">ab</button>
          <button class="ss-toggle ss-toggle-regex" data-toggle="regex" title="Use Regular Expression (Alt+R)">.*</button>
          <button class="ss-toggle ss-toggle-sel" data-toggle="findInSelection" title="Find in Selection (Alt+L)">
            <svg class="ss-icon" viewBox="0 0 16 16"><path d="M2 3h5v1H3v9h4v1H2V3zm12 11H9v-1h4V4H9V3h5v11z"/></svg>
          </button>
        </div>
        <button class="ss-btn" data-action="prev" title="Previous Match (Shift+Enter)">
          <svg class="ss-icon" viewBox="0 0 16 16"><path d="M8 5.5l-4.5 4.5 1 1L8 7.5l3.5 3.5 1-1z"/></svg>
        </button>
        <button class="ss-btn" data-action="next" title="Next Match (Enter)">
          <svg class="ss-icon" viewBox="0 0 16 16"><path d="M8 10.5l-4.5-4.5 1-1L8 8.5l3.5-3.5 1 1z"/></svg>
        </button>
        <button class="ss-btn" data-action="close" title="Close (Escape)">
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
      runDistributedSearch();
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
    };

    syncToggleUI();
    return ui;
  }

  function syncToggleUI() {
    if (!ui) return;
    const map = {
      matchCase: ".ss-toggle-case",
      wholeWord: ".ss-toggle-ww",
      regex: ".ss-toggle-regex",
      findInSelection: ".ss-toggle-sel",
    };
    for (const [key, sel] of Object.entries(map)) {
      ui.panel.querySelector(sel)?.classList.toggle("active", !!state[key]);
    }
  }

  function onPanelKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      closePanel();
      return;
    }
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

  function toggle(key) {
    if (key === "findInSelection") {
      if (!state.findInSelection) {
        const range = pickSelectionRange();
        if (!range) {
          flashCounter("Select text first");
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
    runDistributedSearch();
  }

  // Return a usable selection Range, preferring a live page selection but
  // falling back to the most recent one we captured before the panel grabbed focus.
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
      // Validate that the range is still attached to the document.
      if (r.startContainer.isConnected && r.endContainer.isConnected) {
        try { return r.cloneRange(); } catch {}
      }
    }
    return null;
  }

  function openPanel() {
    if (!IS_TOP) return;
    buildUI();

    // Capture selection BEFORE focusing the find input, otherwise focus
    // moves into the input and clears the document selection.
    const sel = document.getSelection();
    const selStr = sel?.toString() ?? "";
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      try { state.savedSelectionRange = sel.getRangeAt(0).cloneRange(); } catch {}
    }

    state.open = true;
    ui.panel.classList.add("open");

    if (selStr.trim()) {
      if (selStr.includes("\n")) {
        // Multi-line: scope the search to it, like VS Code.
        const range = pickSelectionRange();
        if (range) {
          state.selectionRange = range;
          state.findInSelection = true;
          syncToggleUI();
        }
      } else {
        // Single-line: seed the query.
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
    clearHighlights();
    if (state.findInSelection) {
      state.findInSelection = false;
      state.selectionRange = null;
      syncToggleUI();
    }
    broadcast({ cmd: "clear" });
  }

  // ---------- distributed search orchestration (top frame only) ----------
  function runDistributedSearch() {
    if (!IS_TOP) return;

    // Cancel any pending aggregate
    clearTimeout(state.aggregateTimer);
    state.searchNonce++;
    const nonce = state.searchNonce;

    if (!state.query) {
      state.matches = [];
      state.currentLocalIndex = -1;
      state.totalGlobal = 0;
      state.currentGlobalIdx = -1;
      state.frameCounts.clear();
      // applyHighlights wipes match highlights but keeps the scope tint if
      // find-in-selection is active. clearHighlights would erase that too.
      applyHighlights();
      broadcast({ cmd: "clear" });
      updateCounter();
      return;
    }

    // Run own search synchronously
    runLocalSearch();
    state.frameCounts = new Map();
    state.frameCounts.set(0, state.matches.length);

    // Broadcast to subframes
    broadcast({
      cmd: "search",
      query: state.query,
      opts: { matchCase: state.matchCase, wholeWord: state.wholeWord, regex: state.regex },
      nonce,
    });

    // Aggregate after a short window for replies
    state.aggregateTimer = setTimeout(() => finalizeSearch(nonce), 300);

    // Show local results immediately for responsiveness
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

  function scheduleAggregate() {
    if (!state.aggregateTimer) return;
    // Replies are accumulating; the timer will fire and finalize.
  }

  function finalizeSearch(nonce) {
    if (nonce !== state.searchNonce) return;
    const total = [...state.frameCounts.values()].reduce((a, b) => a + b, 0);
    state.totalGlobal = total;
    if (total === 0) {
      state.currentGlobalIdx = -1;
      state.currentFrameId = -1;
      updateCounter();
      return;
    }
    // If we already set current to top-frame's first match, keep it.
    if (state.currentGlobalIdx < 0) {
      setCurrentGlobal(0);
    } else {
      // re-validate global index in case counts changed
      if (state.currentGlobalIdx >= total) setCurrentGlobal(0);
      else updateCounter();
    }
  }

  function frameOrder() {
    return [...state.frameCounts.keys()].sort((a, b) => a - b);
  }

  function setCurrentGlobal(globalIdx) {
    let acc = 0;
    let targetFrame = -1;
    let localIdx = -1;
    for (const fid of frameOrder()) {
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
    }, 2000);
  }
  // Backwards-compat alias used by older call sites.
  function flashCounter(msg) { showNotification(msg); }

  // ---------- local search engine (every frame) ----------
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest(`#${PANEL_ID}`)) return false;
    if (el.offsetParent === null) {
      const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
      if (!cs) return false;
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      if (cs.position !== "fixed") return false;
    }
    return true;
  }

  function rangeIntersects(a, b) {
    return (
      a.compareBoundaryPoints(Range.END_TO_START, b) < 0 &&
      a.compareBoundaryPoints(Range.START_TO_END, b) > 0
    );
  }

  function collectTextNodes(scopeRange) {
    const root = scopeRange ? scopeRange.commonAncestorContainer : document.body;
    if (!root) return [];

    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const parent = n.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA") {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest(`#${PANEL_ID}`)) return NodeFilter.FILTER_REJECT;
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
    return new RegExp(pattern, flags);
  }

  function findRanges() {
    if (!state.query) return [];
    let regex;
    try {
      regex = buildRegex(state.query, state);
    } catch (e) {
      ui?.findWrap.classList.add("invalid");
      return [];
    }
    ui?.findWrap.classList.remove("invalid");
    if (!regex) return [];

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

  function applyHighlights() {
    // Wipe previous field outlines before rebuilding.
    clearFieldOutlines();

    if (CSS.highlights) {
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CUR);
      // HL_SCOPE is refreshed below.
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

    if (CSS.highlights) {
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
      // Scope tint sits underneath the matches.
      if (state.findInSelection && state.selectionRange) {
        try {
          const h = new Highlight(state.selectionRange);
          h.priority = 0;
          CSS.highlights.set(HL_SCOPE, h);
        } catch {}
      } else {
        CSS.highlights.delete(HL_SCOPE);
      }
    }
  }

  function clearFieldOutlines() {
    for (const el of state.fieldMatchEls) {
      el.classList.remove("ss-field-match", "ss-field-match-current");
    }
    state.fieldMatchEls.clear();
  }

  function clearHighlights() {
    if (CSS.highlights) {
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CUR);
      CSS.highlights.delete(HL_SCOPE);
    }
    clearFieldOutlines();
  }

  function runLocalSearch() {
    state.matches = findAllMatches();
    state.currentLocalIndex = state.matches.length ? 0 : -1;
    applyHighlights();
  }

  // Combine DOM text matches and field (input/textarea) matches into a single
  // document-ordered list. Contenteditable text is already in the DOM tree, so
  // it's covered by findRanges and excluded from the field branch.
  function findAllMatches() {
    const out = [];
    for (const range of findRanges()) {
      out.push({ type: "range", range });
    }
    for (const fm of findFieldOnlyMatches()) {
      out.push(fm);
    }
    out.sort(compareMatchPosition);
    return out;
  }

  function compareMatchPosition(a, b) {
    const ra = matchAnchorRange(a);
    const rb = matchAnchorRange(b);
    if (!ra || !rb) return 0;
    try {
      return ra.compareBoundaryPoints(Range.START_TO_START, rb);
    } catch {
      return 0;
    }
  }

  function matchAnchorRange(m) {
    if (m.type === "range") return m.range;
    try {
      const r = document.createRange();
      r.selectNode(m.element);
      return r;
    } catch {
      return null;
    }
  }

  function findFieldOnlyMatches() {
    if (!state.query) return [];
    if (state.findInSelection) return []; // selection scope is DOM-only
    let regex;
    try {
      regex = buildRegex(state.query, state);
    } catch {
      return [];
    }
    if (!regex) return [];

    const out = [];
    const fields = document.querySelectorAll(
      'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="reset"]):not([type="button"]):not([type="file"]):not([type="image"]):not([type="color"]):not([type="range"]), textarea'
    );
    for (const el of fields) {
      if (el.closest(`#${PANEL_ID}`)) continue;
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
        out.push({
          type: "field",
          element: el,
          start: m.index,
          end: m.index + m[0].length,
          isField: true,
        });
      }
    }
    return out;
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
      // Position the caret on the match without stealing focus from the find box.
      try { match.element.setSelectionRange(match.start, match.end); } catch {}
    }
  }

  // ---------- DOM mutation observer (re-run on detach) ----------
  let mutationTimer = null;
  const observer = new MutationObserver(() => {
    if (!state.query) return;
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      const detached = state.matches.some((m) => {
        if (m.type === "range") return !m.range.startContainer.isConnected;
        return !m.element.isConnected;
      });
      if (detached) {
        if (IS_TOP && state.open) runDistributedSearch();
        else runLocalSearch();
      }
    }, 250);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
})();
