/**
 * Verifies video-ad defusing on a simulated YouTube, in a real Chromium.
 *
 * YouTube serves its ads from the hosts that serve its videos, so no network
 * rule can remove them. What removes them is a set of scriptlets that edit the
 * player's own API traffic: the ad descriptors are taken out of the responses
 * before the player reads them. That set used to be absent from the build
 * while the build reported 99.5 % of scriptlets covered — by count it was a
 * rounding error, and by effect it was all of YouTube.
 *
 * So this check does not count anything. It serves pages shaped like the real
 * ones — same hostnames, same endpoints, same response fields, the same
 * Trusted Types policy — loads the built extension, and asks the only question
 * that matters: does the page end up with the ads in hand or not? The filters
 * exercised are the ones in the build, straight from the lists.
 *
 * It then reads the extension's Errors page, the way a user would on
 * chrome://extensions, and requires it to be empty. Wrapping `fetch` puts the
 * extension's frames under every request of the page, and Chrome attributes an
 * uncaught error to the script it surfaces in — so the page deliberately
 * leaves a failed request uncaught, and a deliberately aborted script, and
 * neither may be filed against the extension.
 *
 * The same pages are then served to the userscript — what runs on a phone,
 * where the extension cannot — with no extension loaded at all.
 *
 * What it cannot show is that the real site, today, plays without ads: that
 * depends on YouTube and on the lists keeping up with it.
 */

import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { preinstalledChromium } from '../../shared/chromium.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILT = join(ROOT, 'dist', 'extension');
const STAGED = join(ROOT, 'dist', 'youtube-check-extension');
const USERSCRIPT = join(ROOT, 'userscript', 'addblocker.user.js');

function resolveChromium(): string {
    const explicit = process.env.CHROMIUM_PATH;
    if (explicit !== undefined && explicit !== '') return explicit;
    const preinstalled = preinstalledChromium();
    if (preinstalled !== null) return preinstalled;
    const managed = chromium.executablePath();
    if (existsSync(managed)) return managed;
    throw new Error('no Chromium found');
}

type Invocation = string[];

/** Every invocation the build applies to `host`, parent domains included. */
async function invocationsFor(host: string): Promise<Invocation[]> {
    const out: Invocation[] = [];
    const files = (await readdir(join(BUILT, 'scriptlets'))).filter((f) => f.startsWith('scriptlets-'));
    for (const file of files) {
        const code = await readFile(join(BUILT, 'scriptlets', file), 'utf8');
        const match = /^const I = (\{.*\});$/m.exec(code);
        if (match === null) continue;
        const table = JSON.parse(match[1]) as Record<string, Invocation[]>;
        for (let domain = host; domain.includes('.'); domain = domain.slice(domain.indexOf('.') + 1)) {
            for (const invocation of table[domain] ?? []) {
                out.push(invocation[0].startsWith('~') ? invocation.slice(1) : invocation);
            }
        }
    }
    return out;
}

/** A domain where reading a property aborts the script, and that property. */
async function findAbortCase(): Promise<{ domain: string; property: string } | null> {
    const files = (await readdir(join(BUILT, 'scriptlets')))
        .filter((f) => /^scriptlets-\d/.test(f)).sort();
    for (const file of files) {
        const code = await readFile(join(BUILT, 'scriptlets', file), 'utf8');
        const match = /^const I = (\{.*\});$/m.exec(code);
        if (match === null) continue;
        const table = JSON.parse(match[1]) as Record<string, Invocation[]>;
        for (const [domain, invocations] of Object.entries(table)) {
            for (const [name, property] of invocations) {
                if (name === 'aopr' && property !== undefined && /^[A-Za-z_]\w*$/.test(property)
                    && !(property in globalThis)) {
                    return { domain, property };
                }
            }
        }
    }
    return null;
}

const AD_PLACEMENTS = [{
    adPlacementRenderer: {
        config: { adPlacementConfig: { kind: 'AD_PLACEMENT_KIND_START', adTimeOffset: { offsetStartMilliseconds: '0' } } },
        renderer: { adBreakServiceRenderer: { prefetchMilliseconds: '10000', getAdBreakUrl: 'https://www.youtube.com/get_midroll_info' } },
    },
}];
const AD_SLOTS = [{ adSlotRenderer: { adSlotMetadata: { slotId: 'sim', slotType: 'SLOT_TYPE_PLAYER_BYTES' } } }];

/** A player response, in the field order the real endpoint uses. */
function playerResponse(): Record<string, unknown> {
    return {
        responseContext: { serviceTrackingParams: [] },
        playabilityStatus: { status: 'OK' },
        streamingData: { expiresInSeconds: '21540', formats: [{ itag: 18 }] },
        playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
        adPlacements: AD_PLACEMENTS,
        adSlots: AD_SLOTS,
        adBreakHeartbeatParams: 'Q0FBJTNE',
        videoDetails: { videoId: 'sim', title: 'Simulated' },
    };
}

const reelAd = { command: { reelWatchEndpoint: { videoId: 'ad', adClientParams: { isAd: true } } } };
const reelVideo = (id: string) => ({ command: { reelWatchEndpoint: { videoId: id } } });

function apiResponse(path: string): unknown {
    if (path.startsWith('/youtubei/v1/player')) return playerResponse();
    if (path.startsWith('/youtubei/v1/get_watch')) {
        return [{
            playerResponse: playerResponse(),
            itemSectionRenderer: { contents: [{ adSlotRenderer: {} }, { videoWithContextRenderer: { videoId: 'next' } }] },
        }];
    }
    if (path.startsWith('/youtubei/v1/reel/reel_watch_sequence')) {
        return { entries: [reelVideo('a'), reelAd, reelVideo('b'), reelAd] };
    }
    // Not an endpoint any filter is about: must come through byte for byte.
    if (path.startsWith('/youtubei/v1/guide')) return { adPlacements: ['not-an-ad'], adSlots: 'kept', items: [1, 2] };
    return null;
}

/**
 * The page. It behaves as the site does where it matters here: an inline
 * script assigns the initial player response, another carries the bootstrap
 * the lists rewrite, and the player's API is called over both transports.
 */
function watchPage(): string {
    return `<!doctype html><meta charset="utf-8"><title>watch</title>
<body>
<script>
window.__r = { errors: [] };
window.ytcfg = { data_: { INNERTUBE_CONTEXT: { client: {
  clientName: 'WEB', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36,gzip(gfe)',
} } } };
var ytInitialPlayerResponse = ${JSON.stringify(playerResponse())};
</script>
<script>(function serverContract() { window.__r.bootstrapRan = true; })();</script>
<script id="pristine-natives">window.__r.bypassScriptRan = true; var keep = [window,"fetch"];</script>
<script>
(async () => {
  const r = window.__r;
  const ads = (o) => ['adPlacements', 'adSlots'].filter((k) => o && o[k] !== undefined);
  const api = '/youtubei/v1/player?prettyPrint=false';
  const body = JSON.stringify({ videoId: 'sim' });
  const xhr = (type) => new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', api);
    if (type) x.responseType = type;
    x.onload = () => resolve(x);
    x.onerror = reject;
    x.send(body);
  });
  try {
    r.initial = ['adPlacements', 'adSlots', 'playerAds'].filter((k) => ytInitialPlayerResponse[k] !== undefined);
    r.initialVideo = ytInitialPlayerResponse.videoDetails && ytInitialPlayerResponse.videoDetails.videoId;

    const viaFetch = await fetch(api, { method: 'POST', body });
    r.fetchStatus = viaFetch.status;
    const fetched = await viaFetch.json();
    r.fetchAds = ads(fetched);
    r.fetchVideo = fetched.videoDetails && fetched.videoDetails.videoId;
    r.fetchStreams = Boolean(fetched.streamingData);

    const viaRequest = await (await fetch(new Request(api, { method: 'POST', body }))).json();
    r.requestAds = ads(viaRequest);

    const text = (await xhr('')).responseText;
    try { const parsed = JSON.parse(text); r.xhrAds = ads(parsed); r.xhrVideo = parsed.videoDetails.videoId; }
    catch (e) { r.xhrAds = ['unparseable: ' + text.slice(0, 80)]; }

    const asJson = (await xhr('json')).response;
    r.xhrJsonAds = ads(asJson);
    r.xhrJsonVideo = asJson && asJson.videoDetails && asJson.videoDetails.videoId;

    const watch = await (await fetch('/youtubei/v1/get_watch?prettyPrint=false', { method: 'POST', body })).json();
    r.getWatchAds = ads(watch[0].playerResponse);
    r.getWatchSlots = watch[0].itemSectionRenderer.contents.filter((c) => c.adSlotRenderer).length;
    r.getWatchRest = watch[0].itemSectionRenderer.contents.filter((c) => c.videoWithContextRenderer).length;

    const reelUrl = '/youtubei/v1/reel/reel_watch_sequence?prettyPrint=false';
    const reels = await (await fetch(reelUrl, { method: 'POST', body })).json();
    r.reelFetch = reels.entries.map((e) => e.command.reelWatchEndpoint.videoId).join(',');
    const reelText = await (await fetch(reelUrl.replace('?', '?raw=1&'), { method: 'POST', body })).text();
    r.reelParse = JSON.parse(reelText).entries.map((e) => e.command.reelWatchEndpoint.videoId).join(',');

    const guide = await fetch('/youtubei/v1/guide');
    r.untouched = await guide.text();

    r.serialised = JSON.stringify({
      attestationRequest: { omitBotguardData: true },
      context: { client: { clientName: 'WEB', userAgent: ytcfg.data_.INNERTUBE_CONTEXT.client.userAgent.replace('X11;', 'X11; inline;') } },
      playbackContext: { contentPlaybackContext: { referer: location.href } },
    });
    r.serialisedPlain = JSON.stringify({ a: [1, 'x', null], b: { c: true } });

    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    r.frameFetchIsOurs = frame.contentWindow.fetch === window.fetch;
    r.frameRequestIsOurs = frame.contentWindow.Request === window.Request;
    frame.remove();

    const toString = Function.prototype.toString;
    r.looksNative = [fetch, JSON.parse, JSON.stringify, Node.prototype.appendChild, setTimeout, toString]
      .map((fn) => /^function \\w*\\(\\) \\{ \\[native code\\] \\}$/.test(toString.call(fn)));
    r.bootstrapText = document.scripts[1].textContent;
    r.bypassText = document.getElementById('pristine-natives').textContent;
    r.stack = (() => { try { JSON.stringify(1n); } catch (e) { return e.stack; } return ''; })();
  } catch (e) {
    r.errors.push(String(e && e.stack || e));
  }
  r.done = true;
  // A request the page never checks on, to a port nothing listens on: what a
  // blocked tracker looks like from here. It rejects, uncaught, through the
  // wrapped fetch.
  fetch('https://127.0.0.1:9/api/stats/qoe');
})();
</script>`;
}

function mobilePage(): string {
    return `<!doctype html><meta charset="utf-8"><title>m</title>
<body>
<script>
window.__r = { errors: [] };
var ytInitialPlayerResponse = ${JSON.stringify(playerResponse())};
</script>
<script>
(async () => {
  const r = window.__r;
  try {
    r.initial = ['adPlacements', 'adSlots', 'playerAds'].filter((k) => ytInitialPlayerResponse[k] !== undefined);
    const text = await (await fetch('/youtubei/v1/player?prettyPrint=false', { method: 'POST', body: '{}' })).text();
    const parsed = JSON.parse(text);
    r.parseAds = ['adPlacements', 'adSlots', 'playerAds'].filter((k) => parsed[k] !== undefined);
    r.parseVideo = parsed.videoDetails && parsed.videoDetails.videoId;
    const watch = await (await fetch('/youtubei/v1/get_watch?x=1', { method: 'POST', body: '{}' })).json();
    r.getWatchSlots = watch[0].itemSectionRenderer.contents.filter((c) => c.adSlotRenderer).length;
    r.getWatchRest = watch[0].itemSectionRenderer.contents.filter((c) => c.videoWithContextRenderer).length;
    r.visibility = document.visibilityState;
  } catch (e) {
    r.errors.push(String(e && e.stack || e));
  }
  r.done = true;
})();
</script>`;
}

function abortPage(property: string): string {
    return `<!doctype html><meta charset="utf-8"><title>abort</title>
<script>
window.__r = { reached: false };
// A site with an error handler of its own, as most have.
window.onerror = function () { window.__r.siteHandlerSaw = (window.__r.siteHandlerSaw || 0) + 1; };
</script>
<script>void window.${property}; window.__r.reached = true;</script>
<script>window.__r.done = true;</script>`;
}

/** A certificate for one run. The browser is told not to look at it. */
function throwawayCertificate(): { key: Buffer; cert: Buffer } {
    const dir = mkdtempSync(join(tmpdir(), 'addblocker-cert-'));
    try {
        execFileSync('openssl', [
            'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
            '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
        ], { stdio: 'ignore' });
    } catch (err) {
        throw new Error('this check serves HTTPS and needs the `openssl` command to make a throwaway '
            + `certificate: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
}

function startServer(abortProperty: string | null): Promise<{ server: Server; port: number }> {
    // HTTPS, because the browser will not speak anything else to youtube.com:
    // the domain is on its preloaded HSTS list.
    const server = createServer(throwawayCertificate(), (req, res) => {
        const host = (req.headers.host ?? '').split(':')[0];
        const path = req.url ?? '/';

        if (path.startsWith('/youtubei/')) {
            const payload = apiResponse(path);
            res.writeHead(payload === null ? 404 : 200, { 'content-type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify(payload));
            return;
        }

        const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
        let html = '<!doctype html><title>blank</title>';
        if (host === 'www.youtube.com') {
            // As the real site: assigning a string to a script's text is
            // refused unless it comes out of a Trusted Types policy.
            headers['content-security-policy'] = "require-trusted-types-for 'script'";
            html = watchPage();
        } else if (host === 'm.youtube.com') {
            html = mobilePage();
        } else if (abortProperty !== null) {
            html = abortPage(abortProperty);
        }
        res.writeHead(200, headers);
        res.end(html);
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
        });
    });
}

async function stageExtension(): Promise<string> {
    await rm(STAGED, { recursive: true, force: true });
    await cp(BUILT, STAGED, { recursive: true });

    const { publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const der = publicKey as unknown as Buffer;
    const digest = createHash('sha256').update(der).digest('hex').slice(0, 32);

    const manifestPath = join(STAGED, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.key = der.toString('base64');
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    await writeFile(join(STAGED, 'probe.html'),
        '<!doctype html><meta charset="utf-8"><title>probe</title>', 'utf8');

    return [...digest].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join('');
}

interface ErrorsPage {
    collecting: boolean;
    installWarnings: string[];
    manifestErrors: Array<{ message: string }>;
    runtimeErrors: Array<{ message: string; source: string; contextUrl: string; severity: string }>;
}

/** What chrome://extensions shows behind the "Errors" button. */
async function readErrorsPage(extensionsPage: Page, extensionId: string): Promise<ErrorsPage> {
    return extensionsPage.evaluate((id) => new Promise<ErrorsPage>((resolve) => {
        const api = (globalThis as unknown as { chrome: { developerPrivate: {
            getExtensionInfo(id: string, cb: (info: Record<string, any>) => void): void;
        } } }).chrome.developerPrivate;
        api.getExtensionInfo(id, (info) => resolve({
            collecting: info.errorCollection?.isActive === true,
            installWarnings: info.installWarnings ?? [],
            manifestErrors: info.manifestErrors ?? [],
            runtimeErrors: info.runtimeErrors ?? [],
        }));
    }), extensionId);
}

let failed = false;
function report(ok: boolean, label: string, detail = ''): void {
    if (!ok) failed = true;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : ` — ${detail}`}`);
}
function skip(label: string, why: string): void {
    console.log(`  SKIP  ${label} — ${why}`);
}

async function visit(context: BrowserContext, url: string): Promise<{
    result: Record<string, any>; pageErrors: string[];
}> {
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as unknown as { __r?: { done?: boolean } }).__r?.done === true,
        undefined, { timeout: 15_000 }).catch(() => { /* reported through the missing results */ });
    // Leave the uncaught request time to fail.
    await page.waitForTimeout(700);
    const result = await page.evaluate(() => (window as unknown as { __r: Record<string, any> }).__r ?? {});
    await page.close();
    return { result, pageErrors };
}

/**
 * The userscript on the same pages, in a browser with no extension.
 *
 * It is injected with `addInitScript`, which runs it in the page's own world
 * before the page's scripts — where a userscript manager puts it. Everything
 * therefore happens in one world, including the script rewriting that the
 * extension does from its isolated one: here it is subject to the site's
 * Trusted Types policy, and has to get through it.
 */
async function checkUserscript(executable: string): Promise<void> {
    console.log('\nThe userscript (no extension loaded)');
    if (!existsSync(USERSCRIPT)) {
        skip('the userscript', 'userscript/addblocker.user.js is not built — run pnpm build-userscript');
        return;
    }
    const { server, port } = await startServer(null);
    const browser = await chromium.launch({
        executablePath: executable,
        headless: true,
        args: [
            `--host-resolver-rules=MAP * 127.0.0.1:${port},EXCLUDE localhost`,
            '--ignore-certificate-errors', '--no-proxy-server', '--no-sandbox', '--disable-gpu',
        ],
    });
    try {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        await context.addInitScript({ path: USERSCRIPT });
        const none = (value: unknown): boolean => Array.isArray(value) && value.length === 0;
        const show = (value: unknown): string => `got ${JSON.stringify(value)}`;

        const mobile = await visit(context, `https://m.youtube.com:${port}/watch?v=sim`);
        const m = mobile.result;
        report(m.done === true && none(m.errors), 'm.youtube.com: the page ran to the end',
            show(m.errors ?? 'no result'));
        report(none(m.initial), 'm.youtube.com: initial player response without ads', show(m.initial));
        report(none(m.parseAds) && m.parseVideo === 'sim',
            'm.youtube.com: player API without ads, video intact', show([m.parseAds, m.parseVideo]));
        report(m.getWatchSlots === 0 && m.getWatchRest === 1,
            'm.youtube.com: sponsored slots removed from the watch feed', show([m.getWatchSlots, m.getWatchRest]));
        report(mobile.pageErrors.length === 0, 'm.youtube.com: no error in the page', show(mobile.pageErrors));

        // A tablet is served the desktop site.
        const watch = await visit(context, `https://www.youtube.com:${port}/watch?v=sim`);
        const r = watch.result;
        report(r.done === true && none(r.errors), 'www.youtube.com: the page ran to the end',
            show(r.errors ?? 'no result'));
        report(none(r.initial) && none(r.fetchAds) && none(r.requestAds) && none(r.xhrAds) && none(r.xhrJsonAds),
            'www.youtube.com: no ads in the initial response, nor over fetch or XMLHttpRequest',
            show([r.initial, r.fetchAds, r.requestAds, r.xhrAds, r.xhrJsonAds]));
        report(r.fetchVideo === 'sim' && r.xhrVideo === 'sim', 'www.youtube.com: the video itself is intact',
            show([r.fetchVideo, r.xhrVideo]));
        report(r.reelFetch === 'a,b' && r.reelParse === 'a,b', 'www.youtube.com: Shorts without the ad entries',
            show([r.reelFetch, r.reelParse]));
        report(r.bootstrapRan === true && typeof r.bootstrapText === 'string' && r.bootstrapText.length > 500,
            'www.youtube.com: the bootstrap script is rewritten from the page\'s own world, through Trusted Types',
            show([r.bootstrapRan, String(r.bootstrapText).slice(0, 60)]));
        const stray = watch.pageErrors.filter((e) => !e.includes('Failed to fetch'));
        report(stray.length === 0, 'www.youtube.com: no error in the page', show(stray));
        await context.close();
    } finally {
        await browser.close();
        server.close();
    }
}

async function main(): Promise<void> {
    const desktop = await invocationsFor('www.youtube.com');
    const has = (name: string, containing = ''): boolean => desktop.some(
        (invocation) => invocation[0] === name && invocation.some((arg) => arg.includes(containing)),
    );
    const abortCase = await findAbortCase();

    const extensionId = await stageExtension();
    const { server, port } = await startServer(abortCase?.property ?? null);
    const profile = join(ROOT, 'dist', 'youtube-check-profile');
    await rm(profile, { recursive: true, force: true });
    await mkdir(profile, { recursive: true });

    const executable = resolveChromium();
    if (executable.includes('headless_shell')) throw new Error('headless shell cannot load extensions');
    console.log(`Chromium: ${executable}\n`);

    const context = await chromium.launchPersistentContext(profile, {
        executablePath: executable,
        headless: true,
        ignoreHTTPSErrors: true,
        ignoreDefaultArgs: ['--disable-extensions'],
        timeout: 120_000,
        args: [
            `--disable-extensions-except=${STAGED}`,
            `--load-extension=${STAGED}`,
            `--host-resolver-rules=MAP * 127.0.0.1:${port},EXCLUDE localhost`,
            '--ignore-certificate-errors',
            // An HTTPS proxy from the environment would take these requests
            // to the real internet instead of the local server.
            '--no-proxy-server',
            '--no-first-run', '--no-sandbox', '--disable-gpu',
        ],
    });

    try {
        // Developer mode, and error collection for this extension: what makes
        // the Errors page exist. An extension loaded from the command line is
        // not collected for by default, so without this the page would be
        // empty whatever happened — and the check below would prove nothing.
        const extensionsPage = await context.newPage();
        await extensionsPage.goto('chrome://extensions');
        await extensionsPage.evaluate((id) => new Promise<void>((resolve) => {
            const api = (globalThis as unknown as { chrome: { developerPrivate: Record<string, Function> } })
                .chrome.developerPrivate;
            api.updateProfileConfiguration({ inDeveloperMode: true }, () => {
                api.updateExtensionConfiguration({ extensionId: id, errorCollection: true }, () => resolve());
            });
        }), extensionId);

        const probe = await context.newPage();
        await probe.goto(`chrome-extension://${extensionId}/probe.html`, { timeout: 60_000 });
        const registered = await probe.evaluate(async () => {
            const scripting = (globalThis as unknown as { chrome: typeof chrome }).chrome.scripting;
            type Script = { id: string; world?: string; js?: string[] };
            let scripts: Script[] = [];
            let previous = -1;
            // Registration is done in one call per batch; wait for it to settle.
            for (let attempt = 0; attempt < 120; attempt += 1) {
                scripts = await scripting.getRegisteredContentScripts() as Script[];
                if (scripts.length > 0 && scripts.length === previous) break;
                previous = scripts.length;
                await new Promise((r) => { setTimeout(r, 500); });
            }
            const scriptlets = scripts.filter((s) => s.id.startsWith('scriptlets-'));
            return {
                main: scriptlets.filter((s) => s.world === 'MAIN').length,
                isolated: scriptlets.filter((s) => s.world !== 'MAIN').length,
                misfiled: scriptlets.filter((s) => (s.world === 'MAIN') === s.id.startsWith('scriptlets-isolated-'))
                    .map((s) => s.id),
                wrongRuntime: scriptlets.filter((s) => (s.js ?? [])[0]?.endsWith(
                    s.world === 'MAIN' ? '/runtime.js' : '/runtime-page.js',
                )).map((s) => s.id),
            };
        });
        await probe.close();

        console.log('Registration');
        report(registered.main > 0 && registered.isolated > 0,
            `${registered.main} scriptlet buckets in the page's world, ${registered.isolated} in the isolated one`);
        report(registered.misfiled.length === 0 && registered.wrongRuntime.length === 0,
            'each bucket is registered in its own world, with that world\'s runtime',
            [...registered.misfiled, ...registered.wrongRuntime].slice(0, 3).join(', '));

        // ---------------------------------------------------------------
        console.log('\nwww.youtube.com — the watch page');
        const watch = await visit(context, `https://www.youtube.com:${port}/watch?v=sim`);
        const r = watch.result;
        const none = (value: unknown): boolean => Array.isArray(value) && value.length === 0;
        const show = (value: unknown): string => `got ${JSON.stringify(value)}`;

        report(r.done === true && none(r.errors), 'the page ran to the end', show(r.errors ?? 'no result'));
        report(none(r.initial) && r.initialVideo === 'sim',
            'initial player response: no ad placements, slots or player ads; the video is still there',
            show([r.initial, r.initialVideo]));
        report(none(r.fetchAds) && r.fetchVideo === 'sim' && r.fetchStreams === true && r.fetchStatus === 200,
            'player API over fetch: ads removed, video and streams intact',
            show([r.fetchAds, r.fetchVideo, r.fetchStreams, r.fetchStatus]));
        report(none(r.requestAds), 'player API over fetch, called with a Request object', show(r.requestAds));
        report(none(r.xhrAds) && r.xhrVideo === 'sim',
            'player API over XMLHttpRequest, read as text: ads removed, still valid JSON',
            show([r.xhrAds, r.xhrVideo]));
        report(none(r.xhrJsonAds) && r.xhrJsonVideo === 'sim',
            'player API over XMLHttpRequest, read as JSON', show([r.xhrJsonAds, r.xhrJsonVideo]));
        report(r.reelFetch === 'a,b', 'Shorts sequence over fetch: the ad entries are gone, the videos remain',
            show(r.reelFetch));
        report(r.reelParse === 'a,b', 'Shorts sequence parsed by the page itself (JSON.parse)', show(r.reelParse));
        report(r.untouched === JSON.stringify(apiResponse('/youtubei/v1/guide')),
            'a response no filter is about arrives byte for byte', show(r.untouched));
        report(r.serialisedPlain === '{"a":[1,"x",null],"b":{"c":true}}',
            'JSON.stringify is unchanged for everything that is not a player request', show(r.serialisedPlain));

        console.log('\nwww.youtube.com — the mechanisms behind it');
        if (has('trusted-edit-inbound-object', 'isInlinePlaybackNoAd')) {
            report(typeof r.serialised === 'string' && r.serialised.includes('"isInlinePlaybackNoAd":true'),
                'the outgoing player request is edited as it is serialised', show(r.serialised));
        } else skip('editing the outgoing player request', 'the lists no longer carry that filter');

        // The lists only rename the ad slots there, which is all uBlock
        // Origin does to that endpoint too.
        if (has('trusted-rpfr', 'get_watch')) {
            report(Array.isArray(r.getWatchAds) && !r.getWatchAds.includes('adSlots'),
                'watch API (get_watch): the ad slots are taken out of the embedded player response',
                show(r.getWatchAds));
        } else skip('the watch API', 'the lists no longer carry that filter');

        if (has('rpnt', 'serverContract')) {
            report(r.bootstrapRan === true && typeof r.bootstrapText === 'string'
                && r.bootstrapText.length > 500 && r.bootstrapText.includes('(function serverContract()'),
                'the bootstrap script was rewritten before it ran, under the site\'s Trusted Types policy',
                show([r.bootstrapRan, String(r.bootstrapText).slice(0, 60)]));
        } else skip('rewriting the bootstrap script', 'the lists no longer carry that filter');

        if (has('rmnt', 'window,"fetch"')) {
            report(r.bypassScriptRan === undefined && r.bypassText === '',
                'the script that saves pristine natives was emptied before it ran',
                show([r.bypassScriptRan, r.bypassText]));
        } else skip('emptying the pristine-natives script', 'the lists no longer carry that filter');

        if (has('trusted-prevent-dom-bypass', 'fetch')) {
            report(r.frameFetchIsOurs === true && r.frameRequestIsOurs === true,
                'a fresh iframe hands back this window\'s fetch and Request, not pristine ones',
                show([r.frameFetchIsOurs, r.frameRequestIsOurs]));
        } else skip('closing the iframe bypass', 'the lists no longer carry that filter');

        report(Array.isArray(r.looksNative) && r.looksNative.every(Boolean),
            'every wrapped function still reads as native code', show(r.looksNative));
        report(typeof r.stack === 'string' && r.stack !== '' && !r.stack.includes('chrome-extension://'),
            'stack traces the page can read do not name the extension', show(String(r.stack).slice(0, 200)));

        const expectedPageError = watch.pageErrors.filter((e) => e.includes('Failed to fetch'));
        const otherPageErrors = watch.pageErrors.filter((e) => !e.includes('Failed to fetch'));
        report(expectedPageError.length === 1,
            'the page\'s own uncaught failed request still reaches its console', show(watch.pageErrors));
        report(otherPageErrors.length === 0, 'no other error in the page', show(otherPageErrors));

        // ---------------------------------------------------------------
        console.log('\nm.youtube.com — the mobile watch page');
        const mobile = await visit(context, `https://m.youtube.com:${port}/watch?v=sim`);
        const m = mobile.result;
        report(m.done === true && none(m.errors), 'the page ran to the end', show(m.errors ?? 'no result'));
        report(none(m.initial), 'initial player response: no ads', show(m.initial));
        report(none(m.parseAds) && m.parseVideo === 'sim',
            'player API parsed by the page: ads removed, video intact', show([m.parseAds, m.parseVideo]));
        report(m.getWatchSlots === 0 && m.getWatchRest === 1,
            'watch API: sponsored slots removed from the feed, the videos remain',
            show([m.getWatchSlots, m.getWatchRest]));
        report(mobile.pageErrors.length === 0, 'no error in the page', show(mobile.pageErrors));

        // ---------------------------------------------------------------
        console.log('\nAborted scripts');
        if (abortCase !== null) {
            const aborted = await visit(context, `https://${abortCase.domain}:${port}/`);
            report(aborted.result.reached === false && aborted.result.done === true,
                `aopr(${abortCase.property}) on ${abortCase.domain}: the script was stopped, the next one ran`,
                show(aborted.result));
            report(aborted.pageErrors.length === 0,
                'the deliberate abort is not reported as an error', show(aborted.pageErrors));
        } else skip('aborting a script', 'no simple aopr invocation in the build');

        // ---------------------------------------------------------------
        console.log('\nThe extension\'s Errors page');
        await extensionsPage.waitForTimeout(500);
        const errors = await readErrorsPage(extensionsPage, extensionId);
        report(errors.collecting, 'Chromium is collecting errors for the extension');
        report(errors.installWarnings.length === 0 && errors.manifestErrors.length === 0,
            'no install warning, no manifest error',
            show([...errors.installWarnings, ...errors.manifestErrors.map((e) => e.message)].slice(0, 3)));
        report(errors.runtimeErrors.length === 0,
            'no runtime error — not even the page\'s own failed request or the aborted script',
            errors.runtimeErrors.slice(0, 4)
                .map((e) => `${e.message} [${e.source.replace(/^chrome-extension:\/\/[a-p]+/, '')} on ${e.contextUrl}]`)
                .join(' ; '));
        await extensionsPage.close();
    } finally {
        await context.close();
        server.close();
        await rm(profile, { recursive: true, force: true });
        await rm(STAGED, { recursive: true, force: true });
    }

    await checkUserscript(executable);

    console.log(`\n${failed ? 'YOUTUBE CHECK FAILED' : 'YOUTUBE CHECK PASSED'}`);
    if (failed) process.exitCode = 1;
}

await main();
