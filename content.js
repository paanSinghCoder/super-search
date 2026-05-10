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
    editableMatches: [],
    currentLocalIndex: -1, // index into matches (-1 = none current here)
    fieldMatchEls: new Set(), // currently outlined field elements (for cleanup)

    // top-frame-only state
    open: false,
    replaceVisible: false,
    overrideNativeFind: true, // Cmd/Ctrl+F opens SuperSearch by default; user can disable in options
    replacement: "",
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
    position: null, // {x, y} or null = default
  };

  let ui = null;

  // ---------- preferences ----------
  const PREF_KEYS = ["matchCase", "wholeWord", "regex", "overrideNativeFind", "panelPosition"];
  chrome.storage?.local.get(PREF_KEYS, (prefs) => {
    if (!prefs) return;
    state.matchCase = !!prefs.matchCase;
    state.wholeWord = !!prefs.wholeWord;
    state.regex = !!prefs.regex;
    // Default ON unless explicitly disabled (undefined means user never touched it).
    state.overrideNativeFind = prefs.overrideNativeFind !== false;
    state.position = prefs.panelPosition || null;
    if (ui) {
      syncToggleUI();
      applyPanelPosition();
    }
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
      if (msg.action === "open") openPanel(false);
      else if (msg.action === "open-replace") openPanel(true);
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
      state.editableMatches = [];
      state.currentLocalIndex = -1;
      clearHighlights();
    } else if (payload.cmd === "replace-all") {
      state.replacement = payload.replacement;
      const replaced = doReplaceAll();
      replyToTop({ cmd: "replaced", count: replaced });
      runLocalSearch();
      replyToTop({ cmd: "count", nonce: payload.nonce, count: state.matches.length });
    } else if (payload.cmd === "replace-current") {
      if (state.myFrameId < 0) return;
      // only the frame holding the current match should act
      if (payload.frameId === state.myFrameId) {
        state.replacement = payload.replacement;
        doReplaceCurrent();
        runLocalSearch();
        replyToTop({ cmd: "count", nonce: payload.nonce, count: state.matches.length });
      }
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
      <div class="ss-row" data-role="drag-row">
        <button class="ss-btn ss-toggle-replace" title="Toggle Replace (Cmd/Ctrl+Shift+H)" data-action="toggle-replace">
          <svg class="ss-icon" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4V4z"/></svg>
        </button>
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
      <div class="ss-row ss-replace-row">
        <span class="ss-grid-spacer"></span>
        <div class="ss-input-wrap">
          <input class="ss-input" data-role="replace" type="text" placeholder="Replace" spellcheck="false" autocomplete="off"/>
          <span class="ss-replace-info" data-role="replace-info"></span>
          <button class="ss-clear-btn" data-action="clear-replace" type="button" title="Clear" aria-label="Clear replace">
            <svg viewBox="0 0 16 16"><path d="M4.7 3.3l3.3 3.3 3.3-3.3 1.4 1.4L9.4 8l3.3 3.3-1.4 1.4L8 9.4l-3.3 3.3-1.4-1.4L6.6 8 3.3 4.7z"/></svg>
          </button>
        </div>
        <span class="ss-grid-spacer"></span>
        <button class="ss-btn" data-action="replace-one" title="Replace (Enter in replace box)">
          <svg class="ss-icon" viewBox="0 0 16 16"><path d="M3 3h6v2h2V3a2 2 0 00-2-2H3a2 2 0 00-2 2v6a2 2 0 002 2h2v-2H3V3zm10 4H7a2 2 0 00-2 2v6a2 2 0 002 2h6a2 2 0 002-2V9a2 2 0 00-2-2zm0 8H7V9h6v6z"/></svg>
        </button>
        <button class="ss-btn" data-action="replace-all" title="Replace All (Cmd/Ctrl+Alt+Enter)">
          <svg class="ss-icon" viewBox="0 0 16 16"><path d="M2 2h6v2h2V2a2 2 0 00-2-2H2a2 2 0 00-2 2v6a2 2 0 002 2h2V8H2V2zm10 5H6a2 2 0 00-2 2v5a2 2 0 002 2h6a2 2 0 002-2V9a2 2 0 00-2-2zm0 7H6V9h6v5zm-4-3h2v1H8v-1z"/></svg>
        </button>
        <span class="ss-grid-spacer"></span>
      </div>
      <div class="ss-hint ss-replace-hint">
        <svg class="ss-icon ss-hint-icon" viewBox="0 0 16 16"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm0 1a5.5 5.5 0 110 11 5.5 5.5 0 010-11zm0 2.25a.75.75 0 110 1.5.75.75 0 010-1.5zM7.25 7.5h1.5v4.25h-1.5V7.5z"/></svg>
        <span>Replace affects editable fields only.</span>
      </div>
      <div class="ss-notification" data-role="notification">
        <svg class="ss-icon ss-notification-icon" viewBox="0 0 16 16"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm0 1a5.5 5.5 0 110 11 5.5 5.5 0 010-11zm0 2.25a.75.75 0 110 1.5.75.75 0 010-1.5zM7.25 7.5h1.5v4.25h-1.5V7.5z"/></svg>
        <span class="ss-notification-text" data-role="notification-text"></span>
      </div>
    `;
    document.documentElement.appendChild(panel);

    const findInput = panel.querySelector('[data-role="find"]');
    const replaceInput = panel.querySelector('[data-role="replace"]');

    findInput.addEventListener("input", () => {
      state.query = findInput.value;
      runDistributedSearch();
    });
    replaceInput.addEventListener("input", () => {
      state.replacement = replaceInput.value;
      updateReplaceInfo();
    });

    panel.addEventListener("click", (e) => {
      const t = e.target.closest("[data-action], [data-toggle]");
      if (!t) return;
      const act = t.dataset.action;
      const tog = t.dataset.toggle;
      if (act === "close") closePanel();
      else if (act === "next") navigate(1);
      else if (act === "prev") navigate(-1);
      else if (act === "toggle-replace") setReplaceVisible(!state.replaceVisible);
      else if (act === "replace-one") replaceCurrent();
      else if (act === "replace-all") replaceAll();
      else if (act === "clear-find") {
        ui.findInput.value = "";
        state.query = "";
        runDistributedSearch();
        ui.findInput.focus();
      }
      else if (act === "clear-replace") {
        ui.replaceInput.value = "";
        state.replacement = "";
        updateReplaceInfo();
        ui.replaceInput.focus();
      }
      if (tog) toggle(tog);
    });

    panel.addEventListener("keydown", onPanelKeydown, true);

    ui = {
      panel,
      findInput,
      replaceInput,
      counter: panel.querySelector('[data-role="counter"]'),
      findWrap: panel.querySelector('[data-role="find-wrap"]'),
      replaceInfo: panel.querySelector('[data-role="replace-info"]'),
      dragRow: panel.querySelector('[data-role="drag-row"]'),
      notification: panel.querySelector('[data-role="notification"]'),
      notificationText: panel.querySelector('[data-role="notification-text"]'),
    };

    setupDrag();
    syncToggleUI();
    applyPanelPosition();
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

  function applyPanelPosition() {
    if (!ui) return;
    const p = state.position;
    if (!p) {
      ui.panel.style.left = "";
      ui.panel.style.right = "";
      ui.panel.style.top = "";
      return;
    }
    // Clamp into viewport
    const w = ui.panel.offsetWidth || 360;
    const h = ui.panel.offsetHeight || 36;
    const x = Math.max(0, Math.min(window.innerWidth - w, p.x));
    const y = Math.max(0, Math.min(window.innerHeight - h, p.y));
    ui.panel.style.left = `${x}px`;
    ui.panel.style.top = `${y}px`;
    ui.panel.style.right = "auto";
  }

  function setupDrag() {
    if (!ui) return;
    let dragging = false;
    let startX = 0, startY = 0, origX = 0, origY = 0;

    ui.panel.addEventListener("pointerdown", (e) => {
      // Only initiate drag from non-interactive elements in the panel
      const isInteractive = e.target.closest("input, button, .ss-toggle");
      if (isInteractive) return;
      const rect = ui.panel.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      dragging = true;
      ui.panel.setPointerCapture(e.pointerId);
      ui.panel.style.cursor = "grabbing";
    });

    ui.panel.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const w = ui.panel.offsetWidth;
      const h = ui.panel.offsetHeight;
      const x = Math.max(0, Math.min(window.innerWidth - w, origX + dx));
      const y = Math.max(0, Math.min(window.innerHeight - h, origY + dy));
      ui.panel.style.left = `${x}px`;
      ui.panel.style.top = `${y}px`;
      ui.panel.style.right = "auto";
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      ui.panel.style.cursor = "";
      try { ui.panel.releasePointerCapture(e.pointerId); } catch {}
      const rect = ui.panel.getBoundingClientRect();
      state.position = { x: Math.round(rect.left), y: Math.round(rect.top) };
      chrome.storage?.local.set({ panelPosition: state.position });
    }
    ui.panel.addEventListener("pointerup", endDrag);
    ui.panel.addEventListener("pointercancel", endDrag);

    window.addEventListener("resize", applyPanelPosition);
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
    if (e.target === ui.replaceInput && e.key === "Enter" && !e.shiftKey && !(e.metaKey || e.ctrlKey || e.altKey)) {
      e.preventDefault();
      replaceCurrent();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.altKey && e.key === "Enter") {
      e.preventDefault();
      replaceAll();
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

  function setReplaceVisible(v) {
    state.replaceVisible = v;
    if (!ui) return;
    ui.panel.classList.toggle("replace-open", v);
    if (v) ui.replaceInput.focus();
    else ui.findInput.focus();
    updateReplaceInfo();
  }

  function openPanel(withReplace) {
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
    setReplaceVisible(!!withReplace);
    applyPanelPosition();

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
      updateReplaceInfo();
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
    updateReplaceInfo();
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

  function updateReplaceInfo() {
    if (!ui) return;
    if (!state.replaceVisible) {
      ui.replaceInfo.textContent = "";
      return;
    }
    const total = state.editableMatches.reduce((s, e) => s + e.matches.length, 0);
    const fields = state.editableMatches.length;
    if (!total) {
      ui.replaceInfo.textContent = "0 in editables";
    } else {
      ui.replaceInfo.textContent = `${total} in ${fields} field${fields === 1 ? "" : "s"}`;
    }
  }

  // ---------- replace orchestration ----------
  function replaceCurrent() {
    if (!IS_TOP) return;
    if (!state.replaceVisible) {
      setReplaceVisible(true);
      return;
    }
    if (state.totalGlobal === 0) {
      flashCounter("No matches");
      return;
    }
    if (state.currentFrameId === 0) {
      doReplaceCurrent();
      runDistributedSearch();
    } else {
      // ask the holding frame to replace its current match
      broadcast({
        cmd: "replace-current",
        frameId: state.currentFrameId,
        replacement: state.replacement,
        nonce: state.searchNonce,
      });
      // after sub-frame replaces and re-counts, re-aggregate
      setTimeout(() => runDistributedSearch(), 50);
    }
  }

  function replaceAll() {
    if (!IS_TOP) return;
    if (!state.replaceVisible) {
      setReplaceVisible(true);
      return;
    }
    state.searchNonce++;
    const nonce = state.searchNonce;
    let totalReplaced = doReplaceAll();
    broadcast({ cmd: "replace-all", replacement: state.replacement, nonce });

    // We'll re-aggregate after a window
    clearTimeout(state.aggregateTimer);
    state.frameCounts = new Map();
    runLocalSearch();
    state.frameCounts.set(0, state.matches.length);

    state.aggregateTimer = setTimeout(() => {
      finalizeSearch(nonce);
      flashCounter(`Replaced ${totalReplaced}+`);
    }, 300);

    state.totalGlobal = state.matches.length;
    state.currentLocalIndex = state.matches.length ? 0 : -1;
    state.currentGlobalIdx = state.matches.length ? 0 : -1;
    state.currentFrameId = state.matches.length ? 0 : -1;
    applyHighlights();
    updateCounter();
    updateReplaceInfo();
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

  function findEditableMatches() {
    if (!state.query) return [];
    let regex;
    try { regex = buildRegex(state.query, state); } catch { return []; }
    if (!regex) return [];

    const out = [];
    const editables = document.querySelectorAll(
      'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="reset"]):not([type="button"]):not([type="file"]):not([type="image"]):not([type="color"]):not([type="range"]), textarea, [contenteditable=""], [contenteditable="true"]'
    );

    for (const el of editables) {
      if (el.closest(`#${PANEL_ID}`)) continue;
      if (!isVisible(el)) continue;
      const isField = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
      const value = isField ? el.value : el.textContent;
      if (!value) continue;
      regex.lastIndex = 0;
      let m;
      const matches = [];
      while ((m = regex.exec(value)) !== null) {
        if (m[0].length === 0) { regex.lastIndex++; continue; }
        matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
      }
      if (matches.length) out.push({ element: el, matches, isField });
    }
    return out;
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
    state.editableMatches = findEditableMatches();
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

  // ---------- replace primitives (every frame) ----------
  function doReplaceCurrent() {
    if (!state.editableMatches.length) return 0;
    const focused = document.activeElement;
    let target = state.editableMatches.find((e) => e.element === focused);
    if (!target) target = state.editableMatches[0];
    const first = target.matches[0];
    replaceInElement(target.element, target.isField, first.start, first.end, state.replacement);
    return 1;
  }

  function doReplaceAll() {
    if (!state.editableMatches.length) return 0;
    let total = 0;
    for (const entry of state.editableMatches) {
      const { element, matches, isField } = entry;
      if (isField) {
        let value = element.value;
        for (let i = matches.length - 1; i >= 0; i--) {
          const m = matches[i];
          value = value.slice(0, m.start) + state.replacement + value.slice(m.end);
          total++;
        }
        setFieldValue(element, value);
      } else {
        replaceInContentEditable(element, matches, state.replacement);
        total += matches.length;
      }
    }
    return total;
  }

  function replaceInElement(el, isField, start, end, replacement) {
    if (isField) {
      const v = el.value;
      setFieldValue(el, v.slice(0, start) + replacement + v.slice(end));
    } else {
      replaceInContentEditable(el, [{ start, end }], replacement);
    }
  }

  function setFieldValue(el, newVal) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, newVal);
    else el.value = newVal;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function replaceInContentEditable(el, matches, replacement) {
    const nodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) nodes.push(n);

    const segs = [];
    let full = "";
    for (const node of nodes) {
      segs.push({ node, start: full.length, end: full.length + node.nodeValue.length });
      full += node.nodeValue;
    }

    const sorted = [...matches].sort((a, b) => b.start - a.start);
    for (const m of sorted) {
      const startSeg = segs.find((s) => s.start <= m.start && m.start < s.end);
      const endSeg = segs.find((s) => s.start < m.end && m.end <= s.end);
      if (!startSeg || !endSeg) continue;
      const range = document.createRange();
      try {
        range.setStart(startSeg.node, m.start - startSeg.start);
        range.setEnd(endSeg.node, m.end - endSeg.start);
        range.deleteContents();
        range.insertNode(document.createTextNode(replacement));
      } catch {}
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
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
