/**
 * Builds a CSS selector for an element the user picked.
 *
 * The goal is not the shortest selector but the most *durable* one. A selector
 * built from a generated class like `css-1x7ab3` breaks on the site's next
 * deploy; one built from a stable id or a semantic class survives. When nothing
 * stable exists we fall back to structure, which is worse but predictable.
 */

export interface ElementDescriptor {
    tag: string;
    id: string | null;
    classes: string[];
    /** Attributes worth keeping, in priority order. */
    attributes: Array<[name: string, value: string]>;
    /** 1-based position among siblings of the same tag. */
    nthOfType: number;
}

/**
 * Classes that look machine-generated.
 *
 * CSS-in-JS and hashed build output produce names that change on every
 * deployment; a filter built on one is worse than useless because it fails
 * silently later.
 */
const GENERATED_CLASS = [
    // Short prefix + a token mixing letters and digits: `css-1x7ab3` (emotion),
    // `jss-a1b2c`. The lookahead requires a digit so `ad-banner` is spared —
    // over-flagging a meaningful class would push the picker to a worse
    // selector than the one it was handed.
    /^[a-z]{1,4}-(?=[a-z0-9]*\d)[a-z0-9]{5,}$/i,
    /^[0-9a-f]{6,}$/i,               // a1b2c3d4
    /^_+[\w-]*_+[a-z0-9]{4,}$/i,     // __styles__x1y2
    /^[\w-]+__[a-z0-9]{5,}$/i,       // Button__x9k2m
    /\d{4,}/,                        // anything with a long digit run
];

export function looksGenerated(className: string): boolean {
    return GENERATED_CLASS.some((pattern) => pattern.test(className));
}

/** Attributes that identify an ad slot more reliably than a class does. */
const USEFUL_ATTRIBUTES = [
    'data-ad', 'data-ad-slot', 'data-ad-client', 'data-adunit', 'data-testid',
    'aria-label', 'role', 'data-module', 'data-component',
];

function escapeIdentifier(value: string): string {
    // CSS.escape is unavailable outside the browser; this covers the cases a
    // class or id can actually contain.
    return value.replace(/([^\w-])/g, '\\$1');
}

/** Turns a descriptor into a selector, preferring stable anchors. */
export function buildSelector(path: ElementDescriptor[]): string {
    if (path.length === 0) return '';

    const target = path[path.length - 1];

    // An id is the strongest anchor there is — if it is not generated.
    if (target.id !== null && target.id !== '' && !looksGenerated(target.id)) {
        return `#${escapeIdentifier(target.id)}`;
    }

    // A meaningful attribute beats a class: sites rename classes far more
    // often than they change their ad-slot markers.
    for (const name of USEFUL_ATTRIBUTES) {
        const found = target.attributes.find(([attr]) => attr === name);
        if (found !== undefined && found[1] !== '') {
            return `${target.tag}[${found[0]}="${found[1].replace(/"/g, '\\"')}"]`;
        }
    }

    const stableClasses = target.classes.filter((c) => !looksGenerated(c));
    if (stableClasses.length > 0) {
        return `${target.tag}.${stableClasses.map(escapeIdentifier).join('.')}`;
    }

    // Nothing stable on the element itself: anchor on the nearest ancestor
    // that has something, then describe the way down.
    for (let i = path.length - 2; i >= 0; i -= 1) {
        const ancestor = path[i];
        let anchor: string | null = null;

        if (ancestor.id !== null && ancestor.id !== '' && !looksGenerated(ancestor.id)) {
            anchor = `#${escapeIdentifier(ancestor.id)}`;
        } else {
            const classes = ancestor.classes.filter((c) => !looksGenerated(c));
            if (classes.length > 0) anchor = `${ancestor.tag}.${escapeIdentifier(classes[0])}`;
        }

        if (anchor !== null) {
            const descent = path.slice(i + 1)
                .map((step) => `${step.tag}:nth-of-type(${step.nthOfType})`)
                .join(' > ');
            return `${anchor} > ${descent}`;
        }
    }

    // Last resort: pure structure. Brittle, but at least it is honest about it.
    return path.map((step) => `${step.tag}:nth-of-type(${step.nthOfType})`).join(' > ');
}

/** Assembles the filter line for a selector on a site. */
export function buildCosmeticFilter(hostname: string, selector: string): string {
    const host = hostname.replace(/^www\./, '');
    return `${host}##${selector}`;
}

/**
 * Rates how likely a selector is to keep working.
 *
 * Shown in the picker so the user can tell a solid filter from one that will
 * quietly stop working after the site's next deploy.
 */
export function rateSelector(selector: string): { score: 'strong' | 'fair' | 'brittle'; why: string } {
    if (selector.startsWith('#') && !selector.includes('>')) {
        return { score: 'strong', why: 'ancré sur un identifiant' };
    }
    if (/\[[\w-]+=/.test(selector) && !selector.includes('nth-of-type')) {
        return { score: 'strong', why: 'ancré sur un attribut stable' };
    }
    if (!selector.includes('nth-of-type')) {
        return { score: 'fair', why: 'ancré sur une classe' };
    }
    return { score: 'brittle', why: 'dépend de la position dans la page, cassera si le site change' };
}
