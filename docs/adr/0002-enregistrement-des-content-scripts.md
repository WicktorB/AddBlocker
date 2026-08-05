# ADR 0002 — Enregistrement des content scripts cosmétiques

- **Statut** : accepté
- **Date** : 2026-08-05
- **Décide** : enregistrer les content scripts cosmétiques via `chrome.scripting.registerContentScripts()` au lieu de les déclarer dans le manifest
- **Remplace** : la stratégie « content scripts pré-générés déclarés au manifest » décrite dans [docs/02-architecture.md §4.1](../02-architecture.md)

## Question

Le filtrage cosmétique couvre **22 113 domaines**. Chacun doit recevoir ses sélecteurs à `document_start`, sans aller-retour avec le service worker — un réveil à froid de 50–200 ms laisserait la publicité s'afficher puis disparaître.

L'architecture initiale prévoyait des content scripts générés au build et déclarés dans le manifest, avec un `match pattern` par domaine. Cette approche est celle que nous prêtions à uBlock Origin Lite.

## Ce que la mesure a montré

Chrome ne documente aucune limite sur `content_scripts`, et refuse un manifest trop gros **sans message d'erreur** : l'extension ne se charge simplement pas. Mesuré avec `tools/verify-extension/src/calibrate-manifest.ts` :

| Scripts | Patterns/script | Total patterns | Manifest | Charge | Démarrage Chrome |
|---|---|---|---|---|---|
| 1 | 1 000 | 1 000 | 34 kB | oui | **1,6 s** |
| 200 | 10 | 2 000 | 77 kB | oui | 4,4 s |
| 60 | 100 | 6 000 | 201 kB | oui | 34 s |
| 20 | 400 | 8 000 | 269 kB | oui | **71 s** |
| 1 | 8 000 | 8 000 | 273 kB | oui | 71 s |
| 30 | 400 | 12 000 | 405 kB | **non** | — |
| 1 | 20 000 | 20 000 | 693 kB | **non** | — |

Deux enseignements :

1. **C'est le nombre total de `match patterns` qui compte**, pas le nombre de scripts ni la taille du manifest. 60 scripts × 100 patterns démarrent deux fois plus vite qu'un seul script de 8 000 patterns.
2. **Le coût est quadratique.** 8 000 patterns « fonctionnent » au sens où l'extension charge — après 71 secondes de démarrage. Le budget réellement utilisable est de l'ordre de **1 000 à 2 000 patterns**.

22 113 domaines sont donc hors d'atteinte par cette voie, d'un facteur dix.

## L'alternative mesurée

`chrome.scripting.registerContentScripts()` emprunte un autre chemin. Mesuré avec `calibrate-dynamic.ts` :

| Scripts | Patterns/script | Total patterns | Enregistre | Temps |
|---|---|---|---|---|
| 1 | 1 000 | 1 000 | oui | 21 ms |
| 1 | 10 000 | 10 000 | oui | 407 ms |
| 56 | 400 | 22 400 | oui | **1,6 s** |
| 100 | 250 | 25 000 | oui | 1,9 s |

25 000 patterns passent en moins de deux secondes, **une seule fois** : avec `persistAcrossSessions: true`, Chrome conserve l'enregistrement entre les sessions. Le démarrage du navigateur n'est pas affecté.

## Décision

- Le manifest ne déclare **aucun** content script (voir la révision ci-dessous).
- Tous les scripts — 56 buckets cosmétiques, 88 buckets scriptlets, la feuille générique et les filtres de l'utilisateur — sont enregistrés par le service worker via `registerContentScripts()`, avec `persistAcrossSessions: true`.
- Le build émet `cosmetic/registrations.json` ; le service worker le lit et réconcilie l'état enregistré au démarrage et à l'installation.

L'injection reste native et à `document_start` : une fois enregistrés, ces scripts se comportent exactement comme ceux du manifest. Le seul changement est la manière de les déclarer.

## Conséquences

- **Le service worker devient nécessaire au premier démarrage**, ce que l'architecture initiale cherchait à éviter. Nuance importante : il n'est nécessaire qu'une fois, pour l'enregistrement — ensuite Chrome injecte seul, sans réveil du service worker. Le chemin chaud reste sans service worker.
- Un décalage est possible à la toute première seconde après installation, avant que l'enregistrement n'aboutisse. Sur une extension déjà installée, il n'y en a pas.
- La réconciliation doit être **idempotente** : ré-enregistrer un id existant échoue. Le service worker compare avant d'écrire.
- Le budget de patterns du manifest reste utile pour d'autres besoins (~1 000 disponibles) : ne pas le dilapider.

## Ce que cela dit de l'architecture initiale

Le document d'architecture recommandait la voie du manifest en s'appuyant sur ce que fait uBlock Origin Lite. La mesure montre que cette voie ne passe pas à l'échelle des listes réelles. C'est le genre d'erreur qu'aucune relecture n'aurait attrapée : Chrome accepte 8 000 patterns, les documente nulle part, et se contente de démarrer soixante-dix fois plus lentement.

Corollaire méthodologique, déjà appris en phase 0 avec les regex non-RE2 : **tout quota non documenté doit être mesuré dans un vrai navigateur avant qu'on s'appuie dessus.**

## Révision (phase 4) : le coût d'une *mutation* de l'ensemble enregistré

Le tableau ci-dessus mesure l'enregistrement **initial**. Il ne dit rien du coût
d'une modification ultérieure, et c'est là que se trouvait le problème réel :
un filtre créé par l'utilisateur mettait plus d'une seconde à agir, et la CI
échouait par intermittence sur cette latence.

Mesuré sur un ensemble de 144 scripts déjà enregistrés :

| Opération | Temps |
|---|---|
| `getRegisteredContentScripts()` (lecture) | 86 ms |
| `registerContentScripts()` — **un seul** script | **7,5 s** (20 échantillons, 7,4–7,7 s) |
| `updateContentScripts()` sur les 144 | plusieurs secondes |

Le coût n'est pas proportionnel à ce qu'on ajoute mais à ce qui est **déjà**
enregistré : ajouter un script fait réécrire l'ensemble persisté, soit ici
~57 000 match patterns. Vingt échantillons consécutifs à ±0,2 s écartent la
contention comme explication.

Trois conséquences, toutes appliquées :

1. **Aucun enregistrement à l'exécution.** Le script qui applique les filtres de
   l'utilisateur est enregistré au build comme les autres, et lit ses sélecteurs
   dans `chrome.storage`. Ajouter un filtre est une écriture en stockage.
   Mesuré : **~400 ms** avant effet, contre 1 220 ms auparavant — et surtout
   sans mutation de l'ensemble enregistré.
2. **Les exclusions ne sont réécrites que si elles ont changé.** Elles changent
   quand on désactive un site, pas quand on ajoute un filtre. L'état appliqué
   est mémorisé et comparé (`exclusionsDiffer`), en se trompant du côté sûr :
   une réécriture inutile coûte du temps, une réécriture manquée laisserait le
   filtrage actif là où l'utilisateur l'a coupé.
3. **Les synchronisations sont sérialisées.** Deux passes concurrentes se
   disputent le même ensemble et l'une échoue sur un id déjà pris.

## Révision (phase 4) : pourquoi plus rien dans le manifest

La feuille générique était restée dans le manifest — un seul pattern, et
disponible dès la toute première page, avant même le réveil du service worker.
C'était un défaut de correction, pas une optimisation : **un content script du
manifest ne peut pas voir ses `exclude_matches` modifiées à l'exécution.**
Désactiver un site coupait donc le réseau mais laissait le cosmétique générique
masquer des éléments. Or « désactivé ici » doit vouloir dire désactivé — le même
principe qui met l'allowlist réseau à la priorité 100 000.

Le prix de la correction est que le cosmétique générique est inerte pendant le
premier enregistrement d'un profil neuf. Ce coût est ponctuel : Chrome persiste
les enregistrements, tous les démarrages suivants les ont d'emblée. La
correction est vérifiée par un test qui échoue bien sur l'ancien schéma
(`ui-check` : « cosmetic filtering stops on a disabled site »).
