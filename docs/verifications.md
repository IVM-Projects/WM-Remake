# Journal des vérifications

Projet Supabase de démo « WMR » (`iggurckxmoagsajzrnwd`, org « WM Prod », eu-west-1, Postgres 17.11). Vérifications faites via le MCP Supabase (`execute_sql`, `apply_migration`, `get_advisors`) et, pour PostgREST, par `curl` avec la clé publiable (rôle `anon`). Complété à la Task 14.

## M0 — Task 12 : migrations, schéma exposé, conseillers

| Élément | Méthode | Résultat | Date |
|---|---|---|---|
| État initial : tables | `list_tables` (schémas `public`, `wm`) | Aucune table ; schéma `wm` absent | 2026-10-19 |
| État initial : migrations | `list_migrations` | Aucune migration | 2026-10-19 |
| État initial : déclencheurs d'événement | `select … from pg_event_trigger` | 7 : `issue_graphql_placeholder`, `pgrst_ddl_watch`, `pgrst_drop_watch`, `issue_pg_cron_access`, `issue_pg_net_access`, `issue_pg_graphql_access`, `ensure_rls` → `public.rls_auto_enable()` (option « RLS automatique » : active la RLS sur toute nouvelle table de `public` seulement ; sans effet sur nos migrations, qui l'activent déjà) | 2026-10-19 |
| État initial : droits par défaut | `select … from pg_default_acl` | Tables créées par `postgres` dans `public` : `anon`, `authenticated`, `service_role` reçoivent `Dxtm` (truncate, references, trigger, maintain) ; fonctions : `postgres` seul ; rien pour `postgres` dans `wm`. Le `revoke all` de `0002` retire ces `Dxtm` (vérifié plus bas) | 2026-10-19 |
| État initial : `authenticator` | `pg_roles.rolconfig` | `session_preload_libraries=supautils, safeupdate`, `statement_timeout=8s`, `lock_timeout=8s` ; pas de `pgrst.db_schemas` | 2026-10-19 |
| Migration `0001_mirror_core` | `apply_migration` (contenu exact du fichier) | Succès ; version `20261019204833` ; md5 stocké = md5 du fichier (`f3bc072e…`) | 2026-10-19 |
| Migration `0002_mirror_rls` | `apply_migration` (contenu exact du fichier) | Succès ; version `20261019205025` ; md5 identique (`420b68ff…`) | 2026-10-19 |
| Migration `1000_wm_core` | `apply_migration` (contenu exact du fichier) | Succès ; version `20261019205134` ; md5 identique (`6b7feac0…`) | 2026-10-19 |
| Versions de migration | `list_migrations` | Le MCP horodate les versions (`2026101920…`), elles ne reprennent pas les préfixes `0001`/`0002`/`1000` des fichiers : à aligner (`supabase migration repair`) avant tout `db push` de la CLI | 2026-10-19 |
| Exposition de `wm` à PostgREST | `alter role authenticator set pgrst.db_schemas = 'public, graphql_public, wm'; notify pgrst, 'reload config';` | Accepté (aucune erreur de droits) ; `rolconfig` contient `pgrst.db_schemas=public, graphql_public, wm` | 2026-10-19 |
| Exposition vue de PostgREST | `curl` `POST /rest/v1/rpc/health`, `Content-Profile: nope` (témoin) | 406 `PGRST106`, indice « Only the following schemas are exposed: public, graphql_public, wm » | 2026-10-19 |
| Cache de schéma | `curl` `Content-Profile: wm` avant/après `notify pgrst, 'reload schema'` | Avant : 404 `PGRST202` (fonction absente du cache) ; après : 401 `42501` « permission denied for schema wm » pour `anon` (attendu). `reload config` seul ne suffit pas, il faut aussi `reload schema` | 2026-10-19 |
| Droits clés | `has_table_privilege('authenticated','public.tags','insert')`, `has_table_privilege('anon','public.cards','select')`, `has_function_privilege('authenticated','wm.health()','execute')`, `has_function_privilege('service_role','wm.health()','execute')` | `t, f, f, t` (attendu `t, f, f, t`) | 2026-10-19 |
| Droits de colonne et de schéma | `has_column_privilege('authenticated','public.user_cards','count'/'starred','update')`, `has_schema_privilege('anon'/'authenticated','wm','usage')` | `f, t, f, f` (attendu `f, t, f, f`) | 2026-10-19 |
| RLS de `public` | `pg_class.relrowsecurity` (`relkind = 'r'`) | `true` pour les 6 tables (`cards`, `profiles`, `tags`, `user_card_tags`, `user_cards`, `wishlist_items`) ; 11 politiques | 2026-10-19 |
| ACL effectives | `relacl`, `attacl`, `proacl`, `nspacl` | `public` : `postgres` et `service_role` tout, `authenticated` `r` (profiles, cards, user_cards) ou `ard` (tags, user_card_tags, wishlist_items), colonnes `user_cards.starred`, `tags.name`, `tags.color` en `w` ; aucun droit `anon`. `wm` : schéma `postgres`/`service_role=U` ; tables `postgres` seul ; 7 fonctions `security definer`, `search_path=""`, `EXECUTE` à `postgres` et `service_role` seuls | 2026-10-19 |
| Conseiller sécurité | `get_advisors` `security` | Aucune `ERROR`. 2 `WARN` (0028, 0029) sur `public.rls_auto_enable()` — voir ci-dessous | 2026-10-19 |
| Conseiller performance | `get_advisors` `performance` | Aucune `ERROR`, aucun `WARN`. 2 `INFO` « unindexed foreign keys », 6 `INFO` « unused index » — voir ci-dessous | 2026-10-19 |

### Alertes des conseillers

| Alerte | Niveau | Objet | Décision |
|---|---|---|---|
| 0028 `anon_security_definer_function_executable` | WARN | `public.rls_auto_enable()` | Acceptée : fonction de Supabase (option « RLS automatique »), pas la nôtre. Retour `event_trigger` : l'appel `POST /rest/v1/rpc/rls_auto_enable` échoue (400 `0A000` « cannot display a value of type event_trigger »), elle n'agit que dans un déclencheur d'événement. Hygiène possible plus tard : `revoke execute … from public, anon, authenticated` |
| 0029 `authenticated_security_definer_function_executable` | WARN | `public.rls_auto_enable()` | Idem 0028 |
| 0001 `unindexed_foreign_keys` | INFO | `wm.sanctions.user_id` | À corriger plus tard : `wm.actor()` filtre `sanctions` par `user_id` à chaque écriture ; index à ajouter par une migration (TDD) avant que la table grossisse |
| 0001 `unindexed_foreign_keys` | INFO | `public.wishlist_items.card_id` (2ᵉ colonne de la clé primaire) | Acceptée pour M0 : ne sert qu'à la suppression d'une carte (rare) ; à revoir avec le domaine des souhaits (D§9.4) |
| 0005 `unused_index` (×6) | INFO | `profiles_avatar_user_card_id_idx`, `user_cards_user_id_idx`, `user_cards_card_id_idx`, `user_card_tags_tag_id_idx`, `tags_user_id_idx`, `wb_ledger_user_id_created_at_idx` | Acceptée : base vide, aucun trafic ; index de clés étrangères voulus |

## M0 — Task 13 : déploiement Vercel protégé

Projet Vercel `wmr` (`prj_bNmEEgvcwM6Mhb8jC8QWNUbLukiz`, équipe IVM `team_nXdYy8ZVSzoNaYlzG7a1whey`). Vérifications via le MCP Vercel (`get_project`, `list_project_domains`, `list_deployments`, `get_deployment`, `filter_project_envs`, `create_project_env`, `get_runtime_logs`, `web_fetch_vercel_url`, qui traverse la Vercel Authentication et suit les redirections) et `curl` sans contournement.

| Élément | Méthode | Résultat | Date |
|---|---|---|---|
| Projet | `get_project` | Framework `nextjs`, Node `24.x` ; Vercel Authentication `all_except_custom_domains` ; mot de passe Vercel et IP de confiance inactifs. La réponse du MCP n'expose pas le champ `link` | 2026-10-19 |
| Dépôt lié | `get_deployment` (`withGitRepoInfo`), `list_deployments` | `source: git`, `githubOrg: IVM-Projects`, `githubRepo: WM-Remake` (GitHub signale que `wm-remake` a été renommé `WM-Remake` ; le push par l'ancien nom passe par la redirection). Les commits de notre branche se déploient sans refus (C32 sans objet) | 2026-10-19 |
| Branche de production | `list_deployments` (`target: production`), domaines du projet | `main` : seul déploiement de production = `main` 3202f30 « first commit » (`dpl_97xDo3sUpwE977kxrgWGwRUMxYvT`), alias `wmr-git-main-ivm-projects.vercel.app`. Notre flux (PR vers `develop`) ne met donc pas à jour la production tant que `main` ne reçoit pas le code | 2026-10-19 |
| Domaine de démo | `list_project_domains` | `wmr-ivm.vercel.app`, vérifié, sans `gitBranch` (suit la production) | 2026-10-19 |
| Région | `vercel.json` `{ "regions": ["dub1"] }` | Déploiement 84d2085 : `regions: ["dub1"]` (les précédents étaient en `iad1`) ; `x-vercel-id` de `/api/health` : `iad1::dub1::…` (fonction exécutée à Dublin) | 2026-10-19 |
| Variables d'environnement | `filter_project_envs` puis `create_project_env` (production + preview) | Aucune variable avant. Créées : `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (clé `sb_publishable_…`), type `encrypted` ; `DEMO_GATE_PASSWORD`, `GATE_COOKIE_SECRET`, type `sensitive`. `NEXT_PUBLIC_BRAND_NAME` non défini (marque `WikiCartes`). `SUPABASE_SECRET_KEY` absente : étape humaine | 2026-10-19 |
| Déploiement preview | push de `claude/clever-cannon-59x0dj` (84d2085) | `dpl_Eqffw7yBCPWvwRsvvUQKjNCAkFRL`, `wmr-m4689orbr-ivm-projects.vercel.app` (alias `wmr-git-claude-clever-cannon-59x0dj-ivm-projects.vercel.app`), `READY` en ~25 s | 2026-10-19 |
| Protection de la preview | `curl` sans contournement | 302 vers `vercel.com/sso-api` (Vercel Authentication active) | 2026-10-19 |
| `/api/health` (preview) | `web_fetch_vercel_url` | 500 `{"error":"Erreur interne, réessaie dans un instant.","message":"…"}`, `X-Robots-Tag: noindex, nofollow, noarchive`. Journal : `{"route":"/api/health","status":500,"ms":1,"rpc":"health","pg_code":null,"uid_hash":null}` (échec avant tout appel réseau : clé secrète absente). **En attente** de `SUPABASE_SECRET_KEY` puis d'un redéploiement ; attendu alors 200 `{"ok":true,"db":"ok",…}` | 2026-10-19 |
| `/` (preview) | `web_fetch_vercel_url` | Redirection suivie par l'outil (statut 3xx non visible) : page finale `x-matched-path: /gate`, URL rendue `gate?next=%2F` (charge RSC `"q":"?next=%2F"`), titre « Démo privée », `<html lang="fr">`, `X-Robots-Tag: noindex, nofollow, noarchive`, `<meta name="robots" content="noindex, nofollow">` | 2026-10-19 |
| `/robots.txt` (preview) | `web_fetch_vercel_url` | 200 `User-Agent: *` / `Disallow: /`, `X-Robots-Tag: noindex, nofollow, noarchive` | 2026-10-19 |
| `https://wmr-ivm.vercel.app` | `web_fetch_vercel_url` et `curl` sans contournement | Public (domaine hors Vercel Authentication) mais sert l'ancien build de production `main` « first commit » : `/` 200 « Create Next App » (`lang="en"`), `/api/health` 404. Le workflow `health.yml` (déjà sur cette URL) échouera tant que la production n'a pas notre code | 2026-10-19 |
