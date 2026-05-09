const KEYS = ["overrideNativeFind", "matchCase", "wholeWord", "regex"];

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
    cb.checked = !!prefs[k];
    cb.addEventListener("change", () => {
      chrome.storage.local.set({ [k]: cb.checked }, showSaved);
    });
  }
});

document.getElementById("customizeShortcuts").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});
