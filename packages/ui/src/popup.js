/**
 * Popup: the two things the user actually needs in the moment — turn
 * filtering off on a broken site, and hide an element that got through.
 */

const $ = (id) => document.getElementById(id);

function normalise(hostname) {
    return hostname.replace(/^www\./, '');
}

async function currentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

function isFilterable(url) {
    return typeof url === 'string' && /^https?:/.test(url);
}

async function render() {
    const tab = await currentTab();
    if (tab === undefined || !isFilterable(tab.url)) {
        $('host').textContent = 'page non filtrable';
        $('toggle').disabled = true;
        $('pick').disabled = true;
        $('count').textContent = '—';
        return;
    }

    const host = normalise(new URL(tab.url).hostname);
    $('host').textContent = host;

    const state = await chrome.runtime.sendMessage({ type: 'getState', payload: { tabId: tab.id } });
    const disabled = (state?.settings?.disabledSites ?? []).some(
        (d) => host === d || host.endsWith(`.${d}`),
    );

    $('count').textContent = String(state?.count ?? 0);
    $('toggle').textContent = disabled ? 'Réactiver' : 'Désactiver';
    $('toggle').classList.toggle('primary', disabled);
    $('host').classList.toggle('off', disabled);
    $('status').textContent = disabled
        ? 'Filtrage désactivé sur ce site.'
        : '';

    return { tab, host, disabled };
}

$('toggle').addEventListener('click', async () => {
    const tab = await currentTab();
    if (tab === undefined || !isFilterable(tab.url)) return;

    const host = normalise(new URL(tab.url).hostname);
    const result = await chrome.runtime.sendMessage({ type: 'toggleSite', payload: { hostname: host } });
    if (result?.ok !== true) {
        $('status').textContent = 'Impossible de modifier ce site.';
        return;
    }

    // Rules and script exclusions only take effect on the next load.
    await chrome.tabs.reload(tab.id);
    window.close();
});

$('pick').addEventListener('click', async () => {
    const tab = await currentTab();
    if (tab === undefined || !isFilterable(tab.url)) return;

    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['picker.js'],
    });
    window.close();
});

$('options').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
});

void render();
