/**
 * Shared helpers for the scriptlet catalogue.
 *
 * Everything here runs in the page's own world (`world: MAIN`), at
 * document_start, before the site's scripts. There is no `chrome.*` here and no
 * module loader — the bundle must be self-contained.
 */

/**
 * Builds a matcher from uBO's argument conventions: `/regex/flags`, a plain
 * substring, or an empty string meaning "match anything".
 */
export function matcher(pattern: string | undefined): (value: string) => boolean {
    if (pattern === undefined || pattern === '' || pattern === '*') return () => true;

    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
        const end = pattern.lastIndexOf('/');
        try {
            const re = new RegExp(pattern.slice(1, end), pattern.slice(end + 1));
            return (value) => re.test(value);
        } catch {
            return () => false;
        }
    }

    // A leading `!` negates, as uBO does for several scriptlets.
    if (pattern.startsWith('!')) {
        const inner = pattern.slice(1);
        return (value) => !value.includes(inner);
    }

    return (value) => value.includes(pattern);
}

/** Resolves uBO's value keywords used by `set-constant` and friends. */
export function resolveValue(raw: string): unknown {
    switch (raw) {
        case 'undefined': return undefined;
        case 'false': return false;
        case 'true': return true;
        case 'null': return null;
        case 'emptyObj': return {};
        case 'emptyArr': return [];
        case 'noopFunc': return () => { /* noop */ };
        case 'trueFunc': return () => true;
        case 'falseFunc': return () => false;
        case 'noopPromiseResolve': return () => Promise.resolve();
        case '': return undefined;
        default: {
            if (/^-?\d+$/.test(raw)) return Number(raw);
            if (/^-?\d*\.\d+$/.test(raw)) return Number(raw);
            return raw;
        }
    }
}

/**
 * Walks a dotted property path, installing a hook on the final property.
 *
 * The intermediate objects may not exist yet at document_start, so each level
 * is itself hooked and the chain completed lazily as the page builds it.
 */
export function definePath(
    root: unknown,
    path: string,
    install: (owner: Record<string, unknown>, prop: string) => void,
): void {
    const parts = path.split('.');
    const last = parts.pop();
    if (last === undefined) return;

    const step = (owner: unknown, index: number): void => {
        if (owner === null || owner === undefined) return;
        if (index === parts.length) {
            install(owner as Record<string, unknown>, last);
            return;
        }

        const name = parts[index];
        const record = owner as Record<string, unknown>;
        const existing = record[name];
        if (existing !== undefined && existing !== null) {
            step(existing, index + 1);
            return;
        }

        // Not there yet: wait for the page to create it.
        let stored: unknown;
        try {
            Object.defineProperty(record, name, {
                configurable: true,
                get() { return stored; },
                set(value: unknown) {
                    stored = value;
                    if (value !== null && value !== undefined) step(value, index + 1);
                },
            });
        } catch {
            // A non-configurable property: nothing we can do.
        }
    };

    step(root, 0);
}

/**
 * Set while the scriptlets of a page are being installed.
 *
 * A trap must show its installer the real value and everyone else the forced
 * one. When the scriptlets arrive as an inline `<script>`, that script is
 * `document.currentScript` and can be told apart; injected by the browser as a
 * content script there is no current script at all, and neither is there one
 * inside a timer or an event handler of the page — so "no current script"
 * cannot be taken to mean "us". This flag says it instead.
 */
export const installing = { active: false };

let abortToken: string | undefined;

/**
 * Prepares for aborting scripts: picks the marker the thrown errors will
 * carry, and starts recognising it.
 *
 * Aborting a script means throwing inside it, on purpose. Left alone, each of
 * those throws surfaces as an uncaught error in the page's console, where a
 * working filter then reads as a defect. An `error` event whose message
 * carries the marker is ours, and is cancelled — which is all it takes for the
 * browser not to report it. Every other error is left exactly as it was.
 *
 * The listener is attached when the scriptlet is installed, not when it first
 * fires: at document_start nothing of the page has run, so it is first in line
 * and the page holds no reference with which to remove it. (Assigning
 * `window.onerror` would have been undone by the first site that assigns its
 * own, which is most of them.)
 */
export function armAbort(): string {
    if (abortToken !== undefined) return abortToken;
    const token = String.fromCharCode(Date.now() % 26 + 97)
        + Math.floor(Math.random() * 982451653 + 982451653).toString(36);
    abortToken = token;
    try {
        EventTarget.prototype.addEventListener.call(self, 'error', (event: Event) => {
            const { message, error } = event as ErrorEvent;
            const ours = (typeof message === 'string' && message.includes(token))
                || (error instanceof Error && error.message === token);
            if (ours) event.preventDefault();
        }, true);
    } catch { /* no window to listen on */ }
    return token;
}

/** Thrown to abort a script, mirroring uBO's approach. */
export function abort(): never {
    throw new ReferenceError(armAbort());
}

/** Text of the script currently executing, for `abort-current-script`. */
export function currentScriptText(): string {
    const script = document.currentScript;
    return script instanceof HTMLScriptElement ? (script.textContent ?? script.src) : '';
}

/** Safely reads a nested property without throwing. */
export function getPath(root: unknown, path: string): unknown {
    let current = root;
    for (const part of path.split('.')) {
        if (current === null || current === undefined) return undefined;
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}
