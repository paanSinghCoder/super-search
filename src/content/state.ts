import type { AppState } from "../shared/types";

export function createInitialState(isTop: boolean): AppState {
  return {
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
    myFrameId: isTop ? 0 : -1,
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
}
