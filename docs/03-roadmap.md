# Roadmap et critères d'acceptation

Chaque phase se termine par un critère **mesurable**. Pas de passage à la phase suivante sans le critère atteint.

## Phase 0 — Décision technique ✅ terminée

Trancher : **repartir de zéro ou s'appuyer sur `@adguard/tsurlfilter`** ?

> **Critère de sortie atteint** : [ADR 0001](adr/0001-moteur-de-conversion.md) — compilateur maison, `tsurlfilter` conservé comme oracle de test.

Résultats mesurés sur 77 265 filtres réseau (EasyList + EasyPrivacy + uAssets) :

| | Maison | AdGuard |
|---|---|---|
| Règles DNR | **12 760** (42,5 % du quota garanti) | 73 224 (244 %) |
| Compression | **5,75×** | 1,0× |
| Filtres non convertis | 5,0 % | 4,6 % |

Validé dans Chromium 141 réel : rulesets acceptés, blocage effectif confirmé, et Chrome avale jusqu'à 50 000 domaines dans une seule règle sans dégradation.

Enseignement le plus coûteux évité : une regex avec lookahead fait rejeter **tout un ruleset** en silence. D'où deux exigences reprises dans les phases suivantes — validation RE2 avant émission, et chargement réel dans Chrome en CI.

## Phase 1 — Blocage réseau ✅ terminée

> **Critères de sortie atteints** :
> - filtres non convertis : **0,40 %** (cible < 3 %, phase 0 était à 5,0 %)
> - oracle différentiel : **98,41 % d'accord, zéro sur-blocage, 5/5 divergences expliquées**
> - chargement dans Chromium : **vert**, tous les rulesets acceptés et blocage vérifié

### Ce qui a été livré

| Composant | Rôle |
|---|---|
| `packages/filter-parser` | Syntaxe ABP/uBO → AST typé |
| `packages/dnr-compiler` | AST → règles DNR, fusion par domaines, validation |
| `tools/build-rulesets` | Pipeline de build → `dist/extension` |
| `tools/verify-extension` | Charge le build dans Chromium et vérifie le blocage réel |
| `tools/oracle-diff` | Compare nos décisions à celles de `tsurlfilter` |
| `.github/workflows/ci.yml` | Enchaîne les quatre étapes à chaque push |

73 tests unitaires couvrent le mapping ABP→DNR, les bandes de priorité, la fusion et la validation.

### Rulesets produits

| Ruleset | Règles | Compression | Par défaut |
|---|---|---|---|
| `ads` (EasyList) | 2 802 | 21,2× | activé |
| `privacy` (EasyPrivacy) | 6 728 | 1,5× | activé |
| `ubo-core` | 1 242 | 1,1× | activé |
| `ubo-badware` | 1 311 | 3,2× | activé |
| `ubo-privacy` | 939 | 1,1× | activé |
| `annoyances` | 260 | 1,0× | désactivé |

**13 022 règles activées par défaut**, soit 43,4 % du minimum garanti. 226 regex sur 1 000.

### Comment le taux de conversion est passé de 5,0 % à 0,40 %

| Correctif | Filtres récupérés |
|---|---|
| `$popup` → blocage `main_frame` | ~2 825 |
| `$elemhide`/`$generichide` reclassés (cosmétiques, pas des échecs réseau) | 661 |
| Expansion des jokers TLD (`example.*`) | ~109 |
| `$rewrite` reconnu comme alias de `$redirect`, `strict1p`/`strict3p` | ~20 |

Le cas `$popup` mérite une note : DNR n'a pas de type de ressource « popup ». On le traduit en blocage `main_frame`, ce qui est *légèrement* plus large qu'uBO — une visite directe est bloquée aussi. Les filtres concernés ciblant exclusivement des domaines de spam et de paris, c'est le comportement souhaitable. C'est aussi la seule source de divergence avec l'oracle, et elle est classée automatiquement.

### Garde-fou ajouté en cours de route

Le build a attrapé des adresses IPv6 littérales (`[::1]`) dans des listes de domaines, que DNR n'accepte pas. Plutôt que de retirer l'entrée fautive — ce qui, sur une *exclusion*, élargirait le blocage et casserait des sites — le filtre entier est écarté. Principe retenu : **ne jamais sur-bloquer en silence**.

## Phase 2 — Filtrage cosmétique ✅ terminée

> **Critères de sortie atteints** :
> - masquage vérifié dans Chromium sur des cas tirés des listes réelles (simples **et** procéduraux)
> - **aucun flash** : l'élément n'est jamais visible, vérifié dès le premier paint et non « caché peu après »
> - aucun sur-masquage : un élément témoin reste visible sur chaque page de test

### Ce qui a été livré

| Composant | Rôle |
|---|---|
| `filter-parser` (`cosmetic.ts`) | Syntaxe `domains##selector`, `#@#`, `#$#`, `:style()` |
| `packages/cosmetic-compiler` | Index domaine → sélecteurs, buckets, génération des scripts |
| `packages/cosmetic-runtime` | Injection CSS + moteur procédural + MutationObserver |
| `tools/verify-extension` (`cosmetic-check`) | Masquage et absence de flash dans un vrai Chromium |

**22 113 domaines** en 56 buckets, **56 100 sélecteurs spécifiques**, 13 755 génériques, 3 640 procéduraux, 445 exceptions. 119 tests unitaires.

### La découverte qui a changé l'architecture

L'approche prévue — un `match pattern` par domaine dans le manifest — **ne passe pas à l'échelle**. Mesuré : 8 000 patterns coûtent **71 s de démarrage de Chrome**, 12 000 empêchent le chargement, et le coût est quadratique. Le budget réel du manifest est de ~1 000 patterns.

`chrome.scripting.registerContentScripts()` accepte 25 000 patterns en 1,9 s, une seule fois. Décision et mesures dans l'[ADR 0002](adr/0002-enregistrement-des-content-scripts.md).

### Choix notables

- **`:has()` reste en CSS.** Natif dans Chrome depuis la 105, c'est la pseudo-classe « procédurale » la plus fréquente (728 occurrences). La laisser au moteur CSS évite l'essentiel du travail JS ; seuls `:has-text()` (241) et la longue traîne passent par le moteur procédural.
- **Un `*` en position de domaine est un générique**, pas un domaine littéral. Traité littéralement il produit le pattern `*://*.*/*`, que Chrome refuse — en refusant l'extension entière.
- **Coût du générique mesuré** : 234 kB injectés sur chaque page, 36 ms jusqu'à `DOMContentLoaded`. Acceptable, mais c'est le premier candidat à l'optimisation (n'injecter que les sélecteurs dont la classe/l'id existe réellement).

### Limite assumée

Le critère initial parlait de « 20 sites de référence ». Le proxy de l'environnement de développement bloque la quasi-totalité du web : les tests s'appuient donc sur des pages locales reproduisant les sélecteurs **réellement présents dans les listes**, servies sous les domaines concernés. Cela valide le mécanisme, pas le rendu sur les vrais sites. La mesure sur sites réels reste la phase 6.

## Phase 3 — Scriptlets ✅ terminée

> **Critères de sortie atteints** (adaptés, voir plus bas) :
> - **99,5 %** des invocations couvertes par le catalogue (61 805 sur 62 107)
> - scriptlets vérifiés dans Chromium : exécution dans le monde de la page, **avant** ses scripts
> - comportement vérifié cas par cas, pas seulement la présence du code

### Ce qui a été livré

| Composant | Rôle |
|---|---|
| `packages/scriptlet-runtime` | Catalogue de 22 scriptlets + helpers, monde `MAIN` |
| `packages/scriptlet-compiler` | Parsing `+js(...)` et `//scriptlet(...)`, index par domaine, buckets |
| `tools/verify-extension` (`scriptlet-check`) | Vérifie le comportement réel dans Chromium |

**35 102 domaines** en 88 buckets, **61 805 invocations**. 158 tests unitaires au total.

### Couverture du catalogue

22 scriptlets suffisent à couvrir 99,5 % des invocations — la distribution est très concentrée :

| Scriptlet | Invocations |
|---|---|
| `trusted-set-cookie` | 960 |
| `aopr` (abort-on-property-read) | 910 |
| `trusted-click-element` | 903 |
| `acs` (abort-current-script) | 765 |
| `set` (set-constant) | 575 |
| `aeld` (addEventListener-defuser) | 557 |
| … 16 autres | |

Les 302 invocations restantes se répartissent sur 38 scriptlets rares (`rpnt`, `noeval`, `cookie-remover`…). Elles sont **comptées et affichées** par le build, jamais ignorées en silence : un scriptlet absent du catalogue serait sinon un no-op invisible.

### Choix notables

- **Les scriptlets génériques ne sont pas appliqués.** Un `##+js(...)` sans domaine accrocherait des globales sur *tous* les sites visités. Le rayon d'action est sans commune mesure avec un sélecteur cosmétique générique ; ils sont comptés et écartés.
- **Un scriptlet qui échoue n'interrompt pas les autres.** Chaque invocation est isolée : un filtre cassé ne doit pas désarmer la page entière.
- **`world: MAIN` est la raison d'être du dispositif.** Accrocher `window.open` depuis le monde isolé ne changerait rien à ce que la page observe — c'est ce que le test vérifie explicitement.

### Limite assumée sur le critère de sortie

Le critère initial disait « YouTube sans pré-roll, Twitch et 3 sites à anti-adblock ». **Ce n'est pas vérifiable ici** : le proxy de l'environnement bloque le web. Le critère a été remplacé par une vérification de comportement — des pages locales servies sous les domaines réellement ciblés, exécutant le motif que le scriptlet est censé neutraliser, et vérifiant le résultat observé par la page.

Cela prouve que le mécanisme fonctionne (`aopr` lève bien, `set` force bien la valeur, le cookie est bien posé avant que la page ne le lise). Cela ne prouve pas que YouTube est débloqué aujourd'hui — cette vérification reste à faire sur une machine avec un accès réseau normal.

## Phase 4 — UI et contrôle utilisateur ✅ terminée

> **Critère de sortie atteint** : un utilisateur peut débloquer un site cassé et créer un filtre sans quitter le navigateur — vérifié de bout en bout dans Chromium, en observant le comportement de la page, pas seulement l'état stocké.

### Ce qui a été livré

| Composant | Rôle |
|---|---|
| `packages/extension-core` | Réglages, règles dérivées, service worker |
| `packages/ui` | Popup, page d'options, element picker |
| `tools/verify-extension` (`ui-check`) | Pilote les flux utilisateur dans Chromium |

- **Popup** : compteur de blocages de l'onglet, bascule par site, accès au picker.
- **Options** : activation des listes, sites désactivés, éditeur de filtres.
- **Picker** : surligne l'élément survolé, construit le sélecteur le plus durable possible et **annonce sa solidité avant validation**.

219 tests unitaires.

### La mesure qui a dicté la conception

Désactiver un site touche deux mécanismes. Mesuré dans Chromium :

| Opération | Coût |
|---|---|
| Règle DNR dynamique (`allowAllRequests`) | **5 ms** |
| Mutation de l'ensemble des scripts enregistrés | **7,5 s**, quel que soit ce qu'on ajoute |
| Enregistrement initial des 146 buckets | ~9 s, une seule fois |

La réponse à l'utilisateur ne peut donc pas attendre les content scripts. Le service worker applique d'abord le chemin rapide (DNR + rulesets) puis lance la synchronisation des scripts **en arrière-plan**. Résultat mesuré : `toggleSite` répond en ~150 ms, et le rechargement de page qui suit voit déjà le site débloqué — ce qui est précisément ce que l'utilisateur attend d'un site cassé.

Les 7,5 s ne dépendent pas de ce qu'on ajoute mais de ce qui est **déjà** enregistré : Chrome réécrit tout l'ensemble persisté. La conséquence est qu'aucun script ne doit être enregistré à l'exécution — celui qui porte les filtres de l'utilisateur est enregistré au build et lit ses sélecteurs dans `chrome.storage`. Ajouter un filtre coûte alors une écriture, et l'effet est visible au rechargement suivant (**~400 ms** mesurés, contre 1 220 ms auparavant). Détail complet dans [ADR 0002](adr/0002-enregistrement-des-content-scripts.md).

### Deux défauts trouvés en corrigeant la CI

**Le cosmétique générique ignorait les sites désactivés.** La feuille générique était déclarée dans le manifest, et un content script du manifest ne peut pas voir ses `exclude_matches` modifiées à l'exécution : couper le filtrage sur un site coupait le réseau mais laissait des éléments masqués. Corrigé en enregistrant la feuille comme les autres. Le test qui le couvre échoue bien sur l'ancien schéma — vérifié, sinon il ne prouverait rien.

**Les listes désactivées par défaut s'activaient toutes seules.** Le worker activait tout ce qui n'était pas explicitement désactivé, écrasant le `enabled: false` du manifest : la liste *annoyances*, qui ne doit pas être active par défaut, l'était. Un seul ensemble « désactivé » ne peut pas distinguer « l'utilisateur n'a rien choisi » de « l'utilisateur a activé » ; les réglages enregistrent maintenant les deux écarts et le manifest reste la référence. Ce défaut était présent depuis la phase 1 et masqué par la lenteur du worker : en le rendant rapide, la vérification a commencé à observer l'état réel.

### Choix notables

- **La règle d'allowlist a la priorité 100 000**, au-dessus de toutes les bandes statiques, y compris les blocages `$important` à 3 000+. « Désactivé ici » doit vouloir dire désactivé, quoi que disent les listes.
- **`allowAllRequests` plutôt que `allow`** : une exception sur le seul document laisserait les sous-requêtes bloquées, ce qui ne réparerait pas le site.
- **Le picker note la fragilité du sélecteur.** Un filtre ancré sur une classe générée comme `css-1x7ab3` cessera de fonctionner au prochain déploiement du site ; l'utilisateur doit le savoir au moment où il le crée, pas des semaines plus tard.

### Un bug attrapé par les tests

Le détecteur de classes générées ratait `css-1x7ab3` — le format d'emotion, l'un des plus répandus — parce que le motif n'acceptait que de l'hexadécimal, or `x` n'en fait pas partie. Corrigé, avec des cas de non-régression sur les faux positifs : sur-signaler une classe *significative* est le pire des deux, puisque cela pousse le picker vers un sélecteur positionnel, strictement plus fragile.

## Phase 5 — Rafraîchissement des listes ✅

> **Critère de sortie** : `pnpm update-filters` régénère et recharge en moins d'une minute.
> **Atteint** — 4,1 s avec des listes modifiées en amont, 0,2 s quand rien n'a bougé.

| Cas | Mesuré |
|---|---|
| 22 listes vérifiées, 9 modifiées en amont → rebuild | **4,1 s** |
| 22 listes vérifiées, aucune modifiée → rien à faire | **0,2 s** |
| Rebuild forcé sans changement amont | 2,5 s |

Les requêtes sont conditionnelles (`If-None-Match` / `If-Modified-Since`) : vérifier 22 listes inchangées coûte 183 ms de 304, et rien n'est recompilé si rien n'a bougé. Une liste injoignable conserve sa copie en cache — une panne amont ne doit pas réduire silencieusement la protection.

Le rapport compte les **domaines** en plus des règles. La fusion par `requestDomains` fait qu'une liste peut grossir de milliers d'entrées sans que le nombre de règles bouge : ne montrer que les règles ferait passer une vraie mise à jour pour un non-événement.

### Le rechargement, et le piège du mode de chargement

Recharger l'extension depuis un script passe par le protocole DevTools. La vérification de ce chemin a d'abord échoué pour une raison instructive : une extension chargée par `--load-extension` **disparaît définitivement** après `chrome.runtime.reload()` — le drapeau la charge une fois et rien ne la réinstalle. Testée ainsi, la mécanique aurait été déclarée cassée alors qu'elle fonctionne.

Le harnais installe donc l'extension via `Extensions.loadUnpacked` (CDP), c'est-à-dire comme le bouton « Charger l'extension non empaquetée » — la configuration réelle de l'utilisateur. Le test modifie les règles sur disque, vérifie que **rien ne change avant le rechargement**, recharge, puis vérifie que les nouvelles règles s'appliquent.

Si aucun Chrome n'écoute sur le port de debug, la mise à jour réussit quand même et le script indique l'étape manuelle. Le rechargement est le seul maillon qui dépend de l'environnement ; le faire échouer bruyamment serait disproportionné.

### Kill switch par règle

`updateStaticRules()` neutralise une règle statique précise, sans toucher au reste. C'est la réparation fine que l'allowlist par site ne sait pas faire : quand une règle sur des dizaines de milliers casse un détail, couper tout le site — ou toute la liste — abandonne beaucoup trop.

Le popup liste les règles qui ont réellement bloqué quelque chose sur l'onglet, avec le domaine concerné : un identifiant de règle seul ne dit rien à personne. Vérifié en Chromium : la règle neutralisée cesse de bloquer, **toutes les autres continuent**, et le rétablissement re-bloque.

Une règle neutralisée ne se déclenchant plus, elle ne peut pas reparaître dans la liste du popup — le rétablissement vit donc dans les réglages, sans quoi la neutralisation serait irréversible.

Limite assumée : les identifiants de règles sont renumérotés à chaque rebuild, donc une neutralisation ne survit pas à `update-filters`. C'est un dépannage immédiat, pas une préférence durable, et l'interface le dit.

## Phase 6 — Mesure de parité ✅ (partiellement — voir la limite)

> **Critère de sortie** : **≥ 95 % du taux de blocage d'uBO**, **≤ 1 %** de sites cassés.
> **Atteint sur corpus synthétique** : 100 % du taux de blocage, 0 % de sur-blocage.
> **Non mesuré sur le web réel** : le proxy de l'environnement de développement refuse le CONNECT vers les sites (403). Le harnais existe et fonctionne, il reste à l'exécuter sur une machine connectée.

### La référence est uBlock Origin lui-même

Pas une approximation : `@gorhill/ubo-core` **est** le moteur de filtrage réseau statique d'uBO, publié en bibliothèque. Il reçoit les mêmes listes et arbitre chaque requête. Notre côté est mesuré dans un vrai Chromium exécutant l'extension construite — c'est le moteur `declarativeNetRequest` de Chrome qui décide, pas un modèle de celui-ci. Une requête en échec n'est jamais prise pour une preuve de blocage : seul un `onRuleMatchedDebug` compte.

| Graine | Requêtes | uBO bloque | Nous bloquons | Parité | Sur-blocage |
|---|---|---|---|---|---|
| 20260806 | 5 200 | 3 869 | 3 869 | **100 %** | **0 %** |
| 987654321 | 5 200 | 3 843 | 3 843 | **100 %** | **0 %** |

### Le corpus vient des listes brutes, pas de nos règles

Distinction essentielle : un filtre que le compilateur échoue à convertir ne laisse aucune trace dans nos règles. Un corpus bâti sur elles ne pourrait donc jamais contenir les requêtes que nous ratons — la mesure se flatterait elle-même.

Les cas discriminants sont construits **par paires** : la même requête depuis un contexte que le filtre couvre et depuis un contexte qu'il ne couvre pas. Perdre une restriction `$domain=` ou `$third-party` à la compilation ne se voit pas sur le premier ; c'est le second qui le révèle. Le corpus contient aussi des requêtes qui ne doivent **pas** être bloquées — sans elles, un bloqueur qui bloque tout obtiendrait un score parfait.

### Trois erreurs de mesure avant d'obtenir un chiffre honnête

Le premier résultat fut 100 % du premier coup, sur 200 requêtes. C'était un signal d'alarme, pas un succès : le corpus n'était fait que de `||domaine^` triviaux.

1. **Listes inégales.** uBO recevait les 22 listes, l'extension en désactive une par défaut (*annoyances*). L'écart était imputé au compilateur. Corrigé : uBO ne reçoit que les listes réellement actives.
2. **Redirections comptées comme des échecs.** Une action `redirect` empêche la ressource d'origine de se charger tout autant qu'un `block`, et uBO compte ainsi ses propres filtres `$redirect`. Ne compter que `block` transformait des requêtes correctement traitées en manques.
3. **Un bug réel, trouvé grâce aux deux corrections précédentes** — voir ci-dessous.

### Le bug que cette phase a trouvé

```
*$script,redirect-rule=noopjs,domain=acusports.com|…|siusalukis.com|…
```

`$redirect-rule` ressemble à `$redirect` et n'a pas le même sens : il ne bloque **rien** par lui-même, il dit seulement quoi servir *si un autre filtre bloque déjà* la requête. Le compilateur les traitait à l'identique et produisait une redirection inconditionnelle sur le motif `*` — donc **tout script remplacé par un stub vide sur environ deux cents sites**, qui auraient été intégralement cassés.

DNR n'a pas de forme conditionnelle : ces filtres n'émettent désormais plus rien. Le blocage reste assuré par le filtre qui bloquait déjà ; seul le stub neutre est perdu. Cas de non-régression ajouté, dans les deux sens (`$redirect` doit continuer de fonctionner).

C'est le genre de défaut qu'aucune relecture n'attrape : le filtre est syntaxiquement correct, la règle produite est valide, Chrome l'accepte sans broncher, et le symptôme n'apparaît que sur des sites précis.

### Ce qui reste non mesuré

`pnpm parity-sites` pilote Chromium sur des sites réels, enregistre chaque requête, demande son verdict à uBO, et juge la casse **par différence** avec la même page sans extension — un site cassé tout seul ne nous est pas imputé. Le corpus fourni compte 243 sites (presse, commerce, vidéo, forums, services publics, plus des sites techniques en témoins).

Il n'a pas pu tourner ici : le proxy refuse le CONNECT vers le web ouvert. Le pipeline est validé de bout en bout contre un serveur local (uBO 2, nous 2, aucune casse), mais **la distribution du trafic réel n'est pas celle d'un corpus synthétique** : requêtes générées après exécution de scripts, URL dynamiques, première partie mêlée à la troisième. Le 100 % ci-dessus mesure la fidélité de la traduction des filtres, pas le comportement sur une page de presse chargée.

---

## Décisions actées

**Distribution : usage personnel, extension non empaquetée, pas de Chrome Web Store.** Ce choix relâche trois contraintes majeures de l'architecture initiale :

| Contrainte | En contexte store | En usage personnel |
|---|---|---|
| Code distant interdit | Structurante — scriptlets figés dans le paquet | **Levée** : les scriptlets peuvent être rechargés localement |
| Latence de mise à jour | Revue de quelques heures à quelques jours | **Nulle** : rebuild local immédiat |
| Compteur de blocages | Approximatif (`getMatchedRules`, 20 appels / 10 min) | **Exact** : `onRuleMatchedDebug` est disponible en non empaqueté |
| Permissions à l'installation | `<all_urls>` fait fuir les utilisateurs | Sans objet — un seul utilisateur, consentant |

Reste ouvert, sans impact sur l'architecture : le périmètre exact des listes régionales à embarquer. Le quota n'étant pas contraignant (42,5 % du minimum garanti), on peut être généreux.
