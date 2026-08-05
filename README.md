# AddBlocker

Ad‑blocker Chrome Manifest V3, conçu pour se rapprocher au maximum d'uBlock Origin
maintenant que MV2 n'existe plus sur Chrome (retrait définitif du Web Store : 31 août 2026).

**État : phases 1 à 4 terminées** — blocage réseau, cosmétique, scriptlets et interface fonctionnent. Reste la mesure de parité sur sites réels (phase 6).

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
| `pnpm test` | 219 tests unitaires (DNR, cosmétique, scriptlets, réglages, picker) |
| `pnpm build` | Compile les listes ; échoue sur dépassement de quota ou règle invalide |
| `pnpm verify` | Charge le build dans Chromium et vérifie le blocage réel |
| `pnpm cosmetic-check` | Vérifie le masquage et l'absence de flash |
| `pnpm scriptlet-check` | Vérifie les scriptlets dans le monde de la page |
| `pnpm ui-check` | Vérifie les flux utilisateur de bout en bout |
| `pnpm oracle` | Compare nos décisions à `@adguard/tsurlfilter` |

## Où ça en est

| Domaine | État |
|---|---|
| Blocage réseau | ✅ 13 022 règles, 0,40 % de filtres perdus, 98,4 % d'accord avec l'oracle |
| Filtrage cosmétique | ✅ 22 113 domaines, 56 100 sélecteurs, sans flash |
| Scriptlets | ✅ 61 805 invocations, 99,5 % du catalogue couvert |
| UI (popup, options, picker) | ✅ bascule par site en ~150 ms, filtres utilisateur, picker |

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
