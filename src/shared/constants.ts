export const PANEL_ID = "super-search-panel";
export const HL_OVERLAY_ID = "super-search-overlay-root";
export const HL_ALL = "super-search-match";
export const HL_CUR = "super-search-current";
export const HL_SCOPE = "super-search-scope";

export const TIMINGS = {
  AGGREGATE_FALLBACK: 300,
  AGGREGATE_REPLY: 50,
  MUTATION_DEBOUNCE: 250,
  SEARCH_DEBOUNCE: 80,
  NOTIFICATION_HIDE: 2000,
  OVERLAY_REFRESH: 16,
} as const;

export const PREF_KEYS = ["matchCase", "wholeWord", "regex", "overrideNativeFind"] as const;

export const SKIP_INPUT_TYPES = new Set([
  "password",
  "hidden",
  "checkbox",
  "radio",
  "submit",
  "reset",
  "button",
  "file",
  "image",
  "color",
  "range",
]);
