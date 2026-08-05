/**
 * Service worker.
 *
 * Two jobs, both off the hot path:
 *   - register the cosmetic and scriptlet content scripts once (the manifest
 *     cannot hold their match patterns — docs/adr/0002);
 *   - apply user settings: per-site allowlisting, user filters, ruleset toggles.
 *
 * Network filtering itself is Chrome's DNR engine, and cosmetic filtering is
 * content scripts Chrome injects. Neither needs this worker awake.
 */

import {
    DEFAULT_SETTINGS,
    RULE_ID_BASE,
    buildAllowlistRules,
    buildCosmeticUserRules,
    buildExcludeMatches,
    normaliseHostname,
    parseUserFilter,
    type Settings,
} from './settings.js';

const REGISTRATIONS_URL = 'cosmetic/registrations.json';
const SETTINGS_KEY = 'settings';
const USER_COSMETIC_SCRIPT_ID = 'user-cosmetic';

declare const chrome: typeof globalThis extends { chrome: infer C } ? C : any;

export async function loadSettings(): Promise<Settings> {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

/** Registers the generated bucket scripts, honouring disabled sites. */
async function syncContentScripts(settings: Settings): Promise<void> {
    let wanted: Array<Record<string, unknown>>;
    try {
        const response = await fetch(chrome.runtime.getURL(REGISTRATIONS_URL));
        wanted = await response.json();
    } catch (err) {
        console.error('[addblocker] cannot read registrations:', err);
        return;
    }

    const excludeMatches = buildExcludeMatches(settings);
    const withExclusions = wanted.map((script) => ({
        ...script,
        ...(excludeMatches.length > 0 ? { excludeMatches } : {}),
    }));

    const existing = await chrome.scripting.getRegisteredContentScripts();
    const existingIds = new Set(existing.map((script: { id: string }) => script.id));
    const wantedIds = new Set(withExclusions.map((script) => script.id as string));

    const stale = existing
        .map((script: { id: string }) => script.id)
        .filter((id: string) => !wantedIds.has(id) && id !== USER_COSMETIC_SCRIPT_ID);
    if (stale.length > 0) await chrome.scripting.unregisterContentScripts({ ids: stale });

    const missing = withExclusions.filter((script) => !existingIds.has(script.id as string));
    const present = withExclusions.filter((script) => existingIds.has(script.id as string));

    if (missing.length > 0) {
        try {
            await chrome.scripting.registerContentScripts(missing);
        } catch (err) {
            console.error('[addblocker] registration failed:', err);
        }
    }

    // Updating in place is what applies a newly disabled site without paying
    // to re-register several thousand match patterns.
    if (present.length > 0 && excludeMatches.length >= 0) {
        try {
            await chrome.scripting.updateContentScripts(
                present.map((script) => ({ id: script.id, excludeMatches })),
            );
        } catch (err) {
            console.error('[addblocker] updating exclusions failed:', err);
        }
    }
}

/** Applies the user's own cosmetic filters through one small script. */
async function syncUserCosmetic(settings: Settings): Promise<void> {
    const rules = buildCosmeticUserRules(settings);
    const hasAny = rules.generic.length > 0 || Object.keys(rules.byDomain).length > 0;

    const existing = await chrome.scripting.getRegisteredContentScripts();
    const alreadyThere = existing.some((s: { id: string }) => s.id === USER_COSMETIC_SCRIPT_ID);

    if (!hasAny) {
        if (alreadyThere) {
            await chrome.scripting.unregisterContentScripts({ ids: [USER_COSMETIC_SCRIPT_ID] });
        }
        return;
    }

    // The built-in buckets are generated at build time, so their selectors are
    // inlined. User filters change at runtime, so they live in storage and a
    // small static script reads them. That read is async — a brief flash is
    // possible on the very first paint, which is an acceptable trade for a
    // handful of filters the user just wrote.
    await chrome.storage.local.set({ userCosmeticRules: rules });

    if (!alreadyThere) {
        try {
            await chrome.scripting.registerContentScripts([{
                id: USER_COSMETIC_SCRIPT_ID,
                matches: ['*://*/*'],
                js: ['user-cosmetic.js'],
                runAt: 'document_start',
                allFrames: true,
                excludeMatches: buildExcludeMatches(settings),
                persistAcrossSessions: true,
            }]);
        } catch (err) {
            console.error('[addblocker] user cosmetic registration failed:', err);
        }
    } else {
        await chrome.scripting.updateContentScripts([{
            id: USER_COSMETIC_SCRIPT_ID,
            excludeMatches: buildExcludeMatches(settings),
        }]);
    }
}

/** Rewrites the dynamic rules derived from settings. */
async function syncDynamicRules(settings: Settings): Promise<void> {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing.map((rule: { id: number }) => rule.id);

    const addRules = [...buildAllowlistRules(settings)];

    // User network filters are added verbatim as simple block rules; anything
    // more elaborate belongs in a list, not in the popup.
    let nextId = RULE_ID_BASE.userNetwork;
    for (const line of settings.userFilters) {
        const parsed = parseUserFilter(line);
        if (parsed.kind !== 'network') continue;
        addRules.push({
            id: nextId,
            priority: 1000,
            action: { type: 'block' },
            condition: { urlFilter: parsed.selector },
        });
        nextId += 1;
    }

    try {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    } catch (err) {
        console.error('[addblocker] dynamic rules failed:', err);
    }
}

/** Enables or disables static rulesets per the user's choice. */
async function syncRulesets(settings: Settings): Promise<void> {
    const manifest = chrome.runtime.getManifest();
    const all: Array<{ id: string }> = manifest.declarative_net_request?.rule_resources ?? [];
    const disabled = new Set(settings.disabledRulesets);

    const enableRulesetIds = all.map((r) => r.id).filter((id) => !disabled.has(id));
    const disableRulesetIds = all.map((r) => r.id).filter((id) => disabled.has(id));

    try {
        await chrome.declarativeNetRequest.updateEnabledRulesets({
            enableRulesetIds, disableRulesetIds,
        });
    } catch (err) {
        console.error('[addblocker] ruleset toggle failed:', err);
    }
}

/**
 * Applies the settings that must take effect immediately.
 *
 * Measured: a dynamic DNR rule lands in ~5ms, while updating the registered
 * content scripts takes seconds — up to ~15s for the first call after start-up.
 * Disabling a site therefore rides on the DNR allowlist, which is also the part
 * that matters: it is what makes a broken site work again on reload.
 */
async function applyFastSettings(settings: Settings): Promise<void> {
    await Promise.all([syncDynamicRules(settings), syncRulesets(settings)]);
}

/** Applies the slow half in the background; never awaited by a UI action. */
function applyScriptSettings(settings: Settings): void {
    void (async () => {
        try {
            await syncContentScripts(settings);
            await syncUserCosmetic(settings);
        } catch (err) {
            console.error('[addblocker] script sync failed:', err);
        }
    })();
}

export async function applySettings(): Promise<void> {
    const settings = await loadSettings();
    await applyFastSettings(settings);
    applyScriptSettings(settings);
}

/** Awaits everything — used at install time, where there is no user waiting. */
export async function applySettingsFully(): Promise<void> {
    const settings = await loadSettings();
    await applyFastSettings(settings);
    await syncContentScripts(settings);
    await syncUserCosmetic(settings);
}

/**
 * Per-tab block counts.
 *
 * `onRuleMatchedDebug` only exists for unpacked extensions — which is exactly
 * how this one is meant to run — so the count is exact rather than the
 * quota-limited estimate a Web Store build would have to live with.
 */
const counts = new Map<number, number>();

function trackMatches(): void {
    if (chrome.declarativeNetRequest.onRuleMatchedDebug === undefined) return;

    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info: {
        request: { tabId: number };
    }) => {
        const tabId = info.request.tabId;
        if (tabId < 0) return;
        const next = (counts.get(tabId) ?? 0) + 1;
        counts.set(tabId, next);
        void chrome.action.setBadgeText({ tabId, text: next > 999 ? '999+' : String(next) });
        void chrome.action.setBadgeBackgroundColor({ tabId, color: '#4a5568' });
    });

    chrome.tabs.onRemoved.addListener((tabId: number) => { counts.delete(tabId); });
    chrome.webNavigation?.onCommitted.addListener((details: { tabId: number; frameId: number }) => {
        if (details.frameId === 0) counts.set(details.tabId, 0);
    });
}

export function getCount(tabId: number): number {
    return counts.get(tabId) ?? 0;
}

// Message handling for the popup, options page and picker.
chrome.runtime.onMessage.addListener((message: { type: string; payload?: unknown },
    _sender: unknown, sendResponse: (response: unknown) => void) => {
    void (async () => {
        switch (message.type) {
            case 'getState': {
                const settings = await loadSettings();
                const payload = message.payload as { tabId?: number; hostname?: string } | undefined;
                sendResponse({
                    settings,
                    count: payload?.tabId === undefined ? 0 : getCount(payload.tabId),
                });
                return;
            }
            case 'setSettings': {
                await saveSettings(message.payload as Settings);
                await applySettings();
                sendResponse({ ok: true });
                return;
            }
            case 'toggleSite': {
                const host = normaliseHostname((message.payload as { hostname: string }).hostname);
                if (host === null) { sendResponse({ ok: false }); return; }
                const settings = await loadSettings();
                const disabled = settings.disabledSites.includes(host);
                settings.disabledSites = disabled
                    ? settings.disabledSites.filter((d) => d !== host)
                    : [...settings.disabledSites, host];
                await saveSettings(settings);
                await applySettings();
                sendResponse({ ok: true, disabled: !disabled });
                return;
            }
            case 'addFilter': {
                const settings = await loadSettings();
                const filter = (message.payload as { filter: string }).filter.trim();
                if (filter !== '' && !settings.userFilters.includes(filter)) {
                    settings.userFilters = [...settings.userFilters, filter];
                    await saveSettings(settings);
                    await applySettings();
                }
                sendResponse({ ok: true });
                return;
            }
            default:
                sendResponse({ ok: false, error: `unknown message: ${message.type}` });
        }
    })();

    // Keeps the message channel open for the async work above.
    return true;
});

// At install and start-up nobody is waiting, so take the time to finish.
chrome.runtime.onInstalled.addListener(() => { void applySettingsFully(); });
chrome.runtime.onStartup.addListener(() => { void applySettingsFully(); });

trackMatches();
void applySettingsFully();
