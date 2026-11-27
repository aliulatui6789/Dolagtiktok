/**
 * popup.js — controller for popup.html.
 *
 *  - Auto-Fix toggle      -> chrome.storage.local `autoFixEnabled` (content.js watches it)
 *  - Errors-fixed counter -> background (TTAF_GET_COUNTER / TTAF_RESET_COUNTER),
 *                            live-updated via chrome.storage.onChanged
 *  - Auto-scroll buttons  -> content.js (START_SCROLL / STOP_SCROLL). The scroll
 *                            loop runs entirely in content.js, so it keeps going
 *                            after this popup closes. On open, the popup asks
 *                            GET_SCROLL_STATUS to show the live state again.
 *                            Injects content.js via chrome.scripting if the tab
 *                            was opened before the extension was installed.
 *  - Follow Sync          -> count of confirmed follows in chrome.storage.local
 *                            (`ttFollowConfirmed`, 24 h TTL), HARD_RELOAD_TAB
 *                            (background, bypassCache) and CLEAR_FOLLOW_SYNC.
 */
'use strict';

const COUNTER_KEY = 'fixedCount';
const FOLLOW_SYNC_KEY = 'ttFollowConfirmed';
const FOLLOW_SYNC_TTL_MS = 24 * 60 * 60 * 1000;
const CONFIRMED_STATES = new Set([1, 2, 4]);
const TIKTOK_URL_RE = /^https?:\/\/([a-z0-9-]+\.)*tiktok\.com\//i;

const $ = (id) => document.getElementById(id);
const ui = {
  toggle: $('autoFixToggle'),
  count: $('fixedCount'),
  reset: $('resetCounter'),
  pageStatus: $('pageStatus'),
  start: $('startScroll'),
  stop: $('stopScroll'),
  scrollStatus: $('scrollStatus'),
  version: $('version'),
  syncCount: $('syncCount'),
  hardRefresh: $('hardRefresh'),
  clearSync: $('clearSync'),
  syncStatus: $('syncStatus'),
};

let activeTab = null;
let statusTimer = null; // cleared automatically when the popup closes

/* ------------------------------------------------------------------------- */
/* Messaging helpers                                                         */
/* ------------------------------------------------------------------------- */

function sendToBackground(message) {
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}

function sendToTab(message) {
  if (!activeTab) return Promise.resolve(undefined);
  return chrome.tabs.sendMessage(activeTab.id, message).catch(() => undefined);
}

/**
 * Makes sure content.js is running in the active tab. Tabs that were already
 * open when the extension was installed/reloaded have no content script yet;
 * activeTab + scripting lets us inject it on demand. content.js guards against
 * double injection itself.
 */
async function ensureContentScript() {
  if (!activeTab) return false;
  const pong = await sendToTab({ type: 'TTAF_PING' });
  if (pong && pong.ok) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ['content.js'] });
    const retry = await sendToTab({ type: 'TTAF_PING' });
    return Boolean(retry && retry.ok);
  } catch (err) {
    console.warn('[TT Auto-Fix] Could not inject content script:', err);
    return false;
  }
}

/* ------------------------------------------------------------------------- */
/* Rendering                                                                 */
/* ------------------------------------------------------------------------- */

function renderCount(count) {
  ui.count.textContent = String(Number(count) || 0);
}

function setStatus(el, text, variant = '') {
  el.textContent = text;
  el.className = `${el.id === 'pageStatus' ? 'page-status' : 'scroll-status'} ${variant}`.trim();
}

function renderScroll(scroll) {
  const running = Boolean(scroll && scroll.scrolling);
  ui.start.disabled = running || !activeTab;
  ui.stop.disabled = !running;

  if (!scroll) return;
  const users = Number(scroll.estimatedUsers) || 0;
  if (running) {
    setStatus(ui.scrollStatus,
      `Scrolling · ~${users} accounts loaded · idle ${scroll.emptyAttempts}/${scroll.maxIdleChecks}`, 'active');
  } else if (scroll.reason && scroll.reason !== 'tick') {
    setStatus(ui.scrollStatus, `Auto-scroll ${scroll.reason} · ~${users} accounts loaded.`);
  }
}

function renderPageStatus(status) {
  if (!status) {
    setStatus(ui.pageStatus, 'Reload the TikTok tab to activate the helper.', 'warn');
    return;
  }
  if (!status.autoFixEnabled) {
    setStatus(ui.pageStatus, 'Auto-Fix is off for all tabs.', 'warn');
  } else if (status.breakerOpen) {
    setStatus(ui.pageStatus,
      `Gave up on this page after ${status.maxAttempts} attempts. Navigate to reset.`, 'warn');
  } else if (status.errorVisible) {
    setStatus(ui.pageStatus, `Error detected — fixing (attempt ${status.attempts}/${status.maxAttempts})…`, 'warn');
  } else {
    setStatus(ui.pageStatus, 'Watching this tab for errors.');
  }
}

function setSyncStatus(text, variant = '') {
  ui.syncStatus.textContent = text;
  ui.syncStatus.className = `scroll-status ${variant}`.trim();
}

/** Counts non-expired confirmed follows (1 following, 2 friends, 4 requested). */
function renderSyncCount(entries) {
  const now = Date.now();
  const count = Object.values(entries || {}).filter((e) => e
    && CONFIRMED_STATES.has(Number(e.followStatus))
    && typeof e.timestamp === 'number'
    && now - e.timestamp < FOLLOW_SYNC_TTL_MS).length;
  ui.syncCount.textContent = String(count);
}

async function loadSyncCount() {
  try {
    const data = await chrome.storage.local.get(FOLLOW_SYNC_KEY);
    renderSyncCount(data[FOLLOW_SYNC_KEY]);
  } catch (err) {
    console.warn('[TT Follow-Sync] Could not read storage:', err);
    renderSyncCount({});
  }
}

let syncMessageUntil = 0; // keep a button's result visible for a moment

function renderFollowSync(sync) {
  if (Date.now() < syncMessageUntil) return;
  if (!activeTab) {
    setSyncStatus('Open a tiktok.com tab to use Hard Refresh.', 'warn');
  } else if (!sync || !sync.username) {
    setSyncStatus('Open a profile (tiktok.com/@name) to check its follow state.');
  } else if (sync.patched) {
    setSyncStatus(`@${sync.username}: server confirmed ${sync.followStatus === 4 ? 'request' : 'follow'}, ` +
      'page shows a cached "Follow" — button re-labelled. Hard Refresh to reload without cache.', 'ok');
  } else if (sync.confirmed) {
    setSyncStatus(`@${sync.username}: follow confirmed and the page is up to date.`, 'ok');
  } else {
    setSyncStatus(`@${sync.username}: no confirmed follow recorded in the last 24 h.`);
  }
}

async function refreshTabStatus() {
  const status = await sendToTab({ type: 'TTAF_GET_STATUS' });
  renderPageStatus(status);
  renderScroll(status ? status.scroll : { scrolling: false });
  renderFollowSync(status && status.followSync);
}

/* ------------------------------------------------------------------------- */
/* Event handlers                                                            */
/* ------------------------------------------------------------------------- */

ui.toggle.addEventListener('change', async () => {
  await chrome.storage.local.set({ autoFixEnabled: ui.toggle.checked });
  if (activeTab) refreshTabStatus();
});

ui.reset.addEventListener('click', async () => {
  const res = await sendToBackground({ type: 'TTAF_RESET_COUNTER' });
  if (res && res.ok) renderCount(res.count);
});

/**
 * Start is fire-and-forget from the popup's point of view: START_SCROLL is sent
 * first (one round-trip), so the loop is already running in the page even if
 * the user clicks back onto TikTok and the popup closes right away. Every
 * promise is caught, so a closed popup never produces an uncaught error.
 */
ui.start.addEventListener('click', async () => {
  ui.start.disabled = true;
  setStatus(ui.scrollStatus, 'Starting…');
  try {
    let res = await sendToTab({ type: 'START_SCROLL' });
    if (!res && (await ensureContentScript())) res = await sendToTab({ type: 'START_SCROLL' });
    if (!res) {
      setStatus(ui.scrollStatus, 'Could not reach the page. Reload the TikTok tab and try again.', 'warn');
      ui.start.disabled = false;
      return;
    }
    renderScroll(res);
  } catch (_) {
    /* popup closed mid-request — the scroll loop in content.js is unaffected */
  }
});

ui.stop.addEventListener('click', async () => {
  try {
    const res = await sendToTab({ type: 'STOP_SCROLL' });
    renderScroll(res || { scrolling: false });
  } catch (_) {
    /* popup closed mid-request */
  }
});

ui.hardRefresh.addEventListener('click', async () => {
  if (!activeTab) return;
  ui.hardRefresh.disabled = true;
  try {
    const res = await sendToBackground({ type: 'HARD_RELOAD_TAB', tabId: activeTab.id });
    syncMessageUntil = Date.now() + 3000;
    if (res && res.ok) setSyncStatus('Reloading the tab without cache…', 'ok');
    else setSyncStatus(`Hard refresh failed: ${(res && res.error) || 'no response from the extension'}.`, 'warn');
  } finally {
    setTimeout(() => { ui.hardRefresh.disabled = !activeTab; }, 1500);
  }
});

ui.clearSync.addEventListener('click', async () => {
  const res = await sendToBackground({ type: 'CLEAR_FOLLOW_SYNC' });
  syncMessageUntil = Date.now() + 3000;
  if (res && res.ok) {
    renderSyncCount({});
    setSyncStatus('Sync history cleared.');
  } else {
    setSyncStatus(`Could not clear history: ${(res && res.error) || 'no response from the extension'}.`, 'warn');
  }
});

/* Live updates: counter (storage) and scroll ticks (runtime broadcast). */
chrome.storage.onChanged.addListener((changes, area) => {
  if (changes[COUNTER_KEY] && (area === 'session' || area === 'local')) {
    renderCount(changes[COUNTER_KEY].newValue);
  }
  if (area === 'local' && changes[FOLLOW_SYNC_KEY]) {
    renderSyncCount(changes[FOLLOW_SYNC_KEY].newValue);
  }
  if (area === 'local' && changes.autoFixEnabled) {
    ui.toggle.checked = changes.autoFixEnabled.newValue !== false;
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'TTAF_SCROLL_STATE') return false;
  if (!activeTab || !sender.tab || sender.tab.id !== activeTab.id) return false;
  renderScroll(msg);
  return false;
});

/* ------------------------------------------------------------------------- */
/* Init                                                                      */
/* ------------------------------------------------------------------------- */

async function init() {
  ui.version.textContent = chrome.runtime.getManifest().version;

  const settings = await chrome.storage.local.get({ autoFixEnabled: true });
  ui.toggle.checked = settings.autoFixEnabled !== false;

  await loadSyncCount();

  const counter = await sendToBackground({ type: 'TTAF_GET_COUNTER' });
  renderCount(counter && counter.ok ? counter.count : 0);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // tab.url is only visible for hosts we have permission for, i.e. TikTok.
  if (tab && tab.url && TIKTOK_URL_RE.test(tab.url)) {
    activeTab = tab;
    // Restore the live scroll state first (scrolling may have been started earlier).
    const scroll = await sendToTab({ type: 'GET_SCROLL_STATUS' });
    if (scroll) renderScroll(scroll);
    await refreshTabStatus();
    statusTimer = setInterval(refreshTabStatus, 1500);
  } else {
    setStatus(ui.pageStatus, 'Open a tiktok.com tab to use the helper.', 'warn');
    ui.start.disabled = true;
    ui.stop.disabled = true;
    ui.hardRefresh.disabled = true;
    renderFollowSync(null);
  }
}

init().catch((err) => console.warn('[TT Auto-Fix] Popup init failed:', err));
