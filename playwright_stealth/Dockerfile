FROM mcr.microsoft.com/playwright:v1.51.0-jammy

ENV LANG=C.UTF-8 \
    DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# jq for parsing the add-on's options.json at runtime.
# Xvfb + x11vnc + novnc support optional headed browser viewing via
# the noVNC web console; pulled in here so the runtime decision is
# just a config toggle, not a rebuild.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        jq \
        ca-certificates \
        xvfb \
        x11vnc \
        novnc \
        websockify \
        net-tools \
 && rm -rf /var/lib/apt/lists/*

COPY rootfs/ /
RUN chmod +x /usr/local/bin/run.sh

LABEL \
    io.hass.name="Playwright Stealth Browser" \
    io.hass.description="Playwright server bundling Chromium for stealth-aware automation." \
    io.hass.type="addon" \
    io.hass.version="0.4.0" \
    maintainer="Dan Simms <daniel@simmsfamily.me>"

CMD ["/usr/local/bin/run.sh"]
