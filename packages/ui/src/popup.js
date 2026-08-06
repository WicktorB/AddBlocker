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

/**
 * Shows what was blocked on this tab, so a single rule can be neutralised.
 *
 * Turning filtering off for the whole site is the blunt repair; when one rule
 * out of tens of thousands breaks one thing, this gives back exactly that.
 * The blocked URL is shown because a rule id on its own tells nobody anything.
 */
function renderRules(tab, state) {
    const list = $('rules');
    list.innerHTML = '';

    if (state.rules.length === 0) {
        list.innerHTML = '<p class="hint">Aucune requête bloquée sur cet onglet '
            + '— rechargez la page pour voir ce qui est filtré.</p>';
        return;
    }

    for (const [index, rule] of state.rules.entries()) {
        const killed = state.isKilled[index] === true;
        const row = document.createElement('div');
        row.className = killed ? 'rule killed' : 'rule';

        const url = document.createElement('span');
        url.className = 'url';
        let shown = rule.sampleUrl;
        try { shown = new URL(rule.sampleUrl).hostname; } catch { /* keep the raw URL */ }
        url.textContent = shown;
        url.title = `${rule.sampleUrl}\n${rule.rulesetId} #${rule.ruleId}`;

        const n = document.createElement('span');
        n.className = 'n';
        n.textContent = `×${rule.count}`;

        const action = document.createElement('button');
        action.textContent = killed ? 'Rétablir' : 'Neutraliser';
        action.addEventListener('click', async () => {
            action.disabled = true;
            await chrome.runtime.sendMessage({
                type: killed ? 'restoreRule' : 'killRule',
                payload: { rulesetId: rule.rulesetId, ruleId: rule.ruleId },
            });
            await chrome.tabs.reload(tab.id);
            window.close();
        });

        row.append(url, n, action);
        list.append(row);
    }

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Une neutralisation ne survit pas à une mise à jour des listes, '
        + 'qui renumérote les règles.';
    list.append(hint);
}

$('diagnose').addEventListener('click', async () => {
    const tab = await currentTab();
    if (tab === undefined || !isFilterable(tab.url)) return;
    const state = await chrome.runtime.sendMessage({
        type: 'getMatchedRules', payload: { tabId: tab.id },
    });
    $('diagnose').style.display = 'none';
    renderRules(tab, state ?? { rules: [], isKilled: [] });
});

void render();
