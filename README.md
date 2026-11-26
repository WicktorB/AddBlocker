# AddBlocker

Ad‑blocker Chrome Manifest V3, conçu pour se rapprocher au maximum d'uBlock Origin
maintenant que MV2 n'existe plus sur Chrome (retrait définitif du Web Store : 31 août 2026).

**État : phases 1 à 6 terminées** — blocage réseau, cosmétique, scriptlets, interface, mise à jour des listes et mesure de parité.

La parité atteint **100 % du taux de blocage d'uBlock Origin, 0 % de sur-blocage**, mesurée contre son propre moteur (`@gorhill/ubo-core`) sur 5 200 requêtes. Une réserve importante : ce corpus est **synthétique**. Il mesure la fidélité de la traduction des filtres, pas le comportement sur une vraie page. La mesure sur sites réels s'obtient avec `pnpm parity-sites`, qui demande un accès au web ouvert.

## Démarrage

```bash
pnpm install
pnpm build     # télécharge les listes, compile les rulesets vers dist/extension
pnpm check     # tests + build + vérification navigateur + oracle différentiel
```

Puis charger `dist/extension` via `chrome://extensions` → *Charger l'extension non empaquetée*.

Au premier lancement, l'extension enregistre ses content scripts : compter environ
10 secondes avant que le filtrage cosmétique soit actif. Ensuite c'est persistant.

| Commande | Rôle |
|---|---|
| `pnpm test` | 391 tests unitaires (DNR, cosmétique, scriptlets, réglages, picker, directives) |
| `pnpm build` | Compile les listes ; échoue sur dépassement de quota ou règle invalide |
| `pnpm update-filters` | Rafraîchit les listes, recompile, recharge l'extension |
| `pnpm verify` | Charge le build dans Chromium, vérifie le blocage réel et que Chrome n'a ignoré aucune règle |
| `pnpm cosmetic-check` | Vérifie le masquage et l'absence de flash |
| `pnpm scriptlet-check` | Vérifie les scriptlets dans le monde de la page |
| `pnpm youtube-check` | Sert un YouTube simulé (extension puis userscript) : réponses du lecteur sans publicité, et page d'erreurs de l'extension vide |
| `pnpm ui-check` | Vérifie les flux utilisateur de bout en bout |
| `pnpm kill-check` | Vérifie la neutralisation d'une règle précise |
| `pnpm reload-check` | Vérifie que le rebuild est bien pris en compte |
| `pnpm oracle` | Compare nos décisions à `@adguard/tsurlfilter` |
| `pnpm parity` | Mesure la parité contre le moteur réel d'uBlock Origin |
| `pnpm parity-sites` | Même mesure sur des sites réels (nécessite le web ouvert) |
| `pnpm build-userscript` | Génère le userscript (mobile, Safari, Tampermonkey) |
| `pnpm userscript-check` | Vérifie le userscript dans un vrai navigateur (`USERSCRIPT_BROWSER=webkit` pour le moteur de Safari) |
| `pnpm render-icons` | Régénère les PNG de l'icône depuis `packages/ui/src/icons/icon.svg` |

## Où ça en est

| Domaine | État |
|---|---|
| Blocage réseau | ✅ 17 457 règles (58 % du quota garanti), 0,61 % de filtres perdus, 97,8 % d'accord avec l'oracle |
| Filtrage cosmétique | ✅ 23 668 domaines, 58 795 sélecteurs, sans flash |
| Scriptlets | ✅ 63 211 invocations ; les scriptlets de réécriture des réponses du lecteur vidéo (YouTube) sont couverts et vérifiés sur page simulée — pas sur le vrai site |
| UI (popup, options, picker) | ✅ bascule par site en ~150 ms, filtres utilisateur, picker |
| Mise à jour des listes | ✅ `pnpm update-filters` en 4,1 s, kill switch par règle |
| Parité vs uBlock Origin | ✅ 100 % sur 5 200 requêtes, 0 % de sur-blocage — non mesuré sur le web réel |

## Version et mise à jour

Chaque build porte une version qui est sa date, au format `AAAA.MMJJ.HHmm` en UTC : `2026.1126.1338` a été construit le 26 novembre 2026 à 13 h 38. La même version figure dans le manifest de l'extension, dans `dist/extension/build-info.json` et dans l'en-tête du userscript.

- **Popup** : la version et la date du build, en bas.
- **Réglages → Version** : version, date, commit, date de téléchargement des listes, nombre de règles, et un état — *À jour* ou *Mise à jour disponible* — obtenu en comparant le commit du build à la branche `main` sur GitHub. C'est la seule requête que l'extension émet pour elle-même, et seulement quand cette page est ouverte.
- **Listes** : au-delà de 7 jours, le popup et les réglages le signalent ; `pnpm update-filters` les rafraîchit.

Pour mettre à jour : `git pull`, `pnpm build`, puis « Recharger » sur la page des extensions.

L'icône est dans `packages/ui/src/icons/icon.svg` ; deux variantes sont dans `alternatives/` et les trois sont comparées dans [`docs/icon-proposals.png`](docs/icon-proposals.png). Pour en changer : `pnpm render-icons packages/ui/src/icons/alternatives/ad-barre.svg`.

## Listes embarquées

| Ruleset | Source | Par défaut |
|---|---|---|
| `ads` | EasyList | activé |
| `ads-fr` | Liste FR (sites francophones) | activé |
| `privacy` | EasyPrivacy | activé |
| `ubo-core`, `ubo-badware`, `ubo-privacy` | uAssets (uBlock Origin) | activé |
| `annoyances` | uAssets — bannières cookies et autres nuisances | activé |

Chaque liste se désactive dans la page d'options. Si un site se comporte mal après une bannière de cookies masquée, c'est `annoyances` qu'il faut couper en premier.

## Documentation

| Document | Contenu |
|---|---|
| [01 — Analyse MV3](docs/01-analyse-mv3.md) | Ce que MV3 permet et interdit réellement, quotas exacts, ce qui est définitivement perdu |
| [02 — Architecture](docs/02-architecture.md) | Chaîne de compilation, moteur DNR, moteur cosmétique, runtime, risques |
| [03 — Roadmap](docs/03-roadmap.md) | Phases, critères d'acceptation mesurables, décisions préalables |

## L'idée en trois points

1. **Le moteur de filtrage tourne au build, pas au runtime.** MV3 supprime le blocage dynamique : Chrome évalue lui‑même des règles déclaratives. La qualité du produit dépend donc du *compilateur* qui traduit les listes de filtres, pas du code embarqué.
2. **Le quota est la contrainte centrale.** ~100 000 filtres réseau doivent tenir dans 30 000 règles garanties. On y arrive par fusion par domaines (gain ×10 à ×20), pas par troncature.
3. **Le filtrage côté page est intact.** Cosmétique et scriptlets restent pleinement faisables — c'est là que se rattrape la majeure partie de l'écart avec uBO.

## Parité visée

| Domaine | Cible |
|---|---|
| Blocage réseau | **100 % d'uBO** sur corpus synthétique (5 200 requêtes, 0 % de sur-blocage) |
| Filtrage cosmétique (dont procédural) | ~100 % |
| Scriptlets / anti‑anti‑adblock | ~95 % des scriptlets d'uBO ; ceux qu'utilisent les filtres YouTube le sont tous |
| Réactivité aux ripostes | inférieure — limite structurelle de MV3, sans solution |

## Sur mobile et dans les navigateurs sans extension

[`userscript/addblocker.user.js`](https://raw.githubusercontent.com/WicktorB/AddBlocker/main/userscript/addblocker.user.js) (2,0 Mo) s'installe dans **Tampermonkey**, **Violentmonkey** ou **Userscripts** (Safari iOS). [`userscript/addblocker-lite.user.js`](https://raw.githubusercontent.com/WicktorB/AddBlocker/main/userscript/addblocker-lite.user.js) (280 ko) ne contient que les règles génériques, pour les appareils où la taille compte.

Chaque build porte une version datée : le gestionnaire de userscripts récupère donc les listes à jour tout seul. Le script tourne aussi dans les iframes, et retombe sur le seul masquage cosmétique là où la CSP du site interdit l'injection dans la page.

**Ce qu'il ne fait pas : bloquer le réseau.** Aucun gestionnaire de userscripts n'expose l'équivalent de `declarativeNetRequest` — les publicités sont téléchargées puis masquées. La page n'est pas allégée, seulement nettoyée. Deux des trois moteurs sont là (cosmétique et scriptlets), le troisième est structurellement hors d'atteinte.

Pour un vrai blocage réseau : l'extension sur Chrome de bureau, ou un bloqueur de contenu natif sur Safari iOS.
