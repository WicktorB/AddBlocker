/**
 * Wraps a function reachable from `globalThis` — `JSON.parse`, `fetch`,
 * `Node.prototype.appendChild` — so a handler sees every call to it.
 *
 * A wrapped native must go on looking native. Sites probe for hooks with
 * `Function.prototype.toString`, and a proxy answers that with a body that is
 * not the original's; so `toString` itself is wrapped, once, to answer for
 * every function wrapped here with the text of the function it stands for.
 */

export interface CallContext {
    callFn: Function;
    /** Absent when the function was called with `new`. */
    thisArg?: unknown;
    callArgs: unknown[];
    /** Makes the original call, with `callArgs` as they are at that moment. */
    reflect(): unknown;
}

const originals = new WeakMap<object, Function>();
let toStringCloaked = false;

function cloakToString(): void {
    if (toStringCloaked) return;
    toStringCloaked = true;
    const nativeToString = Function.prototype.toString;
    const cloaked = new Proxy(nativeToString, {
        apply(_target, thisArg: object) {
            let fn = thisArg;
            for (;;) {
                const original = originals.get(fn);
                if (original === undefined) break;
                fn = original;
            }
            return nativeToString.call(fn);
        },
    });
    originals.set(cloaked, nativeToString);
    Function.prototype.toString = cloaked;
}

/** Registers `proxy` as standing for `original`, for `toString` purposes. */
export function cloak(proxy: object, original: Function): void {
    cloakToString();
    originals.set(proxy, original);
}

export function proxyApply(target: string, handler: (context: CallContext) => unknown): void {
    let owner: any = globalThis;
    let prop = target;
    for (;;) {
        const dot = prop.indexOf('.');
        if (dot === -1) break;
        owner = owner[prop.slice(0, dot)];
        if (!(owner instanceof Object)) return;
        prop = prop.slice(dot + 1);
    }
    const fn = owner[prop];
    if (typeof fn !== 'function') return;

    const details: ProxyHandler<Function> = {
        apply(callFn, thisArg, callArgs) {
            return handler({
                callFn, thisArg, callArgs,
                reflect() { return Reflect.apply(this.callFn, this.thisArg, this.callArgs); },
            });
        },
    };
    if (fn.prototype?.constructor === fn) {
        details.construct = (callFn, callArgs) => handler({
            callFn, callArgs,
            reflect() { return Reflect.construct(this.callFn as new (...a: unknown[]) => object, this.callArgs); },
        }) as object;
    }
    const proxied = new Proxy(fn, details);
    cloak(proxied, fn);
    owner[prop] = proxied;
}
