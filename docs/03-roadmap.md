# Roadmap et critères d'acceptation

Chaque phase se termine par un critère **mesurable**. Pas de passage à la phase suivante sans le critère atteint.

## Phase 0 — Décision technique (1 semaine)

Avant d'écrire le compilateur, trancher : **repartir de zéro ou s'appuyer sur `@adguard/tsurlfilter`** ?

Banc d'essai : compiler EasyList + EasyPrivacy avec les deux approches, comparer nombre de règles produites, taux de filtres non convertis, fidélité du modèle de priorité.

> **Critère de sortie** : un ADR (`docs/adr/0001-moteur-de-conversion.md`) tranché, chiffres à l'appui.

Cette décision conditionne 80 % de l'effort restant. Elle mérite une semaine.

## Phase 1 — Blocage réseau (3–4 semaines)

- `filter-parser` : syntaxe ABP/uBO → AST (options réseau, `$badfilter`, exceptions).
- `dnr-compiler` : traduction + optimiseur (fusion par `requestDomains`, dédup, bandes de priorité).
- `tools/build-rulesets` : pipeline CI de génération des rulesets.
- Extension minimale : manifest + rulesets, aucune UI.

> **Critère de sortie** : EasyList + EasyPrivacy compilés **sous 30 000 règles**, extension chargée dans Chrome, blocage vérifié sur 20 sites de référence.

C'est le jalon qui prouve la viabilité du projet. S'il n'est pas atteint, l'optimiseur est à revoir avant toute autre chose.

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

## Phase 5 — Mise à jour à chaud (2 semaines)

Diff de règles signé sur CDN, application en règles dynamiques, validation par schéma en liste blanche, kill switch pour règle défectueuse.

> **Critère de sortie** : une règle cassant un site est neutralisée en production **sans publication au store**, en moins de 2 h.

## Phase 6 — Mesure de parité et publication (3 semaines)

- `tools/bench` : corpus 200–500 sites, comparaison automatisée contre uBO MV2 (Firefox) comme référence.
- Intégration CI : détection de régression du taux de blocage à chaque changement du compilateur.
- Soumission Chrome Web Store.

> **Critère de sortie** : **≥ 95 % du taux de blocage d'uBO** sur le corpus, **≤ 1 %** de sites cassés.

---

## Ce qu'il faut décider avant de commencer

Quatre questions dont les réponses changent l'architecture :

1. **Listes visées** : EasyList seul (léger, sûr) ou pack uBO complet + régionales (couverture maximale, pression sur le quota) ?
2. **Permissions à l'installation** : `<all_urls>` d'emblée (fonctionne partout, effraie et fait désinstaller) ou permissions à la demande par site (installation plus douce, friction à l'usage) ?
3. **Infrastructure de mise à jour** : un CDN à opérer, ou on s'en passe et on republie chaque semaine ? La phase 5 disparaît si la réponse est « on s'en passe ».
4. **Cible de distribution** : Chrome Web Store public (revue, conformité stricte) ou usage personnel en non empaqueté (aucune contrainte, `onRuleMatchedDebug` disponible, compteur exact possible) ?

La réponse à la question 4 change particulièrement la donne : en usage personnel non empaqueté, la contrainte « pas de code distant » disparaît et le compteur exact redevient accessible.
