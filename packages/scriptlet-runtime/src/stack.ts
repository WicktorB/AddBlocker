/**
 * Matches the current call stack against a needle.
 *
 * The stack is normalised first, to the form the lists are written against:
 * one ` function url:line:1` entry per frame, tab-separated, with the page's
 * own inline scripts named `inlineScript` and evaluated code `injectedScript`,
 * and a leading `stackDepth:N`.
 */

import { randomToken, testPattern, type PatternDetails } from './safe.js';

const FRAME = /(.*?@)?(\S+)(:\d+):\d+\)?$/;

export function matchesStackTrace(needle: PatternDetails): boolean {
    const token = randomToken();
    const error = new Error(token);
    const page = new URL(self.location.href);
    page.hash = '';

    const lines: string[] = [];
    for (const raw of (error.stack ?? '').split(/[\n\r]+/)) {
        if (raw.includes(token)) continue;
        const line = raw.trim();
        const match = FRAME.exec(line);
        if (match === null) continue;
        let url = match[2];
        if (url.startsWith('(')) url = url.slice(1);
        if (url === page.href) url = 'inlineScript';
        else if (url.startsWith('<anonymous>')) url = 'injectedScript';
        let fn = match[1] !== undefined ? match[1].slice(0, -1) : line.slice(0, match.index).trim();
        if (fn.startsWith('at')) fn = fn.slice(2).trim();
        lines.push(' ' + `${fn} ${url}${match[3]}:1`.trim());
    }
    lines[0] = `stackDepth:${lines.length - 1}`;
    return needle.matchAll !== true && testPattern(needle, lines.join('\t'));
}
