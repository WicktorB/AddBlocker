/** Options page: filter lists, disabled sites, and the user's own filters. */

const $ = (id) => document.getElementById(id);
let settings = null;

async function load() {
    const state = await chrome.runtime.sendMessage({ type: 'getState', payload: {} });
    settings = state.settings;

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
        label.append(box, document.createTextNode(ruleset.id));
        $('rulesets').append(label);
    }

    renderSites();
    $('filters').value = settings.userFilters.join('\n');
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
