# Passation entre sessions

> À lire en premier par toute nouvelle session Claude sur ce dépôt.

## Où on en est (2026-10-19)

- **Validé par l'utilisateur** : le récap REA (`docs/rea-recap.md`), le design (`docs/superpowers/specs/2026-10-18-wikimasters-rebuild-design.md`) et le plan du jalon M0 (`docs/superpowers/plans/2026-10-19-m0-fondations.md`).
- **Méthode d'exécution choisie** : `superpowers:subagent-driven-development` (un implémenteur neuf par tâche, puis un relecteur, puis une revue de toute la branche).
- **Rien n'est encore construit** : aucun code d'app, aucune ressource Vercel, aucune migration appliquée.
- **Branche de travail** : `claude/clever-cannon-59x0dj`.

## Changement de comptes demandé par l'utilisateur

Avant de lancer M0, l'utilisateur connecte de **nouveaux comptes** GitHub, Supabase et Vercel. Les identifiants cités dans le design et le plan sont ceux de **l'ancien** compte et doivent être remplacés :

| Élément | Ancien (ne plus utiliser) | Nouveau |
|---|---|---|
| Organisation et projet Supabase | org `xwlidrqbodwlulipmcym` (XBZ), projet `vlazmfshvuborizccqza` | à découvrir (MCP `list_organizations`) ; créer le projet `WikiMaster`, région `eu-west-3`, plan Free |
| Équipe Vercel | `team_EdDmARh6VZ9afHMb1WTeywEN` (XBZ) | à découvrir (MCP `list_teams`) |
| Dépôt GitHub | `ilan9903/wikimaster` | inchangé, sauf si l'utilisateur l'a transféré |

## Première étape de la nouvelle session

1. Vérifier les connecteurs : Supabase (`list_organizations`, `list_projects`), Vercel (`list_teams`), accès GitHub au dépôt (push sur la branche de travail).
2. Créer le projet Supabase dans la nouvelle organisation (plan Free, `eu-west-3`) après confirmation du coût nul par le MCP.
3. Remplacer les anciens identifiants dans le design (§3.2, §4.1 point 7, §12.2) et dans le plan (Tasks 12 et 13) ; commit.
4. Exécuter le plan M0 avec `superpowers:subagent-driven-development`.

## Rappels pour l'exécution

- Choix du modèle de chaque sous-agent selon le skill `model-routing` (silencieusement) : code, architecture, revue → Opus ; tâches mécaniques sans ambiguïté → Haiku.
- Réseau du bac à sable : wiki-masters.com, Wikimedia, Stripe, Brevo et l'hôte Postgres Supabase sont bloqués ; Supabase passe par son MCP. Voir le design §3.3.
- Étapes humaines prévues au M0 (à demander au bon moment) : copier la clé secrète Supabase (`sb_secret_…`) dans Vercel ; ajouter le dépôt à l'espace Graphify ; exposer le schéma `wm` dans Supabase si la commande SQL ne suffit pas (plan, Task 12).
- Les décisions de l'utilisateur sont listées au design §4.1 (vente à Naïm, plan B, plans gratuits pendant la construction puis Supabase Pro environ un mois autour du pitch, démo privée, aucune capture de session connectée sur wiki-masters.com sans son accord).
