/**
 * popup.js — controller for popup.html.
 *
 *  - Auto-Fix toggle      -> chrome.storage.local `autoFixEnabled` (content.js watches it)
 *  - Errors-fixed counter -> background (TTAF_GET_COUNTER / TTAF_RESET_COUNTER),
 *                            live-updated via chrome.storage.onChanged
 *  - Auto-scroll buttons  -> content.js (TTAF_START_SCROLL / TTAF_STOP_SCROLL);
 *                            injects content.js via chrome.scripting if the tab
 *                            was opened before the extension was installed.
 */
'use strict';

const COUNTER_KEY = 'fixedCount';
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
  if (running) {
    const where = scroll.target ? ` on ${scroll.target}` : '';
    setStatus(ui.scrollStatus,
      `Scrolling${where} · tick ${scroll.ticks} · idle ${scroll.idleChecks}/${scroll.maxIdleChecks}`, 'active');
  } else if (scroll.reason && scroll.reason !== 'tick') {
    setStatus(ui.scrollStatus, `Auto-scroll ${scroll.reason}${scroll.ticks ? ` (${scroll.ticks} ticks)` : ''}.`);
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

async function refreshTabStatus() {
  const status = await sendToTab({ type: 'TTAF_GET_STATUS' });
  renderPageStatus(status);
  renderScroll(status ? status.scroll : { scrolling: false });
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

ui.start.addEventListener('click', async () => {
  ui.start.disabled = true;
  setStatus(ui.scrollStatus, 'Starting…');
  if (!(await ensureContentScript())) {
    setStatus(ui.scrollStatus, 'Could not reach the page. Reload the TikTok tab and try again.', 'warn');
    ui.start.disabled = false;
    return;
  }
  renderScroll(await sendToTab({ type: 'TTAF_START_SCROLL' }));
});

ui.stop.addEventListener('click', async () => {
  const res = await sendToTab({ type: 'TTAF_STOP_SCROLL' });
  renderScroll(res ? { ...res, reason: 'stopped' } : { scrolling: false });
});

/* Live updates: counter (storage) and scroll ticks (runtime broadcast). */
chrome.storage.onChanged.addListener((changes, area) => {
  if (changes[COUNTER_KEY] && (area === 'session' || area === 'local')) {
    renderCount(changes[COUNTER_KEY].newValue);
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

  const counter = await sendToBackground({ type: 'TTAF_GET_COUNTER' });
  renderCount(counter && counter.ok ? counter.count : 0);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // tab.url is only visible for hosts we have permission for, i.e. TikTok.
  if (tab && tab.url && TIKTOK_URL_RE.test(tab.url)) {
    activeTab = tab;
    await refreshTabStatus();
    statusTimer = setInterval(refreshTabStatus, 1500);
  } else {
    setStatus(ui.pageStatus, 'Open a tiktok.com tab to use the helper.', 'warn');
    ui.start.disabled = true;
    ui.stop.disabled = true;
  }
}

init();
