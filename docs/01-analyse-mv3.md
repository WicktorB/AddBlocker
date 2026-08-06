# Analyse : ce que Manifest V3 permet réellement (état août 2026)

## 1. Le contexte

La fin de MV2 sur Chrome est consommée :

| Jalon | Date | Effet |
|---|---|---|
| Désactivation progressive MV2 | juin 2024 → 2025 | Extensions MV2 désactivées par vagues |
| Chrome 138 | mi‑2025 | Dernière version supportant MV2 (via policy entreprise) |
| Chrome 139 | juin 2025 | Retrait de `ExtensionManifestV2Availability` — plus d'échappatoire entreprise |
| Chrome 151 | 28 juillet 2026 | Suppression des derniers flags MV2 du code Chromium |
| Chrome Web Store | 31 août 2026 | Retrait des dernières extensions MV2 du store |

Conclusion : il n'existe plus aucun chemin de contournement sur Chrome. Toute solution doit être 100 % MV3. uBO « classique » ne reviendra pas ; la question n'est pas de le porter, mais de reconstruire ses garanties avec des primitives différentes.

## 2. Le changement de paradigme

C'est le point qu'il faut intégrer avant de dessiner quoi que ce soit.

**uBO MV2** : `webRequest` en mode *blocking*. Chrome suspend chaque requête et demande à du JS arbitraire « je bloque ou pas ? ». Le moteur de filtrage vit dans l'extension, tourne à chaque requête, et peut faire n'importe quelle logique (état, heuristiques, corrélations inter‑requêtes, résolution CNAME…).

**MV3** : `declarativeNetRequest` (DNR). L'extension *déclare à l'avance* des règles ; c'est le moteur natif de Chrome qui les évalue. L'extension ne voit jamais la requête passer et ne décide plus rien en temps réel.

Trois conséquences structurantes :

1. **Le moteur de filtrage se déplace du runtime vers le build.** La qualité du blocage n'est plus déterminée par la qualité du code qui tourne dans le navigateur, mais par la qualité du **compilateur** qui traduit les listes de filtres en règles DNR. C'est là que se joue tout le projet.
2. **Ce qui reste dynamique est contingenté** (quotas de règles, voir §3).
3. **Le filtrage côté page (cosmétique, scriptlets) est intact.** MV3 n'a rien retiré aux content scripts. Toute la moitié « cosmétique » d'uBO est reproductible à ~100 %.

## 3. Les quotas DNR exacts

Valeurs relevées dans les définitions officielles de l'API (`@types/chrome` 0.2.5, constantes `chrome.declarativeNetRequest`) :

| Constante | Valeur | Commentaire |
|---|---|---|
| `GUARANTEED_MINIMUM_STATIC_RULES` | **30 000** | Garanti à l'extension, quoi qu'il arrive |
| Pool global de règles statiques | ~330 000 | Partagé entre **toutes** les extensions installées, *premier arrivé premier servi* — interroger via `getAvailableStaticRuleCount()` |
| `MAX_NUMBER_OF_STATIC_RULESETS` | **100** | Rulesets déclarables dans le manifest |
| `MAX_NUMBER_OF_ENABLED_STATIC_RULESETS` | **50** | Activables simultanément |
| `MAX_NUMBER_OF_DYNAMIC_RULES` | **30 000** | Persistantes, modifiables à chaud |
| `MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES` | **5 000** | Sous‑quota (voir « unsafe » ci‑dessous) |
| `MAX_NUMBER_OF_SESSION_RULES` | **5 000** | En mémoire, perdues au redémarrage |
| `MAX_NUMBER_OF_UNSAFE_SESSION_RULES` | **5 000** | |
| `MAX_NUMBER_OF_REGEX_RULES` | **1 000** | Évalué séparément pour statique et pour dynamique |
| `MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL` | **20 / 10 min** | Impacte directement le compteur de l'UI (§6) |

**Règles « safe » vs « unsafe »** : une règle est *safe* si son action est `block`, `allow`, `allowAllRequests` ou `upgradeScheme` — actions qui ne peuvent pas servir à exfiltrer des données. `redirect` et `modifyHeaders` sont *unsafe* et tombent sous le sous‑quota de 5 000. Cela contraint directement le nombre de `$redirect`, `$removeparam` et `$csp` qu'on peut charger dynamiquement.

Ordre de grandeur : EasyList + EasyPrivacy + les listes par défaut d'uBO ≈ 100 000 filtres réseau. **On ne rentre pas dans 30 000 règles naïvement.** On y rentre par compilation optimisante (§ architecture, fusion par `requestDomains`) — c'est le cœur technique du projet.

## 4. Capacités exploitables

### `declarativeNetRequest`
- Actions : `block`, `allow`, `allowAllRequests`, `redirect`, `upgradeScheme`, `modifyHeaders`.
- Conditions : `urlFilter` (syntaxe calquée sur ABP : `||domain^`, `^`, `|`), `regexFilter` (RE2), `resourceTypes`, `domainType` (`firstParty`/`thirdParty`), `initiatorDomains` / `excludedInitiatorDomains`, `requestDomains` / `excludedRequestDomains`, `requestMethods`, `tabIds`, `responseHeaders` / `excludedResponseHeaders`.
- Bonne nouvelle : **`urlFilter` parle déjà le dialecte ABP**. La traduction d'un filtre réseau simple est quasi 1:1.
- `responseHeaders` en condition (Chrome 128+) ouvre le filtrage par type MIME réel, pas seulement par `resourceTypes` deviné.

### Content scripts
Inchangés et très puissants :
- `world: "MAIN"` (Chrome 111+) → injection de scriptlets dans le contexte de la page, indispensable pour neutraliser les anti‑adblock.
- `run_at: "document_start"` → on passe avant le script de la page.
- `chrome.scripting.registerContentScripts()` → enregistrement dynamique par domaine.
- MutationObserver, CSS injecté → cosmétique procédurale complète (`:has-text()`, `:matches-css()`, `:upward()`…).

### `chrome.userScripts` — piège à éviter
Depuis Chrome 138, l'API exige un interrupteur **« Allow User Scripts » par extension, désactivé par défaut**, que l'utilisateur doit activer à la main dans `chrome://extensions`. Elle est `undefined` sinon. **Elle n'est donc pas utilisable comme socle** : nos scriptlets doivent passer par `scripting` + `world: MAIN`, qui ne demande aucune action utilisateur.

## 5. Ce qui est définitivement perdu

À dire franchement, parce que ça conditionne les promesses du produit :

| Fonction uBO | Statut MV3 | Contournement |
|---|---|---|
| Filtrage du **corps** de réponse (`$replace`, HTML filtering) | **Impossible** | Scriptlet en `world: MAIN` qui patche l'objet JS après parsing (`json-prune`) |
| **CNAME uncloaking** | **Impossible** (pas de décision dynamique) | Aucun. Blocage par domaine connu seulement |
| Logique procédurale arbitraire par requête | **Impossible** | Recompilation en règles déclaratives |
| Mise à jour instantanée illimitée des filtres réseau | **Contingentée** | 30 000 règles dynamiques (§ hot‑update) |
| Compteur exact de requêtes bloquées | **Dégradé** | `getMatchedRules` limité à 20 appels / 10 min |
| Regex avancées (lookahead, backreference) | **Impossible** | RE2 uniquement, 1 000 max |

Et une contrainte de **conformité Chrome Web Store**, structurante pour l'architecture :
- Télécharger des **règles DNR** ou des **sélecteurs CSS** depuis un serveur = données de configuration → accepté.
- Télécharger des **scriptlets** = code exécutable à distance → **rejet garanti à la revue**.

Il faut donc séparer strictement, dès la conception, ce qui est *donnée* (mettable à jour à chaud) de ce qui est *code* (figé dans le paquet, mis à jour par publication au store). C'est le point qui casse le plus de projets d'ad‑blockers MV3 en cours de route.

## 6. Le cas YouTube

C'est le test décisif que tout le monde applique. L'anti‑adblock YouTube se neutralise aujourd'hui par scriptlets (`json-prune` sur la réponse du player, patch de `XMLHttpRequest`/`fetch`). Faisable en MV3 via `world: MAIN` — mais chaque riposte de YouTube exige une mise à jour de scriptlet, donc **une republication au store** (revue : quelques heures à quelques jours).

Mitigation architecturale : livrer des **scriptlets génériques paramétrables** (le code de `json-prune` est bundlé une fois ; les *chemins JSON* à élaguer sont des données mises à jour à chaud). On absorbe alors la majorité des ripostes sans republier. C'est la seule stratégie viable et elle doit être prévue dès le départ, pas rajoutée après.

## 7. Verdict de faisabilité

| Domaine | Parité atteignable vs uBO MV2 |
|---|---|
| Blocage réseau (EasyList/EasyPrivacy) | ~95 % |
| Filtrage cosmétique (y compris procédural) | ~100 % |
| Scriptlets / anti‑anti‑adblock | ~95 % (latence de mise à jour en plus) |
| Filtres utilisateur, picker d'élément | ~100 % |
| Réactivité aux ripostes | **Nettement inférieure** |

Un ad‑blocker MV3 « aussi bon qu'uBO » au sens de l'expérience quotidienne est atteignable. La parité stricte sur les sites qui luttent activement ne l'est pas — et aucun produit MV3 existant ne l'atteint. Le projet doit viser le premier objectif et être honnête sur le second.

## Sources

- [Manifest V2 support timeline — Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline)
- [ExtensionManifestV2Availability — Chrome Enterprise](https://chromeenterprise.google/policies/extension-manifest-v2-availability/)
- [Google shares final Web Store removal date for Manifest V2 extensions](https://piunikaweb.com/2026/07/08/google-chrome-manifest-v2-web-store-removal-date/)
- [chrome.declarativeNetRequest — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- [declarativeNetRequest — MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest)
- [Enabling chrome.userScripts in Chrome Extensions is changing](https://developer.chrome.com/blog/chrome-userscript)
- [uBlock Origin Lite (MV3) — DeepWiki](https://deepwiki.com/gorhill/uBlock/10-ublock-origin-lite-(mv3))
- [uBOL FAQ](https://github.com/uBlockOrigin/uBOL-home/wiki/Frequently-asked-questions-(FAQ))
- [AdguardTeam/tsurlfilter](https://github.com/AdguardTeam/tsurlfilter)
