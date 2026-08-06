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

const DEFAULT_PORT = 9222;

interface Target {
    type: string;
    url: string;
    webSocketDebuggerUrl?: string;
}

export type ReloadOutcome =
    | { ok: true; extensionId: string }
    | { ok: false; reason: string };

/** One `Runtime.evaluate` round trip against a target. */
function evaluate(wsUrl: string, expression: string, timeoutMs = 5_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
        if (typeof WebSocket === 'undefined') {
            reject(new Error('this Node build has no WebSocket'));
            return;
        }
        const socket = new WebSocket(wsUrl);
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error('timed out'));
        }, timeoutMs);

        socket.addEventListener('open', () => {
            socket.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression, returnByValue: true, awaitPromise: true },
            }));
        });

        socket.addEventListener('message', (event) => {
            clearTimeout(timer);
            let payload: { result?: { result?: { value?: unknown } } };
            try {
                payload = JSON.parse(String(event.data));
            } catch (err) {
                socket.close();
                reject(err instanceof Error ? err : new Error(String(err)));
                return;
            }
            socket.close();
            resolve(payload.result?.result?.value);
        });

        socket.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error('websocket error'));
        });
    });
}

/**
 * Finds our service worker among the debuggable targets and reloads it.
 *
 * Identification is by manifest name rather than by extension id: the id
 * depends on where the extension was loaded from, which this script cannot
 * know, whereas the name is ours.
 */
export async function reloadExtension(
    name: string,
    port = DEFAULT_PORT,
): Promise<ReloadOutcome> {
    let targets: Target[];
    try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
            signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) return { ok: false, reason: `DevTools answered HTTP ${response.status}` };
        targets = await response.json() as Target[];
    } catch {
        return {
            ok: false,
            reason: `no Chrome listening on 127.0.0.1:${port} with --remote-debugging-port`,
        };
    }

    const workers = targets.filter(
        (t) => t.type === 'service_worker'
            && t.url.startsWith('chrome-extension://')
            && t.webSocketDebuggerUrl !== undefined,
    );
    if (workers.length === 0) return { ok: false, reason: 'no extension service worker is running' };

    for (const worker of workers) {
        let found: unknown;
        try {
            found = await evaluate(worker.webSocketDebuggerUrl as string,
                'chrome.runtime.getManifest().name');
        } catch {
            continue;
        }
        if (found !== name) continue;

        const extensionId = new URL(worker.url).host;
        try {
            // The worker is torn down by the reload, so the reply may never
            // arrive; the call having been sent is what matters.
            await evaluate(worker.webSocketDebuggerUrl as string, 'chrome.runtime.reload()', 2_000);
        } catch {
            // Expected often enough not to be worth reporting.
        }
        return { ok: true, extensionId };
    }

    return { ok: false, reason: `no running extension is named ${name}` };
}
