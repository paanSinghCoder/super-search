import type { AppState, PanelUI, SetCurrentPayload } from "../shared/types";
import { applyHighlights, clearHighlights } from "./highlights";
import { handleBroadcast, handleSubframeReply } from "./messaging";
import { initSubframeMutationObserver, startMutationObserver, stopMutationObserver } from "./mutation";
import { openPanel, updateCounter } from "./panel";
import { initFrameIdentity, initNativeFindOverride, initPreferences } from "./preferences";
import { createInitialState } from "./state";

export class ContentScriptApp {
  readonly isTop: boolean;
  readonly supportsHighlights: boolean;
  readonly state: AppState;

  ui: PanelUI | null = null;
  visibilityCache = new WeakMap<Element, boolean>();
  overlayRoot: HTMLDivElement | null = null;
  overlayScrollHandler: (() => void) | null = null;
  overlayRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  pendingSetCurrent: SetCurrentPayload | null = null;
  searchInputTimer: ReturnType<typeof setTimeout> | null = null;
  onDocumentKeydownRef: ((e: KeyboardEvent) => void) | null = null;
  onDocumentWheelRef: ((e: WheelEvent) => void) | null = null;
  mutationTimer: ReturnType<typeof setTimeout> | null = null;
  mutationObserver: MutationObserver | null = null;
  notificationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.isTop = window === window.top;
    this.supportsHighlights = typeof CSS !== "undefined" && !!CSS.highlights;
    this.state = createInitialState(this.isTop);
  }

  applyHighlights(): void {
    applyHighlights(this);
  }

  clearHighlights(): void {
    clearHighlights(this);
  }

  updateCounter(): void {
    updateCounter(this);
  }

  openPanel(): void {
    openPanel(this);
  }

  startMutationObserver(): void {
    startMutationObserver(this);
  }

  stopMutationObserver(): void {
    stopMutationObserver(this);
  }

  init(): void {
    initPreferences(this);
    initFrameIdentity(this);
    initNativeFindOverride(this);
    initSubframeMutationObserver(this);

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (this.isTop && msg.type === "super-search" && msg.action === "open") {
        this.openPanel();
        return;
      }
      if (msg.type === "ss-relay") {
        if (this.isTop && msg.fromFrameId === 0) return;
        handleBroadcast(this, msg.payload);
        return;
      }
      if (msg.type === "ss-relay-from-frame" && this.isTop) {
        handleSubframeReply(this, msg.payload, msg.fromFrameId);
      }
    });
  }
}
