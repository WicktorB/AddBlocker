/**
 * Loads the compiled rulesets into a real Chromium and checks what the browser
 * actually accepts and enforces.
 *
 * This is the part of phase 0 that turns an estimate into evidence. In
 * particular it answers the question the compression ratio raises: does Chrome
 * accept a single rule carrying tens of thousands of `requestDomains`?
 */

import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from 'playwright-core';

import { groupLists, loadLists } from './lists.js';
import { parseList } from './parser.js';
import { compile, type DnrRule } from './compiler.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = join(ROOT, 'out', 'extension');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** A domain we know is in the lists, plus a control that is not. */
interface Probe {
    domain: string;
    shouldBlock: boolean;
}

/**
 * Chrome derives an extension's ID from its public key. Embedding a generated
 * key in the manifest makes the ID predictable, so we can drive an extension
 * page directly instead of hunting for an ephemeral service worker.
 */
function makeExtensionIdentity(): { key: string; id: string } {
    const { publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const der = publicKey as unknown as Buffer;
    const digest = createHash('sha256').update(der).digest('hex').slice(0, 32);
    // Chrome maps each hex digit onto 'a'..'p'.
    const id = [...digest].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join('');
    return { key: der.toString('base64'), id };
}

async function buildExtension(): Promise<{ rulesets: Array<{ id: string; count: number }>; probes: Probe[]; extensionId: string }> {
    await rm(EXT_DIR, { recursive: true, force: true });
    await mkdir(join(EXT_DIR, 'rules'), { recursive: true });

    const lists = await loadLists();
    const bundles = groupLists(lists);
    const rulesets: Array<{ id: string; count: number }> = [];
    let blockedDomain: string | null = null;
    let biggestRuleDomains = 0;

    for (const [name, content] of bundles) {
        const { filters } = parseList(content);
        const { rules } = compile(filters);
        await writeFile(join(EXT_DIR, 'rules', `${name}.json`), JSON.stringify(rules), 'utf8');
        rulesets.push({ id: name, count: rules.length });

        // Pick a probe domain from the largest merged rule: an unconditional
        // third-party block is the cleanest thing to assert on.
        for (const rule of rules) {
            const domains = rule.condition.requestDomains as string[] | undefined;
            if (domains === undefined || rule.action.type !== 'block') continue;
            if (domains.length > biggestRuleDomains && isUnconditional(rule)) {
                biggestRuleDomains = domains.length;
                blockedDomain = domains[Math.floor(domains.length / 2)];
            }
        }
    }

    const identity = makeExtensionIdentity();
    const manifest = {
        manifest_version: 3,
        name: 'AddBlocker phase 0 probe',
        version: '0.0.1',
        key: identity.key,
        permissions: ['declarativeNetRequest', 'declarativeNetRequestFeedback'],
        host_permissions: ['<all_urls>'],
        background: { service_worker: 'sw.js' },
        declarative_net_request: {
            rule_resources: rulesets.map((r) => ({
                id: r.id,
                enabled: true,
                path: `rules/${r.id}.json`,
            })),
        },
    };

    await writeFile(join(EXT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    await writeFile(join(EXT_DIR, 'sw.js'), 'self.addEventListener("install", () => self.skipWaiting());\n', 'utf8');
    // An extension page gives us a stable context with full API access.
    await writeFile(join(EXT_DIR, 'probe.html'), '<!doctype html><meta charset="utf-8"><title>probe</title>\n', 'utf8');

    console.log(`Built extension: ${rulesets.map((r) => `${r.id}=${r.count}`).join(' ')}`);
    console.log(`Extension id: ${identity.id}`);
    console.log(`Probe domain drawn from a merged rule of ${biggestRuleDomains} domains: ${blockedDomain}`);

    return {
        rulesets,
        extensionId: identity.id,
        probes: [
            { domain: blockedDomain ?? 'doubleclick.net', shouldBlock: true },
            { domain: 'definitely-not-in-any-list-9f3a2b.test', shouldBlock: false },
        ],
    };
}

/** True when a block rule applies regardless of resource type or initiator. */
function isUnconditional(rule: DnrRule): boolean {
    const c = rule.condition;
    return c.resourceTypes === undefined
        && c.initiatorDomains === undefined
        && c.excludedInitiatorDomains === undefined
        && c.requestMethods === undefined;
}

/** Serves the probe page and a script for every hostname Chromium resolves to us. */
function startServer(probes: Probe[]): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => {
        if (req.url === '/' || req.url?.startsWith('/index')) {
            const checks = probes.map((p) => `  {domain: ${JSON.stringify(p.domain)}, shouldBlock: ${p.shouldBlock}}`).join(',\n');
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(`<!doctype html><meta charset="utf-8"><title>probe</title>
<script>
window.__results = (async () => {
  const probes = [
${checks}
  ];
  const out = [];
  for (const p of probes) {
    let blocked = false;
    try {
      await fetch('http://' + p.domain + '/tracker.js', {cache: 'no-store'});
    } catch (e) {
      blocked = true;
    }
    out.push({domain: p.domain, shouldBlock: p.shouldBlock, blocked});
  }
  return out;
})();
</script>`);
            return;
        }
        res.writeHead(200, { 'content-type': 'application/javascript', 'access-control-allow-origin': '*' });
        res.end('/* served */');
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;
            resolve({ server, port });
        });
    });
}

async function readDnrState(context: BrowserContext, extensionId: string): Promise<unknown> {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/probe.html`);
    const state = await page.evaluate(async () => {
        const dnr = (globalThis as unknown as { chrome: typeof chrome }).chrome.declarativeNetRequest;
        return {
            enabledRulesets: await dnr.getEnabledRulesets(),
            availableStaticRuleCount: await dnr.getAvailableStaticRuleCount(),
            constants: {
                GUARANTEED_MINIMUM_STATIC_RULES: dnr.GUARANTEED_MINIMUM_STATIC_RULES,
                MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: dnr.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
                MAX_NUMBER_OF_DYNAMIC_RULES: dnr.MAX_NUMBER_OF_DYNAMIC_RULES,
                MAX_NUMBER_OF_REGEX_RULES: dnr.MAX_NUMBER_OF_REGEX_RULES,
            },
        };
    });
    await page.close();
    return state;
}

async function main(): Promise<void> {
    const { rulesets, probes, extensionId } = await buildExtension();
    const { server, port } = await startServer(probes);
    const userDataDir = join(ROOT, 'out', 'profile');
    await rm(userDataDir, { recursive: true, force: true });

    console.log(`\nLaunching Chromium with the extension loaded…`);
    const context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: CHROME,
        // New-headless Chromium loads extensions fine; the old headless shell
        // does not. Keep the real chrome binary via executablePath.
        headless: true,
        // Playwright passes --disable-extensions by default, which silently
        // defeats --load-extension.
        ignoreDefaultArgs: ['--disable-extensions'],
        timeout: 120_000,
        args: [
            `--disable-extensions-except=${EXT_DIR}`,
            `--load-extension=${EXT_DIR}`,
            // Every hostname resolves to our local server, so probe requests are
            // real network requests that DNR sees, with no external traffic.
            // localhost is excluded so Chromium's own plumbing keeps working.
            `--host-resolver-rules=MAP * 127.0.0.1:${port},EXCLUDE localhost`,
            '--no-first-run',
            '--no-sandbox',
            '--disable-gpu',
        ],
    });

    let failed = false;
    try {
        const state = await readDnrState(context, extensionId) as {
            enabledRulesets: string[];
            availableStaticRuleCount: number;
            constants: Record<string, number>;
        };

        console.log('\n--- What Chrome reports ---');
        console.log(`  enabled rulesets:      ${JSON.stringify(state.enabledRulesets)}`);
        console.log(`  available static rules: ${state.availableStaticRuleCount}`);
        console.log(`  constants: ${JSON.stringify(state.constants)}`);

        const expected = rulesets.map((r) => r.id).sort();
        const actual = [...state.enabledRulesets].sort();
        const allEnabled = JSON.stringify(expected) === JSON.stringify(actual);
        console.log(`  ${allEnabled ? 'PASS' : 'FAIL'}  every ruleset accepted and enabled`);
        if (!allEnabled) failed = true;

        const page = await context.newPage();
        await page.goto(`http://probe.test:${port}/`, { waitUntil: 'load' });
        const results = await page.evaluate(() => (window as unknown as { __results: Promise<unknown> }).__results);

        console.log('\n--- Enforcement ---');
        for (const result of results as Array<{ domain: string; shouldBlock: boolean; blocked: boolean }>) {
            const ok = result.blocked === result.shouldBlock;
            if (!ok) failed = true;
            console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${result.domain} ` +
                `expected=${result.shouldBlock ? 'blocked' : 'allowed'} actual=${result.blocked ? 'blocked' : 'allowed'}`);
        }
    } finally {
        await context.close();
        server.close();
    }

    console.log(`\n${failed ? 'BROWSER VALIDATION FAILED' : 'BROWSER VALIDATION PASSED'}`);
    if (failed) process.exitCode = 1;
}

await main();
