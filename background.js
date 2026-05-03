const STORAGE_KEYS = {
  keywords: 'keywords',
  scanResults: 'scanResults',
  notifiedUrls: 'notifiedUrls'
};

const SITE_PATTERN = /^https:\/\/(www\.)?1lou\.me\//i;
const NOTIFICATION_PREFIX = '1lou-keyword-';
const notificationTargets = new Map();

function normalizeKeyword(keyword) {
  return String(keyword || '').trim().toLowerCase();
}

function isSupportedUrl(url) {
  return SITE_PATTERN.test(url || '');
}

function getStorage(keys) {
  return chrome.storage.local.get(keys);
}

async function getKeywords() {
  const { keywords = [] } = await getStorage([STORAGE_KEYS.keywords]);
  return keywords
    .map(normalizeKeyword)
    .filter(Boolean);
}

function findMatchedKeywords(title, keywords) {
  const normalizedTitle = String(title || '').toLowerCase();
  return keywords.filter((keyword) => normalizedTitle.includes(keyword));
}

async function updateBadge(tabId, count) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#ef4444' });
  await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(Math.min(count, 99)) : '' });
}

async function clearTabState(tabId) {
  const { scanResults = {}, notifiedUrls = {} } = await getStorage([
    STORAGE_KEYS.scanResults,
    STORAGE_KEYS.notifiedUrls
  ]);

  delete scanResults[String(tabId)];
  delete notifiedUrls[String(tabId)];

  await chrome.storage.local.set({
    [STORAGE_KEYS.scanResults]: scanResults,
    [STORAGE_KEYS.notifiedUrls]: notifiedUrls
  });
  await updateBadge(tabId, 0);
}

async function createNotification(tabId, newMatches) {
  if (!newMatches.length) {
    return;
  }

  const firstMatch = newMatches[0];
  const title = newMatches.length === 1
    ? `发现 1 条关键词命中: ${firstMatch.matchedKeywords.join(', ')}`
    : `发现 ${newMatches.length} 条新的关键词命中`;
  const message = newMatches
    .slice(0, 3)
    .map((item) => `• ${item.title}`)
    .join('\n');
  const notificationId = `${NOTIFICATION_PREFIX}${tabId}-${Date.now()}`;

  notificationTargets.set(notificationId, firstMatch.url);

  await chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title,
    message: message || firstMatch.title,
    priority: 1
  });
}

async function handleScanResult(tabId, payload) {
  const keywords = await getKeywords();
  const { scanResults = {}, notifiedUrls = {} } = await getStorage([
    STORAGE_KEYS.scanResults,
    STORAGE_KEYS.notifiedUrls
  ]);

  const matchedItems = (payload.items || [])
    .map((item) => ({
      ...item,
      matchedKeywords: findMatchedKeywords(item.title, keywords)
    }))
    .filter((item) => item.matchedKeywords.length > 0);

  const tabKey = String(tabId);
  const seenUrls = new Set(notifiedUrls[tabKey] || []);
  const newMatches = matchedItems.filter((item) => !seenUrls.has(item.url));

  scanResults[tabKey] = {
    pageUrl: payload.pageUrl,
    pageTitle: payload.pageTitle,
    scannedAt: payload.scannedAt,
    items: payload.items,
    matchedItems,
    attachments: payload.attachments || []
  };

  notifiedUrls[tabKey] = Array.from(new Set([
    ...Array.from(seenUrls),
    ...matchedItems.map((item) => item.url)
  ])).slice(-200);

  await chrome.storage.local.set({
    [STORAGE_KEYS.scanResults]: scanResults,
    [STORAGE_KEYS.notifiedUrls]: notifiedUrls
  });
  await updateBadge(tabId, matchedItems.length);

  if (keywords.length > 0 && newMatches.length > 0) {
    await createNotification(tabId, newMatches);
  }

  return scanResults[tabKey];
}

async function getTabState(tabId) {
  const { scanResults = {}, keywords = [] } = await getStorage([
    STORAGE_KEYS.scanResults,
    STORAGE_KEYS.keywords
  ]);

  return {
    keywords,
    scan: scanResults[String(tabId)] || null
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  const { keywords } = await getStorage([STORAGE_KEYS.keywords]);
  if (!Array.isArray(keywords)) {
    await chrome.storage.local.set({ [STORAGE_KEYS.keywords]: [] });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'scanResult') {
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ ok: false, error: 'Missing sender tab id.' });
      return false;
    }

    handleScanResult(tabId, message.payload)
      .then((scan) => sendResponse({ ok: true, scan }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'getState') {
    getTabState(message.tabId)
      .then((state) => sendResponse({ ok: true, ...state }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'saveKeywords') {
    const keywords = Array.from(new Set((message.keywords || [])
      .map(normalizeKeyword)
      .filter(Boolean)));

    chrome.storage.local.set({ [STORAGE_KEYS.keywords]: keywords })
      .then(async () => {
        if (typeof message.tabId === 'number') {
          try {
            await chrome.tabs.sendMessage(message.tabId, { type: 'rescan' });
          } catch (error) {
            if (!String(error.message || '').includes('Receiving end does not exist')) {
              throw error;
            }
          }
        }

        sendResponse({ ok: true, keywords });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'triggerRescan') {
    chrome.tabs.sendMessage(message.tabId, { type: 'rescan' })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabState(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url && !isSupportedUrl(tab.url)) {
    clearTabState(tabId).catch(() => {});
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  const targetUrl = notificationTargets.get(notificationId);
  if (!targetUrl) {
    return;
  }

  chrome.tabs.create({ url: targetUrl }).catch(() => {});
  chrome.notifications.clear(notificationId).catch(() => {});
  notificationTargets.delete(notificationId);
});

chrome.notifications.onClosed.addListener((notificationId) => {
  notificationTargets.delete(notificationId);
});