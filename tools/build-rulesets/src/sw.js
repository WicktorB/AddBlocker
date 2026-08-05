/**
 * Service worker.
 *
 * Its one job on the hot path is: nothing. Network filtering is handled by
 * Chrome's DNR engine and cosmetic filtering by content scripts Chrome injects
 * itself. The worker only registers those content scripts once — the manifest
 * cannot hold 22k match patterns without crippling browser startup
 * (docs/adr/0002).
 *
 * Registration persists across sessions, so after the first run this worker
 * stays asleep.
 */

const REGISTRATIONS_URL = 'cosmetic/registrations.json';

async function syncContentScripts() {
    let wanted;
    try {
        const response = await fetch(chrome.runtime.getURL(REGISTRATIONS_URL));
        wanted = await response.json();
    } catch (err) {
        console.error('[addblocker] cannot read cosmetic registrations:', err);
        return;
    }

    const existing = await chrome.scripting.getRegisteredContentScripts();
    const existingIds = new Set(existing.map((script) => script.id));
    const wantedIds = new Set(wanted.map((script) => script.id));

    // Same set of ids means a previous run already did this — registrations
    // persist across sessions, so re-registering would only cost time.
    const unchanged = existingIds.size === wantedIds.size
        && [...wantedIds].every((id) => existingIds.has(id));
    if (unchanged) return;

    const stale = existing.filter((script) => !wantedIds.has(script.id)).map((script) => script.id);
    if (stale.length > 0) {
        await chrome.scripting.unregisterContentScripts({ ids: stale });
    }

    // registerContentScripts rejects the whole call if any id already exists.
    const missing = wanted.filter((script) => !existingIds.has(script.id));
    if (missing.length === 0) return;

    try {
        await chrome.scripting.registerContentScripts(missing);
        console.info(`[addblocker] registered ${missing.length} cosmetic content scripts`);
    } catch (err) {
        console.error('[addblocker] cosmetic registration failed:', err);
    }
}

chrome.runtime.onInstalled.addListener(() => { void syncContentScripts(); });
chrome.runtime.onStartup.addListener(() => { void syncContentScripts(); });

// The worker can also be started by other events; reconciling is cheap when
// nothing changed, and this covers a registration lost to a crash.
void syncContentScripts();
