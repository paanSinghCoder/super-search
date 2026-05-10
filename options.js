const KEYS = ["overrideNativeFind", "matchCase", "wholeWord", "regex"];
// Defaults applied when storage has no value yet.
const DEFAULTS = { overrideNativeFind: true, matchCase: false, wholeWord: false, regex: false };

function showSaved() {
  const el = document.getElementById("saved");
  el.classList.add("visible");
  clearTimeout(showSaved._t);
  showSaved._t = setTimeout(() => el.classList.remove("visible"), 1200);
}

chrome.storage.local.get(KEYS, (prefs) => {
  for (const k of KEYS) {
    const cb = document.getElementById(k);
    if (!cb) continue;
    cb.checked = prefs[k] === undefined ? !!DEFAULTS[k] : !!prefs[k];
    cb.addEventListener("change", () => {
      chrome.storage.local.set({ [k]: cb.checked }, showSaved);
    });
  }
});

