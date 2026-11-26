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
    /**
     * `#@#+js(...)`: cancels that exact invocation on these domains. With an
     * empty name — `#@#+js()` — it cancels every scriptlet there.
     */
    isException: boolean;
    isGeneric: boolean;
    /**
     * Whether the list this came from may use `trusted-*` scriptlets. Those
     * inject arbitrary text into pages, so uBlock Origin only honours them
     * from its own lists; a third-party list gets the restricted set.
     */
    trusted: boolean;
}

export interface ParseOptions {
    trusted?: boolean;
}

const SEPARATOR = /#(@)?(%)?#/;

const QUOTES = new Set(['"', "'", '`']);

/** An odd run of backslashes right before a position: the next char is escaped. */
const ODD_TRAILING_ESCAPE = /(?:^|[^\\])(?:\\\\)*\\$/;
const TRAILING_ESCAPES = /\\+$/;

interface ArgSpan {
    /** The argument's text, between `begin` and `end`. */
    begin: number;
    end: number;
    /** Where the next argument starts. */
    next: number;
    /** The delimiter that ended it: a comma, or the quote it was wrapped in. */
    delimiter: string;
    /** Whether an escaped delimiter was stepped over, and must be unescaped. */
    escaped: boolean;
}

/** Scans to the next unescaped `delimiter`, or to the end of the text. */
function scan(text: string, from: number, delimiter: string): { end: number; escaped: boolean } {
    let end = from;
    let escaped = false;
    while (end < text.length) {
        const at = text.indexOf(delimiter, end);
        if (at === -1) return { end: text.length, escaped };
        if (!ODD_TRAILING_ESCAPE.test(text.slice(0, at))) return { end: at, escaped };
        escaped = true;
        end = at + 1;
    }
    return { end, escaped };
}

/**
 * Reads one argument starting at `from`.
 *
 * This follows uBlock Origin's argument-list parser rule for rule, because the
 * lists are written against it and nothing else: an argument wrapped in `'`,
 * `"` or a backtick may contain commas, provided the closing quote is followed
 * by a comma or the end of the list; otherwise commas separate, unless escaped.
 * Nothing here knows about regexes — a list author writes `{2\,4}`.
 */
function nextArg(text: string, from: number): ArgSpan {
    const length = text.length;
    const start = from + (/^\s+/.exec(text.slice(from))?.[0].length ?? 0);

    const quote = text.charAt(start);
    if (QUOTES.has(quote)) {
        const { end, escaped } = scan(text, start + 1, quote);
        if (end !== length) {
            let next = end + 1;
            next += /^\s+/.exec(text.slice(next))?.[0].length ?? 0;
            if (next === length) return { begin: start + 1, end, next, delimiter: quote, escaped };
            if (text.charAt(next) === ',') {
                return { begin: start + 1, end, next: next + 1, delimiter: quote, escaped };
            }
        }
    }

    const { end: separator, escaped } = scan(text, start, ',');
    const next = separator < length ? separator + 1 : separator;
    const trailing = /(?:^|\S)(\s+)$/.exec(text.slice(0, separator))?.[1].length ?? 0;
    return { begin: start, end: separator - trailing, next, delimiter: ',', escaped };
}

/**
 * Removes the backslash that escaped a delimiter, and only that one.
 *
 * Every other backslash is the argument's own — `\/player(?:\?.+)?$` is a
 * regex, and stripping its backslashes turns it into a different one.
 */
function unescapeDelimiter(value: string, delimiter: string): string {
    let rest = value;
    let out = '';
    for (;;) {
        const at = rest.lastIndexOf(delimiter);
        if (at === -1) break;
        out = rest.slice(at) + out;
        rest = rest.slice(0, at);
        const run = TRAILING_ESCAPES.exec(rest);
        if (run === null) continue;
        const kept = (run[0].length & 1) !== 0 ? run[0].slice(0, -1) : run[0];
        out = kept + out;
        rest = rest.slice(0, -run[0].length);
    }
    return rest + out;
}

/**
 * Splits `name, arg1, arg2` the way uBlock Origin does.
 *
 * The first element is the scriptlet's name. Empty arguments are kept — they
 * are positional — except a trailing one after a final comma.
 */
export function splitArgs(text: string): string[] {
    if (text === '') return [];

    const head = nextArg(text, 0);
    const out = [text.slice(head.begin, Math.max(head.begin, head.end))];

    const rest = text.slice(head.next);
    let at = 0;
    for (;;) {
        const span = nextArg(rest, at);
        if (at === rest.length) break;
        const raw = rest.slice(span.begin, Math.max(span.begin, span.end));
        out.push(span.escaped ? unescapeDelimiter(raw, span.delimiter) : raw);
        at = span.next;
    }
    return out;
}

export function parseScriptletFilter(line: string, options: ParseOptions = {}): ScriptletFilter | null {
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

    const parts = splitArgs(inner);
    // Lists write `name` and `name.js` interchangeably.
    const name = (parts.shift() ?? '').replace(/\.js$/, '');
    // Only an exception may go unnamed: `#@#+js()` means "none of them here".
    if (name === '' && !isException) return null;

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
        trusted: options.trusted === true,
    };
}

export function parseScriptletList(content: string, options: ParseOptions = {}): ScriptletFilter[] {
    const filters: ScriptletFilter[] = [];
    for (const line of content.split('\n')) {
        const parsed = parseScriptletFilter(line, options);
        if (parsed !== null) filters.push(parsed);
    }
    return filters;
}
