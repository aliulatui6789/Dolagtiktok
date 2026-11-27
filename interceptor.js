/**
 * interceptor.js — runs in the page's MAIN world at document_start.
 *
 * Purpose: TikTok sometimes renders a stale cached profile after F5 (shows
 * "Follow" although the follow already succeeded on the server). To detect
 * the real server-side state, this script wraps `window.fetch` and
 * `XMLHttpRequest` and inspects the JSON responses of:
 *
 *   /api/commit/follow/user/   -> follow / unfollow result (authoritative)
 *   /api/user/detail/          -> profile identity (id <-> @username)
 *   /api/user/list/            -> follow lists (identity of every row)
 *   /api/.../item_list/        -> feeds (identity of every video author)
 *
 * It never changes requests or responses: it only reads a clone. Results are
 * broadcast to the isolated-world content script via window CustomEvents:
 *
 *   TT_FOLLOW_STATE_CONFIRMED  detail: { username, userId, secUid, followStatus, timestamp }
 *   TT_USER_IDENTITY           detail: { username, userId, secUid, followStatus|null, source }
 *
 * The content script can send `TT_INTERCEPTOR_SYNC_REQUEST` to get every
 * identity learnt so far replayed (it loads later, at document_idle).
 */
(() => {
  'use strict';

  if (window.__ttfsInterceptorInstalled) return;
  Object.defineProperty(window, '__ttfsInterceptorInstalled', { value: true });

  const LOG_PREFIX = '[TT Follow-Sync]';
  const FOLLOW_RE = /\/api\/commit\/follow\/user\/?/;
  const DETAIL_RE = /\/api\/user\/detail\/?/;
  const LIST_RE = /\/api\/user\/list\/?/;
  const ITEMS_RE = /\/api\/[a-z_/]*item_list\/?/;
  const MAX_IDENTITIES = 3000;

  /** userId -> { username, userId, secUid, followStatus } */
  const identities = new Map();
  /** secUid -> userId */
  const secIndex = new Map();

  const safe = (fn) => {
    try {
      return fn();
    } catch (err) {
      console.debug(LOG_PREFIX, 'ignored error:', err);
      return undefined;
    }
  };

  const emit = (name, detail) => safe(() => window.dispatchEvent(new CustomEvent(name, { detail })));

  const str = (v) => (v === undefined || v === null || v === '' ? null : String(v));

  const toNumberOrNull = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  /** Username of the profile in the address bar (`/@name` or `/@name/video/…`). */
  function pathUsername() {
    const m = /^\/@([^/?#]+)/.exec(window.location.pathname);
    return m ? safe(() => decodeURIComponent(m[1])) || m[1] : null;
  }

  /* ----------------------------------------------------------------------- */
  /* Identity map                                                            */
  /* ----------------------------------------------------------------------- */

  function rememberUser(user, source, relation) {
    if (!user || typeof user !== 'object') return;
    const userId = str(user.id || user.uid || user.user_id);
    const username = str(user.uniqueId || user.unique_id);
    const secUid = str(user.secUid || user.sec_uid);
    if (!userId || !username) return;

    const followStatus = toNumberOrNull(relation !== undefined ? relation : user.relation);
    const entry = { username, userId, secUid, followStatus };
    identities.delete(userId); // re-insert => most-recent last (cheap LRU)
    identities.set(userId, entry);
    if (secUid) secIndex.set(secUid, userId);

    if (identities.size > MAX_IDENTITIES) {
      const oldest = identities.keys().next().value;
      const old = identities.get(oldest);
      identities.delete(oldest);
      if (old && old.secUid) secIndex.delete(old.secUid);
    }
    emit('TT_USER_IDENTITY', { ...entry, source });
  }

  function handleDetail(json) {
    const info = json && (json.userInfo || (json.data && json.data.userInfo));
    if (!info || !info.user) return;
    const relation = info.user.relation !== undefined
      ? info.user.relation
      : info.stats && info.stats.relation;
    rememberUser(info.user, 'user/detail', relation);
  }

  function handleList(json) {
    const list = json && (json.userList || json.user_list);
    if (!Array.isArray(list)) return;
    for (const row of list) rememberUser(row && (row.user || row), 'user/list');
  }

  function handleItems(json) {
    const list = json && (json.itemList || json.item_list || json.items);
    if (!Array.isArray(list)) return;
    for (const item of list) if (item && item.author) rememberUser(item.author, 'item_list');
  }

  /** Server-side-rendered profile data (present on F5 of a profile page). */
  function readRehydrationData() {
    safe(() => {
      const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (!el || !el.textContent) return;
      const data = JSON.parse(el.textContent);
      const scope = data && data.__DEFAULT_SCOPE__;
      const detail = scope && scope['webapp.user-detail'];
      if (detail) handleDetail(detail);
    });
  }

  /* ----------------------------------------------------------------------- */
  /* Follow result                                                           */
  /* ----------------------------------------------------------------------- */

  /** Collects request params from the URL query and a form-encoded / JSON body. */
  function collectParams(url, body) {
    const params = new Map();
    safe(() => {
      new URL(url, window.location.href).searchParams.forEach((v, k) => params.set(k, v));
    });
    if (body === undefined || body === null) return params;

    safe(() => {
      if (body instanceof URLSearchParams) {
        body.forEach((v, k) => params.set(k, v));
      } else if (typeof FormData !== 'undefined' && body instanceof FormData) {
        body.forEach((v, k) => {
          if (typeof v === 'string') params.set(k, v);
        });
      } else if (typeof body === 'string' && body) {
        const trimmed = body.trim();
        if (trimmed.startsWith('{')) {
          const obj = JSON.parse(trimmed);
          for (const [k, v] of Object.entries(obj)) if (v !== null && typeof v !== 'object') params.set(k, String(v));
        } else {
          new URLSearchParams(trimmed).forEach((v, k) => params.set(k, v));
        }
      }
    });
    return params;
  }

  function handleFollow(json, url, body) {
    if (!json || typeof json !== 'object') return;
    const statusCode = json.status_code !== undefined ? json.status_code : json.statusCode;
    if (Number(statusCode) !== 0) return; // only trust successful commits

    const params = collectParams(url, body);
    const userId = str(params.get('user_id') || params.get('userId'));
    const secUid = str(params.get('sec_user_id') || params.get('secUid'));

    let followStatus = toNumberOrNull(
      json.follow_status !== undefined ? json.follow_status : json.followStatus,
    );
    if (followStatus === null) {
      // Older responses omit follow_status: infer it from the request's intent.
      const type = toNumberOrNull(params.get('type') || params.get('action_type'));
      if (type === 1) followStatus = 1;
      else if (type === 0) followStatus = 0;
    }
    if (followStatus === null) return;

    // Resolve @username: learnt identity first; the address bar only if it is
    // not provably a *different* user (e.g. following someone from the
    // Followers popup of another profile).
    const knownId = userId || (secUid && secIndex.get(secUid)) || null;
    let username = knownId && identities.has(knownId) ? identities.get(knownId).username : null;
    if (!username) {
      const pathUser = pathUsername();
      if (pathUser) {
        const owner = [...identities.values()].find((e) => e.username.toLowerCase() === pathUser.toLowerCase());
        if (!owner || !knownId || owner.userId === knownId) username = pathUser;
      }
    }

    const detail = {
      username,
      userId: knownId,
      secUid,
      followStatus,
      timestamp: Date.now(),
    };
    console.info(LOG_PREFIX, 'Follow state confirmed by server:', detail);
    emit('TT_FOLLOW_STATE_CONFIRMED', detail);
  }

  /** Routes a parsed JSON response to the right handler. */
  function inspect(url, body, json) {
    if (!url || !json) return;
    if (FOLLOW_RE.test(url)) handleFollow(json, url, body);
    else if (DETAIL_RE.test(url)) handleDetail(json);
    else if (LIST_RE.test(url)) handleList(json);
    else if (ITEMS_RE.test(url)) handleItems(json);
  }

  const isWatched = (url) => FOLLOW_RE.test(url) || DETAIL_RE.test(url) || LIST_RE.test(url) || ITEMS_RE.test(url);

  /* ----------------------------------------------------------------------- */
  /* fetch                                                                   */
  /* ----------------------------------------------------------------------- */

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    const patchedFetch = function fetch(input, init) {
      const url = safe(() => (typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url)) || '';
      const watched = isWatched(url);

      let bodyPromise = Promise.resolve(undefined);
      if (watched) {
        if (init && init.body !== undefined) {
          bodyPromise = Promise.resolve(init.body);
        } else if (typeof Request !== 'undefined' && input instanceof Request && !input.bodyUsed) {
          // Must clone BEFORE the original fetch consumes the body.
          bodyPromise = safe(() => input.clone().text().catch(() => undefined)) || bodyPromise;
        }
      }

      const result = originalFetch.apply(this, arguments);
      if (watched) {
        result
          .then((response) => {
            if (!response || !response.ok) return undefined;
            return Promise.all([bodyPromise, response.clone().json()]).then(([body, json]) => {
              inspect(response.url || url, body, json);
            });
          })
          .catch(() => {
            /* non-JSON / aborted — the page handles its own errors */
          });
      }
      return result;
    };
    safe(() => Object.defineProperty(patchedFetch, 'toString', { value: () => originalFetch.toString() }));
    window.fetch = patchedFetch;
  }

  /* ----------------------------------------------------------------------- */
  /* XMLHttpRequest                                                          */
  /* ----------------------------------------------------------------------- */

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const meta = new WeakMap();
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;

    XHR.prototype.open = function open(method, url) {
      safe(() => meta.set(this, { url: String(url) }));
      return originalOpen.apply(this, arguments);
    };

    XHR.prototype.send = function send(body) {
      const info = meta.get(this);
      if (info && isWatched(info.url)) {
        this.addEventListener('load', () => {
          safe(() => {
            if (this.status < 200 || this.status >= 300) return;
            let json = null;
            if (this.responseType === '' || this.responseType === 'text') {
              json = JSON.parse(this.responseText);
            } else if (this.responseType === 'json') {
              json = this.response;
            }
            inspect(this.responseURL || info.url, body, json);
          });
        });
      }
      return originalSend.apply(this, arguments);
    };
  }

  /* ----------------------------------------------------------------------- */
  /* Bridge to the content script                                            */
  /* ----------------------------------------------------------------------- */

  window.addEventListener('TT_INTERCEPTOR_SYNC_REQUEST', () => {
    readRehydrationData();
    for (const entry of identities.values()) emit('TT_USER_IDENTITY', { ...entry, source: 'replay' });
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', readRehydrationData, { once: true });
  } else {
    readRehydrationData();
  }
})();
