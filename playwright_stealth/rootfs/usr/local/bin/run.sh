#!/usr/bin/env bash
set -eu

CONFIG=/data/options.json

RUNNER_PORT=3001
LOG_LEVEL=info
VNC_ENABLED="false"
VNC_PASSWORD=""
if [ -f "$CONFIG" ]; then
    RUNNER_PORT="$(jq -r '.runner_port // 3001' "$CONFIG")"
    LOG_LEVEL="$(jq -r '.log_level // "info"' "$CONFIG")"
    VNC_ENABLED="$(jq -r '.vnc_enabled // false' "$CONFIG")"
    VNC_PASSWORD="$(jq -r '.vnc_password // empty' "$CONFIG")"
fi

export DEBUG=
case "$LOG_LEVEL" in
    silent) export DEBUG="" ;;
    error)  export DEBUG="pw:error" ;;
    warn)   export DEBUG="pw:error,pw:warning" ;;
    info)   export DEBUG="pw:browser*,pw:api" ;;
    debug)  export DEBUG="pw:*" ;;
    trace)  export DEBUG="pw:*,pw:protocol" ;;
esac

# When VNC is enabled, start Xvfb + x11vnc + noVNC alongside the
# Playwright services. Callers that connect with `headless: false`
# (or the bundled flow runner, which auto-detects DISPLAY) will have
# their browser visible in the noVNC viewer at port 7901.
#
# noVNC bridges the VNC TCP server (x11vnc on :5900) to a websocket
# (port 7901) that any browser can open at
#   http://<ha-ip>:7901/vnc.html?autoconnect=1
# 7901 deliberately not 7900 to avoid clashing with the Selenium
# Standalone Chromium add-on.
if [ "$VNC_ENABLED" = "true" ]; then
    if [ -z "${VNC_PASSWORD:-}" ]; then
        echo "ERROR: vnc_enabled=true but vnc_password is empty."
        echo "       Refusing to start VNC services without a password."
        echo "       Set vnc_password in the add-on Configuration tab"
        echo "       and restart, or set vnc_enabled=false to disable"
        echo "       the VNC viewer."
        echo "       The flow runner will start as normal; only the"
        echo "       VNC viewer (port 7901) is suppressed."
    else
        DISPLAY_NUMBER=99
        export DISPLAY=":${DISPLAY_NUMBER}"

        echo "Starting Xvfb on ${DISPLAY}..."
        Xvfb "${DISPLAY}" -screen 0 1920x1080x24 -ac +extension RANDR &

        sleep 1

        echo "Starting x11vnc against ${DISPLAY}..."
        x11vnc \
            -display "${DISPLAY}" \
            -forever \
            -shared \
            -passwd "${VNC_PASSWORD}" \
            -rfbport 5900 \
            -quiet &

        echo "Starting noVNC websocket bridge on 0.0.0.0:7901..."
        websockify --web=/usr/share/novnc 7901 localhost:5900 >/dev/null 2>&1 &
    fi
else
    echo "noVNC disabled (vnc_enabled=false). Port 7901 will refuse connections."
fi

# Install runner deps on first run. Patchright's npm postinstall
# does NOT download the patched Chromium when PLAYWRIGHT_BROWSERS_PATH
# is preset by the base image; we need an explicit `patchright install
# chromium` step. This downloads ~250 MB and only happens once per
# container lifetime; the binary lands under /ms-playwright/
# alongside (and separate from) the base image's standard Chromium.
if [ ! -d /srv/runner/node_modules ]; then
    echo "Installing flow runner npm dependencies..."
    (cd /srv/runner && npm install --omit=dev --no-fund --no-audit)
fi

# Detect whether the patched Chromium is already installed. We
# check for a Patchright-versioned chromium directory; the base
# image ships `chromium-1161` which is the unpatched build and
# would defeat the whole point of this addon.
if ! ls -d /ms-playwright/chromium-12* >/dev/null 2>&1; then
    echo "Installing patched Chromium (first run; downloads ~250 MB)..."
    (cd /srv/runner && npx --yes patchright install chromium)
fi

# Foreground: the flow runner HTTP service. server.js inspects the
# DISPLAY env var: if set, browsers launch headed (visible via
# noVNC); otherwise headless.
echo "Starting flow runner on 0.0.0.0:${RUNNER_PORT}..."
exec env RUNNER_PORT="${RUNNER_PORT}" node /srv/runner/server.js
