/**
 * background.js — MV3 service worker.
 *
 * Responsibilities:
 *   1. Delete TikTok's `msToken` cookie on request from content.js
 *      (content scripts cannot touch HttpOnly cookies, chrome.cookies can).
 *   2. Keep the "errors fixed this session" counter and mirror it on the
 *      toolbar badge.
 *   3. Seed default settings on install.
 *
 * Message protocol (all messages are objects with a `type` field):
 *   content -> bg  { type: 'TTAF_CLEAR_MSTOKEN' }  => { ok, removed, error? }
 *   content -> bg  { type: 'TTAF_ERROR_FIXED', url } => { ok, count }
 *   popup   -> bg  { type: 'TTAF_GET_COUNTER' }    => { ok, count }
 *   popup   -> bg  { type: 'TTAF_RESET_COUNTER' }  => { ok, count: 0 }
 */
'use strict';

const COUNTER_KEY = 'fixedCount';
const SETTINGS_DEFAULTS = { autoFixEnabled: true };

/**
 * chrome.storage.session is cleared when the browser session ends, which is
 * exactly the lifetime we want for the counter. Very old Chromium builds lack
 * it, so fall back to storage.local and reset it on browser startup.
 */
const counterArea = chrome.storage.session || chrome.storage.local;

/* ------------------------------------------------------------------------- */
/* Lifecycle                                                                 */
/* ------------------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener(async () => {
  // Only write defaults for keys that are not set yet (preserve user choice on update).
  const current = await chrome.storage.local.get(Object.keys(SETTINGS_DEFAULTS));
  const missing = {};
  for (const [key, value] of Object.entries(SETTINGS_DEFAULTS)) {
    if (current[key] === undefined) missing[key] = value;
  }
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);

  chrome.action.setBadgeBackgroundColor({ color: '#FE2C55' });
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  if (!chrome.storage.session) await counterArea.set({ [COUNTER_KEY]: 0 });
  chrome.action.setBadgeBackgroundColor({ color: '#FE2C55' });
  await refreshBadge();
});

/* ------------------------------------------------------------------------- */
/* Counter helpers                                                           */
/* ------------------------------------------------------------------------- */

async function getCount() {
  const data = await counterArea.get(COUNTER_KEY);
  return Number(data[COUNTER_KEY]) || 0;
}

async function setCount(count) {
  await counterArea.set({ [COUNTER_KEY]: count });
  await refreshBadge(count);
  return count;
}

async function refreshBadge(count) {
  const value = count === undefined ? await getCount() : count;
  await chrome.action.setBadgeText({ text: value > 0 ? String(value > 999 ? '999+' : value) : '' });
}

/**
 * Increments are serialised through a promise chain so that several tabs
 * reporting a fix at the same moment can never lose an update.
 */
let counterQueue = Promise.resolve();
function incrementCount() {
  const next = counterQueue.then(async () => setCount((await getCount()) + 1));
  counterQueue = next.catch(() => {});
  return next;
}

/* ------------------------------------------------------------------------- */
/* Cookie handling                                                           */
/* ------------------------------------------------------------------------- */

/** Finds the cookie store (normal / incognito) that owns the sender's tab. */
async function storeIdForTab(tabId) {
  if (tabId === undefined) return undefined;
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    const match = stores.find((store) => store.tabIds.includes(tabId));
    return match ? match.id : undefined;
  } catch (_) {
    return undefined;
  }
}

/** Removes every `msToken` cookie scoped to tiktok.com (incl. subdomains). */
async function clearMsToken(tabId) {
  const storeId = await storeIdForTab(tabId);
  const query = { name: 'msToken' };
  if (storeId) query.storeId = storeId;

  const cookies = await chrome.cookies.getAll(query);
  const targets = cookies.filter((c) => /(^|\.)tiktok\.com$/i.test(c.domain.replace(/^\./, '')));

  let removed = 0;
  for (const cookie of targets) {
    const host = cookie.domain.replace(/^\./, '');
    const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`;
    const details = { url, name: cookie.name, storeId: cookie.storeId };
    // Partitioned (CHIPS) cookies must be removed with their partition key.
    if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
    try {
      const result = await chrome.cookies.remove(details);
      if (result) removed += 1;
    } catch (err) {
      console.warn('[TT Auto-Fix] Failed to remove cookie', details, err);
    }
  }
  console.info(`[TT Auto-Fix] Cleared ${removed}/${targets.length} msToken cookie(s).`);
  return removed;
}

/* ------------------------------------------------------------------------- */
/* Message router                                                            */
/* ------------------------------------------------------------------------- */

const handlers = {
  async TTAF_CLEAR_MSTOKEN(_msg, sender) {
    const removed = await clearMsToken(sender.tab && sender.tab.id);
    return { ok: true, removed };
  },
  async TTAF_ERROR_FIXED() {
    const count = await incrementCount();
    return { ok: true, count };
  },
  async TTAF_GET_COUNTER() {
    return { ok: true, count: await getCount() };
  },
  async TTAF_RESET_COUNTER() {
    return { ok: true, count: await setCount(0) };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler) return false; // not for us (e.g. popup <-> content traffic)

  handler(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // keep the channel open for the async response
});
