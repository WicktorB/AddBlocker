/**
 * Procedural selector engine.
 *
 * Only handles what CSS cannot express. `:has()` is native in Chrome and never
 * reaches this code — it stays in the stylesheet, where the browser's own
 * matching is far faster than anything we could do here.
 */

export interface ProceduralStep {
    name: string;
    arg: string;
}

export interface ProceduralSelector {
    /** Plain CSS prefix used to seed the candidate set. */
    prefix: string;
    steps: ProceduralStep[];
    /** `:remove()` deletes the node instead of hiding it. */
    remove: boolean;
    /** Declaration to apply instead of hiding. */
    declaration: string | null;
}

/** Splits `div.ad:has-text(Sponsored):upward(2)` into a prefix plus steps. */
export function parseProcedural(selector: string): ProceduralSelector | null {
    const steps: ProceduralStep[] = [];
    let prefix = '';
    let rest = selector;
    let remove = false;

    // Walk left to right, peeling off procedural pseudo-classes.
    const PSEUDO = /:(-abp-)?(has-text|contains|matches-css|matches-css-before|matches-css-after|matches-attr|matches-path|upward|xpath|min-text-length|remove|remove-attr|remove-class|others|watch-attr)\(/;

    for (;;) {
        const match = PSEUDO.exec(rest);
        if (match === null) {
            prefix += rest;
            break;
        }

        prefix += rest.slice(0, match.index);

        // Find the matching close paren, respecting nesting.
        let depth = 1;
        let i = match.index + match[0].length;
        for (; i < rest.length && depth > 0; i += 1) {
            if (rest[i] === '(') depth += 1;
            else if (rest[i] === ')') depth -= 1;
        }
        if (depth !== 0) return null;

        const arg = rest.slice(match.index + match[0].length, i - 1);
        const name = match[2];
        if (name === 'remove') remove = true;
        else steps.push({ name, arg });

        rest = rest.slice(i);
    }

    if (steps.length === 0 && !remove) return null;
    return { prefix: prefix.trim() === '' ? '*' : prefix.trim(), steps, remove, declaration: null };
}

function textOf(element: Element): string {
    return (element as HTMLElement).innerText ?? element.textContent ?? '';
}

/** Builds a matcher for `/regex/` or plain-substring arguments. */
function textMatcher(arg: string): (value: string) => boolean {
    const trimmed = arg.trim();
    if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
        const end = trimmed.lastIndexOf('/');
        try {
            const re = new RegExp(trimmed.slice(1, end), trimmed.slice(end + 1));
            return (value) => re.test(value);
        } catch {
            return () => false;
        }
    }
    return (value) => value.includes(trimmed);
}

function applyStep(elements: Element[], step: ProceduralStep): Element[] {
    switch (step.name) {
        case 'has-text': case 'contains': {
            const matches = textMatcher(step.arg);
            return elements.filter((el) => matches(textOf(el)));
        }

        case 'min-text-length': {
            const min = Number(step.arg);
            return Number.isFinite(min) ? elements.filter((el) => textOf(el).length >= min) : [];
        }

        case 'upward': {
            const steps = Number(step.arg);
            if (Number.isFinite(steps)) {
                return elements.map((el) => {
                    let node: Element | null = el;
                    for (let i = 0; i < steps && node !== null; i += 1) node = node.parentElement;
                    return node;
                }).filter((el): el is Element => el !== null);
            }
            // Non-numeric argument is a selector to walk up to.
            return elements.map((el) => el.closest(step.arg)).filter((el): el is Element => el !== null);
        }

        case 'matches-css': case 'matches-css-before': case 'matches-css-after': {
            const colon = step.arg.indexOf(':');
            if (colon === -1) return [];
            const property = step.arg.slice(0, colon).trim();
            const matches = textMatcher(step.arg.slice(colon + 1));
            const pseudo = step.name === 'matches-css' ? undefined
                : step.name === 'matches-css-before' ? '::before' : '::after';
            return elements.filter((el) => {
                const value = getComputedStyle(el, pseudo).getPropertyValue(property);
                return matches(value);
            });
        }

        case 'matches-attr': {
            const eq = step.arg.indexOf('=');
            const name = (eq === -1 ? step.arg : step.arg.slice(0, eq)).trim();
            const matches = eq === -1 ? null : textMatcher(step.arg.slice(eq + 1));
            return elements.filter((el) => {
                const value = el.getAttribute(name);
                if (value === null) return false;
                return matches === null || matches(value);
            });
        }

        case 'matches-path': {
            const matches = textMatcher(step.arg);
            return matches(location.pathname + location.search) ? elements : [];
        }

        case 'xpath': {
            const found: Element[] = [];
            for (const el of elements) {
                const result = document.evaluate(
                    step.arg, el, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null,
                );
                for (let i = 0; i < result.snapshotLength; i += 1) {
                    const node = result.snapshotItem(i);
                    if (node instanceof Element) found.push(node);
                }
            }
            return found;
        }

        case 'remove-attr': {
            for (const el of elements) {
                for (const name of step.arg.split('|')) el.removeAttribute(name.trim());
            }
            // A mutation step, not a filter: the set passes through untouched.
            return [];
        }

        case 'remove-class': {
            for (const el of elements) {
                for (const name of step.arg.split('|')) el.classList.remove(name.trim());
            }
            return [];
        }

        // `:others()` and `:watch-attr()` need state we do not keep; skipping
        // them is safer than approximating and hiding the wrong element.
        default:
            return [];
    }
}

/** Resolves a procedural selector against the current document. */
export function resolve(selector: ProceduralSelector, root: ParentNode = document): Element[] {
    let elements: Element[];
    try {
        // `:xpath()` with no prefix starts from the document, not from `*`.
        if (selector.prefix === '*' && selector.steps[0]?.name === 'xpath') {
            elements = [document.documentElement];
        } else {
            elements = [...root.querySelectorAll(selector.prefix)];
        }
    } catch {
        return [];
    }

    for (const step of selector.steps) {
        if (elements.length === 0) return [];
        elements = applyStep(elements, step);
    }

    return elements;
}
