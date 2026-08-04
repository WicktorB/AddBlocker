# AddBlocker

Ad‑blocker Chrome Manifest V3, conçu pour se rapprocher au maximum d'uBlock Origin
maintenant que MV2 n'existe plus sur Chrome (retrait définitif du Web Store : 31 août 2026).

**État : conception.** Aucun code n'est encore écrit — l'analyse et l'architecture sont à valider avant implémentation.

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
| Blocage réseau | ~95 % d'uBO |
| Filtrage cosmétique (dont procédural) | ~100 % |
| Scriptlets / anti‑anti‑adblock | ~95 % |
| Réactivité aux ripostes | inférieure — limite structurelle de MV3, sans solution |
