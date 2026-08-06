/**
 * Parses scriptlet filters: `domains##+js(name, arg1, arg2)` and AdGuard's
 * `domains#%#//scriptlet('name', 'arg1')`.
 */

export interface ScriptletFilter {
    raw: string;
    name: string;
    args: string[];
    domains: string[];
    excludedDomains: string[];
    /** `#@#+js(...)`: disables the scriptlet on these domains. */
    isException: boolean;
    isGeneric: boolean;
}

const SEPARATOR = /#(@)?(%)?#/;

/**
 * Splits scriptlet arguments on commas.
 *
 * uBO escapes a literal comma as `\,`, and arguments frequently contain
 * regexes with their own commas inside — `/^(a|b){2,3}$/` must stay one
 * argument.
 */
export function splitArgs(text: string): string[] {
    const args: string[] = [];
    let current = '';
    let escaped = false;
    let inRegex = false;

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];

        if (escaped) { current += ch; escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }

        // A `/` starts a regex only at the beginning of an argument.
        if (ch === '/' && !inRegex && current.trim() === '') { inRegex = true; current += ch; continue; }
        if (ch === '/' && inRegex) { inRegex = false; current += ch; continue; }

        if (ch === ',' && !inRegex) { args.push(current.trim()); current = ''; continue; }
        current += ch;
    }

    args.push(current.trim());
    return args;
}

/** Strips matching quotes around an AdGuard-style argument. */
function unquote(value: string): string {
    if (value.length >= 2
        && ((value.startsWith("'") && value.endsWith("'"))
            || (value.startsWith('"') && value.endsWith('"')))) {
        return value.slice(1, -1);
    }
    return value;
}

export function parseScriptletFilter(line: string): ScriptletFilter | null {
    const text = line.trim();
    if (text === '' || text.startsWith('!') || text.startsWith('[Adblock') || text.startsWith('/')) return null;

    const match = SEPARATOR.exec(text);
    if (match === null) return null;

    const isException = match[1] === '@';
    const isAdGuard = match[2] === '%';
    const domainPart = text.slice(0, match.index);
    const body = text.slice(match.index + match[0].length);

    let inner: string;
    if (body.startsWith('+js(')) {
        if (!body.endsWith(')')) return null;
        inner = body.slice(4, -1);
    } else if (isAdGuard && body.startsWith('//scriptlet')) {
        const open = body.indexOf('(');
        if (open === -1 || !body.endsWith(')')) return null;
        inner = body.slice(open + 1, -1);
    } else {
        return null;
    }

    const parts = splitArgs(inner).map(unquote);
    const name = parts.shift();
    if (name === undefined || name === '') return null;

    const domains: string[] = [];
    const excludedDomains: string[] = [];
    for (const entry of domainPart.split(',')) {
        const domain = entry.trim().toLowerCase();
        if (domain === '' || domain === '*') continue;
        if (domain.startsWith('~')) excludedDomains.push(domain.slice(1));
        else domains.push(domain);
    }

    return {
        raw: line,
        name,
        args: parts,
        domains,
        excludedDomains,
        isException,
        isGeneric: domains.length === 0,
    };
}

export function parseScriptletList(content: string): ScriptletFilter[] {
    const filters: ScriptletFilter[] = [];
    for (const line of content.split('\n')) {
        const parsed = parseScriptletFilter(line);
        if (parsed !== null) filters.push(parsed);
    }
    return filters;
}
