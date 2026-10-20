// Context menus + toolbar/shortcut entry points. Items to send are queued in chrome.storage.session;
// the side panel picks them up and hands them to the Handoff app it embeds.

const MENU_ITEMS = [
  { id: "send-selection", title: "Send selected text to phone", contexts: ["selection"] },
  { id: "send-link", title: "Send link to phone", contexts: ["link"] },
  { id: "send-image", title: "Send image to phone", contexts: ["image"] },
  { id: "send-page", title: "Send this page to phone", contexts: ["page"] },
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  chrome.contextMenus.removeAll(() => {
    for (const item of MENU_ITEMS) chrome.contextMenus.create(item);
  });
});

function itemFromMenuClick(info, tab) {
  switch (info.menuItemId) {
    case "send-selection":
      return { kind: "text", text: info.selectionText };
    case "send-link":
      return { kind: "text", text: info.linkUrl };
    case "send-page":
      return { kind: "text", text: tab?.url };
    case "send-image":
      return { kind: "image", srcUrl: info.srcUrl, tabId: tab?.id };
    default:
      return null;
  }
}

async function enqueue(item) {
  const { queue = [] } = await chrome.storage.session.get("queue");
  queue.push({ ...item, id: crypto.randomUUID(), at: Date.now() });
  await chrome.storage.session.set({ queue });
}

function openPanel(windowId) {
  // Must run synchronously inside the user gesture (menu click / shortcut)
  chrome.sidePanel.open({ windowId }).catch((err) => console.warn("Could not open side panel:", err));
}

export async function handleMenuClick(info, tab) {
  if (tab?.windowId !== undefined) openPanel(tab.windowId);
  const item = itemFromMenuClick(info, tab);
  if (item && (item.text || item.srcUrl)) await enqueue(item);
}

chrome.contextMenus.onClicked.addListener(handleMenuClick);

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "open-handoff" && tab?.windowId !== undefined) openPanel(tab.windowId);
});

// Exposed for automated tests (menus can't be clicked from a test runner)
self.handleMenuClick = handleMenuClick;
