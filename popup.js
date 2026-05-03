const state = {
  activeTabId: null,
  keywords: [],
  scan: null,
  filter: 'matched'
};

const elements = {
  keywordsInput: document.getElementById('keywordsInput'),
  saveButton: document.getElementById('saveButton'),
  saveStatus: document.getElementById('saveStatus'),
  rescanButton: document.getElementById('rescanButton'),
  pageMeta: document.getElementById('pageMeta'),
  matchCount: document.getElementById('matchCount'),
  itemCount: document.getElementById('itemCount'),
  resultsList: document.getElementById('resultsList'),
  emptyState: document.getElementById('emptyState'),
  attachPanel: document.getElementById('attachPanel'),
  attachList: document.getElementById('attachList'),
  keywordsToggle: document.getElementById('keywordsToggle'),
  keywordsBody: document.getElementById('keywordsBody'),
  filterButtons: Array.from(document.querySelectorAll('[data-filter]'))
};

function splitKeywords(input) {
  return Array.from(new Set(String(input || '')
    .split(/[\n,，]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean)));
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function syncActiveTab() {
  const activeTab = await getActiveTab();
  state.activeTabId = activeTab?.id ?? null;
  return activeTab;
}

function formatTime(value) {
  if (!value) {
    return '尚未扫描';
  }

  return new Date(value).toLocaleString('zh-CN', {
    hour12: false
  });
}

function setStatus(message, isError = false) {
  elements.saveStatus.textContent = message;
  elements.saveStatus.style.color = isError ? '#fca5a5' : '';
}

function openThread(url) {
  chrome.tabs.create({ url }).catch(() => {});
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendHighlightedTitle(link, title, keywords) {
  const uniqueKeywords = Array.from(new Set((keywords || []).filter(Boolean)));
  if (!uniqueKeywords.length) {
    link.textContent = title;
    return;
  }

  const matcher = new RegExp(`(${uniqueKeywords
    .sort((left, right) => right.length - left.length)
    .map(escapeForRegex)
    .join('|')})`, 'gi');

  let lastIndex = 0;
  let matched = false;

  title.replace(matcher, (segment, _group, offset) => {
    if (offset > lastIndex) {
      link.append(document.createTextNode(title.slice(lastIndex, offset)));
    }

    const highlight = document.createElement('mark');
    highlight.className = 'title-highlight';
    highlight.textContent = segment;
    link.appendChild(highlight);
    lastIndex = offset + segment.length;
    matched = true;
    return segment;
  });

  if (!matched) {
    link.textContent = title;
    return;
  }

  if (lastIndex < title.length) {
    link.append(document.createTextNode(title.slice(lastIndex)));
  }
}

function updateListScrollbarState(element) {
  if (!element) {
    return;
  }

  const hasVerticalScrollbar = element.scrollHeight - element.clientHeight > 1;
  element.classList.toggle('has-scrollbar', hasVerticalScrollbar);
}

function syncListScrollbarStates() {
  updateListScrollbarState(elements.resultsList);
  updateListScrollbarState(elements.attachList);
}

function renderList() {
  const scan = state.scan;
  const items = scan?.items || [];
  const matchedUrls = new Set((scan?.matchedItems || []).map((item) => item.url));
  const matchedLookup = new Map((scan?.matchedItems || []).map((item) => [item.url, item]));
  const visibleItems = state.filter === 'matched'
    ? items.filter((item) => matchedUrls.has(item.url))
    : items;

  elements.resultsList.innerHTML = '';

  visibleItems.forEach((item) => {
    const matchedItem = matchedLookup.get(item.url);
    const li = document.createElement('li');
    li.className = `result-item${matchedItem ? ' matched' : ''}`;

    const link = document.createElement('a');
    link.href = item.url;
    link.className = 'result-title';
    link.title = item.title;
    appendHighlightedTitle(link, item.title, matchedItem?.matchedKeywords || []);
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openThread(item.url);
    });

    const meta = document.createElement('div');
    meta.className = 'result-meta';
    if (item.forumName) {
      const forumTag = document.createElement('span');
      forumTag.className = 'tag forum';
      forumTag.textContent = item.forumName;
      meta.appendChild(forumTag);
    }
    if (matchedItem) {
      matchedItem.matchedKeywords.forEach((keyword) => {
        const keywordTag = document.createElement('span');
        keywordTag.className = 'tag';
        keywordTag.textContent = keyword;
        meta.appendChild(keywordTag);
      });
    }

    li.appendChild(link);
    li.appendChild(meta);
    elements.resultsList.appendChild(li);
  });

  elements.emptyState.classList.toggle('hidden', visibleItems.length > 0);
  syncListScrollbarStates();
}

function renderAttachments() {
  const attachments = state.scan?.attachments || [];
  elements.attachList.innerHTML = '';
  elements.attachPanel.classList.toggle('hidden', attachments.length === 0);

  attachments.forEach((attach) => {
    const li = document.createElement('li');
    li.className = 'attach-item';

    const icon = document.createElement('span');
    icon.className = 'attach-icon';
    icon.textContent = '🧲';

    const link = document.createElement('a');
    link.href = attach.url;
    link.className = 'attach-link';
    link.textContent = attach.name;
    link.title = attach.name;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      chrome.tabs.create({ url: attach.url }).catch(() => {});
    });

    li.appendChild(icon);
    li.appendChild(link);
    elements.attachList.appendChild(li);
  });

  syncListScrollbarStates();
}

function renderSummary() {
  const scan = state.scan;
  const matchedCount = scan?.matchedItems?.length || 0;
  const totalCount = scan?.items?.length || 0;

  elements.keywordsInput.value = state.keywords.join('\n');
  elements.matchCount.textContent = `${matchedCount} 命中`;
  elements.itemCount.textContent = `${totalCount} 主题`;

  if (!scan) {
    elements.pageMeta.textContent = '当前标签页不是 1lou.me，或页面尚未被扫描。';
  } else {
    elements.pageMeta.textContent = `最近扫描：${formatTime(scan.scannedAt)}`;
  }

  elements.filterButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === state.filter);
  });

  renderList();
  renderAttachments();
}

async function refreshState() {
  await syncActiveTab();

  if (typeof state.activeTabId !== 'number') {
    state.scan = null;
    renderSummary();
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: 'getState',
    tabId: state.activeTabId
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'Failed to load extension state.');
  }

  state.keywords = response.keywords || [];
  state.scan = response.scan;
  renderSummary();
}

async function saveKeywords() {
  await syncActiveTab();

  const keywords = splitKeywords(elements.keywordsInput.value);
  const response = await chrome.runtime.sendMessage({
    type: 'saveKeywords',
    tabId: state.activeTabId,
    keywords
  });

  if (!response?.ok) {
    throw new Error(response?.error || '保存关键词失败。');
  }

  state.keywords = response.keywords || [];
  setStatus('关键词已保存');
  await refreshState();
}

async function triggerRescan() {
  await syncActiveTab();

  if (typeof state.activeTabId !== 'number') {
    setStatus('当前没有可扫描的标签页', true);
    return;
  }

  setStatus('正在扫描...');
  const response = await chrome.runtime.sendMessage({
    type: 'triggerRescan',
    tabId: state.activeTabId
  });

  if (!response?.ok) {
    throw new Error(response?.error || '触发扫描失败。');
  }

  await refreshState();
  setStatus('扫描完成');
}

async function initialize() {
  await syncActiveTab();
  await refreshState();
}

const MIN_POPUP_HEIGHT = 420;

function getViewportHeight() {
  return Math.round(
    window.visualViewport?.height
      || window.innerHeight
      || document.documentElement.clientHeight
      || 0
  );
}

function lockPopupViewportHeight() {
  const viewportHeight = getViewportHeight();
  if (viewportHeight < MIN_POPUP_HEIGHT) {
    return;
  }

  const popupHeight = `${viewportHeight}px`;

  document.documentElement.style.setProperty('--popup-height', popupHeight);
  document.documentElement.style.height = popupHeight;
  document.body.style.height = popupHeight;
  document.body.style.maxHeight = popupHeight;
  document.body.style.overflow = 'hidden';
}

function schedulePopupHeightLock() {
  requestAnimationFrame(() => {
    requestAnimationFrame(lockPopupViewportHeight);
  });
}

// Keywords panel collapse/expand
const KEYWORDS_EXPANDED_KEY = '1loume_keywords_expanded';

function setKeywordsExpanded(expanded) {
  elements.keywordsToggle.setAttribute('aria-expanded', String(expanded));
  elements.keywordsBody.classList.toggle('expanded', expanded);
  localStorage.setItem(KEYWORDS_EXPANDED_KEY, String(expanded));
}

elements.keywordsToggle.addEventListener('click', () => {
  const expanded = elements.keywordsToggle.getAttribute('aria-expanded') !== 'true';
  setKeywordsExpanded(expanded);
});

// Restore saved state (default collapsed)
setKeywordsExpanded(localStorage.getItem(KEYWORDS_EXPANDED_KEY) === 'true');

schedulePopupHeightLock();
window.addEventListener('resize', schedulePopupHeightLock);
window.visualViewport?.addEventListener('resize', schedulePopupHeightLock);
window.addEventListener('resize', syncListScrollbarStates);
window.visualViewport?.addEventListener('resize', syncListScrollbarStates);

elements.saveButton.addEventListener('click', () => {
  saveKeywords().catch((error) => setStatus(error.message, true));
});

elements.rescanButton.addEventListener('click', () => {
  triggerRescan().catch((error) => setStatus(error.message, true));
});

elements.filterButtons.forEach((button) => {
  button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    renderSummary();
  });
});

initialize().catch((error) => setStatus(error.message, true));