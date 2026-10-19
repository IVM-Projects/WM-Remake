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
