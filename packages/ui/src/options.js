/** Options page: filter lists, disabled sites, and the user's own filters. */

const $ = (id) => document.getElementById(id);
let settings = null;

async function load() {
    const state = await chrome.runtime.sendMessage({ type: 'getState', payload: {} });
    settings = state.settings;

    const info = await BuildInfo.load();
    const manifest = chrome.runtime.getManifest();
    const rulesets = manifest.declarative_net_request?.rule_resources ?? [];
    const forcedOff = new Set(settings.disabledRulesets);
    const forcedOn = new Set(settings.enabledRulesets ?? []);

    $('rulesets').innerHTML = '';
    for (const ruleset of rulesets) {
        const shipsEnabled = ruleset.enabled !== false;
        const label = document.createElement('label');
        label.className = 'row';
        const box = document.createElement('input');
        box.type = 'checkbox';
        // Mirrors resolveRulesets: the manifest sets the default and the
        // settings only record where the user departed from it.
        box.checked = forcedOn.has(ruleset.id) || (shipsEnabled && !forcedOff.has(ruleset.id));
        box.addEventListener('change', async () => {
            settings.disabledRulesets = settings.disabledRulesets.filter((id) => id !== ruleset.id);
            settings.enabledRulesets = (settings.enabledRulesets ?? [])
                .filter((id) => id !== ruleset.id);
            if (box.checked !== shipsEnabled) {
                const list = box.checked ? 'enabledRulesets' : 'disabledRulesets';
                settings[list] = [...settings[list], ruleset.id];
            }
            await save('Liste mise à jour.');
        });
        // The title and size come from the build; the id alone ("ads-fr")
        // tells the reader little.
        const described = info.rulesets?.[ruleset.id];
        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = described ? `${described.rules.toLocaleString('fr-FR')} règles` : '';
        label.append(box, document.createTextNode(described?.title ?? ruleset.id), count);
        $('rulesets').append(label);
    }

    renderSites();
    renderKilled();
    $('filters').value = settings.userFilters.join('\n');
}

/**
 * Lists neutralised rules so they can be put back.
 *
 * This is the only place they can be: a disabled rule never matches anything,
 * so it never appears again in the popup's list of what fired on the page.
 * Without this section a kill would be irreversible short of editing storage.
 */
function renderKilled() {
    const killed = settings.killedRules ?? [];
    if (killed.length === 0) {
        $('killed').innerHTML = '<p class="empty">Aucune règle neutralisée.</p>';
        return;
    }
    const list = document.createElement('ul');
    for (const rule of killed) {
        const item = document.createElement('li');
        const label = document.createElement('code');
        label.textContent = `${rule.rulesetId} #${rule.ruleId}`;
        const restore = document.createElement('button');
        restore.textContent = 'Rétablir';
        restore.addEventListener('click', async () => {
            restore.disabled = true;
            await chrome.runtime.sendMessage({ type: 'restoreRule', payload: rule });
            await load();
        });
        item.append(label, restore);
        list.append(item);
    }
    $('killed').innerHTML = '';
    $('killed').append(list);
}

function renderSites() {
    if (settings.disabledSites.length === 0) {
        $('sites').innerHTML = '<p class="empty">Aucun site désactivé.</p>';
        return;
    }
    const list = document.createElement('ul');
    for (const site of settings.disabledSites) {
        const item = document.createElement('li');
        item.textContent = `${site} `;
        const remove = document.createElement('a');
        remove.href = '#';
        remove.textContent = 'réactiver';
        remove.addEventListener('click', async (event) => {
            event.preventDefault();
            settings.disabledSites = settings.disabledSites.filter((s) => s !== site);
            await save('Site réactivé.');
            renderSites();
        });
        item.append(remove);
        list.append(item);
    }
    $('sites').innerHTML = '';
    $('sites').append(list);
}

async function save(message) {
    await chrome.runtime.sendMessage({ type: 'setSettings', payload: settings });
    $('status').textContent = message ?? 'Enregistré.';
    setTimeout(() => { $('status').textContent = ''; }, 2500);
}

$('save').addEventListener('click', async () => {
    settings.userFilters = $('filters').value
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    await save();
});

void load();

/**
 * The "Version" section: what is running, how old it is, and whether GitHub
 * has something newer.
 */
async function renderAbout() {
    const info = await BuildInfo.load();

    $('about-version').textContent = info.version ?? '—';
    $('about-built').textContent = BuildInfo.formatDate(info.builtAt);
    $('about-commit').textContent = info.commit
        ? `${info.commit}${info.dirty ? ' + modifications locales' : ''}`
        : 'inconnu';
    $('about-rules').textContent = typeof info.rules === 'number'
        ? info.rules.toLocaleString('fr-FR') : '—';

    const listAge = BuildInfo.daysSince(info.listsFetchedAt);
    const lists = $('about-lists');
    lists.textContent = BuildInfo.formatDate(info.listsFetchedAt)
        + (listAge === null ? '' : listAge === 0 ? ' (aujourd\'hui)'
            : ` (il y a ${listAge} jour${listAge > 1 ? 's' : ''})`);
    lists.className = BuildInfo.listsAreStale(info) ? 'warn' : '';

    const status = $('about-update');
    const howto = [];
    const result = await BuildInfo.checkForUpdate(info);
    if (result.state === 'current') {
        status.textContent = 'À jour — c\'est la dernière version publiée.';
        status.className = 'ok';
    } else if (result.state === 'behind') {
        status.textContent = `Mise à jour disponible — ${result.behind} modification`
            + `${result.behind > 1 ? 's' : ''} de retard sur GitHub.`;
        status.className = 'warn';
        howto.push('Pour mettre à jour : <code>git pull</code> puis <code>pnpm build</code> '
            + 'dans le dossier du projet, puis « Recharger » sur la page des extensions.');
    } else if (result.state === 'local') {
        status.textContent = 'Version locale — construite depuis un code qui n\'est pas sur GitHub.';
        status.className = '';
    } else {
        status.textContent = 'Vérification impossible (GitHub injoignable).';
        status.className = '';
    }

    if (BuildInfo.listsAreStale(info)) {
        howto.push('Les listes ont plus de ' + BuildInfo.STALE_LISTS_DAYS + ' jours : '
            + '<code>pnpm update-filters</code> les rafraîchit sans toucher au code.');
    }
    $('about-howto').innerHTML = howto.join('<br>');
}

void renderAbout();
