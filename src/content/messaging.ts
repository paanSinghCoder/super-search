import { TIMINGS } from "../shared/constants";
import type { BroadcastPayload, DistributedSearchOptions, SetCurrentOptions, SetCurrentPayload, SubframePayload } from "../shared/types";
import type { ContentScriptApp } from "./app";
import { getFrameOrderFromMatches, isThisFrameVisible, scrollMatchIntoView } from "./dom";
import { clearHighlights } from "./highlights";
import { runLocalSearch } from "./search";

export function broadcast(payload: BroadcastPayload): void {
  chrome.runtime.sendMessage({ type: "ss-broadcast", payload }).catch(() => {});
}

export function replyToTop(payload: SubframePayload): void {
  chrome.runtime.sendMessage({ type: "ss-to-top", payload }).catch(() => {});
}

function storeFrameOrder(app: ContentScriptApp, frameId: number, orderTop?: number, orderLeft?: number): void {
  if (orderTop === undefined) return;
  app.state.frameOrder.set(frameId, { top: orderTop, left: orderLeft ?? 0 });
}

function sumFrameCounts(app: ContentScriptApp): number {
  return [...app.state.frameCounts.values()].reduce((a, b) => a + b, 0);
}

function sortedFrameIds(app: ContentScriptApp): number[] {
  return [...app.state.frameCounts.keys()].sort((a, b) => {
    const oa = app.state.frameOrder.get(a) ?? { top: a * 1e6, left: 0 };
    const ob = app.state.frameOrder.get(b) ?? { top: b * 1e6, left: 0 };
    if (oa.top !== ob.top) return oa.top - ob.top;
    if (oa.left !== ob.left) return oa.left - ob.left;
    return a - b;
  });
}

function applySetCurrent(app: ContentScriptApp, payload: SetCurrentPayload): void {
  if (payload.frameId === app.state.myFrameId) {
    app.state.currentLocalIndex = payload.indexInFrame;
    app.applyHighlights();
    if (payload.scroll !== false && app.state.matches[payload.indexInFrame]) {
      scrollMatchIntoView(app, app.state.matches[payload.indexInFrame]);
    }
  } else {
    app.state.currentLocalIndex = -1;
    app.applyHighlights();
  }
}

export { applySetCurrent };

function handleSetCurrent(app: ContentScriptApp, payload: SetCurrentPayload): void {
  if (app.state.myFrameId < 0) {
    app.pendingSetCurrent = payload;
    return;
  }
  applySetCurrent(app, payload);
}

export function handleBroadcast(app: ContentScriptApp, payload: BroadcastPayload): void {
  if (payload.cmd === "search") {
    app.state.query = payload.query;
    app.state.matchCase = !!payload.opts.matchCase;
    app.state.wholeWord = !!payload.opts.wholeWord;
    app.state.regex = !!payload.opts.regex;
    app.state.findInSelection = false;
    app.state.selectionRange = null;
    if (!isThisFrameVisible(app)) {
      app.state.matches = [];
      app.state.currentLocalIndex = -1;
      clearHighlights(app);
      replyToTop({
        cmd: "count",
        nonce: payload.nonce,
        count: 0,
        orderTop: Infinity,
        orderLeft: Infinity,
      });
      return;
    }
    runLocalSearch(app);
    const order = getFrameOrderFromMatches(app, app.state.matches);
    replyToTop({
      cmd: "count",
      nonce: payload.nonce,
      count: app.state.matches.length,
      orderTop: order.top,
      orderLeft: order.left,
    });
  } else if (payload.cmd === "set-current") {
    handleSetCurrent(app, payload);
  } else if (payload.cmd === "clear") {
    app.state.query = "";
    app.state.matches = [];
    app.state.currentLocalIndex = -1;
    clearHighlights(app);
  }
}

export function handleSubframeReply(app: ContentScriptApp, payload: SubframePayload, fromFrameId: number): void {
  if (payload.cmd !== "count" && payload.cmd !== "count-update") return;
  if (payload.cmd === "count" && payload.nonce !== app.state.searchNonce) return;
  if (payload.cmd === "count-update") {
    if (!app.state.open || !app.state.query) return;
    if (!app.state.frameCounts.has(fromFrameId)) return;
  }

  app.state.frameCounts.set(fromFrameId, payload.count);
  storeFrameOrder(app, fromFrameId, payload.orderTop, payload.orderLeft);

  if (payload.cmd === "count") {
    if (app.state.aggregateTimer) clearTimeout(app.state.aggregateTimer);
    app.state.aggregateTimer = setTimeout(
      () => finalizeSearch(app, payload.nonce),
      TIMINGS.AGGREGATE_REPLY,
    );
    return;
  }

  const total = sumFrameCounts(app);
  app.state.totalGlobal = total;
  if (total === 0) {
    app.state.currentGlobalIdx = -1;
    app.state.currentFrameId = -1;
  } else if (app.state.currentGlobalIdx >= total) {
    setCurrentGlobal(app, total - 1, { scroll: false });
  } else if (app.state.currentGlobalIdx < 0) {
    setCurrentGlobal(app, 0, { scroll: false });
  }
  app.updateCounter();
}

export function runDistributedSearch(app: ContentScriptApp, opts: DistributedSearchOptions = {}): void {
  if (!app.isTop) return;

  if (app.state.aggregateTimer) clearTimeout(app.state.aggregateTimer);
  app.state.searchNonce++;
  const nonce = app.state.searchNonce;
  app.state.preserveGlobalIdx = opts.preservePosition ? app.state.currentGlobalIdx : -1;

  if (!app.state.query) {
    app.state.matches = [];
    app.state.currentLocalIndex = -1;
    app.state.totalGlobal = 0;
    app.state.currentGlobalIdx = -1;
    app.state.frameCounts.clear();
    app.state.frameOrder.clear();
    app.applyHighlights();
    broadcast({ cmd: "clear" });
    app.updateCounter();
    return;
  }

  runLocalSearch(app, { preserveLocalIndex: opts.preservePosition });
  app.state.frameCounts = new Map();
  app.state.frameOrder = new Map();
  app.state.frameCounts.set(0, app.state.matches.length);
  app.state.frameOrder.set(0, getFrameOrderFromMatches(app, app.state.matches));

  broadcast({
    cmd: "search",
    query: app.state.query,
    opts: {
      matchCase: app.state.matchCase,
      wholeWord: app.state.wholeWord,
      regex: app.state.regex,
    },
    nonce,
  });

  app.state.aggregateTimer = setTimeout(() => finalizeSearch(app, nonce), TIMINGS.AGGREGATE_FALLBACK);

  if (!opts.preservePosition) {
    if (app.state.matches.length) {
      app.state.currentLocalIndex = 0;
      app.applyHighlights();
      scrollMatchIntoView(app, app.state.matches[0]);
      app.state.currentGlobalIdx = 0;
      app.state.currentFrameId = 0;
    } else {
      app.state.currentLocalIndex = -1;
      app.applyHighlights();
      app.state.currentGlobalIdx = -1;
      app.state.currentFrameId = -1;
    }
    app.state.totalGlobal = app.state.matches.length;
    app.updateCounter();
  }
}

function finalizeSearch(app: ContentScriptApp, nonce: number): void {
  if (nonce !== app.state.searchNonce) return;
  const total = sumFrameCounts(app);
  app.state.totalGlobal = total;
  const preserve = app.state.preserveGlobalIdx;
  app.state.preserveGlobalIdx = -1;

  if (total === 0) {
    app.state.currentGlobalIdx = -1;
    app.state.currentFrameId = -1;
    app.updateCounter();
    return;
  }

  if (preserve >= 0 && preserve < total && preserve !== app.state.currentGlobalIdx) {
    setCurrentGlobal(app, preserve, { scroll: false });
  } else if (app.state.currentGlobalIdx < 0 || app.state.currentGlobalIdx >= total) {
    setCurrentGlobal(app, 0);
  } else {
    app.updateCounter();
  }
}

export function setCurrentGlobal(app: ContentScriptApp, globalIdx: number, opts: SetCurrentOptions = {}): void {
  let acc = 0;
  let targetFrame = -1;
  let localIdx = -1;
  for (const fid of sortedFrameIds(app)) {
    const count = app.state.frameCounts.get(fid) ?? 0;
    if (globalIdx < acc + count) {
      targetFrame = fid;
      localIdx = globalIdx - acc;
      break;
    }
    acc += count;
  }
  if (targetFrame < 0) return;
  app.state.currentGlobalIdx = globalIdx;
  app.state.currentFrameId = targetFrame;

  if (targetFrame === 0) {
    app.state.currentLocalIndex = localIdx;
    app.applyHighlights();
    if (opts.scroll !== false && app.state.matches[localIdx]) {
      scrollMatchIntoView(app, app.state.matches[localIdx]);
    }
  } else {
    app.state.currentLocalIndex = -1;
    app.applyHighlights();
  }
  broadcast({
    cmd: "set-current",
    frameId: targetFrame,
    indexInFrame: localIdx,
    scroll: opts.scroll !== false,
  });
  app.updateCounter();
}

export function navigate(app: ContentScriptApp, dir: number): void {
  if (app.state.totalGlobal === 0) return;
  if (app.state.aggregateTimer) clearTimeout(app.state.aggregateTimer);
  app.state.aggregateTimer = null;
  app.state.preserveGlobalIdx = -1;
  const next = (app.state.currentGlobalIdx + dir + app.state.totalGlobal) % app.state.totalGlobal;
  setCurrentGlobal(app, next);
}
