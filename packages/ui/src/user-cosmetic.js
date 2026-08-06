/**
 * Applies the user's own cosmetic filters.
 *
 * Unlike the generated buckets, these live in storage because they change at
 * runtime — so this read is async and a brief flash is possible on first paint.
 * That is an acceptable trade for a handful of hand-written filters; the bulk
 * of filtering stays inlined and synchronous.
 */
(() => {
    chrome.storage.local.get('userCosmeticRules', (stored) => {
        const rules = stored?.userCosmeticRules;
        if (!rules) return;

        const selectors = [...(rules.generic ?? [])];
        let host = location.hostname.replace(/^www\./, '');
        while (host.includes('.')) {
            const forHost = rules.byDomain?.[host];
            if (forHost) selectors.push(...forHost);
            host = host.slice(host.indexOf('.') + 1);
        }
        if (selectors.length === 0) return;

        const style = document.createElement('style');
        style.textContent = `${selectors.join(',')}{display:none!important;}`;
        (document.head || document.documentElement).append(style);
    });
})();
