/**
 * page-hook.js — runs in the page's MAIN world at document_start.
 *
 * Content scripts live in an isolated JS world, so they cannot see the page's
 * own calls to history.pushState / replaceState (TikTok's SPA router uses
 * these). This tiny hook wraps both methods and broadcasts a DOM event that
 * content.js (isolated world) listens to. The DOM / window event target is
 * shared between worlds, which makes this a safe, dependency-free bridge.
 *
 * It intentionally does nothing else and exposes no globals.
 */
(() => {
  'use strict';

  const EVENT_NAME = 'ttaf:locationchange';
  if (window.__ttafHistoryHooked) return;
  Object.defineProperty(window, '__ttafHistoryHooked', { value: true });

  const notify = () => {
    try {
      window.dispatchEvent(new CustomEvent(EVENT_NAME));
    } catch (_) {
      /* never break the page */
    }
  };

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    if (typeof original !== 'function') continue;
    history[method] = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      notify();
      return result;
    };
  }

  window.addEventListener('popstate', notify);
})();
