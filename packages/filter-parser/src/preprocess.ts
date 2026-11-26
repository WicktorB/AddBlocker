/**
 * Preprocessor directives (`!#if`, `!#else`, `!#endif`).
 *
 * uBO's lists are not flat: blocks are fenced by conditions on the environment
 * the list is being compiled for — `!#if env_firefox`, `!#if !env_mobile`,
 * `!#if cap_html_filtering`. To every other parser those lines are comments,
 * so a parser that ignores them applies *every* branch at once: the filters
 * meant for Firefox, the ones meant for mobile, and both sides of each
 * `!#else`.
 *
 * The directives are resolved here, on the raw text, before any filter is
 * parsed. That keeps the three parsers (network, cosmetic, scriptlet) unaware
 * of them, and guarantees they all see the same lines.
 */

/** The tokens that hold for a given build target. */
export type PreprocessEnv = ReadonlySet<string>;

/**
 * The extension: uBO-syntax lists, on Chromium, under Manifest V3. This is the
 * set uBO Lite declares for itself, which is the closest relative there is.
 */
export const EXTENSION_ENV: PreprocessEnv = new Set([
    'ext_ublock', 'ext_ubol', 'env_chromium', 'env_mv3', 'cap_user_stylesheet',
]);

/**
 * The userscript: runs mostly in Safari on iOS, never in an extension context.
 * Neither `env_chromium` nor `env_firefox` holds — the script cannot know its
 * engine at build time, and a block written for one engine's quirks is better
 * left out than applied to another.
 */
export const USERSCRIPT_ENV: PreprocessEnv = new Set([
    'ext_ublock', 'env_mobile', 'env_safari',
]);

const TOKEN = /^[a-z0-9_]+$/;

/**
 * Evaluates a directive expression.
 *
 * Supports what the lists use: tokens, `!` negation, `&&`, `||` and
 * parentheses. A token outside the environment is false — including one this
 * code has never heard of, so a block guarded by a capability we do not know
 * we have is left out rather than applied blind. Returns `null` when the
 * expression cannot be parsed at all.
 */
export function evaluateDirective(expression: string, env: PreprocessEnv): boolean | null {
    const tokens = expression.match(/&&|\|\||!|\(|\)|[^\s!()&|]+/g);
    if (tokens === null) return null;

    let position = 0;
    let malformed = false;

    const parsePrimary = (): boolean => {
        const token = tokens[position];
        if (token === undefined) { malformed = true; return false; }
        position += 1;

        if (token === '!') return !parsePrimary();
        if (token === '(') {
            const value = parseOr();
            if (tokens[position] !== ')') malformed = true;
            position += 1;
            return value;
        }
        if (!TOKEN.test(token)) { malformed = true; return false; }
        return env.has(token);
    };

    const parseAnd = (): boolean => {
        let value = parsePrimary();
        while (tokens[position] === '&&') {
            position += 1;
            // Evaluate both sides regardless, so a malformed right-hand side is
            // still noticed.
            const right = parsePrimary();
            value = value && right;
        }
        return value;
    };

    function parseOr(): boolean {
        let value = parseAnd();
        while (tokens[position] === '||') {
            position += 1;
            const right = parseAnd();
            value = value || right;
        }
        return value;
    }

    const result = parseOr();
    if (malformed || position !== tokens.length) return null;
    return result;
}

export interface PreprocessResult {
    text: string;
    /** `!#if` blocks seen. */
    blocks: number;
    /** Lines removed because their condition did not hold. */
    droppedLines: number;
    /** Directives that could not be parsed; their block is dropped. */
    malformed: number;
}

/**
 * Removes the lines whose enclosing conditions do not hold for `env`.
 *
 * Line count is preserved — dropped lines become empty ones — so the line
 * numbers reported elsewhere in the build still point into the original list.
 */
export function preprocess(content: string, env: PreprocessEnv): PreprocessResult {
    const lines = content.split('\n');
    // One entry per open `!#if`: whether this branch is live, and whether the
    // block's condition held (needed to flip on `!#else`).
    const stack: Array<{ live: boolean; condition: boolean }> = [];
    let blocks = 0;
    let droppedLines = 0;
    let malformed = 0;

    const live = (): boolean => stack.every((frame) => frame.live);

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();

        if (line.startsWith('!#if ') || line === '!#if') {
            blocks += 1;
            const value = evaluateDirective(line.slice(4), env);
            if (value === null) malformed += 1;
            // An unparseable condition drops its block: never apply what we
            // could not decide.
            stack.push({ live: value === true, condition: value === true });
            lines[i] = '';
            continue;
        }

        if (line === '!#else') {
            const frame = stack[stack.length - 1];
            if (frame !== undefined) frame.live = !frame.condition;
            lines[i] = '';
            continue;
        }

        if (line === '!#endif') {
            stack.pop();
            lines[i] = '';
            continue;
        }

        if (stack.length > 0 && !live()) {
            if (line !== '') droppedLines += 1;
            lines[i] = '';
        }
    }

    return { text: lines.join('\n'), blocks, droppedLines, malformed };
}
