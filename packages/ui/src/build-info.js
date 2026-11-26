/**
 * What this build knows about itself, for the popup and the options page.
 *
 * Loaded as a plain script before theirs; it defines one global, `BuildInfo`.
 */

const BuildInfo = (() => {
    /** Past this, the lists are worth refreshing. */
    const STALE_LISTS_DAYS = 7;

    let cached = null;

    /** Reads build-info.json, written by the build next to the manifest. */
    async function load() {
        if (cached !== null) return cached;
        try {
            const response = await fetch(chrome.runtime.getURL('build-info.json'));
            cached = await response.json();
        } catch {
            // An older build without the file: fall back to the manifest.
            cached = { version: chrome.runtime.getManifest().version };
        }
        return cached;
    }

    /** "26 nov. 2026 à 14:35", in the reader's own time zone. */
    function formatDate(iso) {
        if (!iso) return 'date inconnue';
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return 'date inconnue';
        const day = date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
        const time = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        return `${day} à ${time}`;
    }

    function daysSince(iso) {
        if (!iso) return null;
        const then = new Date(iso).getTime();
        if (Number.isNaN(then)) return null;
        return Math.floor((Date.now() - then) / 86_400_000);
    }

    /** Whether the lists are old enough to say so. */
    function listsAreStale(info) {
        const days = daysSince(info.listsFetchedAt);
        return days !== null && days >= STALE_LISTS_DAYS;
    }

    /**
     * Asks GitHub whether `main` has moved past the commit this build was made
     * from.
     *
     * One request to the public API, made only when the options page is open —
     * never from the popup, and never in the background: an ad blocker that
     * phones home on a timer would be a strange thing to install.
     *
     * Resolves to `{ state, behind }` where state is one of:
     *   current   — built from the tip of main
     *   behind    — main is `behind` commits ahead
     *   local     — built from a commit GitHub does not have
     *   unknown   — no commit recorded, or GitHub could not be reached
     */
    async function checkForUpdate(info) {
        if (!info.commit || !info.repository) return { state: 'unknown' };
        try {
            const response = await fetch(
                `https://api.github.com/repos/${info.repository}/compare/${info.commit}...main`,
                { headers: { accept: 'application/vnd.github+json' }, cache: 'no-store' },
            );
            if (response.status === 404) return { state: 'local' };
            if (!response.ok) return { state: 'unknown' };
            const comparison = await response.json();
            const behind = Number(comparison.ahead_by ?? 0);
            return behind > 0 ? { state: 'behind', behind } : { state: 'current' };
        } catch {
            return { state: 'unknown' };
        }
    }

    return { load, formatDate, daysSince, listsAreStale, checkForUpdate, STALE_LISTS_DAYS };
})();
