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

## Phase 1 — Blocage réseau (2–3 semaines)

Le prototype de phase 0 a déjà prouvé la viabilité et sert de base. Il reste à le durcir :

- Promouvoir `tools/phase0-bench/src/{parser,compiler}.ts` en `packages/filter-parser` et `packages/dnr-compiler`.
- Compléter la couverture des options rares ; expanser les jokers TLD (`example.*`) pour récupérer une partie des 5 % de filtres perdus.
- Découpe en rulesets thématiques activables (`ads`, `privacy`, `annoyances`, régionales).
- Oracle différentiel en CI contre `tsurlfilter` : toute divergence de décision est un bug à instruire.

> **Critère de sortie** : taux de filtres non convertis **sous 3 %**, zéro divergence non expliquée face à l'oracle, chargement dans Chrome vert en CI.

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
