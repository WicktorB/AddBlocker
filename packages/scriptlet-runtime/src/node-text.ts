/**
 * Rewrites the text of nodes as the parser inserts them — in practice, the
 * source of inline scripts, before they run.
 *
 * A mutation observer is told about a parser-inserted `<script>` before the
 * script executes, so replacing its text at that point changes what runs. It
 * is the only way to alter an inline script without touching the network
 * response it came in, which Manifest V3 does not allow.
 *
 * These scriptlets run in the extension's isolated world, as they do in
 * uBlock Origin: they only need the DOM, and from there the page can neither
 * see nor disturb the observer.
 */

import { natives, parseVarargs, patternToRegex, randomToken, runAt } from './safe.js';

interface ScriptTextFactory {
    createScript(text: string): unknown;
}

/**
 * Where a page enforces Trusted Types, assigning a string to a script's text
 * is refused. A policy of our own makes the assignment legitimate; where
 * nothing is enforced the string is used as is.
 */
function scriptTextFactory(): ScriptTextFactory {
    const passthrough: ScriptTextFactory = { createScript: (text) => text };
    try {
        const tt = (globalThis as unknown as { trustedTypes?: any }).trustedTypes;
        if (tt instanceof Object && typeof tt.getPropertyType === 'function') {
            if (tt.getPropertyType('script', 'textContent') === 'TrustedScript') {
                return tt.createPolicy(randomToken(), passthrough);
            }
        }
    } catch {
        // The page restricts policy names. The plain string is all there is.
    }
    return passthrough;
}

export function replaceNodeTextFn(
    nodeName = '',
    pattern = '',
    replacement = '',
    ...varargs: string[]
): void {
    const { regExpTest } = natives();
    const reNodeName = patternToRegex(nodeName, 'i', true);
    const rePattern = patternToRegex(pattern, 'gms');
    const extraArgs = parseVarargs(varargs);
    const includes = extraArgs.includes || extraArgs.condition;
    const reIncludes = includes ? patternToRegex(`${includes}`, 'ms') : null;
    const reExcludes = extraArgs.excludes ? patternToRegex(`${extraArgs.excludes}`, 'ms') : null;
    const factory = scriptTextFactory();
    let sedCount = (extraArgs.sedCount as number | undefined) ?? Number.MAX_SAFE_INTEGER;

    const handleNode = (node: Node): void => {
        const before = node.textContent ?? '';
        if (reIncludes) {
            reIncludes.lastIndex = 0;
            if (!regExpTest(reIncludes, before)) return;
        }
        if (reExcludes) {
            reExcludes.lastIndex = 0;
            if (regExpTest(reExcludes, before)) return;
        }
        rePattern.lastIndex = 0;
        if (!regExpTest(rePattern, before)) return;
        rePattern.lastIndex = 0;
        const after = pattern !== '' ? before.replace(rePattern, replacement) : replacement;
        try {
            node.textContent = (node.nodeName === 'SCRIPT'
                ? factory.createScript(after)
                : after) as string;
        } catch {
            // Refused by the page's policy: the node keeps its text.
            return;
        }
        sedCount -= 1;
    };

    const handleTree = (root: Node): void => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        const { currentScript } = document;
        for (;;) {
            const node = walker.nextNode();
            if (node === null) break;
            if (node === currentScript) continue;
            if (reNodeName.test(node.nodeName)) {
                handleNode(node);
            } else if (node.nodeName === 'TEMPLATE') {
                handleTree((node as HTMLTemplateElement).content);
            } else {
                continue;
            }
            if (sedCount === 0) break;
        }
    };

    if (document.documentElement) handleTree(document.documentElement);

    const stay = Boolean(extraArgs.stay);
    if (sedCount === 0 && !stay) return;

    const handleMutations = (mutations: MutationRecord[]): void => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (reNodeName.test(node.nodeName)) {
                    handleNode(node);
                } else if (node.nodeName === 'TEMPLATE') {
                    handleTree((node as HTMLTemplateElement).content);
                } else {
                    continue;
                }
                if (sedCount === 0) { stop(false); return; }
            }
        }
    };
    const observer = new MutationObserver(handleMutations);
    const stop = (takeRecords = true): void => {
        const pending = takeRecords ? observer.takeRecords() : [];
        observer.disconnect();
        handleMutations(pending);
    };
    observer.observe(document, { childList: true, subtree: true });
    if (stay) return;
    runAt(() => {
        const quitAfter = (extraArgs.quitAfter as number | undefined) ?? 0;
        if (quitAfter === 0) { stop(); return; }
        setTimeout(() => { stop(); }, quitAfter);
    }, 'interactive');
}

/** `rmnt`: empties the nodes whose text matches. */
export function removeNodeText(nodeName?: string, includes?: string, ...extraArgs: string[]): void {
    replaceNodeTextFn(nodeName, '', '', 'includes', includes || '', ...extraArgs);
}

/** `rpnt`: replaces what `pattern` matches in the text of the nodes. */
export function replaceNodeText(
    nodeName?: string, pattern?: string, replacement?: string, ...extraArgs: string[]
): void {
    replaceNodeTextFn(nodeName, pattern, replacement, ...extraArgs);
}
