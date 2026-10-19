# Passation entre sessions

> À lire en premier par toute nouvelle session Claude sur ce dépôt.

## Où on en est (2026-10-19)

- **M0 implémenté et relu** sur la branche `claude/clever-cannon-59x0dj` : les 14 tâches du plan `docs/superpowers/plans/2026-10-19-m0-fondations.md`, une revue par tâche, puis une revue de toute la branche, corrigée.
- **CI verte** (`.github/workflows/ci.yml`) : contrôles, puis intégration sur `postgres:17` (tests SQL, contrat HTTP, Playwright + axe).
- **Migrations appliquées** (MCP) au projet Supabase « WMR » `iggurckxmoagsajzrnwd` ; journal dans `docs/verifications.md`.
- **Production Vercel** (projet `wmr`, région `dub1`, branche suivie `develop`) sur https://wmr-ivm.vercel.app derrière la porte démo. Vérifié le 2026-10-19 : `/api/health` 200 avec `db: ok`, porte (mauvais mot de passe refusé, aucun cookie), `X-Robots-Tag`, `robots.txt`, `health.yml` vert, aucune erreur d'exécution.
- Comptes : org Supabase « WM Prod » `xyyxepqjbgmhyocqqcbx`, équipe Vercel IVM `team_nXdYy8ZVSzoNaYlzG7a1whey`, dépôt `IVM-Projects/wm-remake` (flux `develop` intégration, `master` production, `hotfix`).

## Étapes humaines ouvertes

1. Faites le 2026-10-19 : `SUPABASE_SECRET_KEY` en Production, et branche de production réglée sur `develop` (Vercel → Settings → Environments → Production → Branch Tracking ; l'onglet Git ne l'a plus).
2. Restant : cocher aussi **Preview** pour `SUPABASE_SECRET_KEY` (Vercel → Settings → Environment Variables), sinon `/api/health` répond 500 sur les previews.
3. Ajouter le dépôt `IVM-Projects/wm-remake` à un espace de travail Graphify, puis rejouer les notes de `docs/decisions-graphify.md`.
4. Facultatif : ajouter `wm` dans Supabase → Settings → API → Exposed schemas, pour que le réglage du rôle (`pgrst.db_schemas`) ne puisse pas dériver.
5. **Pause Supabase Free** (7 jours sans activité) : écartée tant que `health.yml` interroge la production chaque jour ; s'il échoue, il ouvre une issue.

## Étape suivante : écrire le plan M1

Trancher d'abord :

- le banc d'auth des tests : conteneur GoTrue ou `supabase start` en CI ;
- un helper d'appel `wm` sans HTTP pour les Server Components ;
- `route()` : POST à corps vide, validation des paramètres de chemin, transmission de la clé d'idempotence.

## Points différés

Triés par jalon dans `docs/m0-suivi.md`. Le fichier de suivi des tâches (`.superpowers/sdd/2026-10-19-m0-fondations/progress.md`) est ignoré par git et sera supprimé.

## Rappels pour l'exécution

- Choix du modèle de chaque sous-agent selon le skill `model-routing` (silencieusement).
- Réseau du bac à sable : wiki-masters.com, Wikimedia, Stripe, Brevo et l'hôte Postgres Supabase sont bloqués ; Supabase passe par son MCP (design §3.3).
- Les décisions de l'utilisateur sont listées au design §4.1.
