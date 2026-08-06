/**
 * Reloads the running unpacked extension.
 *
 * There is no way to make Chrome pick up rebuilt files from outside: an
 * unpacked extension keeps serving what it loaded until something calls
 * `chrome.runtime.reload()`. The only handle from a script is the DevTools
 * protocol, which requires Chrome to have been started with a debugging port.
 *
 * So this is best-effort by construction. When the port is not there the
 * update still succeeded — only the last step, which the user can do by hand,
 * did not. Saying so plainly beats failing the command.
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const DEFAULT_PORT = 9222;

interface Target {
    id?: string;
    type: string;
    url: string;
    webSocketDebuggerUrl?: string;
}

export type ReloadOutcome =
    | { ok: true; extensionId: string; via: 'live target' | 'opened page' }
    | { ok: false; reason: string };

/**
 * A minimal DevTools client.
 *
 * Replies are matched on the message id: the protocol interleaves events with
 * responses, so resolving on whatever arrives first will eventually resolve on
 * an event instead of the answer.
 */
class Cdp {
    private readonly socket: WebSocket;
    private nextId = 1;
    private readonly pending = new Map<number, {
        resolve: (value: unknown) => void; reject: (reason: Error) => void;
    }>();

    private constructor(socket: WebSocket) {
        this.socket = socket;
        socket.addEventListener('message', (event) => {
            let payload: { id?: number; result?: unknown; error?: { message?: string } };
            try {
                payload = JSON.parse(String(event.data));
            } catch {
                return;
            }
            if (payload.id === undefined) return;
            const waiter = this.pending.get(payload.id);
            if (waiter === undefined) return;
            this.pending.delete(payload.id);
            if (payload.error !== undefined) {
                waiter.reject(new Error(payload.error.message ?? 'CDP error'));
                return;
            }
            waiter.resolve(payload.result);
        });
    }

    static connect(url: string, timeoutMs = 5_000): Promise<Cdp> {
        return new Promise((resolveConnection, reject) => {
            if (typeof WebSocket === 'undefined') {
                reject(new Error('this Node build has no WebSocket'));
                return;
            }
            const socket = new WebSocket(url);
            const timer = setTimeout(() => {
                socket.close();
                reject(new Error('timed out connecting'));
            }, timeoutMs);
            socket.addEventListener('open', () => {
                clearTimeout(timer);
                resolveConnection(new Cdp(socket));
            });
            socket.addEventListener('error', () => {
                clearTimeout(timer);
                reject(new Error('websocket error'));
            });
        });
    }

    send(method: string, params: unknown = {}, timeoutMs = 10_000): Promise<unknown> {
        return new Promise((resolveCall, reject) => {
            const id = this.nextId;
            this.nextId += 1;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => { clearTimeout(timer); resolveCall(value); },
                reject: (reason) => { clearTimeout(timer); reject(reason); },
            });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    async evaluate(expression: string, timeoutMs = 10_000): Promise<unknown> {
        const result = await this.send('Runtime.evaluate', {
            expression, returnByValue: true, awaitPromise: true,
        }, timeoutMs) as { result?: { value?: unknown } };
        return result.result?.value;
    }

    close(): void {
        this.socket.close();
    }
}

/**
 * The id Chrome gives an unpacked extension.
 *
 * Derived from the absolute path: the first sixteen bytes of its SHA-256, each
 * nibble mapped onto `a`–`p`. Verified against a real Chromium rather than
 * taken on trust, because the whole fallback below rests on it.
 */
export function extensionIdForPath(directory: string): string {
    const digest = createHash('sha256').update(resolve(directory), 'utf8').digest('hex').slice(0, 32);
    return [...digest].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join('');
}

async function listTargets(port: number): Promise<Target[] | null> {
    try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`, {
            signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) return null;
        return await response.json() as Target[];
    } catch {
        return null;
    }
}

/** Reloads through an extension context that is already running. */
async function viaLiveTarget(name: string, targets: Target[]): Promise<string | null> {
    const candidates = targets.filter(
        (t) => t.url.startsWith('chrome-extension://') && t.webSocketDebuggerUrl !== undefined,
    );

    for (const target of candidates) {
        let client: Cdp;
        try {
            client = await Cdp.connect(target.webSocketDebuggerUrl as string);
        } catch {
            continue;
        }
        try {
            if (await client.evaluate('chrome.runtime.getManifest().name') !== name) continue;
            const extensionId = new URL(target.url).host;
            // The context is torn down by the reload, so the reply may never
            // arrive; having sent the call is what matters.
            await client.evaluate('chrome.runtime.reload()', 2_000).catch(() => undefined);
            return extensionId;
        } catch {
            continue;
        } finally {
            client.close();
        }
    }

    return null;
}

/**
 * Reloads by opening one of the extension's own pages.
 *
 * The path that matters in practice. A Manifest V3 service worker is asleep
 * most of the time, so looking only for a running one finds nothing whenever
 * the browser has been idle — which is exactly when someone runs an update.
 * Opening an extension page creates a context with the `chrome` API in it,
 * whatever the worker is doing.
 */
async function viaOpenedPage(
    name: string, port: number, directory: string,
): Promise<string | null> {
    const extensionId = extensionIdForPath(directory);

    let version: { webSocketDebuggerUrl?: string };
    try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`, {
            signal: AbortSignal.timeout(3_000),
        });
        version = await response.json() as { webSocketDebuggerUrl?: string };
    } catch {
        return null;
    }
    if (version.webSocketDebuggerUrl === undefined) return null;

    let browser: Cdp;
    try {
        browser = await Cdp.connect(version.webSocketDebuggerUrl);
    } catch {
        return null;
    }

    let targetId: string | undefined;
    try {
        const created = await browser.send('Target.createTarget', {
            url: `chrome-extension://${extensionId}/options.html`,
        }) as { targetId?: string };
        targetId = created.targetId;
        if (targetId === undefined) return null;

        // Give the page a moment to exist, then find its socket.
        let page: Target | undefined;
        for (let attempt = 0; attempt < 20 && page === undefined; attempt += 1) {
            await new Promise((r) => { setTimeout(r, 150); });
            const targets = await listTargets(port);
            page = targets?.find((t) => t.id === targetId && t.webSocketDebuggerUrl !== undefined);
        }
        if (page === undefined) return null;

        const client = await Cdp.connect(page.webSocketDebuggerUrl as string);
        try {
            if (await client.evaluate('chrome.runtime.getManifest().name') !== name) return null;
            await client.evaluate('chrome.runtime.reload()', 2_000).catch(() => undefined);
            return extensionId;
        } finally {
            client.close();
        }
    } catch {
        return null;
    } finally {
        if (targetId !== undefined) {
            // The reload usually closes it already; this is for the paths where
            // it does not, so no stray tab is left behind.
            await browser.send('Target.closeTarget', { targetId }).catch(() => undefined);
        }
        browser.close();
    }
}

/**
 * Finds our extension among the debuggable targets and reloads it.
 *
 * Identification is by manifest name rather than by extension id: the id
 * depends on where the extension was loaded from. `directory` is that place,
 * and lets the reload work even with nothing of the extension running.
 */
export async function reloadExtension(
    name: string,
    port = DEFAULT_PORT,
    directory?: string,
): Promise<ReloadOutcome> {
    const targets = await listTargets(port);
    if (targets === null) {
        return {
            ok: false,
            reason: `no Chrome listening on 127.0.0.1:${String(port)} with --remote-debugging-port`,
        };
    }

    const live = await viaLiveTarget(name, targets);
    if (live !== null) return { ok: true, extensionId: live, via: 'live target' };

    if (directory !== undefined) {
        const opened = await viaOpenedPage(name, port, directory);
        if (opened !== null) return { ok: true, extensionId: opened, via: 'opened page' };
    }

    return {
        ok: false,
        reason: directory === undefined
            ? `no running context of an extension named ${name}`
            : `no extension named ${name} is loaded from the built directory`,
    };
}
