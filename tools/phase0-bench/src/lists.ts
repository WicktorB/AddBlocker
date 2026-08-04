import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = join(ROOT, '.lists');

/**
 * Filter lists used for the phase 0 benchmark.
 *
 * EasyList publishes its canonical bundle on easylist.to, which is unreachable
 * from this environment; the upstream repository fragments are equivalent and
 * are what the maintainers actually edit.
 */
export interface ListSource {
    /** Short identifier, also used as the cache file name. */
    id: string;
    /** Which bundle this fragment belongs to. */
    group: 'easylist' | 'easyprivacy' | 'ubo';
    url: string;
}

const EL = (name: string): ListSource => ({
    id: name,
    group: 'easylist',
    url: `https://raw.githubusercontent.com/easylist/easylist/master/easylist/${name}.txt`,
});

const EP = (name: string): ListSource => ({
    id: name,
    group: 'easyprivacy',
    url: `https://raw.githubusercontent.com/easylist/easylist/master/easyprivacy/${name}.txt`,
});

const UBO = (name: string): ListSource => ({
    id: `ubo_${name}`,
    group: 'ubo',
    url: `https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/${name}.txt`,
});

export const SOURCES: ListSource[] = [
    EL('easylist_adservers'),
    EL('easylist_adservers_popup'),
    EL('easylist_allowlist'),
    EL('easylist_general_block'),
    EL('easylist_general_block_popup'),
    EL('easylist_general_hide'),
    EL('easylist_specific_block'),
    EL('easylist_specific_hide'),
    EL('easylist_thirdparty'),
    EL('easylist_thirdparty_popup'),
    EP('easyprivacy_general'),
    EP('easyprivacy_specific'),
    EP('easyprivacy_thirdparty'),
    EP('easyprivacy_trackingservers'),
    EP('easyprivacy_trackingservers_international'),
    EP('easyprivacy_allowlist'),
    UBO('filters'),
    UBO('badware'),
    UBO('privacy'),
    UBO('quick-fixes'),
];

async function fetchWithRetry(url: string, attempts = 4): Promise<string> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i += 1) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } catch (err) {
            lastError = err;
            await new Promise((r) => { setTimeout(r, 2 ** i * 1000); });
        }
    }
    throw new Error(`failed to fetch ${url}: ${String(lastError)}`);
}

/** Downloads every source, caching on disk so repeated runs stay offline. */
export async function loadLists(): Promise<Map<string, string>> {
    await mkdir(CACHE_DIR, { recursive: true });
    const out = new Map<string, string>();

    for (const source of SOURCES) {
        const cached = join(CACHE_DIR, `${source.id}.txt`);
        if (existsSync(cached)) {
            out.set(source.id, await readFile(cached, 'utf8'));
            continue;
        }
        const text = await fetchWithRetry(source.url);
        await writeFile(cached, text, 'utf8');
        out.set(source.id, text);
    }

    return out;
}

/** Groups raw list content into the three bundles we benchmark. */
export function groupLists(lists: Map<string, string>): Map<string, string> {
    const groups = new Map<string, string[]>();
    for (const source of SOURCES) {
        const content = lists.get(source.id);
        if (content === undefined) continue;
        const bucket = groups.get(source.group) ?? [];
        bucket.push(content);
        groups.set(source.group, bucket);
    }
    return new Map([...groups].map(([name, parts]) => [name, parts.join('\n')]));
}
