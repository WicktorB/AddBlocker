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

## Phase 2 — Filtrage cosmétique (3–4 semaines)

- `cosmetic-compiler` : index domaine → sélecteurs, génération des content scripts par bucket.
- `cosmetic-runtime` : sélecteurs procéduraux (`:has-text`, `:matches-css`, `:upward`, `:watch-attr`) + MutationObserver.
- Injection CSS des sélecteurs génériques, conditionnée à la présence réelle des classes/ids.

> **Critère de sortie** : zéro espace vide résiduel sur les 20 sites de référence, aucun flash de contenu (mesuré au CLS).

## Phase 3 — Scriptlets (2–3 semaines)

- Catalogue bundlé (`json-prune`, `set-constant`, `abort-on-property-read`, `nano-setTimeout-booster`…), `world: MAIN`.
- Table d'invocations paramétrable, séparée du code.

> **Critère de sortie** : YouTube sans pré‑roll, Twitch et 3 sites à anti‑adblock connus fonctionnels.

## Phase 4 — UI et contrôle utilisateur (3 semaines)

Popup (bascule par site, modes, compteur), page d'options (listes, filtres utilisateur), element picker, logger de requêtes.

> **Critère de sortie** : un utilisateur peut débloquer un site cassé et créer un filtre sans quitter le navigateur.

## Phase 5 — Rafraîchissement des listes (1 semaine)

En usage personnel, pas de CDN à opérer ni de revue à subir : un script de rebuild local suffit.

- Rebuild déclenché à la main ou par tâche planifiée : re-télécharge les listes, recompile, recharge l'extension.
- Kill switch en règles dynamiques pour neutraliser une règle qui casse un site, sans rebuild complet.

> **Critère de sortie** : `pnpm update-filters` régénère et recharge en moins d'une minute.

## Phase 6 — Mesure de parité (2 semaines)

- `tools/bench` : corpus 200–500 sites, comparaison automatisée contre uBO MV2 (Firefox) comme référence.
- Intégration CI : détection de régression du taux de blocage à chaque changement du compilateur.

> **Critère de sortie** : **≥ 95 % du taux de blocage d'uBO** sur le corpus, **≤ 1 %** de sites cassés.

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
