/**
 * Element picker.
 *
 * Injected on demand into the page. Highlights what the cursor is over, builds
 * the most durable selector it can, and shows how solid that selector is before
 * the user commits — a filter anchored on a generated class like `css-1x7ab3`
 * will stop working at the site's next deploy, and the user deserves to know
 * that at the moment they create it, not weeks later.
 */

(() => {
    if (window.__addblockerPicker) return;
    window.__addblockerPicker = true;

    // Kept in sync with packages/extension-core/src/selector.ts, which is where
    // these patterns are unit-tested.
    const GENERATED_CLASS = [
        /^[a-z]{1,4}-(?=[a-z0-9]*\d)[a-z0-9]{5,}$/i,
        /^[0-9a-f]{6,}$/i,
        /^_+[\w-]*_+[a-z0-9]{4,}$/i,
        /^[\w-]+__[a-z0-9]{5,}$/i,
        /\d{4,}/,
    ];
    const looksGenerated = (name) => GENERATED_CLASS.some((re) => re.test(name));

    const USEFUL_ATTRIBUTES = [
        'data-ad', 'data-ad-slot', 'data-ad-client', 'data-adunit',
        'data-testid', 'aria-label', 'role', 'data-module', 'data-component',
    ];

    const escapeIdent = (value) => value.replace(/([^\w-])/g, '\\$1');

    function describe(element) {
        const parent = element.parentElement;
        let nth = 1;
        if (parent !== null) {
            const sameTag = [...parent.children].filter((c) => c.tagName === element.tagName);
            nth = sameTag.indexOf(element) + 1;
        }
        return {
            tag: element.tagName.toLowerCase(),
            id: element.id || null,
            classes: [...element.classList],
            attributes: USEFUL_ATTRIBUTES
                .map((name) => [name, element.getAttribute(name)])
                .filter(([, value]) => value !== null),
            nthOfType: nth,
        };
    }

    function buildSelector(element) {
        const path = [];
        let current = element;
        while (current !== null && current !== document.documentElement && path.length < 8) {
            path.unshift(describe(current));
            current = current.parentElement;
        }
        if (path.length === 0) return '';

        const target = path[path.length - 1];

        if (target.id !== null && target.id !== '' && !looksGenerated(target.id)) {
            return `#${escapeIdent(target.id)}`;
        }

        for (const name of USEFUL_ATTRIBUTES) {
            const found = target.attributes.find(([attr]) => attr === name);
            if (found !== undefined && found[1] !== '') {
                return `${target.tag}[${found[0]}="${String(found[1]).replace(/"/g, '\\"')}"]`;
            }
        }

        const stable = target.classes.filter((c) => !looksGenerated(c));
        if (stable.length > 0) return `${target.tag}.${stable.map(escapeIdent).join('.')}`;

        for (let i = path.length - 2; i >= 0; i -= 1) {
            const ancestor = path[i];
            let anchor = null;
            if (ancestor.id !== null && ancestor.id !== '' && !looksGenerated(ancestor.id)) {
                anchor = `#${escapeIdent(ancestor.id)}`;
            } else {
                const classes = ancestor.classes.filter((c) => !looksGenerated(c));
                if (classes.length > 0) anchor = `${ancestor.tag}.${escapeIdent(classes[0])}`;
            }
            if (anchor !== null) {
                const descent = path.slice(i + 1)
                    .map((s) => `${s.tag}:nth-of-type(${s.nthOfType})`).join(' > ');
                return `${anchor} > ${descent}`;
            }
        }

        return path.map((s) => `${s.tag}:nth-of-type(${s.nthOfType})`).join(' > ');
    }

    function rate(selector) {
        if (selector.startsWith('#') && !selector.includes('>')) {
            return ['strong', 'Solide — ancré sur un identifiant'];
        }
        if (/\[[\w-]+=/.test(selector) && !selector.includes('nth-of-type')) {
            return ['strong', 'Solide — ancré sur un attribut stable'];
        }
        if (!selector.includes('nth-of-type')) {
            return ['fair', 'Correct — ancré sur une classe'];
        }
        return ['brittle', 'Fragile — dépend de la position, cassera si le site change'];
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = [
        'position:fixed', 'pointer-events:none', 'z-index:2147483646',
        'background:rgba(43,108,176,.28)', 'outline:2px solid #2b6cb0',
        'transition:all 40ms linear',
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
        'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483647',
        'max-width:min(560px,92vw)', 'padding:12px 14px', 'border-radius:8px',
        'background:#1a202c', 'color:#f7fafc', 'box-shadow:0 8px 28px rgba(0,0,0,.4)',
        'font:13px/1.5 system-ui,-apple-system,sans-serif',
    ].join(';');
    panel.innerHTML = `
        <div style="font-weight:600;margin-bottom:6px">Cliquez l'élément à masquer — Échap pour annuler</div>
        <code id="ab-sel" style="display:block;padding:6px 8px;background:#2d3748;border-radius:4px;
              word-break:break-all;font-size:12px">—</code>
        <div id="ab-rate" style="margin-top:6px;font-size:12px;color:#a0aec0">&nbsp;</div>`;

    let target = null;

    const onMove = (event) => {
        const element = event.target;
        if (!(element instanceof Element) || element === overlay || panel.contains(element)) return;
        target = element;

        const rect = element.getBoundingClientRect();
        overlay.style.top = `${rect.top}px`;
        overlay.style.left = `${rect.left}px`;
        overlay.style.width = `${rect.width}px`;
        overlay.style.height = `${rect.height}px`;

        const selector = buildSelector(element);
        const [score, label] = rate(selector);
        panel.querySelector('#ab-sel').textContent = selector;
        const rateEl = panel.querySelector('#ab-rate');
        rateEl.textContent = label;
        rateEl.style.color = score === 'strong' ? '#68d391' : score === 'fair' ? '#f6e05e' : '#fc8181';
    };

    const teardown = () => {
        overlay.remove();
        panel.remove();
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
        window.__addblockerPicker = false;
    };

    const onClick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (target === null) return;

        const selector = buildSelector(target);
        const host = location.hostname.replace(/^www\./, '');
        const filter = `${host}##${selector}`;

        chrome.runtime.sendMessage({ type: 'addFilter', payload: { filter } }, () => {
            // Hide it immediately: the registered script only applies on the
            // next load, and the user expects to see the result now.
            try {
                for (const el of document.querySelectorAll(selector)) {
                    el.style.setProperty('display', 'none', 'important');
                }
            } catch { /* selector may not be valid for querySelectorAll */ }
            teardown();
        });
    };

    const onKey = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); teardown(); }
    };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    document.documentElement.append(overlay, panel);
})();
