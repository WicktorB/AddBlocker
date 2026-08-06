# Banc d'essai phase 0

Mesure comparative `compilateur maison` vs `@adguard/tsurlfilter`, et validation
dans un Chromium réel. Conclusions dans [ADR 0001](../../docs/adr/0001-moteur-de-conversion.md).

## Commandes

| Commande | Ce qu'elle fait |
|---|---|
| `pnpm bench` | Compile les listes avec les deux moteurs, compare volume et couverture |
| `pnpm sanity` | Tests de table du mapping ABP→DNR + intégrité de la fusion |
| `pnpm validate` | Charge les rulesets dans Chromium 141, vérifie acceptation et blocage réel |
| `pnpm calibrate` | Cherche la limite de domaines acceptés dans une règle DNR |
| `pnpm find-bad-rules` | Dichotomie pour isoler une règle que Chrome refuse |

Les listes sont mises en cache dans `.lists/`, les artefacts dans `out/` (tous deux ignorés par git).

## Notes d'environnement

- Chromium est pris dans `/opt/pw-browsers/chromium-1194` (préinstallé).
- Le chargement d'extension exige `ignoreDefaultArgs: ['--disable-extensions']` : Playwright
  passe ce flag par défaut, ce qui neutralise silencieusement `--load-extension`.
- Le *headless shell* ne charge pas les extensions ; il faut le vrai binaire Chromium.
- `--host-resolver-rules` redirige toutes les résolutions vers un serveur local :
  les tests de blocage sont réels mais ne génèrent aucun trafic externe.
