/**
 * Removes properties from an object by path — the engine behind `json-prune`
 * and its fetch and XHR variants.
 *
 * A path is dotted. Besides plain property names, a segment can be:
 *   `[]`   every element of an array        `{}` or `*`  every property
 *   `[-]`  remove the array elements for which the rest of the path exists
 *   `{-}`  the same, for the properties of an object
 * and a final `*` removes every property of its owner.
 *
 * `[-]` is what video sites need: `entries.[-].command.…adClientParams.isAd`
 * drops the ad entries out of a feed and leaves the rest in place.
 */

import { natives, type PatternDetails } from './safe.js';
import { matchesStackTrace } from './stack.js';

type Dict = Record<string, unknown>;

/**
 * Walks `path` from `root`. Without `prune`, answers whether the path exists;
 * with it, removes what the path designates and answers whether anything went.
 */
export function findOwner(root: unknown, path: string, prune = false): boolean {
    const { hasOwn } = natives();
    let owner = root;
    let chain = path;
    for (;;) {
        if (typeof owner !== 'object' || owner === null) return false;
        const dot = chain.indexOf('.');
        if (dot === -1) {
            if (!prune) return hasOwn(owner, chain);
            let modified = false;
            if (chain === '*') {
                for (const key in owner) {
                    if (!hasOwn(owner, key)) continue;
                    delete (owner as Dict)[key];
                    modified = true;
                }
            } else if (hasOwn(owner, chain)) {
                delete (owner as Dict)[chain];
                modified = true;
            }
            return modified;
        }
        const prop = chain.slice(0, dot);
        const next = chain.slice(dot + 1);
        let found = false;
        if (prop === '[-]' && Array.isArray(owner)) {
            let i = owner.length;
            while (i--) {
                if (!findOwner(owner[i], next)) continue;
                owner.splice(i, 1);
                found = true;
            }
            return found;
        }
        if (prop === '{-}' && owner instanceof Object) {
            for (const key of Object.keys(owner)) {
                if (!findOwner((owner as Dict)[key], next)) continue;
                delete (owner as Dict)[key];
                found = true;
            }
            return found;
        }
        if (
            (prop === '[]' && Array.isArray(owner))
            || (prop === '{}' && owner instanceof Object)
            || (prop === '*' && owner instanceof Object)
        ) {
            for (const key of Object.keys(owner)) {
                if (!findOwner((owner as Dict)[key], next, prune)) continue;
                found = true;
            }
            return found;
        }
        if (!hasOwn(owner, prop)) return false;
        owner = (owner as Dict)[prop];
        chain = next;
    }
}

/**
 * Prunes `obj` in place.
 *
 * Returns the object when something was removed and `undefined` otherwise, so
 * a caller can tell "left alone" from "changed" and avoid rebuilding a
 * response that did not need it. `rawNeedlePaths` are paths that must all
 * exist for the pruning to happen at all.
 */
export function objectPrune<T>(
    obj: T,
    rawPrunePaths: string,
    rawNeedlePaths = '',
    stackNeedle: PatternDetails = { matchAll: true, expect: true },
): T | undefined {
    if (typeof rawPrunePaths !== 'string') return undefined;
    const prunePaths = rawPrunePaths !== '' ? rawPrunePaths.split(/ +/) : [];
    const needlePaths = prunePaths.length !== 0 && rawNeedlePaths !== ''
        ? rawNeedlePaths.split(/ +/)
        : [];
    if (stackNeedle.matchAll !== true && !matchesStackTrace(stackNeedle)) return undefined;
    if (prunePaths.length === 0) return undefined;
    for (const needle of needlePaths) {
        if (!findOwner(obj, needle)) return undefined;
    }
    let matched = false;
    for (const path of prunePaths) {
        if (findOwner(obj, path, true)) matched = true;
    }
    return matched ? obj : undefined;
}
