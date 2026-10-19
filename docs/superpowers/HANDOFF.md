# Passation entre sessions

> À lire en premier par toute nouvelle session Claude sur ce dépôt.

## Où on en est (2026-10-19)

- **M0 implémenté et relu** sur la branche `claude/clever-cannon-59x0dj` : les 14 tâches du plan `docs/superpowers/plans/2026-10-19-m0-fondations.md`, une revue par tâche, puis une revue de toute la branche, corrigée.
- **CI verte** (`.github/workflows/ci.yml`) : contrôles, puis intégration sur `postgres:17` (tests SQL, contrat HTTP, Playwright + axe).
- **Migrations appliquées** (MCP) au projet Supabase « WMR » `iggurckxmoagsajzrnwd` ; journal dans `docs/verifications.md`.
- **Preview Vercel** (projet `wmr`, région `dub1`) derrière la porte démo. Son `/api/health` répond 500 tant que la clé secrète manque.
- Comptes : org Supabase « WM Prod » `xyyxepqjbgmhyocqqcbx`, équipe Vercel IVM `team_nXdYy8ZVSzoNaYlzG7a1whey`, dépôt `IVM-Projects/wm-remake` (flux `develop` intégration, `master` production, `hotfix`).

## Étapes humaines ouvertes

1. Ajouter `SUPABASE_SECRET_KEY` (clé `sb_secret_…`, Supabase → Settings → API Keys) au projet Vercel `wmr`, pour Production et Preview, puis redéployer.
2. Régler Vercel → Settings → Git → Production Branch sur `develop` ou `master` (`main` n'existe pas).
3. Ajouter le dépôt `IVM-Projects/wm-remake` à un espace de travail Graphify, puis rejouer les notes de `docs/decisions-graphify.md`.
4. Facultatif : ajouter `wm` dans Supabase → Settings → API → Exposed schemas, pour que le réglage du rôle (`pgrst.db_schemas`) ne puisse pas dériver.
5. **Délai** : tout cela avant le 2026-10-26 (7 jours après le 2026-10-19), sinon le projet Supabase Free se met en pause. `health.yml` ne peut le garder éveillé qu'une fois que la production sert ce build avec la clé.

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
