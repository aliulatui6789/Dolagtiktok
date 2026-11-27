/**
 * content.js — runs in the isolated world on every *.tiktok.com page.
 *
 * Modules:
 *   1. Settings        — reads/watches `autoFixEnabled` in chrome.storage.local.
 *   2. RetryStore      — per-URL retry state persisted in sessionStorage.
 *   3. ErrorDetector   — finds TikTok's "Something went wrong" block + its Refresh button.
 *   4. AutoFixer       — MutationObserver + retry state machine + circuit breaker.
 *   5. NavigationWatch — SPA URL change detection (pushState/replaceState/popstate).
 *   6. AutoScroller    — Following/Followers list auto-scroll (Feature B).
 *   7. Message bridge  — popup <-> content <-> background messaging.
 *
 * The whole file is wrapped in a guard so that a second injection via
 * chrome.scripting.executeScript (popup fallback) is a harmless no-op.
 */
(() => {
  'use strict';

  if (window.__ttafContentLoaded) return;
  window.__ttafContentLoaded = true;

  /* ======================================================================= */
  /* Constants                                                               */
  /* ======================================================================= */

  const LOG_PREFIX = '[TT Auto-Fix]';

  const CONFIG = Object.freeze({
    /** Delay before acting on a detected error (gives TikTok a chance to self-heal). */
    actionDelayMs: 2500,
    /** How long to wait after an action before deciding whether it worked. */
    verifyDelayMs: 4000,
    /** After our hard reload, how long the page must stay error-free to count as fixed. */
    postReloadVerifyMs: 6000,
    /** Number of Refresh-button clicks before escalating to cookie clear + reload. */
    maxButtonClicks: 2,
    /** Total attempts per URL before the circuit breaker opens. */
    maxAttempts: 3,
    /** Throttle for MutationObserver-driven scans. */
    scanThrottleMs: 400,
    /** Fallback polling interval for URL changes (if the MAIN-world hook is unavailable). */
    urlPollMs: 1000,
    /** Auto-scroll tick interval. */
    scrollIntervalMs: 1600,
    /** Consecutive ticks without height growth before auto-scroll stops. */
    scrollMaxIdleChecks: 8,
  });

  const STORAGE_PREFIX = 'ttaf:retry:';

  /** Exact (trimmed) error captions, EN + VI. Trailing punctuation tolerated. */
  const ERROR_TEXT_RE = /^(something went wrong|đã xảy ra sự cố)[\s.!…]*$/i;

  /** Labels of the recovery button rendered next to the error. */
  const REFRESH_TEXT_RE = /^(refresh|làm mới|try again|thử lại|retry)$/i;

  const log = (...args) => console.info(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Normalises text for matching (NFC so Vietnamese diacritics compare reliably). */
  const normalizeText = (text) => (text || '').normalize('NFC').replace(/\s+/g, ' ').trim();

  /**
   * chrome.runtime.sendMessage wrapper that never throws — the extension may
   * have been reloaded/updated (context invalidated) or nobody may be listening.
   */
  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          void chrome.runtime.lastError; // swallow "Receiving end does not exist"
          resolve(response);
        });
      } catch (_) {
        resolve(undefined);
      }
    });
  }

  /* ======================================================================= */
  /* 1. Settings                                                             */
  /* ======================================================================= */

  const Settings = {
    autoFixEnabled: true,
    listeners: new Set(),

    async init() {
      try {
        const data = await chrome.storage.local.get({ autoFixEnabled: true });
        this.autoFixEnabled = data.autoFixEnabled !== false;
      } catch (_) {
        this.autoFixEnabled = true;
      }

      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.autoFixEnabled) return;
        this.autoFixEnabled = changes.autoFixEnabled.newValue !== false;
        this.listeners.forEach((fn) => fn(this.autoFixEnabled));
      });
    },

    onChange(fn) {
      this.listeners.add(fn);
    },
  };

  /* ======================================================================= */
  /* 2. RetryStore — sessionStorage state keyed by window.location.href      */
  /* ======================================================================= */

  /**
   * Shape: { attempts: number, pendingReloadVerify: boolean, breakerLogged: boolean }
   * sessionStorage survives our own window.location.reload(), which is what
   * makes the circuit breaker work across hard reloads.
   */
  const RetryStore = {
    key(url = window.location.href) {
      return STORAGE_PREFIX + url;
    },

    get(url) {
      try {
        const raw = sessionStorage.getItem(this.key(url));
        if (raw) return { attempts: 0, pendingReloadVerify: false, breakerLogged: false, ...JSON.parse(raw) };
      } catch (_) {
        /* corrupted entry or storage blocked — start fresh */
      }
      return { attempts: 0, pendingReloadVerify: false, breakerLogged: false };
    },

    set(state, url) {
      try {
        sessionStorage.setItem(this.key(url), JSON.stringify(state));
      } catch (_) {
        /* storage full/blocked — state stays in-memory only for this action */
      }
    },

    /** Removes every retry entry (called on navigation to a new URL). */
    clearAll() {
      try {
        const keys = [];
        for (let i = 0; i < sessionStorage.length; i += 1) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith(STORAGE_PREFIX)) keys.push(k);
        }
        keys.forEach((k) => sessionStorage.removeItem(k));
      } catch (_) {
        /* ignore */
      }
    },
  };

  /* ======================================================================= */
  /* 3. ErrorDetector                                                        */
  /* ======================================================================= */

  const ErrorDetector = {
    isVisible(el) {
      if (!el || !el.isConnected) return false;
      if (el.closest('[hidden], [aria-hidden="true"]')) return false;
      const rects = el.getClientRects();
      if (!rects.length) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
    },

    /** Elements we must never treat as an error block (user-typed text, our own UI). */
    isExcluded(el) {
      return Boolean(el.closest('[contenteditable="true"], textarea, input, script, style, noscript, #ttaf-scroll-overlay'));
    },

    /**
     * Returns the visible element whose own text is exactly the error caption,
     * or null. Uses a TreeWalker over text nodes, which is far cheaper than
     * querying every element's innerText.
     */
    findErrorElement(root = document.body) {
      if (!root) return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const value = node.nodeValue;
          // Cheap pre-filter before the regex: captions are short.
          if (!value || value.length > 60) return NodeFilter.FILTER_SKIP;
          return ERROR_TEXT_RE.test(normalizeText(value)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });

      let node = walker.nextNode();
      while (node) {
        const el = node.parentElement;
        if (el && !this.isExcluded(el) && this.isVisible(el)) return el;
        node = walker.nextNode();
      }
      return null;
    },

    /** True for buttons / clickable elements labelled Refresh / Làm mới / … */
    isRefreshControl(el) {
      const label = normalizeText(el.innerText || el.textContent || el.getAttribute('aria-label'));
      return REFRESH_TEXT_RE.test(label) && this.isVisible(el) && !el.disabled;
    },

    /**
     * Locates the Refresh button closest to the error block by walking up the
     * ancestor chain and searching each container. Falls back to a page-wide
     * search so that layout changes on TikTok's side don't break us.
     */
    findRefreshButton(errorEl) {
      const selector = 'button, [role="button"], a, div[tabindex]';

      let container = errorEl;
      for (let depth = 0; container && depth < 7; depth += 1) {
        const candidates = container.querySelectorAll(selector);
        for (const candidate of candidates) {
          if (this.isRefreshControl(candidate)) return candidate;
        }
        container = container.parentElement;
      }

      for (const candidate of document.querySelectorAll('button, [role="button"]')) {
        if (!this.isExcluded(candidate) && this.isRefreshControl(candidate)) return candidate;
      }
      return null;
    },
  };

  /* ======================================================================= */
  /* 4. AutoFixer — observer + retry state machine                           */
  /* ======================================================================= */

  const AutoFixer = {
    observer: null,
    busy: false,
    scanTimer: null,
    lastScanAt: 0,
    /** Bumped on every navigation; in-flight async work aborts if it changes. */
    generation: 0,

    start() {
      if (this.observer || !document.body) return;
      this.observer = new MutationObserver(() => this.scheduleScan());
      this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      log('Auto-Fix observer started.');
      this.scheduleScan();
    },

    stop() {
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
        log('Auto-Fix observer stopped.');
      }
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
      this.generation += 1; // cancel any in-flight action
      this.busy = false;
    },

    /** Throttled scan: at most one scan every `scanThrottleMs`, trailing edge guaranteed. */
    scheduleScan() {
      if (this.scanTimer) return;
      const wait = Math.max(0, CONFIG.scanThrottleMs - (Date.now() - this.lastScanAt));
      this.scanTimer = setTimeout(() => {
        this.scanTimer = null;
        this.lastScanAt = Date.now();
        this.scan();
      }, wait);
    },

    scan() {
      if (this.busy || !Settings.autoFixEnabled) return;
      const errorEl = ErrorDetector.findErrorElement();
      if (errorEl) this.handleError();
    },

    /** Called on navigation to a different URL. */
    resetForNavigation() {
      this.generation += 1;
      this.busy = false;
      RetryStore.clearAll();
      log('URL changed — retry counter reset:', window.location.href);
      this.scheduleScan();
    },

    /**
     * Retry state machine (per URL):
     *   attempts 0 -> 1 : wait 2.5 s, click Refresh
     *   attempts 1 -> 2 : wait 2.5 s, click Refresh
     *   attempts 2 -> 3 : wait 2.5 s, clear msToken cookie, hard reload
     *   attempts >= 3   : circuit breaker open — do nothing, warn once
     */
    async handleError() {
      const url = window.location.href;
      const state = RetryStore.get(url);

      if (state.attempts >= CONFIG.maxAttempts) {
        if (!state.breakerLogged) {
          warn(`Circuit breaker open: error persisted after ${state.attempts} attempts on ${url}. ` +
            'Auto-fix paused for this URL until you navigate elsewhere.');
          state.breakerLogged = true;
          state.pendingReloadVerify = false;
          RetryStore.set(state, url);
        }
        return;
      }

      this.busy = true;
      const gen = this.generation;
      const stillValid = () => gen === this.generation && window.location.href === url && Settings.autoFixEnabled;

      try {
        await sleep(CONFIG.actionDelayMs);
        if (!stillValid()) return;

        const errorEl = ErrorDetector.findErrorElement();
        if (!errorEl) {
          log('Error disappeared on its own — no action needed.');
          return;
        }

        state.attempts += 1;
        const attempt = state.attempts;
        const button = attempt <= CONFIG.maxButtonClicks ? ErrorDetector.findRefreshButton(errorEl) : null;

        if (button) {
          RetryStore.set(state, url);
          log(`Attempt ${attempt}/${CONFIG.maxAttempts}: clicking "${normalizeText(button.innerText)}" button.`);
          button.click();

          await sleep(CONFIG.verifyDelayMs);
          if (!stillValid()) return;
          if (!ErrorDetector.findErrorElement()) {
            log(`Attempt ${attempt} succeeded — error cleared.`);
            sendRuntimeMessage({ type: 'TTAF_ERROR_FIXED', url });
          } else {
            log(`Attempt ${attempt} did not clear the error.`);
          }
          return;
        }

        // Attempt 3 — or an earlier attempt where no Refresh button exists.
        if (attempt <= CONFIG.maxButtonClicks) {
          log(`Attempt ${attempt}: no Refresh button found — escalating to hard reset.`);
          state.attempts = CONFIG.maxAttempts; // a hard reload is always the final step
        }
        await this.hardReset(state, url);
      } finally {
        if (gen === this.generation) {
          this.busy = false;
          // The DOM may not mutate again if the error is still showing; re-check.
          this.scheduleScan();
        }
      }
    },

    async hardReset(state, url) {
      log(`Attempt ${state.attempts}/${CONFIG.maxAttempts}: clearing msToken cookie and reloading.`);
      state.pendingReloadVerify = true;
      RetryStore.set(state, url);

      const response = await sendRuntimeMessage({ type: 'TTAF_CLEAR_MSTOKEN' });
      if (!response || !response.ok) {
        warn('Background cookie removal failed; falling back to document.cookie.', response && response.error);
      }
      // Belt and braces: expire any non-HttpOnly copy visible to the page.
      const expired = 'msToken=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
      document.cookie = `${expired}; domain=.tiktok.com`;
      document.cookie = expired;

      window.location.reload();
      await sleep(10000); // keep `busy` set while the page unloads
    },

    /**
     * After our own hard reload, wait a few seconds; if the page is clean, the
     * reload fixed the problem and we report it.
     */
    async verifyAfterReload() {
      const url = window.location.href;
      const state = RetryStore.get(url);
      if (!state.pendingReloadVerify) return;

      const gen = this.generation;
      await sleep(CONFIG.postReloadVerifyMs);
      if (gen !== this.generation || window.location.href !== url) return;

      const latest = RetryStore.get(url);
      if (!latest.pendingReloadVerify) return;
      latest.pendingReloadVerify = false;
      RetryStore.set(latest, url);

      if (!ErrorDetector.findErrorElement()) {
        log('Hard reload succeeded — error cleared.');
        sendRuntimeMessage({ type: 'TTAF_ERROR_FIXED', url });
      }
    },
  };

  /* ======================================================================= */
  /* 5. NavigationWatch — SPA URL changes                                    */
  /* ======================================================================= */

  const NavigationWatch = {
    lastUrl: window.location.href,

    init(onChange) {
      const check = () => {
        const current = window.location.href;
        if (current === this.lastUrl) return;
        this.lastUrl = current;
        onChange(current);
      };

      // Primary: event from page-hook.js (MAIN world pushState/replaceState hook).
      window.addEventListener('ttaf:locationchange', check);
      // popstate is dispatched on window, visible from the isolated world too.
      window.addEventListener('popstate', check);
      // Navigation API (Chromium 102+) as an additional signal.
      if (window.navigation && typeof window.navigation.addEventListener === 'function') {
        window.navigation.addEventListener('navigatesuccess', check);
      }
      // Fallback polling (cheap string compare) in case all of the above miss.
      setInterval(check, CONFIG.urlPollMs);
    },

    /**
     * A full-page navigation (typed URL, link with reload, back/forward from
     * another site) is a "new URL" too — only our own reload should keep the
     * retry counter. Navigation type `reload` covers both our reload and F5.
     */
    isFreshDocumentLoad() {
      try {
        const [entry] = performance.getEntriesByType('navigation');
        return !entry || entry.type !== 'reload';
      } catch (_) {
        return true;
      }
    },
  };

  /* ======================================================================= */
  /* 6. AutoScroller — Feature B                                             */
  /* ======================================================================= */

  const AutoScroller = {
    timer: null,
    target: null,
    lastHeight: 0,
    idleChecks: 0,
    ticks: 0,
    overlay: null,

    isScrollable(el) {
      if (!el || el.scrollHeight <= el.clientHeight + 8) return false;
      const { overflowY } = window.getComputedStyle(el);
      return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
    },

    /** Picks the largest scrollable element inside `root` (including root). */
    largestScrollableIn(root) {
      let best = null;
      let bestArea = 0;
      const consider = (el) => {
        if (!this.isScrollable(el) || !ErrorDetector.isVisible(el)) return;
        const rect = el.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > bestArea) {
          best = el;
          bestArea = area;
        }
      };
      consider(root);
      root.querySelectorAll('*').forEach(consider);
      return best;
    },

    /**
     * Target priority:
     *   1. Scrollable container inside the Following/Followers modal.
     *   2. Any other open dialog's scrollable list.
     *   3. Largest scrollable element on the page.
     *   4. The document itself.
     */
    findTarget() {
      const modal = document.querySelector('[data-e2e="follow-info-popup"]');
      if (modal) {
        const inner = this.largestScrollableIn(modal);
        if (inner) return inner;
      }
      for (const dialog of document.querySelectorAll('[role="dialog"]')) {
        if (!ErrorDetector.isVisible(dialog)) continue;
        const inner = this.largestScrollableIn(dialog);
        if (inner) return inner;
      }
      return this.largestScrollableIn(document.body) || document.scrollingElement || document.documentElement;
    },

    status() {
      return {
        scrolling: Boolean(this.timer),
        ticks: this.ticks,
        idleChecks: this.idleChecks,
        maxIdleChecks: CONFIG.scrollMaxIdleChecks,
        target: this.describeTarget(),
      };
    },

    describeTarget() {
      const el = this.target;
      if (!el) return null;
      if (el === document.scrollingElement || el === document.documentElement) return 'page';
      if (el.closest('[data-e2e="follow-info-popup"]')) return 'follow list popup';
      if (el.closest('[role="dialog"]')) return 'dialog';
      return el.getAttribute('data-e2e') || el.tagName.toLowerCase();
    },

    broadcast(reason) {
      sendRuntimeMessage({ type: 'TTAF_SCROLL_STATE', reason, ...this.status() });
    },

    start() {
      if (this.timer) return { ok: true, alreadyRunning: true, ...this.status() };

      this.target = this.findTarget();
      this.lastHeight = this.target.scrollHeight;
      this.idleChecks = 0;
      this.ticks = 0;
      this.showOverlay();
      log('Auto-scroll started on', this.describeTarget(), this.target);

      this.tick(); // first step immediately, then on interval
      this.timer = setInterval(() => this.tick(), CONFIG.scrollIntervalMs);
      this.broadcast('started');
      return { ok: true, ...this.status() };
    },

    stop(reason = 'stopped') {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        log(`Auto-scroll ${reason} after ${this.ticks} tick(s).`);
      }
      this.hideOverlay();
      this.broadcast(reason);
      return { ok: true, ...this.status() };
    },

    tick() {
      const el = this.target;
      if (!el || !el.isConnected) {
        // Modal was closed (or the SPA re-rendered it) — try to re-acquire once.
        this.target = this.findTarget();
        if (!this.target || !this.target.isConnected) return this.stop('target lost');
      }

      const target = this.target;
      const height = target.scrollHeight;

      if (this.ticks > 0) {
        if (height > this.lastHeight) {
          this.idleChecks = 0;
        } else {
          this.idleChecks += 1;
          if (this.idleChecks >= CONFIG.scrollMaxIdleChecks) return this.stop('finished (end of list)');
        }
      }
      this.lastHeight = height;
      this.ticks += 1;

      // A real wheel event triggers TikTok's infinite-loader listeners…
      const rect = target.getBoundingClientRect();
      const isPage = target === document.scrollingElement || target === document.documentElement;
      const wheel = new WheelEvent('wheel', {
        deltaY: Math.max(400, target.clientHeight || window.innerHeight),
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        bubbles: true,
        cancelable: true,
        clientX: isPage ? window.innerWidth / 2 : rect.left + rect.width / 2,
        clientY: isPage ? window.innerHeight / 2 : rect.top + rect.height / 2,
      });
      (isPage ? document.body : target).dispatchEvent(wheel);

      // …and scrollTop guarantees the IntersectionObserver sentinel is reached.
      if (typeof target.scrollTo === 'function') {
        target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
      } else {
        target.scrollTop = target.scrollHeight;
      }

      this.updateOverlay();
      this.broadcast('tick');
      return undefined;
    },

    /* --- Floating on-page "Stop Scrolling" control ---------------------- */

    showOverlay() {
      if (this.overlay) return;
      const host = document.createElement('div');
      host.id = 'ttaf-scroll-overlay';
      // Shadow DOM keeps TikTok's CSS out and ours in.
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          .box {
            position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
            display: flex; align-items: center; gap: 10px;
            padding: 10px 12px; border-radius: 12px;
            background: rgba(18, 18, 24, 0.92); color: #f2f2f5;
            font: 500 13px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
            box-shadow: 0 8px 24px rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.08);
          }
          .dot { width: 8px; height: 8px; border-radius: 50%; background: #25F4EE;
                 animation: pulse 1s ease-in-out infinite; }
          @keyframes pulse { 50% { opacity: .3; } }
          button {
            all: unset; cursor: pointer; padding: 6px 10px; border-radius: 8px;
            background: #FE2C55; color: #fff; font-weight: 600;
          }
          button:hover { filter: brightness(1.1); }
        </style>
        <div class="box" role="status">
          <span class="dot"></span>
          <span class="label">Auto-scrolling…</span>
          <button type="button">Stop Scrolling</button>
        </div>`;
      shadow.querySelector('button').addEventListener('click', () => this.stop('stopped by user'));
      document.documentElement.appendChild(host);
      this.overlay = host;
    },

    updateOverlay() {
      const label = this.overlay && this.overlay.shadowRoot.querySelector('.label');
      if (label) {
        label.textContent = `Auto-scrolling… tick ${this.ticks} · idle ${this.idleChecks}/${CONFIG.scrollMaxIdleChecks}`;
      }
    },

    hideOverlay() {
      if (this.overlay) {
        this.overlay.remove();
        this.overlay = null;
      }
    },
  };

  /* ======================================================================= */
  /* 7. Message bridge (popup -> content)                                    */
  /* ======================================================================= */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;

    switch (msg.type) {
      case 'TTAF_PING':
        sendResponse({ ok: true });
        return false;
      case 'TTAF_START_SCROLL':
        sendResponse(AutoScroller.start());
        return false;
      case 'TTAF_STOP_SCROLL':
        sendResponse(AutoScroller.stop('stopped by user'));
        return false;
      case 'TTAF_GET_STATUS': {
        const retry = RetryStore.get();
        sendResponse({
          ok: true,
          url: window.location.href,
          autoFixEnabled: Settings.autoFixEnabled,
          attempts: retry.attempts,
          maxAttempts: CONFIG.maxAttempts,
          breakerOpen: retry.attempts >= CONFIG.maxAttempts && !retry.pendingReloadVerify,
          errorVisible: Boolean(ErrorDetector.findErrorElement()),
          scroll: AutoScroller.status(),
        });
        return false;
      }
      default:
        return false;
    }
  });

  /* ======================================================================= */
  /* Bootstrap                                                               */
  /* ======================================================================= */

  async function bootstrap() {
    await Settings.init();

    // New document that wasn't produced by a reload => this URL starts fresh.
    if (NavigationWatch.isFreshDocumentLoad()) RetryStore.clearAll();

    NavigationWatch.init(() => {
      if (AutoScroller.timer) AutoScroller.stop('stopped (navigation)');
      AutoFixer.resetForNavigation();
    });

    Settings.onChange((enabled) => {
      if (enabled) AutoFixer.start();
      else AutoFixer.stop();
    });

    if (Settings.autoFixEnabled) {
      AutoFixer.start();
      AutoFixer.verifyAfterReload();
    } else {
      log('Auto-Fix is disabled in settings.');
    }
  }

  if (document.body) {
    bootstrap();
  } else {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  }
})();
