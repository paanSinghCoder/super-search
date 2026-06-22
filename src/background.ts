chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "super-search", action: "open" }, { frameId: 0 });
  } catch {
    // Content script may not be injected on this page.
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender.tab?.id) return false;
  const tabId = sender.tab.id;
  const fromFrameId = sender.frameId ?? 0;

  if (msg?.type === "ss-whoami") {
    sendResponse({ frameId: fromFrameId });
    return false;
  }

  if (msg?.type === "ss-broadcast") {
    chrome.tabs
      .sendMessage(tabId, {
        type: "ss-relay",
        fromFrameId,
        payload: msg.payload,
      })
      .catch(() => {});
  } else if (msg?.type === "ss-to-top") {
    chrome.tabs
      .sendMessage(
        tabId,
        {
          type: "ss-relay-from-frame",
          fromFrameId,
          payload: msg.payload,
        },
        { frameId: 0 },
      )
      .catch(() => {});
  }
  return false;
});
