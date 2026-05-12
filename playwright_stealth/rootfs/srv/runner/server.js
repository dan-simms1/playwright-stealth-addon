// Generic Playwright flow runner over HTTP.
//
// Exposes a single endpoint, `POST /run-flow`, that takes a structured
// list of actions and runs them against a Playwright browser context
// with stealth fingerprint masking applied. The action vocabulary is
// fixed and constrained: callers cannot inject arbitrary JavaScript.
// This keeps the add-on truly generic - any caller can drive any site
// using the same primitives - while leaving the call-site (the
// integration) responsible for the site-specific selectors and ordering.
//
// Action vocabulary (see runAction() for full semantics):
//   { goto: "https://..." }
//   { wait_for_url_host: "host.example", timeout_ms?: number }
//   { wait_for_url_contains: "substring", timeout_ms?: number }
//   { wait_for_url_not_contains: "substring", timeout_ms?: number }
//   { wait_for_selector: "css", state?: "attached"|"visible"|"hidden", timeout_ms?: number }
//   { wait_for_selector_visible_via_css: "css", timeout_ms?: number }
//   { click: "css", timeout_ms?: number }
//   { click_if_present: "css", timeout_ms?: number }
//   { hover: "css", timeout_ms?: number }
//   { mouse_move: { x: number, y: number, steps?: number }
//                | { selector: "css", steps?: number, timeout_ms?: number } }
//   { scroll: { y: number } | { selector: "css", timeout_ms?: number } }
//   { set_value: { selector: "css", value: "string" } }
//   { type: { selector: "css", value: "string", delay_ms?: number, delay_jitter_ms?: number } }
//   { sleep_ms: number }
//   { sleep_ms_jitter: [min: number, max: number] }
//   { screenshot: "/path/to/file.png" }
//   { save_state: true }   // commit profile mid-flow (no-op if no profile)
//   { assert_url_host: "host.example" }
//   { get_cookies: { domain_filter?: "substring" } }
//
// Strings in action values can reference entries in the request's `args`
// object via `${name}` placeholders - useful for keeping credentials out
// of the action stream. Example: { set_value: { selector: "#Email", value: "${email}" } }.
//
// Request body shape:
//   {
//     "actions": [ ... ],
//     "args": { "name": "value", ... },     // optional, used by ${name} substitutions
//     "context": {                            // optional Playwright context options
//       "locale": "en-GB",
//       "timezone_id": "Europe/London",
//       "viewport": { "width": 1920, "height": 1080 }
//     },
//     "profile": "name"                       // optional persistent profile id
//   }
//
// Response (success):
//   { "result": "ok", "elapsed_ms": <int>, "cookies": { name: value, ... } }
//
// Response (failure):
//   HTTP 4xx/5xx with { "error": "<message>", "failed_action_index": <int>, "elapsed_ms": <int> }
//
// Stealth: this runner uses `patchright`, a Playwright fork that
// ships a Chromium binary patched at the C++ source level to remove
// the standard automation tells (no `--enable-automation` effects,
// no `Runtime.enable` CDP indicator, native `navigator.webdriver`
// shadowing, etc.). No JS-layer stealth plugin is needed - the
// patches mean the browser is genuinely indistinguishable from a
// regular Chromium without lying about it being something it isn't.
// We still run a small init script to pin navigator.language(s) to
// the request locale, because Playwright's `locale` covers the
// HTTP/Intl surfaces but not navigator.languages.
//
// Persistent profiles: when a request includes `"profile": "name"`,
// the runner loads `/data/profiles/<name>.json` (Playwright's
// storageState format: cookies + localStorage) into the context at
// launch, and saves the updated state back on a successful flow. This
// gives reCAPTCHA's first-party cookies (NID, _GRECAPTCHA, etc.)
// continuity across runs, which is the dominant input to its score.
// Profiles are saved only on success so a failed run does not poison
// the last-known-good state.
//
// Headed vs headless: if the DISPLAY env var is set (the launcher
// script starts Xvfb when vnc_enabled=true), browsers launch in
// `headless: false` mode and are visible in the noVNC console.

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { chromium } = require('patchright');

const PORT = parseInt(process.env.RUNNER_PORT || '3001', 10);
const PROFILE_DIR = '/data/profiles';
const LOG = (...args) => console.log(new Date().toISOString(), '[runner]', ...args);

const app = express();
app.use(express.json({ limit: '128kb' }));

const REACT_VALUE_SETTER = `
([sel, val]) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('missing ' + sel);
    const proto = el.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
}
`.trim();

function substArgs(value, args) {
    if (typeof value !== 'string') return value;
    return value.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, key) => {
        if (Object.prototype.hasOwnProperty.call(args, key)) {
            return String(args[key]);
        }
        return m;
    });
}

function profilePath(name) {
    // Constrain to a-z0-9_- to avoid path traversal. Reject anything else.
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
        throw new Error(`invalid profile name: ${name}`);
    }
    return path.join(PROFILE_DIR, `${name}.json`);
}

async function loadStorageState(profile) {
    if (!profile) return undefined;
    const p = profilePath(profile);
    try {
        const raw = await fs.promises.readFile(p, 'utf8');
        const parsed = JSON.parse(raw);
        LOG(`profile '${profile}': loaded storage state from ${p}`);
        return parsed;
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            LOG(`profile '${profile}': no saved state at ${p}, starting fresh`);
            return undefined;
        }
        LOG(`profile '${profile}': failed to load state (${err.message}), starting fresh`);
        return undefined;
    }
}

async function saveStorageState(profile, context) {
    if (!profile) return;
    const p = profilePath(profile);
    try {
        await fs.promises.mkdir(PROFILE_DIR, { recursive: true });
        const state = await context.storageState();
        await fs.promises.writeFile(p, JSON.stringify(state), 'utf8');
        const cookieCount = (state.cookies || []).length;
        const originCount = (state.origins || []).length;
        LOG(`profile '${profile}': saved storage state (${cookieCount} cookies, ${originCount} origins)`);
    } catch (err) {
        LOG(`profile '${profile}': failed to save state: ${err.message}`);
    }
}

function jitterPick(range) {
    if (!Array.isArray(range) || range.length !== 2) {
        throw new Error('sleep_ms_jitter expects [min, max]');
    }
    const [min, max] = range.map(n => Number(n));
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
        throw new Error(`sleep_ms_jitter expects non-negative [min, max]; got ${JSON.stringify(range)}`);
    }
    return Math.floor(min + Math.random() * (max - min + 1));
}

async function runAction(page, context, action, args) {
    const t = action.timeout_ms || 30000;

    if (action.goto !== undefined) {
        const url = substArgs(action.goto, args);
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        return null;
    }

    if (action.wait_for_url_host !== undefined) {
        const expected = substArgs(action.wait_for_url_host, args);
        await page.waitForURL(url => {
            try { return new URL(url).hostname === expected; }
            catch { return false; }
        }, { timeout: t });
        return null;
    }

    if (action.wait_for_url_contains !== undefined) {
        const needle = substArgs(action.wait_for_url_contains, args);
        // Playwright's waitForURL callback receives a URL object, not a
        // string. URL objects do not have `.includes()`; use `.href`.
        await page.waitForURL(url => String(url.href || url).includes(needle), { timeout: t });
        return null;
    }

    if (action.wait_for_url_not_contains !== undefined) {
        const needle = substArgs(action.wait_for_url_not_contains, args);
        await page.waitForURL(url => !String(url.href || url).includes(needle), { timeout: t });
        return null;
    }

    if (action.wait_for_selector !== undefined) {
        const sel = substArgs(action.wait_for_selector, args);
        const state = action.state || 'visible';
        await page.waitForSelector(sel, { state, timeout: t });
        return null;
    }

    if (action.wait_for_selector_visible_via_css !== undefined) {
        // Some forms toggle visibility via display:none rather than via
        // attached/detached (e.g. tabbed login flows). Playwright's
        // `state: visible` uses bounding-box checks, but a parent with
        // display:none can mask a child whose bounding box is non-zero
        // in some layouts. This explicitly checks getComputedStyle.
        const sel = substArgs(action.wait_for_selector_visible_via_css, args);
        await page.waitForFunction(s => {
            const el = document.querySelector(s);
            return el && getComputedStyle(el).display !== 'none';
        }, sel, { timeout: t });
        return null;
    }

    if (action.click !== undefined) {
        const sel = substArgs(action.click, args);
        await page.locator(sel).click({ timeout: t });
        return null;
    }

    if (action.click_if_present !== undefined) {
        const sel = substArgs(action.click_if_present, args);
        try {
            await page.locator(sel).click({ timeout: action.timeout_ms || 2000 });
        } catch (_) {
            // Best-effort: missing element is not a flow failure.
        }
        return null;
    }

    if (action.hover !== undefined) {
        // Playwright's locator.hover() is itself stepped (multiple
        // mouse events between origin and target), which on its own is
        // a meaningful behavioural signal vs a teleporting click.
        const sel = substArgs(action.hover, args);
        await page.locator(sel).hover({ timeout: t });
        return null;
    }

    if (action.mouse_move !== undefined) {
        const m = action.mouse_move;
        const steps = Math.max(1, parseInt(m.steps || 25, 10));
        if (m.selector !== undefined) {
            const sel = substArgs(m.selector, args);
            const handle = await page.waitForSelector(sel, { state: 'visible', timeout: t });
            const box = await handle.boundingBox();
            if (!box) throw new Error(`mouse_move: selector ${sel} has no bounding box`);
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            await page.mouse.move(x, y, { steps });
            return null;
        }
        const x = Number(m.x);
        const y = Number(m.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error('mouse_move: provide either { selector } or numeric { x, y }');
        }
        await page.mouse.move(x, y, { steps });
        return null;
    }

    if (action.scroll !== undefined) {
        const s = action.scroll;
        if (s.selector !== undefined) {
            const sel = substArgs(s.selector, args);
            await page.locator(sel).scrollIntoViewIfNeeded({ timeout: t });
            return null;
        }
        const dy = Number(s.y);
        if (!Number.isFinite(dy)) {
            throw new Error('scroll: provide either { selector } or numeric { y }');
        }
        await page.evaluate(d => window.scrollBy(0, d), dy);
        return null;
    }

    if (action.set_value !== undefined) {
        const sel = substArgs(action.set_value.selector, args);
        const val = substArgs(action.set_value.value, args);
        await page.evaluate(REACT_VALUE_SETTER, [sel, val]);
        return null;
    }

    if (action.type !== undefined) {
        // Real keyboard-style typing. Triggers React state updates
        // even on forms that ignore programmatic value sets, and looks
        // human to fingerprinting heuristics.
        //
        // delay_ms is the base inter-keystroke delay. delay_jitter_ms,
        // if provided, adds a uniform-random offset in
        // [-jitter/2, +jitter/2] per keystroke (clamped at 0). Even a
        // small jitter (~30ms) breaks the perfectly-uniform cadence
        // that bot detectors latch onto.
        const sel = substArgs(action.type.selector, args);
        const val = substArgs(action.type.value, args);
        const baseDelay = parseInt(action.type.delay_ms || 50, 10);
        const jitter = parseInt(action.type.delay_jitter_ms || 0, 10);
        const locator = page.locator(sel);
        await locator.click({ timeout: t });  // focus the field
        await locator.fill('');                 // clear any prefill
        if (jitter > 0) {
            for (const ch of val) {
                const d = Math.max(0, baseDelay + Math.floor((Math.random() - 0.5) * jitter));
                await page.keyboard.type(ch, { delay: d });
            }
        } else {
            await locator.pressSequentially(val, { delay: baseDelay, timeout: t });
        }
        return null;
    }

    if (action.sleep_ms !== undefined) {
        await page.waitForTimeout(action.sleep_ms);
        return null;
    }

    if (action.sleep_ms_jitter !== undefined) {
        const ms = jitterPick(action.sleep_ms_jitter);
        await page.waitForTimeout(ms);
        return null;
    }

    if (action.screenshot !== undefined) {
        const out = substArgs(action.screenshot, args);
        await page.screenshot({ path: out, fullPage: true });
        return null;
    }

    if (action.save_state !== undefined) {
        // Long flows (seasoning, multi-step warmups) benefit from
        // mid-flight checkpointing: a browser/page crash later in the
        // flow then loses at most the work since the last save_state.
        // No-op when no profile was supplied. The runner treats this
        // the same as the flow-end save: explicit saves only happen
        // on the success path of each individual action.
        const profileName = (page._runtimeProfile || null);
        const ctx = page.context();
        if (profileName) {
            await saveStorageState(profileName, ctx);
        } else {
            LOG('save_state: no profile in this request, skipping');
        }
        return null;
    }

    if (action.assert_url_host !== undefined) {
        const expected = substArgs(action.assert_url_host, args);
        const got = new URL(page.url()).hostname;
        if (got !== expected) {
            throw new Error(`expected URL host '${expected}', got '${got}'`);
        }
        return null;
    }

    if (action.get_cookies !== undefined) {
        const filter = substArgs(action.get_cookies.domain_filter || '', args).toLowerCase();
        const raw = await context.cookies();
        const result = {};
        for (const c of raw) {
            const domain = (c.domain || '').toLowerCase().replace(/^\./, '');
            if (filter && !(domain === filter || domain.endsWith('.' + filter))) continue;
            if (typeof c.name === 'string' && typeof c.value === 'string') {
                result[c.name] = c.value;
            }
        }
        return { cookies: result };
    }

    throw new Error('unknown action keys: ' + JSON.stringify(Object.keys(action)));
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/run-flow', async (req, res) => {
    const { actions, args = {}, context: ctxOpts = {}, profile } = req.body || {};

    if (!Array.isArray(actions) || actions.length === 0) {
        return res.status(400).json({ error: 'actions must be a non-empty array' });
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return res.status(400).json({ error: 'args must be an object' });
    }

    let storageState;
    if (profile !== undefined && profile !== null) {
        try {
            storageState = await loadStorageState(profile);
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }
    }

    const headless = !process.env.DISPLAY;
    const start = Date.now();
    let browser;
    let cookies = null;

    try {
        if (!headless) LOG('launching headed Chromium against', process.env.DISPLAY);
        // Patchright's docs are explicit: do NOT pass automation-
        // defeat flags - the patched Chromium handles them
        // internally and adding them re-introduces detectable
        // signatures. We keep only what is strictly required for
        // running as root in the HA add-on container.
        browser = await chromium.launch({
            headless,
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
        });
        const locale = ctxOpts.locale || 'en-GB';
        const context = await browser.newContext({
            locale,
            timezoneId: ctxOpts.timezone_id || 'Europe/London',
            viewport: ctxOpts.viewport || { width: 1920, height: 1080 },
            storageState,
        });
        context.setDefaultTimeout(30_000);
        // Stash the profile name on the page so the save_state action
        // can find it without threading another argument down to
        // runAction. Profile is per-request, page is per-flow.
        const profileForSaves = profile || null;

        // Align navigator.language / navigator.languages with the
        // context locale. Playwright's `locale` option already drives
        // Accept-Language, navigator.language, and Intl resolved
        // options - but `puppeteer-extra-plugin-stealth`'s evader
        // reintroduces a fixed `en-US,en` for navigator.languages on
        // top of that. Bot detectors that cross-check the JS-visible
        // language against the Accept-Language header flag the
        // inconsistency. We define own properties on `navigator`
        // (which shadow stealth's prototype-level patch regardless
        // of init-script ordering), and freeze the array because the
        // native `navigator.languages` returns a frozen array - an
        // unfrozen one is itself a fingerprint.
        const langPrimary = locale;
        const langBase = locale.split('-')[0];
        const languages = langPrimary === langBase
            ? [langPrimary]
            : [langPrimary, langBase];
        await context.addInitScript((langs) => {
            const frozenLangs = Object.freeze([...langs]);
            Object.defineProperty(navigator, 'language', {
                get: () => frozenLangs[0],
                configurable: true,
            });
            Object.defineProperty(navigator, 'languages', {
                get: () => frozenLangs,
                configurable: true,
            });
        }, languages);

        const page = await context.newPage();
        page._runtimeProfile = profileForSaves;

        for (let i = 0; i < actions.length; i++) {
            const action = actions[i];
            const actionType = Object.keys(action).find(k => k !== 'timeout_ms' && k !== 'state') || 'unknown';
            LOG(`action ${i}: ${actionType} ${JSON.stringify(action[actionType] || {}).slice(0, 120)}`);
            try {
                const result = await runAction(page, context, action, args);
                if (result && result.cookies) cookies = result.cookies;
            } catch (err) {
                const msg = err && err.message ? err.message : String(err);
                LOG(`action ${i} failed (${actionType}): ${msg}`);
                // Persist a screenshot + page source + current URL so the
                // user can inspect what the browser was looking at when
                // the action failed. Files land in /tmp inside the addon
                // container; pull with `docker cp`.
                const stamp = Date.now();
                try {
                    await page.screenshot({ path: `/tmp/runner_fail_${stamp}.png`, fullPage: true });
                    LOG(`saved screenshot to /tmp/runner_fail_${stamp}.png`);
                } catch (_) { /* ignore */ }
                try {
                    const html = await page.content();
                    require('fs').writeFileSync(`/tmp/runner_fail_${stamp}.html`, html);
                    LOG(`saved page source to /tmp/runner_fail_${stamp}.html`);
                } catch (_) { /* ignore */ }
                try {
                    LOG(`failure url: ${page.url()}`);
                } catch (_) { /* ignore */ }
                return res.status(502).json({
                    error: msg,
                    failed_action_index: i,
                    failure_url: (() => { try { return page.url(); } catch { return null; } })(),
                    elapsed_ms: Date.now() - start,
                });
            }
        }

        // Persist the updated profile only on full-flow success.
        // A partial state from a failed run could carry forward stale
        // or rejected cookies and poison subsequent attempts.
        if (profile) {
            await saveStorageState(profile, context);
        }

        const elapsed = Date.now() - start;
        const cookieCount = cookies ? Object.keys(cookies).length : 0;
        LOG(`flow OK in ${elapsed}ms (${actions.length} actions, ${cookieCount} cookies)`);
        res.json({
            result: 'ok',
            elapsed_ms: elapsed,
            cookies: cookies || {},
        });
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        LOG('flow setup failed:', msg);
        res.status(502).json({ error: msg, elapsed_ms: Date.now() - start });
    } finally {
        if (browser) {
            try { await browser.close(); } catch (_) { /* ignore cleanup errors */ }
        }
    }
});

app.listen(PORT, '0.0.0.0', () => LOG(`listening on 0.0.0.0:${PORT}`));
