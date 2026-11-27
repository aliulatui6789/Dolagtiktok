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
    scrollIntervalMs: 1800,
    /** Consecutive ticks with no growth (height AND links) before auto-scroll stops (~21 s). */
    scrollMaxIdleChecks: 12,
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

  /**
   * Multi-target scroll engine.
   *
   * TikTok's class names (e.g. `DivUserListContainer-…`) change often, and the
   * list can be re-rendered (new element) while we scroll. So instead of
   * locking onto one element at start, EVERY tick re-scans the DOM for all
   * visible scrollable containers and scrolls each of them to the bottom,
   * firing `scroll` + `wheel` events so React's virtualised list / infinite
   * loader reacts exactly as it does to the manual DevTools script.
   *
   * The loop lives entirely in this content script: closing or re-opening the
   * popup does not affect it. The popup only reads state via GET_SCROLL_STATUS.
   *
   * Completion: a tick is "empty" only if NONE of these grew since the last
   * tick: max container scrollHeight, number of `a[href*="/@"]` links, number
   * of unique profile links seen so far. 12 empty ticks in a row (~21 s at
   * 1.8 s/tick) => end of list. Slow proxies get plenty of time.
   */

  /** Module-scope scroll state (survives popup open/close). */
  let isScrolling = false;
  let estimatedUsers = 0;
  /** Why the last run ended (shown when the popup is re-opened after it finished). */
  let lastStopReason = null;

  const AutoScroller = {
    timer: null,
    ticks: 0,
    emptyAttempts: 0,
    lastMaxHeight: 0,
    lastLinkCount: 0,
    /** Unique profile URLs seen during this run (handles virtualised lists that recycle rows). */
    seenProfiles: new Set(),
    lastContainerCount: 0,
    overlay: null,

    /** Explicit candidates, checked in addition to the generic scan. */
    EXTRA_SELECTORS: [
      '[data-e2e="follow-info-popup"] > div:last-child',
      'div[class*="DivUserListContainer"]',
    ],

    /** True if the element is on screen (rendered with a box). */
    isRendered(el) {
      return el.isConnected && el.getClientRects().length > 0 && el.id !== 'ttaf-scroll-overlay';
    },

    isScrollableStyle(el) {
      const { overflowY } = window.getComputedStyle(el);
      return overflowY === 'auto' || overflowY === 'scroll';
    },

    /**
     * Returns every scroll target for this tick:
     *   a) any visible div that is scrollable (overflow auto/scroll), has
     *      content taller than itself (+20 px) and is at least 150 px tall;
     *   b) the follow-popup's last child and any `DivUserListContainer`
     *      (if they can actually scroll);
     *   c) document.scrollingElement.
     */
    findContainers() {
      const found = new Set();

      for (const el of document.querySelectorAll('div')) {
        if (el.scrollHeight <= el.clientHeight + 20 || el.clientHeight <= 150) continue; // cheap checks first
        if (this.isScrollableStyle(el) && this.isRendered(el)) found.add(el);
      }

      for (const selector of this.EXTRA_SELECTORS) {
        for (const el of document.querySelectorAll(selector)) {
          if (el.scrollHeight > el.clientHeight && this.isRendered(el)) found.add(el);
        }
      }

      const root = document.scrollingElement || document.documentElement;
      if (root) found.add(root);
      return [...found];
    },

    /** Root used to count "loaded accounts": the follow popup if open, else the page. */
    listRoot() {
      return document.querySelector('[data-e2e="follow-info-popup"]') || document;
    },

    /** Collects profile links; returns the total link count in the document. */
    collectProfiles() {
      const allLinks = document.querySelectorAll('a[href*="/@"]');
      for (const a of this.listRoot().querySelectorAll('a[href*="/@"]')) {
        const match = /\/@([^/?#]+)/.exec(a.getAttribute('href') || '');
        if (match) this.seenProfiles.add(match[1].toLowerCase());
      }
      estimatedUsers = this.seenProfiles.size;
      return allLinks.length;
    },

    scrollContainer(el) {
      el.scrollTop = el.scrollHeight;
      // Dispatch on body for the root scroller; window listeners still see it (bubbles).
      const target = el === document.scrollingElement || el === document.documentElement ? document : el;
      target.dispatchEvent(new Event('scroll', { bubbles: true }));
      (target === document ? document.body : el).dispatchEvent(
        new WheelEvent('wheel', { deltaY: 800, deltaMode: 0, bubbles: true, cancelable: true }),
      );
    },

    tick() {
      if (!isScrolling) return;

      const containers = this.findContainers();
      this.lastContainerCount = containers.length;

      // 1) Measure progress: the previous tick's scroll had 1.8 s to load more rows.
      const maxHeight = containers.reduce((max, el) => Math.max(max, el.scrollHeight), 0);
      const seenBefore = this.seenProfiles.size;
      const linkCount = this.collectProfiles();

      if (this.ticks > 0) {
        const grew = maxHeight > this.lastMaxHeight
          || linkCount > this.lastLinkCount
          || this.seenProfiles.size > seenBefore;
        this.emptyAttempts = grew ? 0 : this.emptyAttempts + 1;
      }
      // Track high-water marks so a list that briefly shrinks (re-render) isn't "growth" later.
      this.lastMaxHeight = Math.max(this.lastMaxHeight, maxHeight);
      this.lastLinkCount = Math.max(this.lastLinkCount, linkCount);
      this.ticks += 1;

      if (this.emptyAttempts >= CONFIG.scrollMaxIdleChecks) {
        this.stop('finished (end of list)');
        return;
      }

      // 2) Scroll everything + fire events.
      for (const el of containers) {
        try {
          this.scrollContainer(el);
        } catch (_) {
          /* element vanished mid-tick — next tick rescans */
        }
      }
      window.scrollTo(0, document.body ? document.body.scrollHeight : 0);

      this.updateOverlay();
      this.broadcast('tick');
    },

    status() {
      return {
        ok: true,
        scrolling: isScrolling,
        isScrolling,
        estimatedUsers,
        ticks: this.ticks,
        idleChecks: this.emptyAttempts,
        emptyAttempts: this.emptyAttempts,
        maxIdleChecks: CONFIG.scrollMaxIdleChecks,
        containers: this.lastContainerCount,
        reason: isScrolling ? null : lastStopReason,
      };
    },

    broadcast(reason) {
      sendRuntimeMessage({ type: 'TTAF_SCROLL_STATE', reason, ...this.status() });
    },

    start() {
      if (isScrolling) return { ...this.status(), alreadyRunning: true };

      isScrolling = true;
      lastStopReason = null;
      this.ticks = 0;
      this.emptyAttempts = 0;
      this.lastMaxHeight = 0;
      this.lastLinkCount = 0;
      this.seenProfiles = new Set();
      estimatedUsers = 0;

      this.showOverlay();
      log('Auto-scroll started.');
      this.tick(); // first step immediately
      this.timer = setInterval(() => this.tick(), CONFIG.scrollIntervalMs);
      return this.status();
    },

    stop(reason = 'stopped') {
      const wasRunning = isScrolling;
      isScrolling = false;
      clearInterval(this.timer);
      this.timer = null;
      this.hideOverlay();
      if (wasRunning) {
        lastStopReason = reason;
        log(`Auto-scroll ${reason} after ${this.ticks} tick(s), ~${estimatedUsers} account(s) loaded.`);
        this.broadcast(reason);
      }
      return { ...this.status(), reason };
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
        label.textContent = `Auto-scrolling… ~${estimatedUsers} accounts · idle ${this.emptyAttempts}/${CONFIG.scrollMaxIdleChecks}`;
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
      case 'START_SCROLL':
      case 'TTAF_START_SCROLL':
        sendResponse(AutoScroller.start());
        return false;
      case 'STOP_SCROLL':
      case 'TTAF_STOP_SCROLL':
        sendResponse(AutoScroller.stop('stopped by user'));
        return false;
      case 'GET_SCROLL_STATUS':
        sendResponse(AutoScroller.status());
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
      if (isScrolling) AutoScroller.stop('stopped (navigation)');
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
