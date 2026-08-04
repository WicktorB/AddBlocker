# ADR 0001 — Moteur de conversion des filtres vers DNR

- **Statut** : accepté
- **Date** : 2026-08-04
- **Décide** : construire un compilateur maison, avec `@adguard/tsurlfilter` conservé comme oracle de test
- **Contexte de distribution** : usage personnel, extension non empaquetée, pas de publication au Chrome Web Store

## Question

Faut-il écrire notre propre compilateur `filtres ABP → règles DNR`, ou s'appuyer sur `@adguard/tsurlfilter`, le seul convertisseur open source mature ?

## Méthode

Banc d'essai sur corpus réel, mêmes listes pour les deux approches :

- **EasyList** (fragments amont) : 82 053 lignes
- **EasyPrivacy** : 10 599 lignes
- **uBO uAssets** (`filters`, `badware`, `privacy`, `quick-fixes`) : 21 164 lignes
- Total : **77 265 filtres réseau**, 24 465 filtres cosmétiques, 2 910 scriptlets

Puis validation dans **Chromium 141 réel** : extension MV3 générée, chargée via `--load-extension`, interrogation de l'API DNR et test de blocage effectif (toutes les résolutions DNS pointées vers un serveur local, donc aucun trafic externe).

Code : `tools/phase0-bench` (`run.ts`, `sanity.ts`, `validate-chrome.ts`, `calibrate-domains.ts`, `find-bad-rules.ts`).

## Résultats

### Volume de règles produites

| | Maison | AdGuard |
|---|---|---|
| Règles DNR produites | **12 760** | 73 224 |
| Compression vs filtres bruts | **5,75×** | 1,0× |
| % du quota garanti (30 000) | **42,5 %** | 244 % |
| % du pool global (330 000) | 3,9 % | 22,2 % |
| Filtres non convertis | 5,0 % | 4,6 % |
| Regex utilisées (budget 1 000) | 208 | 0 |
| Temps de compilation | ~300 ms | ~2,8 s |

L'écart tient à **une seule optimisation** : AdGuard émet une règle DNR par filtre, là où nous fusionnons les filtres « bloque ce domaine » partageant les mêmes conditions en une règle unique portant un tableau `requestDomains`. Sur EasyList, dominé par les filtres `||domain^$third-party`, le facteur atteint **20,98×**.

Le taux de conversion est équivalent (5,0 % vs 4,6 % de filtres perdus) : la compression ne se paie pas en couverture.

### Validation dans Chromium 141

```
enabled rulesets:       ["easylist","easyprivacy","ubo"]
available static rules: 317 302
constants: GUARANTEED_MINIMUM_STATIC_RULES=30000, MAX_NUMBER_OF_ENABLED_STATIC_RULESETS=50,
           MAX_NUMBER_OF_DYNAMIC_RULES=30000, MAX_NUMBER_OF_REGEX_RULES=1000
PASS  tous les rulesets acceptés et activés
PASS  lawksister.shop  attendu=bloqué  réel=bloqué
PASS  domaine témoin   attendu=passant réel=passant
```

Le domaine testé est tiré de la règle fusionnée la plus grosse (51 983 domaines) : la fusion fonctionne réellement, pas seulement sur le papier.

### Calibration : combien de domaines dans une règle ?

Le risque principal de la fusion était que Chrome refuse ou peine sur de gros tableaux `requestDomains`. Mesuré, aucun quota documenté n'existant :

| Domaines dans **une** règle | Accepté | Chargement |
|---|---|---|
| 1 000 | oui | 547 ms |
| 10 000 | oui | 553 ms |
| 25 000 | oui | 591 ms |
| **50 000** | **oui** | 633 ms |
| 100 000 répartis sur 200 règles | oui | 749 ms |

Aucune dégradation mesurable. **La fusion agressive est sûre.**

### Le piège qui aurait coûté cher

Un `regexFilter` contenant un lookahead `(?=...)` — non supporté par RE2 — fait **rejeter l'intégralité du ruleset** par Chrome, silencieusement. Une seule règle issue des listes uBO désactivait ainsi les 3 436 autres. Découvert par dichotomie automatisée (`find-bad-rules.ts`).

Conséquence pour l'architecture : **le compilateur doit valider les regex avant émission**, et la CI doit charger les rulesets dans un vrai Chrome. Une validation par schéma JSON n'aurait rien vu.

Deux autres défauts corrigés au passage : `$to=` était mappé en exclusion alors qu'il restreint (inversion de sens), et les domaines à joker TLD (`example.*`) produisaient des entrées qui n'auraient jamais matché.

## Décision

**Compilateur maison**, pour trois raisons :

1. **La compression est structurante.** 12 760 règles contre 73 224, à couverture égale. Même si les deux tiennent dans le pool global en usage personnel, 22 % d'un pool partagé *premier arrivé premier servi* pour un seul blocker est une fragilité inutile — et la version compacte charge et matche plus vite.
2. **Le convertisseur AdGuard n'est plus exporté en v6.** Présent en `@adguard/tsurlfilter@5.0.1`, absent des points d'entrée de la 6.0.2. En dépendre, c'est se lier à une version figée d'une bibliothèque dont l'amont a déplacé le composant.
3. **Le périmètre est tenable.** Le prototype fait ~400 lignes et convertit 95 % des filtres. La maturité industrielle d'AdGuard sert surtout les cas limites et la conformité au store — ni l'un ni l'autre n'est critique ici.

### Honnêtement, la décision est moins tranchée qu'elle n'en a l'air

En usage personnel, **les deux approches fonctionnent** : 73 224 règles tiennent dans le pool global de 330 000. Si le projet avait visé le Chrome Web Store, où l'on ne peut pas compter sur le pool global, AdGuard aurait été disqualifié net. Ici, le choix se fait sur la qualité d'ingénierie, pas sur une impossibilité.

Le vrai risque du choix maison n'est pas le volume : c'est la **fidélité sémantique** sur les cas tordus (priorités exactes, `$badfilter` inter-listes, options rares), là où AdGuard a des années d'avance.

### Mitigation

`@adguard/tsurlfilter@5.0.1` reste en dépendance de développement comme **oracle de test différentiel** : en CI, comparer nos décisions de blocage aux siennes sur un corpus de requêtes, et traiter chaque divergence comme un bug à instruire. On garde le bénéfice de leur maturité sans en dépendre à l'exécution.

## Conséquences

À reprendre dans l'architecture :

- La fusion par `requestDomains` devient une brique de premier plan, pas une optimisation tardive.
- **Validation RE2 obligatoire** avant émission, avec budget regex vérifié en CI (208/1 000 utilisées, marge confortable).
- **Chargement réel dans Chrome en CI** comme test bloquant : c'est le seul moyen de détecter un ruleset rejeté.
- Le mapping `$to=` / `$denyallow=` / jokers TLD est couvert par des tests de table (12 cas, tous verts).
- Amélioration identifiée pour la phase 1 : expanser les jokers TLD (`example.*`) sur une liste de TLD connus, comme le fait AdGuard, pour récupérer une partie des 5 % de filtres perdus.

## Ce que la phase 0 a aussi établi

- Le quota n'est pas le facteur limitant : 42,5 % du minimum garanti, avant même de découper en rulesets thématiques activables.
- Le pool global de ~330 000 règles est confirmé empiriquement (317 302 disponibles après chargement).
- 24 465 filtres cosmétiques et 2 910 scriptlets attendent les phases 2 et 3 — c'est là que se jouera désormais l'essentiel de l'écart avec uBO, plus dans le blocage réseau.
