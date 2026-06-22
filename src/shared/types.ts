export type ToggleKey = "matchCase" | "wholeWord" | "regex" | "findInSelection";

export interface SearchOpts {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface FramePosition {
  top: number;
  left: number;
}

export interface RangeMatch {
  type: "range";
  range: Range;
}

export interface FieldMatch {
  type: "field";
  element: HTMLInputElement | HTMLTextAreaElement;
  start: number;
  end: number;
  anchorRange: Range | null;
}

export type Match = RangeMatch | FieldMatch;

export interface TextSegment {
  node: Text;
  nodeStart: number;
  startInFull: number;
  endInFull: number;
}

export interface SearchIndex {
  full: string;
  segments: TextSegment[];
}

export type BroadcastPayload =
  | { cmd: "search"; query: string; opts: SearchOpts; nonce: number }
  | { cmd: "set-current"; frameId: number; indexInFrame: number; scroll?: boolean }
  | { cmd: "clear" };

export type SubframePayload =
  | { cmd: "count"; nonce: number; count: number; orderTop: number; orderLeft: number }
  | { cmd: "count-update"; count: number; orderTop: number; orderLeft: number };

export interface SetCurrentPayload {
  frameId: number;
  indexInFrame: number;
  scroll?: boolean;
}

export interface PanelUI {
  panel: HTMLDivElement;
  findInput: HTMLInputElement;
  counter: HTMLSpanElement;
  findWrap: HTMLDivElement;
  notification: HTMLDivElement;
  notificationText: HTMLSpanElement;
  toggles: Record<ToggleKey, HTMLButtonElement | null>;
}

export interface AppState {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  findInSelection: boolean;
  selectionRange: Range | null;
  savedSelectionRange: Range | null;
  query: string;
  matches: Match[];
  currentLocalIndex: number;
  fieldMatchEls: Set<HTMLInputElement | HTMLTextAreaElement>;
  open: boolean;
  overrideNativeFind: boolean;
  myFrameId: number;
  frameCounts: Map<number, number>;
  frameOrder: Map<number, FramePosition>;
  totalGlobal: number;
  currentGlobalIdx: number;
  currentFrameId: number;
  searchNonce: number;
  aggregateTimer: ReturnType<typeof setTimeout> | null;
  preserveGlobalIdx: number;
  warnedNoHighlights: boolean;
}

export interface LocalSearchOptions {
  preserveLocalIndex?: boolean;
}

export interface DistributedSearchOptions {
  preservePosition?: boolean;
}

export interface SetCurrentOptions {
  scroll?: boolean;
}
