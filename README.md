# Patchright Stealth Browser add-on for Home Assistant

A Home Assistant add-on that runs [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)
(a Playwright fork shipping a Chromium binary patched at the C++ source
level to remove automation tells). Exposes a generic HTTP flow runner that
takes structured action lists and returns cookies.

This add-on is unofficial and not affiliated with Microsoft, the Playwright
project or any browser vendor.

This is a generic helper. It has no site-specific knowledge. Any caller
that wants stealth-aware browser automation over HTTP can use it.

A sister add-on, [nodriver-stealth-addon](https://github.com/dan-simms1/nodriver-stealth-addon),
exposes the same HTTP API on top of a Python + nodriver stack. The two are
interchangeable from a caller's perspective; pick whichever scores higher
on your target site.

## What this provides

- Flow runner HTTP service on port 3001 with two endpoints:
  - `GET /healthz` — liveness check.
  - `POST /run-flow` — runs a structured action list, returns cookies.
- Per-request profile persistence so cookie history carries across runs.
- Action vocabulary covering navigation, waits, clicks, hover, mouse
  movement, scroll, typing with per-keystroke jitter, and explicit
  state-save checkpoints.
- Optional Xvfb + x11vnc + noVNC stack so any caller that requests headed
  mode can have its browser observed live in the noVNC console at port
  7901.
- Multi-arch image (amd64, aarch64).

## Why Patchright

Earlier versions used vanilla Playwright with the `puppeteer-extra-plugin-stealth`
JS-layer mask plugin. That works for sites that fingerprint via
`navigator.webdriver` or `--enable-automation`, but the static UA lie
(claiming Windows on a Linux container) creates a TLS-vs-UA inconsistency
that more aggressive WAFs (Akamai, Cloudflare) can detect.

Patchright removes the same automation tells at the binary level. The
Chromium binary is genuine Linux Chrome with the automation flags removed —
no JS lies needed, no TLS-vs-UA mismatch.

## Installing

1. **Settings → Add-ons → Add-on Store** in Home Assistant.
2. Three-dot menu → **Repositories**.
3. Add `https://github.com/dan-simms1/playwright-stealth-addon`.
4. Install **Patchright Stealth Browser**, set options if you want, then
   **Start**.

First start is slower than subsequent ones because Patchright's postinstall
downloads its patched Chromium binary (~250 MB). One-time cost.

## Configuration

| Option | Default | Notes |
|---|---|---|
| `runner_port` | `3001` | Port the flow runner listens on. |
| `log_level` | `info` | Playwright debug level. One of `silent`, `error`, `warn`, `info`, `debug`, `trace`. |
| `vnc_enabled` | `false` | When true, runs Xvfb + x11vnc + noVNC alongside the runner and switches the browser to headed mode. |
| `vnc_password` | _empty_ | Password for the noVNC viewer. **Required** when `vnc_enabled=true`. The add-on refuses to start VNC services with an empty password (the flow runner still starts; only the viewer is suppressed). |

## Endpoints

### `GET /healthz`

Returns `{"ok": true}`. For caller-side reachability checks.

### `POST /run-flow`

Body shape:

```json
{
  "actions": [
    { "goto": "https://example.com/login" },
    { "click_if_present": "#cookie-banner-accept" },
    { "wait_for_selector": "#email" },
    { "type": { "selector": "#email", "value": "${user}", "delay_ms": 90, "delay_jitter_ms": 60 } },
    { "type": { "selector": "#password", "value": "${pass}", "delay_ms": 90, "delay_jitter_ms": 60 } },
    { "click": "#submit" },
    { "wait_for_url_host": "example.com" },
    { "get_cookies": { "domain_filter": "example.com" } }
  ],
  "args": { "user": "...", "pass": "..." },
  "context": { "locale": "en-GB", "timezone_id": "Europe/London" },
  "profile": "example-profile"
}
```

Returns `{ "result": "ok", "elapsed_ms": <int>, "cookies": { ... } }` on
success, or `{ "error": "<message>", "failed_action_index": <int> }` with a
4xx/5xx status on failure.

### Action vocabulary

| Action | Notes |
|---|---|
| `{ goto: "url" }` | Navigate the page. |
| `{ wait_for_url_host: "host" }` | Wait until `URL.hostname === "host"`. |
| `{ wait_for_url_contains: "substring" }` | Wait until URL contains the substring. |
| `{ wait_for_url_not_contains: "substring" }` | Wait until URL no longer contains it. |
| `{ wait_for_selector: "css", state?: "visible"\|"attached"\|"hidden" }` | Standard Playwright wait. Default state is `visible`. |
| `{ wait_for_selector_visible_via_css: "css" }` | Wait until `getComputedStyle(el).display !== 'none'`. |
| `{ click: "css" }` | Click an element. Fails if not clickable. |
| `{ click_if_present: "css" }` | Best-effort click. Missing elements are not an error. |
| `{ hover: "css" }` | Move the cursor to an element with stepped events. |
| `{ mouse_move: { x, y, steps? } }` | Stepped cursor move to absolute coords. |
| `{ mouse_move: { selector, steps?, timeout_ms? } }` | Stepped cursor move to an element's centre. |
| `{ scroll: { y } }` | Scroll the page by Y pixels. |
| `{ scroll: { selector } }` | Scroll an element into view. |
| `{ set_value: { selector, value } }` | Set an input value via the React-friendly prototype setter. Fast but skips key events. |
| `{ type: { selector, value, delay_ms?, delay_jitter_ms? } }` | Real typing via `pressSequentially` with optional per-keystroke jitter. Use for inputs that fingerprint as automated when set programmatically. |
| `{ sleep_ms: <int> }` | Fixed sleep. |
| `{ sleep_ms_jitter: [min, max] }` | Random sleep in `[min, max]` ms. |
| `{ screenshot: "/path" }` | Save a full-page screenshot. |
| `{ save_state: true }` | Commit the current cookies + localStorage to the request's `profile` mid-flow. |
| `{ assert_url_host: "host" }` | Throw if hostname does not match. |
| `{ get_cookies: { domain_filter? } }` | Read cookies from the browser context. Result populates the response's `cookies` field. |

All actions accept an optional `timeout_ms` (default 30000).

### Argument substitution

Any string value in an action can include `${name}` placeholders that are
substituted from the request's `args` object before the action runs. Use this
to keep credentials out of the action stream itself.

### Persistent profiles

If a request includes `"profile": "name"` the runner loads
`/data/profiles/<name>.json` (Playwright's `storageState` shape: cookies +
localStorage) into the browser context at launch and saves the updated state
back on a successful flow. This lets cookie history accumulate across runs.
Profiles save only on success so a failed run does not poison the
last-known-good state. The `save_state: true` action commits mid-flow for
long-running flows that want crash-resistant checkpointing.

## Live observation

With `vnc_enabled: true` the runner launches Chromium headed against the
Xvfb display. Open `http://<ha-ip>:7901/vnc.html` and enter the
`vnc_password` to watch flows in real time. When you are done debugging,
set `vnc_enabled: false` and restart the add-on so port 7901 closes again.

## Security

**The flow runner does not authenticate.** Anyone who can reach port 3001 or
7901 can drive a Chromium session on your hardware:

- Open browsers on your behalf, including login forms.
- Read and exfiltrate any cookies set during a session.
- Probe other services on your local network from the browser.
- Watch other users' login flows live via the noVNC viewer when
  `vnc_enabled=true`.

The action vocabulary is fixed (callers cannot inject arbitrary JavaScript)
but the actions themselves are powerful enough to compromise sessions on any
reachable site.

Treat this add-on as you would treat a remote-execution endpoint.

### Recommended hardening

- **Do not forward port 3001 or 7901 from your router. Ever.**
- **Keep the home network isolated.** Untrusted devices on the same Wi-Fi
  can talk to the add-on by default. A guest VLAN is a sensible perimeter.
- **Set a strong `vnc_password`** if you enable VNC. The add-on refuses to
  start VNC at all when the password is empty (no insecure default).
- **Other Home Assistant add-ons can also reach this service** via the
  supervisor's add-on network. Anything you would not trust to drive a
  browser as you, do not install on the same Home Assistant.

## What is inside the image

Layered on top of `mcr.microsoft.com/playwright:v1.51.0-jammy` for the
system fonts and shared libraries. The Patchright npm package and its
patched Chromium are installed on first run; the patched binary lives at
`/ms-playwright/chromium-12xx/chrome-linux/chrome` and is what the runner
launches.

The add-on adds:

- Xvfb + x11vnc + noVNC for the optional VNC viewer.
- A small Node.js flow runner under `/srv/runner` (Express + Patchright,
  pinned versions).
- A launcher script that reads `/data/options.json`, optionally starts Xvfb
  / x11vnc / noVNC, installs runner deps + Patchright Chromium on first
  start, and runs the flow runner.

## Licence

MIT. See `LICENSE`.

The Patchright project is MIT-licensed. The bundled Microsoft Playwright
base image is Apache 2.0. Chromium itself is BSD and others.
