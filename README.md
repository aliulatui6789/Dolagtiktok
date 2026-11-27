# TikTok Auto-Fix & Following Helper

A lightweight Chrome extension (Manifest V3, vanilla JS, no build step) for `*.tiktok.com` that:

- **Auto-fixes the "Something went wrong" / "Đã xảy ra sự cố" error** that TikTok's web app sometimes shows, using a retry routine with a circuit breaker so it can't get stuck reloading forever.
- **Auto-scrolls Following / Followers lists** until the end of the list, with Stop controls in both the popup and the page.
- **Fixes stale "Follow" buttons after F5 (Follow Sync).** Sometimes TikTok saves a follow on the server (`status_code: 0`, `follow_status: 1`), but after a reload the profile still shows **Follow** from a cached copy. The extension remembers follows the server confirmed and re-labels that button **Following ✓ (Confirmed)** (or **Requested ✓** for private accounts), with a green outline.
- Has a **dark popup** with a global on/off switch, a live count of errors fixed this session, and buttons to start and stop scrolling.

---

## Installation (load unpacked)

### Google Chrome / Chromium / Edge / Brave

1. Download or clone this folder. It should contain `manifest.json` at its top level.
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn on **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select this folder.
5. Pin the extension: click the puzzle icon in the toolbar, then the pin next to **TikTok Auto-Fix & Following Helper**.
6. **Reload any TikTok tabs that were already open.** The popup can also inject the helper into an open tab when you start auto-scroll.

### Antidetect browsers (GoLogin, Multilogin, AdsPower, Dolphin Anty, Incogniton, …)

Most of these are Chromium-based and load unpacked extensions per profile:

- **Option A — inside the profile:** start the profile, open `chrome://extensions`, turn on Developer mode, then click **Load unpacked** and pick this folder (same as above).
- **Option B — via the profile manager:** most tools have an *Extensions* section where you can upload a folder or a `.zip`. To build the zip, run this from the parent folder:
  ```bash
  zip -r tiktok-auto-fix.zip Dolagtiktok -x "*.git*"
  ```
  Then upload it and enable it for the profiles you want.
- Requires a **Chromium 111+** core, because `page-hook.js` uses `"world": "MAIN"`. Almost every current antidetect build meets this.
- Each profile has its own storage, so the on/off switch and the counter are kept per profile.

### Updating

After changing files, click the **↻ reload** icon on the extension card in `chrome://extensions`, then reload your TikTok tabs.

---

## Usage

| Control | What it does |
|---|---|
| **Auto-Fix errors** switch | Turns error recovery on or off in every tab. Saved in `chrome.storage.local`. On by default. |
| **errors fixed this session** | Live counter, also shown on the toolbar badge. Resets when the browser restarts. **Reset** sets it to zero. |
| **Start Auto-Scroll List** | Open a profile's *Following* / *Followers* popup on TikTok first, then click this. |
| **Stop Auto-Scroll** | Stops scrolling. You can also use the floating **Stop Scrolling** button on the page. |

| **Follow Sync** count | How many follows the server confirmed in the last 24 h, kept in local storage. |
| **Hard Refresh (Clear Cache)** | Reloads the active TikTok tab with `bypassCache: true`, like Ctrl+Shift+R. |
| **Clear Sync History** | Deletes the stored list of confirmed follows. |

The popup also shows the current tab's status: watching, fixing (attempt *n*/3), or given up on this URL.

---

## How it works

### Auto-fix routine (per URL)

```
error detected ──wait 2.5 s──► still there?
   attempt 1: click "Refresh" / "Làm mới"   → re-check after 4 s
   attempt 2: click "Refresh" / "Làm mới"   → re-check after 4 s
   attempt 3: delete msToken cookie (via background) + location.reload()
   attempt ≥ 3 and the error is back: circuit breaker opens → console.warn, no further action
```

- **Detection:** a `MutationObserver` on `document.body` (throttled to one scan every 400 ms) walks text nodes looking for a visible node whose trimmed text is exactly `Something went wrong` or `Đã xảy ra sự cố`. Text inside inputs and contenteditable fields is ignored, so comments and captions don't cause false positives.
- **Refresh button:** found by searching outward from the error text through up to 7 parent elements for a `button` / `[role=button]` labelled `Refresh`, `Làm mới`, `Try again` or `Thử lại`. If none is found, it searches the whole page. If there is still no button, it goes straight to the hard reset.
- **Saved state:** stored in `sessionStorage` under `ttaf:retry:<location.href>`, so the attempt count survives the extension's own reload, and the circuit breaker still applies after it.
- **Reset on navigation:** `page-hook.js` runs in the page's main JS context and wraps `history.pushState` / `replaceState` / `popstate`, then sends an event that `content.js` listens for. As backups it also uses the Navigation API and a 1-second URL check. When the URL changes, all retry state is cleared. A brand-new page load (anything other than a reload) also starts fresh.
- **What counts as "fixed":** the error is gone 4 s after a button click, or the page stays error-free for 6 s after the hard reload.

### Auto-scroll

- **Finds its targets again on every tick (every 1.8 s).** It doesn't use fixed class names. Each tick it scrolls every visible `div` that has `overflow-y: auto|scroll`, `scrollHeight > clientHeight + 20` and `clientHeight > 150`. It also scrolls `[data-e2e="follow-info-popup"] > div:last-child`, `div[class*="DivUserListContainer"]` and `document.scrollingElement`. If TikTok swaps out the list element, the next tick picks up the new one.
- **For each target:** sets `scrollTop = scrollHeight`, then sends a `scroll` event and a `WheelEvent` (`deltaY: 800`). After that it calls `window.scrollTo(0, document.body.scrollHeight)`.
- **Detecting the end of the list:** a tick counts as empty only if none of these grew: the tallest container's `scrollHeight`, the number of `a[href*="/@"]` links, or the number of different profiles seen so far. The last one matters because TikTok's list removes old rows from the page as you scroll. After **12 empty ticks in a row (~21 s)** it stops, which leaves time for slow proxies.
- **Runs inside the page, not the popup.** The scroll loop runs in `content.js`, so closing the popup doesn't stop it. When you reopen the popup it asks `GET_SCROLL_STATUS` and shows the live state, about how many accounts are loaded, and why the last run ended.
- **It also stops** when you press Stop (in the popup or on the page) or when you go to another page.

### Follow Sync (stale cache fix)

1. **`interceptor.js`** runs in the page's main JS context at `document_start` and wraps `window.fetch` and `XMLHttpRequest`. It only reads a copy of each response and never changes requests.
   - `/api/commit/follow/user/` with `status_code === 0` (or `statusCode`): it reads `user_id` / `sec_user_id` from the URL or request body and `follow_status` from the response. If `follow_status` is missing, it uses the request's `type` (1 = follow, 0 = unfollow). It then dispatches `TT_FOLLOW_STATE_CONFIRMED` with `{ username, userId, secUid, followStatus, timestamp }`.
   - `/api/user/detail/`, `/api/user/list/`, `…/item_list/` and the page's `__UNIVERSAL_DATA_FOR_REHYDRATION__` data are used only to link user IDs to `@usernames`. This way a follow made from another profile's Followers popup is saved under the right account, not under the profile in the address bar.
2. **`content.js` (FollowSync)** saves each confirmation in `chrome.storage.local` under `ttFollowConfirmed`. Entries expire after **24 h**. `follow_status` 1 (following), 2 (friends) and 4 (requested) are saved; 0 (unfollowed) deletes the entry right away. On a profile page (`/@name`), a `MutationObserver` looks for the header's main follow button. If the account is in the saved list but TikTok still shows **Follow**, the button is re-labelled using CSS only (a `data-ttfs-confirmed` attribute and `::after`). TikTok's own DOM isn't edited, so its re-renders can't break the page. When TikTok shows the real state again, the label is removed.
3. **`rules.json` (declarativeNetRequest)** sends `Cache-Control: no-cache` / `Pragma: no-cache` on `/api/user/detail/` requests. It also forces `Cache-Control: no-store` on those responses and on profile pages (`/@name`), so the browser stops serving them from cache.
4. **`background.js`** handles `HARD_RELOAD_TAB`, which calls `chrome.tabs.reload(tabId, { bypassCache: true })` and only works on TikTok tabs.

Clicking a re-labelled button still runs TikTok's own action. Because TikTok thinks you don't follow yet, it sends another follow, which changes nothing on the server. The page then shows **Following**, and you can unfollow normally.

### Messages between the parts

| From → To | Message | Reply |
|---|---|---|
| content → background | `TTAF_CLEAR_MSTOKEN` | `{ ok, removed }` |
| content → background | `TTAF_ERROR_FIXED` | `{ ok, count }` |
| content → popup (broadcast) | `TTAF_SCROLL_STATE` | — |
| popup → background | `TTAF_GET_COUNTER`, `TTAF_RESET_COUNTER` | `{ ok, count }` |
| popup → content | `START_SCROLL`, `STOP_SCROLL`, `GET_SCROLL_STATUS` (`TTAF_`-prefixed aliases also accepted) | `{ isScrolling, estimatedUsers, emptyAttempts, … }` |
| popup → content | `TTAF_PING`, `TTAF_GET_STATUS` (includes `followSync`), `TTFS_GET_STATUS` | status object |
| popup / content → background | `HARD_RELOAD_TAB` (`tabId` required from the popup) | `{ ok, tabId }` or `{ ok: false, error }` |
| popup → background | `CLEAR_FOLLOW_SYNC` | `{ ok }` |
| interceptor → content (window event) | `TT_FOLLOW_STATE_CONFIRMED`, `TT_USER_IDENTITY` | — |
| content → interceptor (window event) | `TT_INTERCEPTOR_SYNC_REQUEST` (replays the user IDs and usernames seen so far) | — |

---

## Permissions

| Permission | Why |
|---|---|
| `storage` | Saves the on/off switch (`local`), the session counter (`session`) and the confirmed-follow list (`local`, 24 h TTL). |
| `declarativeNetRequest` | Static no-cache header rules in `rules.json` (TikTok profile pages and `/api/user/detail/` only). |
| `cookies` | Deletes the `msToken` cookie on attempt 3. It's HttpOnly, so the page itself can't delete it. |
| `activeTab`, `scripting` | Lets the popup inject `content.js` into a TikTok tab that was open before the extension was installed. |
| host `*://*.tiktok.com/*` | Runs the content scripts and reads and removes cookies on TikTok only. |

No analytics, no remote code, and the extension sends no network requests of its own.

---

## Project structure

```
manifest.json            MV3 manifest
background.js            Service worker: msToken removal, counter, toolbar badge
interceptor.js           Main-context fetch/XHR reader (follow results, user IDs and usernames)
page-hook.js             Main-context history hook (catches SPA navigation)
rules.json               declarativeNetRequest no-cache rules
content.js               Error detection, auto-fix routine, URL watcher, auto-scroller
popup.html / .css / .js  Popup UI
icons/icon{16,48,128}.png
scripts/generate_icons.py  Rebuilds the icons with no dependencies: python3 scripts/generate_icons.py
```

## Troubleshooting

- Open DevTools on the TikTok tab and filter the console for `[TT Auto-Fix]` or `[TT Follow-Sync]` to see each step.
- **"Circuit breaker open"** means the error came back after all 3 attempts. Go to another page and back, or reload, to try again.
- **"Reload the TikTok tab to activate the helper"** means the tab was open before the extension was installed or updated. Reload the tab.
