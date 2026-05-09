// Routes keyboard commands and cross-frame messages.

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  let action;
  if (command === "open-find") action = "open";
  else if (command === "open-find-replace") action = "open-replace";
  else return;

  // Send only to top frame — it owns the panel.
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "super-search", action }, { frameId: 0 });
  } catch (e) {}
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "super-search", action: "open" }, { frameId: 0 });
  } catch (e) {}
});

// Relay messages between frames in the same tab.
//   Top frame sends:  { type: "ss-broadcast", payload }   → relay to all frames in tab
//   Sub-frame sends:  { type: "ss-to-top",   payload }    → relay to top frame (frameId 0)
//   Any frame sends:  { type: "ss-whoami" }               → reply with { frameId } for that frame
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender.tab?.id) return false;
  const tabId = sender.tab.id;
  const fromFrameId = sender.frameId ?? 0;

  if (msg?.type === "ss-whoami") {
    sendResponse({ frameId: fromFrameId });
    return false;
  }

  if (msg?.type === "ss-broadcast") {
    chrome.tabs.sendMessage(tabId, {
      type: "ss-relay",
      fromFrameId,
      payload: msg.payload,
    }).catch(() => {});
  } else if (msg?.type === "ss-to-top") {
    chrome.tabs.sendMessage(tabId, {
      type: "ss-relay-from-frame",
      fromFrameId,
      payload: msg.payload,
    }, { frameId: 0 }).catch(() => {});
  }
  return false;
});
