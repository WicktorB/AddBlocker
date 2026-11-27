/**
 * The JSON path queries used by the `json-edit` and `edit-inbound-object`
 * families of scriptlets.
 *
 * This is uBlock Origin's dialect, not RFC 9535, and the lists depend on its
 * every particular:
 *   .a.b   ..b   [*]   ["a","b"]   [0]   [-1]   ./regex/
 *   [?.path]              keep the nodes for which `.path` exists
 *   [?!.path]             … for which it does not
 *   [?.path==value]       with == != < <= > >= ^= $= *=, or =/regex/
 * A query that only selects removes what it selects. One that ends in an
 * assignment changes it instead:
 *   …=value               set to a JSON value
 *   …+={"k":1}            merge into an object, or append to an array
 *   …=repl({"regex":"…","replacement":"…"})   rewrite a string
 *
 * The behaviour, corner cases included, follows uBO's implementation, which is
 * what the filters were tested against.
 */

import { hasOwn } from './safe.js';

const enum Move { Undefined, Root, Current, Children, Descendants, Quantifier }

type Key = string | number | RegExp | Array<string | number | RegExp>;

interface Step {
    mv: Move;
    k?: Key;
    steps?: Step[];
    op?: string;
    rval?: unknown;
    not?: boolean;
    min?: number;
    max?: number;
}

interface Compiled {
    steps: Step[];
    i: number;
    modify?: string;
    rval?: unknown;
    v2?: boolean;
    re?: RegExp | null;
}

type PathKey = string | number;
type Path = PathKey[];

const UNQUOTED_IDENTIFIER = /^[A-Za-z_][\w]*|^\*/;
const EXPRESSION = /^\s*([!=^$*]=|[<>]=?)\s*(.+?)\]/;
const INDICE = /^-?\d+/;
const RVALUE_CALL = /^=([a-z]+)\((.+)\)$/;
const QUANTIFIER = /^\{(\d+|\d+,\d+|\d+,|,\d+)\};\$/;

export class JSONPath {
    private compiled: Compiled | undefined;
    private root: Record<string, unknown> | null = null;
    private v2 = false;

    static create(query: string): JSONPath {
        const jsonp = new JSONPath();
        jsonp.compile(query);
        return jsonp;
    }

    /** The value assigned by the query, if it assigns one. */
    get value(): unknown {
        return this.compiled && this.compiled.rval;
    }

    get valid(): boolean {
        return this.compiled !== undefined;
    }

    compile(query: string): void {
        this.compiled = undefined;
        this.v2 = query.startsWith('v2:');
        if (this.v2) query = query.slice(3);
        const r = this.compileSteps(query, 0);
        if (r === undefined) return;
        if (r.i !== query.length) {
            let val: string | undefined;
            if (query.startsWith('=', r.i)) {
                const match = RVALUE_CALL.exec(query.slice(r.i));
                if (match) {
                    r.modify = match[1];
                    val = match[2];
                } else {
                    val = query.slice(r.i + 1);
                }
            } else if (query.startsWith('+=', r.i)) {
                r.modify = '+';
                val = query.slice(r.i + 2);
            }
            try { r.rval = JSON.parse(val as string); } catch { return; }
        }
        r.v2 = this.v2;
        this.compiled = r;
    }

    /** The paths the query selects in `root`, without changing anything. */
    evaluate(root: unknown): Path[] {
        if (this.compiled === undefined) return [];
        this.root = { $: root };
        const paths = this.evaluateSteps(this.compiled.steps, []);
        this.root = null;
        return paths;
    }

    /**
     * Applies the query to `root`, in place. Returns the (possibly replaced)
     * root when the query selected something, `undefined` when it did not.
     */
    apply(root: unknown): unknown {
        if (this.compiled === undefined) return undefined;
        const { rval } = this.compiled;
        this.root = { $: root };
        const paths = this.evaluateSteps(this.compiled.steps, []);
        let i = paths.length;
        if (i === 0) { this.root = null; return undefined; }
        while (i--) {
            const { obj, key } = this.resolvePath(paths[i]);
            if (obj === undefined) continue;
            if (rval !== undefined) {
                this.modifyVal(obj, key as PathKey);
            } else if (Array.isArray(obj) && typeof key === 'number') {
                obj.splice(key, 1);
            } else {
                delete obj[key as PathKey];
            }
        }
        const result = this.root.$ ?? null;
        this.root = null;
        return result;
    }

    private compileSteps(query: string, i: number): Compiled | undefined {
        if (query.length === 0) return undefined;
        const steps: Step[] = [];
        let c = query.charCodeAt(i);
        if (c === 0x24 /* $ */) {
            steps.push({ mv: Move.Root });
            i += 1;
        } else if (c === 0x40 /* @ */) {
            steps.push({ mv: Move.Current });
            i += 1;
        } else {
            steps.push({ mv: i === 0 ? Move.Root : Move.Current });
        }
        let mv: Move = Move.Undefined;
        for (;;) {
            if (i === query.length) break;
            c = query.charCodeAt(i);
            if (c === 0x20 /* space */) { i += 1; continue; }
            if (c === 0x2E /* . */) {
                if (mv !== Move.Undefined) return undefined;
                if (query.startsWith('..', i)) {
                    mv = Move.Descendants;
                    i += 2;
                } else {
                    mv = Move.Children;
                    i += 1;
                }
                continue;
            }
            if (c === 0x3B /* ; */) {
                if (!query.startsWith(';$', i)) return undefined;
                steps.push({ mv: Move.Quantifier, min: 1, max: 1e6 }, { mv: Move.Root });
                i += 2;
                mv = Move.Undefined;
                continue;
            }
            if (c === 0x7B /* { */) {
                const match = QUANTIFIER.exec(query.slice(i));
                if (match === null) return undefined;
                const comma = match[1].indexOf(',');
                let min: number;
                let max: number;
                if (comma === -1) {
                    min = max = parseInt(match[1]);
                } else {
                    min = parseInt(match[1].slice(0, comma)) || 0;
                    max = parseInt(match[1].slice(comma + 1)) || 1e6;
                }
                steps.push({ mv: Move.Quantifier, min, max }, { mv: Move.Root });
                i += match[0].length;
                mv = Move.Undefined;
                continue;
            }
            if (c !== 0x5B /* [ */) {
                if (mv === Move.Undefined) {
                    const step = steps[steps.length - 1];
                    if (step === undefined) return undefined;
                    const j = this.compileExpr(query, step, i);
                    if (j) i = j;
                    break;
                }
                const r = this.consumeUnquotedIdentifier(query, i);
                if (r === undefined) return undefined;
                steps.push({ mv, k: r.s });
                i = r.i;
                mv = Move.Undefined;
                continue;
            }
            // Bracket accessor.
            if (mv === Move.Children) return undefined;
            if (query.startsWith('[?', i)) {
                const not = query.charCodeAt(i + 2) === 0x21 /* ! */ ? 1 : 0;
                const r = this.compileSteps(query, i + 2 + not);
                if (r === undefined) return undefined;
                if (!query.startsWith(']', r.i)) return undefined;
                if (not) r.steps[r.steps.length - 1].not = true;
                steps.push({ mv: mv || Move.Children, steps: r.steps });
                i = r.i + 1;
                mv = Move.Undefined;
                continue;
            }
            if (query.startsWith('[*]', i)) {
                steps.push({ mv: mv || Move.Children, k: '*' });
                i += 3;
                mv = Move.Undefined;
                continue;
            }
            const r = this.consumeIdentifier(query, i + 1);
            if (r === undefined) return undefined;
            steps.push({ mv: mv || Move.Children, k: r.s });
            i = r.i + 1;
            mv = Move.Undefined;
        }
        if (steps.length === 0) return undefined;
        if (mv !== Move.Undefined) return undefined;
        return { steps, i };
    }

    private evaluateSteps(steps: Step[] | undefined, pathin: Path): Path[] {
        let resultset: Path[] = [];
        if (!Array.isArray(steps)) return resultset;
        for (const step of steps) {
            switch (step.mv) {
            case Move.Root:
                resultset = [['$']];
                break;
            case Move.Current:
                if (step.op) {
                    const { obj, key } = this.resolvePath(pathin);
                    if (obj === undefined) return [];
                    if (this.evaluateExpr(step, obj, key as PathKey) !== true) break;
                }
                resultset = [pathin];
                break;
            case Move.Children:
            case Move.Descendants:
                if (resultset.length === 0) break;
                resultset = this.getMatches(resultset, step);
                break;
            case Move.Quantifier: {
                const { length } = resultset;
                if (length < (step.min as number) || length > (step.max as number)) return [];
                resultset = [];
                break;
            }
            default:
                break;
            }
        }
        return resultset;
    }

    private getMatches(listin: Path[], step: Step): Path[] {
        const listout: Path[] = [];
        for (const pathin of listin) {
            const { value: owner } = this.resolvePath(pathin);
            if (owner === undefined) continue;
            if (step.steps) {
                this.getMatchesFromExpr(pathin, step, owner, listout);
                continue;
            }
            const keys = this.expandKey(owner, step.k as Key);
            if (keys) {
                for (const k of keys) {
                    if (this.evaluateExpr(step, owner, k) !== true) continue;
                    listout.push([...pathin, k]);
                }
            }
            if (step.mv !== Move.Descendants) continue;
            for (const { obj, key, path } of this.descendants(owner, true)) {
                const inner = this.expandKey(obj[key], step.k as Key);
                if (inner === undefined) continue;
                for (const k of inner) {
                    if (this.evaluateExpr(step, obj[key], k) !== true) continue;
                    listout.push([...pathin, ...path, k]);
                }
            }
        }
        return listout;
    }

    private expandKey(owner: any, k: Key): Iterable<PathKey> | undefined {
        if (typeof owner !== 'object' || owner === null) return undefined;
        if (Array.isArray(k)) {
            const out: PathKey[] = [];
            for (const a of k) {
                const keys = this.expandKey(owner, a);
                if (keys === undefined) continue;
                out.push(...keys);
            }
            return out;
        }
        if (typeof k === 'number') {
            if (!Array.isArray(owner)) return undefined;
            return [k >= 0 ? k : owner.length + k];
        }
        if (k === '*') {
            if (Array.isArray(owner)) return owner.keys();
            return Object.keys(owner);
        }
        if (k instanceof RegExp) {
            const out: string[] = [];
            for (const key of Object.keys(owner)) {
                if (!k.test(key)) continue;
                out.push(key);
            }
            return out;
        }
        return [k];
    }

    private getMatchesFromExpr(pathin: Path, step: Step, owner: unknown, out: Path[]): void {
        const recursive = step.mv === Move.Descendants;
        const v2 = (this.compiled?.v2 ?? this.v2) || recursive || Array.isArray(owner);
        for (const { path } of this.descendants(owner, recursive)) {
            const q = v2 ? [...pathin, ...path] : pathin;
            const r = this.evaluateSteps(step.steps, q);
            if (r.length === 0) continue;
            out.push(q);
            if (!v2) break;
        }
    }

    /** Depth-first walk over the properties of `v`, each visited object once. */
    private* descendants(v: any, recursive: boolean): Generator<{ obj: any; key: PathKey; path: Path }> {
        const seen = new WeakSet<object>();
        const keysOf = (o: any): Iterator<PathKey> => (
            Array.isArray(o) ? o.keys() : Object.keys(o).values()
        );
        const stack: Array<{ obj: any; keys: Iterator<PathKey> }> = [];
        const path: Path = [];
        if (Array.isArray(v) || (typeof v === 'object' && v !== null)) {
            stack.push({ obj: v, keys: keysOf(v) });
        }
        while (stack.length !== 0) {
            const n = stack.length;
            const details = stack[n - 1];
            const entry = details.keys.next();
            if (entry.done) {
                stack.pop();
                path.pop();
                continue;
            }
            path[n - 1] = entry.value;
            const child = details.obj[entry.value];
            // Pushed before yielding: the walk goes on from the state it had
            // when this entry was read, even if the consumer edits the tree.
            if (recursive && typeof child === 'object' && child !== null && !seen.has(child)) {
                stack.push({ obj: child, keys: keysOf(child) });
                seen.add(child);
            }
            yield { obj: details.obj, key: entry.value, path: path.slice(0, n) };
        }
    }

    private consumeIdentifier(query: string, i: number): { s: Key; i: number } | undefined {
        const keys: Array<string | number | RegExp> = [];
        let needIdentifier = true;
        while (i < query.length) {
            const c0 = query.charCodeAt(i);
            if (c0 === 0x5D /* ] */) break;
            if (c0 === 0x20 /* space */) { i += 1; continue; }
            if (c0 === 0x2C /* , */) {
                if (needIdentifier) return undefined;
                i += 1;
                needIdentifier = true;
                continue;
            }
            if (c0 === 0x22 /* " */ || c0 === 0x27 /* ' */) {
                const r = this.untilChar(query, c0, i + 1);
                if (r === undefined) return undefined;
                keys.push(r.s);
                i = r.i;
                needIdentifier = false;
                continue;
            }
            if (c0 === 0x2D /* - */ || (c0 >= 0x30 && c0 <= 0x39)) {
                const match = INDICE.exec(query.slice(i));
                if (match === null) return undefined;
                keys.push(parseInt(query.slice(i), 10));
                i += match[0].length;
                needIdentifier = false;
                continue;
            }
            if (this.v2) return undefined;
            const r = this.consumeUnquotedIdentifier(query, i);
            if (r === undefined) return undefined;
            keys.push(r.s);
            i = r.i;
        }
        if (needIdentifier) return undefined;
        return { s: keys.length === 1 ? keys[0] : keys, i };
    }

    private consumeUnquotedIdentifier(query: string, i: number): { s: string | RegExp; i: number } | undefined {
        if (query.charCodeAt(i) === 0x2F /* / */) {
            const r = this.untilChar(query, 0x2F, i + 1);
            if (r === undefined) return undefined;
            try {
                return { s: new RegExp(r.s), i: r.i };
            } catch {
                return undefined;
            }
        }
        const match = UNQUOTED_IDENTIFIER.exec(query.slice(i));
        if (match === null) return undefined;
        return { s: match[0], i: i + match[0].length };
    }

    /** Reads up to an unescaped `target`, dropping the escaping backslashes. */
    private untilChar(query: string, target: number, i: number): { s: string; i: number } | undefined {
        const len = query.length;
        const parts: string[] = [];
        let beg = i;
        let end = i;
        for (;;) {
            if (end === len) return undefined;
            const c = query.charCodeAt(end);
            if (c === target) {
                parts.push(query.slice(beg, end));
                end += 1;
                break;
            }
            if (c === 0x5C /* \ */ && (end + 1) < len) {
                if (query.charCodeAt(end + 1) === target) {
                    parts.push(query.slice(beg, end));
                    end += 1;
                    beg = end;
                }
            }
            end += 1;
        }
        return { s: parts.join(''), i: end };
    }

    private compileExpr(query: string, step: Step, i: number): number | undefined {
        if (query.startsWith('=/', i)) {
            const r = this.untilChar(query, 0x2F /* / */, i + 2);
            if (r === undefined) return i;
            const match = /^[i]/.exec(query.slice(r.i));
            try {
                step.rval = new RegExp(r.s, (match && match[0]) || undefined);
            } catch {
                return undefined;
            }
            step.op = 're';
            if (match) r.i += match[0].length;
            return r.i;
        }
        const match = EXPRESSION.exec(query.slice(i));
        if (match === null) return undefined;
        const op = match[1];
        const rval = match[2];
        if (rval.charCodeAt(0) === 0x27 /* ' */) {
            const r = this.untilChar(rval, 0x27, 1);
            if (r === undefined) return undefined;
            step.rval = r.s;
            step.op = op;
        } else {
            try {
                step.rval = JSON.parse(rval);
                step.op = op;
            } catch {
                return undefined;
            }
        }
        return i + match[0].length - 1;
    }

    private resolvePath(path: Path): { obj?: any; key?: PathKey; value?: any } {
        if (path.length === 0) return { value: this.root };
        const key = path[path.length - 1];
        let obj: any = this.root;
        for (let i = 0, n = path.length - 1; i < n; i++) {
            obj = obj[path[i]];
            if (!(obj instanceof Object)) return {};
        }
        return { obj, key, value: obj[key] };
    }

    private evaluateExpr(step: Step, owner: any, k: PathKey): boolean | undefined {
        if (owner === undefined || owner === null) return undefined;
        const exists = owner[k] !== undefined || hasOwn(owner, k);
        if (step.op !== undefined && !exists) return undefined;
        const target = step.not !== true;
        const v = owner[k];
        const rval = step.rval as any;
        switch (step.op) {
        case '==': return (v === rval) === target;
        case '!=': return (v !== rval) === target;
        case '<': return (v < rval) === target;
        case '<=': return (v <= rval) === target;
        case '>': return (v > rval) === target;
        case '>=': return (v >= rval) === target;
        case '^=': return `${v}`.startsWith(rval) === target;
        case '$=': return `${v}`.endsWith(rval) === target;
        case '*=': return `${v}`.includes(rval) === target;
        case 're': return (rval as RegExp).test(`${v}`);
        default: break;
        }
        return exists === target;
    }

    private modifyVal(obj: any, key: PathKey): void {
        const compiled = this.compiled as Compiled;
        const { modify } = compiled;
        let rval = compiled.rval as any;
        if (typeof rval === 'string') rval = rval.replace('${now}', `${Date.now()}`);
        switch (modify) {
        case undefined:
            obj[key] = rval;
            break;
        case '+': {
            if (!(rval instanceof Object)) return;
            const lval = obj[key];
            if (!(lval instanceof Object)) return;
            if (Array.isArray(lval)) {
                if (Array.isArray(rval)) lval.push(...rval);
                else lval.push(rval);
                break;
            }
            for (const [k, v] of Object.entries(rval)) lval[k] = v;
            break;
        }
        case 'repl': {
            const lval = obj[key];
            if (typeof lval !== 'string') return;
            if (compiled.re === undefined) {
                compiled.re = null;
                try {
                    compiled.re = rval.regex !== undefined
                        ? new RegExp(rval.regex, rval.flags)
                        : new RegExp(rval.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                } catch { /* an unusable pattern rewrites nothing */ }
            }
            if (compiled.re === null) return;
            obj[key] = lval.replace(compiled.re, rval.replacement);
            break;
        }
        default:
            // `call(…)` invokes an arbitrary method with list-supplied
            // arguments. No embedded list needs it, so it is left out rather
            // than carried as an unused way to run code.
            break;
        }
    }
}
