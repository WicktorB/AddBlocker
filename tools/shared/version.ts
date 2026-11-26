/**
 * The build stamp: one version, one date, shared by everything that ships.
 *
 * The version is the build time, written `YYYY.MMDD.HHmm` in UTC. That shape is
 * deliberate on three counts: it sorts, so a userscript manager comparing two
 * versions fetches the newer one; every part is an integer under 65 536, which
 * is all a Chrome manifest `version` may hold; and it can be read — a version
 * that says when it was built answers "is this the latest?" without a lookup
 * table.
 *
 * The commit is recorded beside it because the date alone cannot say which
 * code was built, and it is what the extension compares against GitHub to tell
 * whether a newer version exists.
 *
 * Imports nothing but Node built-ins, so any tool can pull it in by relative
 * path.
 */

import { execFileSync } from 'node:child_process';

export interface BuildStamp {
    /** `YYYY.MMDD.HHmm`, UTC. */
    version: string;
    /** ISO 8601 build time. */
    builtAt: string;
    /** Short commit hash, or '' outside a git checkout. */
    commit: string;
    /** True when the working tree had uncommitted changes. */
    dirty: boolean;
}

export function versionFor(now: Date): string {
    // Each part is computed as a number, not glued from padded strings: just
    // after midnight UTC the time would otherwise read "007", and Chrome
    // refuses a manifest whose version has a part with a leading zero.
    const day = (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
    const time = now.getUTCHours() * 100 + now.getUTCMinutes();
    return `${now.getUTCFullYear()}.${day}.${time}`;
}

function git(cwd: string, args: string[]): string | null {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return null;
    }
}

/**
 * Stamps a build made from the checkout at `root`.
 *
 * `ignore` lists paths whose changes do not count as "dirty" — the generated
 * userscripts, which the build itself rewrites and would otherwise always mark
 * the tree as modified.
 */
export function buildStamp(root: string, now: Date = new Date(), ignore: string[] = []): BuildStamp {
    const commit = git(root, ['rev-parse', '--short=10', 'HEAD']) ?? '';
    const status = commit === '' ? null
        : git(root, ['status', '--porcelain', '--', '.', ...ignore.map((path) => `:(exclude)${path}`)]);
    return {
        version: versionFor(now),
        builtAt: now.toISOString(),
        commit,
        dirty: status !== null && status !== '',
    };
}
