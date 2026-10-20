# WikiCartes (refonte de WikiMasters)

Jeu de cartes à collectionner dans le navigateur, en français, reconstruit sur Next.js 16 (App Router), Supabase et Vercel. Toute la logique métier vit en PL/pgSQL (schéma `wm`) ; les route handlers ne font que l'appeler. La démo est privée, derrière une porte à mot de passe.

## Démarrer

Node 24 (`.nvmrc`), au moins 22.22.

```bash
npm install
cp .env.example .env.local   # puis remplir
npm run dev
```

Le nom affiché vient de `NEXT_PUBLIC_BRAND_NAME` (par défaut `WikiCartes`). Configurer la marque d'origine sans `DEMO_GATE_PASSWORD` fait échouer le build et le démarrage. La porte démo exige les deux variables `DEMO_GATE_PASSWORD` et `GATE_COOKIE_SECRET`, ou aucune : une seule fait échouer le démarrage.

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

### Prérequis des tests SQL, de contrat et E2E

- `psql`, et PostgreSQL 16 dans `/usr/lib/postgresql/16/bin` (autre dossier : `PGBIN`) pour le cluster jetable ; ou un serveur existant désigné par `DATABASE_URL` (CI : `postgres:17`).
- `bash scripts/get-tools.sh` : télécharge dans `.cache/` PostgREST, GoTrue (Supabase Auth) et Mailpit, à SHA-256 épinglé.
- `npm run build:test` avant `npm run test:contract` et `npm run test:e2e`.
- E2E : `PW_CHROMIUM_PATH` désigne un Chromium déjà installé, sinon `npx playwright install chromium`.
- Suite complète : `npm run lint && npm run typecheck && npm test && npm run test:db && npm run build:test && npm run test:contract && npm run test:e2e && npm run coverage:recap`. Le `webServer` de Playwright démarre et arrête le banc.
- Le banc occupe les ports 54321 à 54325 (passerelle, PostgREST, GoTrue, Mailpit HTTP et SMTP), 54329 (PG local), 3100 et 3101 (Next).

## Documentation

- [Design de la refonte](docs/superpowers/specs/2026-10-18-wikimasters-rebuild-design.md)
- [Recap de l'app existante](docs/rea-recap.md)
- [Plans d'implémentation](docs/superpowers/plans/)
- [Passation entre sessions](docs/superpowers/HANDOFF.md) et [points différés](docs/suivi.md)
