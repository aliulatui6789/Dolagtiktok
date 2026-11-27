# TikTok Auto-Fix & Following Helper

A lightweight Chrome extension (Manifest V3, vanilla JS, no build step) for `*.tiktok.com` that:

- **Auto-fixes the "Something went wrong" / "Đã xảy ra sự cố" error** that TikTok's web app sometimes shows, using a retry routine with a circuit breaker so it can't get stuck reloading forever.
- **Auto-scrolls Following / Followers lists** until the end of the list, with Stop controls in both the popup and the page.
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

- **What it scrolls:** the largest scrollable element inside `[data-e2e="follow-info-popup"]`. If that isn't found, it tries any open `[role=dialog]`, then the largest scrollable element on the page, then the page itself.
- **Every 1.6 s** it sends a `WheelEvent` (which triggers TikTok's lazy-loading) and smooth-scrolls `scrollTop` to the bottom.
- **It stops** after **8 checks in a row** with no increase in `scrollHeight`, if you stop it, if you navigate, or if the list disappears.

### Messages between the parts

| From → To | Message | Reply |
|---|---|---|
| content → background | `TTAF_CLEAR_MSTOKEN` | `{ ok, removed }` |
| content → background | `TTAF_ERROR_FIXED` | `{ ok, count }` |
| content → popup (broadcast) | `TTAF_SCROLL_STATE` | — |
| popup → background | `TTAF_GET_COUNTER`, `TTAF_RESET_COUNTER` | `{ ok, count }` |
| popup → content | `TTAF_PING`, `TTAF_START_SCROLL`, `TTAF_STOP_SCROLL`, `TTAF_GET_STATUS` | status object |

---

## Permissions

| Permission | Why |
|---|---|
| `storage` | Saves the on/off switch (`local`) and the session counter (`session`). |
| `cookies` | Deletes the `msToken` cookie on attempt 3. It's HttpOnly, so the page itself can't delete it. |
| `activeTab`, `scripting` | Lets the popup inject `content.js` into a TikTok tab that was open before the extension was installed. |
| host `*://*.tiktok.com/*` | Runs the content scripts and reads and removes cookies on TikTok only. |

No analytics, no remote code, no network requests.

---

## Project structure

```
manifest.json            MV3 manifest
background.js            Service worker: msToken removal, counter, toolbar badge
page-hook.js             Main-context history hook (catches SPA navigation)
content.js               Error detection, auto-fix routine, URL watcher, auto-scroller
popup.html / .css / .js  Popup UI
icons/icon{16,48,128}.png
scripts/generate_icons.py  Rebuilds the icons with no dependencies: python3 scripts/generate_icons.py
```

## Troubleshooting

- Open DevTools on the TikTok tab and filter the console for `[TT Auto-Fix]` to see each step.
- **"Circuit breaker open"** means the error came back after all 3 attempts. Go to another page and back, or reload, to try again.
- **"Reload the TikTok tab to activate the helper"** means the tab was open before the extension was installed or updated. Reload the tab.
