const KEYS = ["overrideNativeFind", "matchCase", "wholeWord", "regex"] as const;
type PrefKey = (typeof KEYS)[number];

const DEFAULTS: Record<PrefKey, boolean> = {
  overrideNativeFind: true,
  matchCase: false,
  wholeWord: false,
  regex: false,
};

let savedTimer: ReturnType<typeof setTimeout> | null = null;

function showSaved(): void {
  const el = document.getElementById("saved");
  if (!el) return;
  el.classList.add("visible");
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove("visible"), 1200);
}

chrome.storage.local.get(KEYS, (prefs) => {
  for (const k of KEYS) {
    const cb = document.getElementById(k) as HTMLInputElement | null;
    if (!cb) continue;
    cb.checked = prefs[k] === undefined ? DEFAULTS[k] : !!prefs[k];
    cb.addEventListener("change", () => {
      chrome.storage.local.set({ [k]: cb.checked }, showSaved);
    });
  }
});
