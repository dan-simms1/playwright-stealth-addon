# Changelog

## 1.0.0 - 2026-05-12

First stable public release. The pre-release iteration (v0.x) has been squashed; this is the maintained public surface.

### What this is

A Home Assistant add-on that wraps [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (a Playwright fork shipping a Chromium binary patched at the C++ source level to remove automation tells) in a generic HTTP flow runner. Any caller that wants stealth-aware browser automation over HTTP can use it.

### Features

- **HTTP flow runner** on port 3001 with two endpoints:
  - `GET /healthz` - liveness check.
  - `POST /run-flow` - runs a structured action list, returns cookies.
- **Action vocabulary** for declarative flow scripting: `goto`, `wait_for_url_*`, `wait_for_selector_*`, `click`, `click_if_present`, `hover`, `mouse_move`, `scroll`, `set_value`, `type` (with per-keystroke jitter), `sleep_ms`, `sleep_ms_jitter`, `screenshot`, `save_state`, `assert_url_host`, `get_cookies`. Callers cannot inject arbitrary JavaScript.
- **Argument substitution** via `${name}` placeholders pulled from the request's `args` object, so credentials never live inside action streams.
- **Persistent profiles**: include a `profile: "name"` field in the request and the runner loads `/data/profiles/<name>.json` at launch (Playwright's `storageState` shape) and saves the updated state on success. Lets cookie history accumulate across runs.
- **Patchright-based stealth**: the bundled Chromium has automation tells removed at the binary level. `navigator.webdriver = false`, no `--enable-automation` effects, no `Runtime.enable` CDP indicator. No JS-layer evader artefacts.
- **Optional Xvfb + x11vnc + noVNC viewer** on port 7901 for live browser observation. Refuses to start with an empty `vnc_password` (no insecure default).
- **Multi-arch image**: `amd64` and `aarch64`.

### Security defaults

- VNC viewer **off** by default. When enabled, refuses to start without a non-empty `vnc_password`.
- The flow runner does NOT authenticate. Anyone who can reach port 3001 can drive a Chromium session on the host. Do not expose to untrusted networks; do not forward the port from the router.

### Installation

\`\`\`
Settings -> Add-ons -> Add-on Store -> three-dot menu -> Repositories
Add: https://github.com/dan-simms1/playwright-stealth-addon
\`\`\`

First start downloads the patched Chromium (~250 MB). Subsequent starts are instant.

### Companion add-on

The sister addon [nodriver-stealth-addon](https://github.com/dan-simms1/nodriver-stealth-addon) exposes the same HTTP API over a Python + nodriver stack. Profiles are interchangeable; pick whichever scores higher against your target site.
