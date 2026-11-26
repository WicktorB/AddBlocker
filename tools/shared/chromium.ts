/**
 * Finds a Chromium that Playwright preinstalled on this machine.
 *
 * The tools used to name one build outright — `chromium-1194` — and a dev
 * container that had moved on to a newer build made every browser check fail
 * with "no Chromium found" while a perfectly good browser sat one directory
 * over. The build number is Playwright's, changes with each release and means
 * nothing to us, so the directory is searched instead.
 *
 * Only full browsers are returned, never `chromium_headless_shell`: the shell
 * ignores `--load-extension` without a word, which would turn every extension
 * check into a rubber stamp.
 *
 * Imports nothing but Node built-ins, so any tool can pull it in by relative
 * path without a workspace dependency.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Where Playwright's browsers live in the dev container. */
const BROWSERS_DIR = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';

/** Layouts Playwright has used for the Linux build, newest first. */
const BINARIES = ['chrome-linux64/chrome', 'chrome-linux/chrome'];

/** The newest preinstalled Chromium, or `null` when there is none. */
export function preinstalledChromium(): string | null {
    let entries: string[];
    try {
        entries = readdirSync(BROWSERS_DIR);
    } catch {
        return null;
    }

    const builds = entries
        .map((name) => /^chromium-(\d+)$/.exec(name))
        .filter((match): match is RegExpExecArray => match !== null)
        .sort((a, b) => Number(b[1]) - Number(a[1]));

    for (const [directory] of builds) {
        for (const binary of BINARIES) {
            const candidate = join(BROWSERS_DIR, directory, binary);
            if (existsSync(candidate)) return candidate;
        }
    }
    return null;
}
