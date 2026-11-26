/**
 * The filter lists we ship, grouped into the rulesets the user can toggle.
 *
 * EasyList publishes its canonical bundle on easylist.to; the upstream
 * repository fragments are what the maintainers actually edit, and are
 * reachable where easylist.to is not.
 */

export interface ListSource {
    id: string;
    url: string;
}

export interface Ruleset {
    /** Ruleset id, also the generated file name and the manifest entry. */
    id: string;
    /** Shown in the UI. */
    title: string;
    /** Enabled on a fresh install. */
    enabledByDefault: boolean;
    sources: ListSource[];
}

const easylist = (name: string): ListSource => ({
    id: name,
    url: `https://raw.githubusercontent.com/easylist/easylist/master/easylist/${name}.txt`,
});

const easyprivacy = (name: string): ListSource => ({
    id: name,
    url: `https://raw.githubusercontent.com/easylist/easylist/master/easyprivacy/${name}.txt`,
});

const uassets = (name: string): ListSource => ({
    id: `ubo_${name}`,
    url: `https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/${name}.txt`,
});

/**
 * Liste FR is published as a single assembled file, unlike EasyList whose
 * fragments we fetch one by one.
 */
const listefr: ListSource = {
    id: 'liste_fr',
    url: 'https://raw.githubusercontent.com/easylist/listefr/master/liste_fr.txt',
};

export const RULESETS: Ruleset[] = [
    {
        id: 'ads',
        title: 'Publicités (EasyList)',
        enabledByDefault: true,
        sources: [
            easylist('easylist_adservers'),
            easylist('easylist_adservers_popup'),
            easylist('easylist_allowlist'),
            easylist('easylist_general_block'),
            easylist('easylist_general_block_popup'),
            easylist('easylist_general_hide'),
            easylist('easylist_specific_block'),
            easylist('easylist_specific_hide'),
            easylist('easylist_thirdparty'),
            easylist('easylist_thirdparty_popup'),
        ],
    },
    {
        // EasyList is written against English-language sites; the regional
        // lists are where a French news site's own ad slots get named. On by
        // default because French is who this build is for.
        id: 'ads-fr',
        title: 'Publicités francophones (Liste FR)',
        enabledByDefault: true,
        sources: [listefr],
    },
    {
        id: 'privacy',
        title: 'Pistage (EasyPrivacy)',
        enabledByDefault: true,
        sources: [
            easyprivacy('easyprivacy_general'),
            easyprivacy('easyprivacy_specific'),
            easyprivacy('easyprivacy_thirdparty'),
            easyprivacy('easyprivacy_trackingservers'),
            easyprivacy('easyprivacy_trackingservers_international'),
            easyprivacy('easyprivacy_allowlist'),
        ],
    },
    {
        id: 'ubo-core',
        title: 'Filtres uBlock Origin',
        enabledByDefault: true,
        sources: [uassets('filters'), uassets('quick-fixes')],
    },
    {
        id: 'ubo-badware',
        title: 'Sites malveillants',
        enabledByDefault: true,
        sources: [uassets('badware')],
    },
    {
        id: 'ubo-privacy',
        title: 'Pistage (uBlock Origin)',
        enabledByDefault: true,
        sources: [uassets('privacy')],
    },
    {
        id: 'annoyances',
        title: 'Nuisances (bannières, cookies)',
        enabledByDefault: true,
        sources: [uassets('annoyances-others'), uassets('annoyances-cookies')],
    },
];

/** Chrome's quotas, from the declarativeNetRequest constants. */
export const QUOTAS = {
    guaranteedStaticRules: 30_000,
    globalStaticRulePool: 330_000,
    maxRegexRules: 1_000,
    maxStaticRulesets: 100,
    maxEnabledStaticRulesets: 50,
} as const;
