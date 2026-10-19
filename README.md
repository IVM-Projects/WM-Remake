# WikiCartes (refonte de WikiMasters)

Jeu de cartes à collectionner dans le navigateur, en français, reconstruit sur Next.js 16 (App Router), Supabase et Vercel. Toute la logique métier vit en PL/pgSQL (schéma `wm`) ; les route handlers ne font que l'appeler. La démo est privée, derrière une porte à mot de passe.

## Démarrer

Node 24 (`.nvmrc`), au moins 22.22.

```bash
npm install
cp .env.example .env.local   # puis remplir
npm run dev
```

Le nom affiché vient de `NEXT_PUBLIC_BRAND_NAME` (par défaut `WikiCartes`). Configurer la marque d'origine sans `DEMO_GATE_PASSWORD` fait échouer le build et le démarrage.

## Commandes

| Commande | Rôle |
|---|---|
| `npm run dev` | serveur de développement |
| `npm run build` / `npm start` | build et serveur de production |
| `npm run build:test` | build pointé sur le backend local des tests |
| `npm run typecheck` | `next typegen` puis `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | tests unitaires (vitest) |
| `npm run test:db` | tests SQL |
| `npm run test:contract` | contrat HTTP |
| `npm run test:e2e` | Playwright + axe |
| `npm run coverage:recap` | couverture des routes du recap |

## Documentation

- [Design de la refonte](docs/superpowers/specs/2026-10-18-wikimasters-rebuild-design.md)
- [Recap de l'app existante](docs/rea-recap.md)
- [Plans d'implémentation](docs/superpowers/plans/)
