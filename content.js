const THREAD_LINK_SELECTOR = 'a[href*="thread-"]';
let lastSignature = '';
let scheduledScan = null;

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function collectThreads() {
  const seenUrls = new Set();
  const items = [];

  document.querySelectorAll(THREAD_LINK_SELECTOR).forEach((link) => {
    const title = normalizeText(link.textContent);
    const url = link.href;

    if (!title || !url || seenUrls.has(url)) {
      return;
    }

    if (!/thread-\d+\.htm/i.test(url)) {
      return;
    }

    const container = link.closest('li, article, div');
    const forumLink = container?.querySelector('a[href^="forum-"]');
    const forumName = normalizeText(forumLink?.textContent || '');

    seenUrls.add(url);
    items.push({
      title,
      url,
      forumName
    });
  });

  return items;
}

function isThreadPage() {
  return /\/thread-\d+\.htm/i.test(window.location.pathname);
}

function collectAttachments() {
  if (!isThreadPage()) {
    return [];
  }

  const attachments = [];
  const seenUrls = new Set();

  document.querySelectorAll('a[href*="attach-download"]').forEach((link) => {
    const name = normalizeText(link.textContent);
    const url = link.href;

    if (!name || !url || seenUrls.has(url)) {
      return;
    }

    seenUrls.add(url);
    attachments.push({ name, url });
  });

  return attachments;
}

function buildPayload() {
  return {
    pageUrl: window.location.href,
    pageTitle: document.title,
    scannedAt: new Date().toISOString(),
    items: collectThreads(),
    attachments: collectAttachments()
  };
}

function computeSignature(payload) {
  const threadSig = payload.items.map((item) => `${item.url}|${item.title}`).join('\n');
  const attachSig = (payload.attachments || []).map((a) => a.url).join('\n');
  return `${threadSig}||${attachSig}`;
}

function sendScan(force = false) {
  const payload = buildPayload();
  const signature = computeSignature(payload);

  if (!force && signature === lastSignature) {
    return Promise.resolve({ ok: true, skipped: true, count: payload.items.length });
  }

  lastSignature = signature;

  return chrome.runtime.sendMessage({ type: 'scanResult', payload })
    .catch(() => ({ ok: false }));
}

function scheduleRescan(force = false) {
  window.clearTimeout(scheduledScan);
  scheduledScan = window.setTimeout(() => {
    sendScan(force);
  }, force ? 50 : 600);
}

const observer = new MutationObserver(() => {
  scheduleRescan(false);
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'rescan') {
    return false;
  }

  sendScan(true)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => scheduleRescan(true), { once: true });
} else {
  scheduleRescan(true);
}