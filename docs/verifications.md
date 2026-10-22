# Journal des vérifications

Projet Supabase de démo « WMR » (`iggurckxmoagsajzrnwd`, org « WM Prod », eu-west-1, Postgres 17.11). Vérifications faites via le MCP Supabase (`execute_sql`, `apply_migration`, `get_advisors`) et, pour PostgREST, par `curl` avec la clé publiable (rôle `anon`). Complété aux Tasks 14 (M0), 16 (M1), 13 et 17 (M2).

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
| Branche de production | `list_deployments` (`target: production`), domaines du projet, `git ls-remote origin` | Déduite, non lue (le MCP n'expose pas le champ `link`) : `main`, d'après le seul déploiement de production (`main` 3202f30 « first commit », `dpl_97xDo3sUpwE977kxrgWGwRUMxYvT`, alias `wmr-git-main-ivm-projects.vercel.app`). **`main` n'existe plus sur GitHub** : `git ls-remote` ne montre que `develop`, `hotfix`, `master` (tous à 3202f30) et notre branche ; `main` a sans doute été renommée `master`. Étape humaine : vérifier Vercel → Settings → Git → Production Branch et la régler sur `develop` ou `master` ; tant que ce n'est pas fait, notre flux (PR vers `develop`) ne met pas à jour la production | 2026-10-19 |
| Domaine de démo | `list_project_domains` | `wmr-ivm.vercel.app`, vérifié, sans `gitBranch` (suit la production) | 2026-10-19 |
| Région | `vercel.json` `{ "regions": ["dub1"] }` | Déploiement 84d2085 : `regions: ["dub1"]` (les précédents étaient en `iad1`) ; `x-vercel-id` de `/api/health` : `iad1::dub1::…` (fonction exécutée à Dublin) | 2026-10-19 |
| Variables d'environnement | `filter_project_envs` puis `create_project_env` (production + preview) | Aucune variable avant. Créées : `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (clé `sb_publishable_…`), type `encrypted` ; `DEMO_GATE_PASSWORD`, `GATE_COOKIE_SECRET`, type `sensitive`. `NEXT_PUBLIC_BRAND_NAME` non défini (marque `WikiCartes`). `SUPABASE_SECRET_KEY` absente : étape humaine | 2026-10-19 |
| Déploiement preview | push de `claude/clever-cannon-59x0dj` (84d2085) | `dpl_Eqffw7yBCPWvwRsvvUQKjNCAkFRL`, `wmr-m4689orbr-ivm-projects.vercel.app` (alias `wmr-git-claude-clever-cannon-59x0dj-ivm-projects.vercel.app`), `READY` en ~25 s | 2026-10-19 |
| Protection de la preview | `curl` sans contournement | 302 vers `vercel.com/sso-api` (Vercel Authentication active) | 2026-10-19 |
| `/api/health` (preview) | `web_fetch_vercel_url` | 500 `{"error":"Erreur interne, réessaie dans un instant.","message":"…"}`, `X-Robots-Tag: noindex, nofollow, noarchive`. Journal : `{"route":"/api/health","status":500,"ms":1,"rpc":"health","pg_code":null,"uid_hash":null}` (échec avant tout appel réseau : clé secrète absente). **En attente** de `SUPABASE_SECRET_KEY` puis d'un redéploiement ; attendu alors 200 `{"ok":true,"db":"ok",…}` | 2026-10-19 |
| `/` (preview) | `web_fetch_vercel_url` | Redirection suivie par l'outil (statut 3xx non visible) : page finale `x-matched-path: /gate`, URL rendue `gate?next=%2F` (charge RSC `"q":"?next=%2F"`), titre « Démo privée », `<html lang="fr">`, `X-Robots-Tag: noindex, nofollow, noarchive`, `<meta name="robots" content="noindex, nofollow">` | 2026-10-19 |
| `/robots.txt` (preview) | `web_fetch_vercel_url` | 200 `User-Agent: *` / `Disallow: /`, `X-Robots-Tag: noindex, nofollow, noarchive` | 2026-10-19 |
| `https://wmr-ivm.vercel.app` | `web_fetch_vercel_url` et `curl` sans contournement | Public (domaine hors Vercel Authentication) mais sert l'ancien build de production (`main` 3202f30 « first commit ») : `/` 200 « Create Next App » (`lang="en"`), `/api/health` 404. Le workflow `health.yml` (déjà sur cette URL) échouera tant que la production n'a pas notre code | 2026-10-19 |

## M0 — Task 14 : vérifications du design (D§13)

Lectures dans `node_modules/` (versions installées par `npm ci`), MCP Vercel `search_vercel_documentation` (complété par les pages `.md` des mêmes URL, lues par `curl`, car les extraits renvoyés par la recherche n'incluent pas les tableaux de limites), `git ls-remote`, `npm view`, API de Docker Hub, MCP GitHub (`actions_get`) et MCP Graphify.

| Élément | Méthode | Résultat | Date |
|---|---|---|---|
| Next installé | `node_modules/next/package.json` | `16.4.2` | 2026-10-19 |
| `proxy.ts` : export et runtime | `proxy.ts` ; guide `dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` (§ Runtime, historique) ; suite de contrat (Task 9) ; CI run 39309760344 | Export nommé `proxy` (fonction `async`) plus `config` (matcher). Runtime Node.js par défaut depuis v16.0.0 ; l'option `runtime` est interdite dans ce fichier (erreur). Comportement prouvé : run 39309760344 `success` (contrat 11/11, e2e 22/22, PG17) et preview Vercel `dub1` derrière la porte (Task 13) | 2026-10-19 |
| `cacheComponents` | `next.config.ts` ; guide `01-getting-started/08-caching.md` | `cacheComponents: true` et `partialPrefetching: true` (laisser ce dernier non défini affiche un avertissement). Avec Cache Components, les route handlers `GET` suivent le modèle de prérendu des pages | 2026-10-19 |
| `'use cache: remote'` | guide `03-api-reference/01-directives/use-cache-remote.md`, `05-config/01-next-config-js/cacheHandlers.md`, `01-getting-started/15-route-handlers.md` | Activé par `cacheComponents` (v16.0.0). Le stockage vient de `cacheHandlers.remote`, « fourni automatiquement par l'hébergeur » ; sans configuration, `default` et `remote` sont un LRU en mémoire (donc en mémoire en local et en CI). Les entrées ne survivent pas à un déploiement (clé = `buildId` ou `deploymentId`). Dans un route handler : **pas directement dans le corps du handler**, il faut une fonction auxiliaire (`async function getX() { 'use cache: remote'; cacheLife(…); cacheTag(…) }`) appelée par `GET`. Imbrication interdite avec `'use cache: private'` | 2026-10-19 |
| `revalidateTag` | `dist/server/web/spec-extension/revalidate.d.ts` ; guide `04-functions/revalidateTag.md` | `revalidateTag(tag: string, profile: string \| CacheLifeConfig): undefined`, avec `CacheLifeConfig = { expire?: number }`. La forme à un argument est dépréciée (se comporte comme `{ expire: 0 }`). `updateTag(tag)` : Server Actions seulement. C16 (`revalidateTag('catalog', 'max')`) est conforme | 2026-10-19 |
| Vercel : WAF Rate Limiting (règle `rate_limit`) | MCP `search_vercel_documentation` ; page « WAF Rate Limiting » (https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting) | « Available on all plans ». Hobby : **1 règle de rate limit par projet** (3 règles personnalisées au total), algorithme fenêtre fixe, fenêtre de 10 s à 10 min, clés IP et JA4, 1 000 000 requêtes autorisées incluses. Compteurs par région | 2026-10-19 |
| Vercel : `@vercel/firewall` `checkRateLimit` | MCP `search_vercel_documentation` (page « Rate Limiting SDK », https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting-sdk) ; `npm view @vercel/firewall version` | `checkRateLimit(id, { request, rateLimitKey? })` → `{ rateLimited }` ; exige une règle WAF dont la condition est `@vercel/firewall` avec un identifiant de limite ; clé par défaut : IP du client. Paquet `1.2.6` sur npm. Sur Hobby, elle consomme l'unique règle de rate limit : C17 tient (les compteurs en base font autorité, le WAF reste un bonus). Paquet non ajouté au M0 | 2026-10-19 |
| Vercel : Runtime Cache | MCP `search_vercel_documentation` ; page « Runtime Cache » (https://vercel.com/docs/caching/runtime-cache) | « Available on all plans ». Sur Vercel, `'use cache: remote'` écrit dans le Runtime Cache (exemple officiel dans un `GET` de route handler via une fonction auxiliaire). Régional, éphémère, éviction LRU ; entrée ≤ 2 Mo, 128 tags, 256 octets par tag ; production et preview séparées. Hobby : **un seul cache partagé par tous les projets de l'équipe** ; purges par tag (`revalidateTag`, `updateTag`, `revalidatePath`…) limitées à 50 appels/s par équipe (429 + `retry-after`). Usage facturé (tarifs régionaux) ; volume inclus sur Hobby non lu | 2026-10-19 |
| Image OmniRoute `diegosouzapw/omniroute:3.8.51` | `git ls-remote --tags https://github.com/diegosouzapw/OmniRoute` ; `npm view omniroute@3.8.51 version` ; `GET hub.docker.com/v2/repositories/diegosouzapw/omniroute/tags/3.8.51` ; `docker manifest inspect` | Tag Git `v3.8.51` présent (objet 770faa71…, commit c1e30b76… ; `v3.8.52` existe aussi). npm : `3.8.51`, `latest` = `3.8.51`. Docker Hub (API joignable depuis le bac à sable) : 200, `tag_status: active`, digest `sha256:8bd462c9f60d8eda79329cfbb6ea7ea723505fe7721beb944f3d43835409e218`, mis à jour le 2026-09-30, images `linux/amd64` et `linux/arm64`. `docker manifest inspect` refusé (« toomanyrequests », limite anonyme du registre) : tirage à confirmer en CI au M5 (`quiz-bank.yml`) | 2026-10-19 |
| Binaire PostgREST v12.2.3 et SHA-256 | `scripts/get-postgrest.sh` ; `sha256sum` de `.cache/postgrest/postgrest-v12.2.3-linux-static-x64.tar.xz` ; `postgrest --version` ; étape CI `bash scripts/get-postgrest.sh` | Épinglé : `9f71269e61ac3a940281e93ff415760f5957e430e475ba4c3889f3ede7d5527c` (3 772 512 octets) ; l'archive locale donne la même somme ; `PostgREST 12.2.3`. La CI retélécharge l'archive et la vérifie (run 39309760344 `success`). Le projet ne publie pas de somme officielle : épinglage au premier téléchargement | 2026-10-19 |
| `GRANT` explicites et exposition de `wm` | Task 12 (tableau ci-dessus) | Voir les lignes « Droits clés », « Droits de colonne et de schéma », « ACL effectives », « Exposition de `wm` à PostgREST » et « Cache de schéma » de la Task 12 ; non dupliqué ici | 2026-10-19 |
| Clés JWT asymétriques du projet | — | **Reportée au M1** : inspection de l'en-tête `alg` d'une vraie session (aucune session réelle au M0) | 2026-10-19 |
| TypeScript 5.9.3 avec `next build` | `node_modules/typescript/package.json` ; CI run 39309760344 (`typecheck`, `build:test`) ; build Vercel de la preview (Task 13) | `5.9.3` installé (le plan est passé de 6.0.3 à la version du create-next-app). `next build` passe en CI (Node 24) et sur Vercel (`dpl_Eqffw7yBCPWvwRsvvUQKjNCAkFRL` READY). Seul garde-fou de version de Next : avertissement sous 5.1.0 (`dist/lib/verify-typescript-setup.js:191`) | 2026-10-19 |
| Statut de TypeScript 7 pour Next | guides `05-config/02-typescript.md` (§ Using TypeScript 7) et `05-config/01-next-config-js/useTypeScriptCli.md` ; `dist/server/config-shared.js:263` | **Contredit la note du plan** : Next 16.4.2 prend en charge TS 7 dans `next build`. Par défaut (`experimental.useTypeScriptCli: true`), il lance le `tsc` local au lieu de l'API JS absente de TS 7. Limites : diagnostics `tsc` bruts (sans les cadres de code de Next), option expérimentale. Non testé ici ; on garde 5.9.3 au M0, le `shortcut:` des contraintes globales est à réviser | 2026-10-19 |
| Graphify : espace de travail | MCP `list_workspaces`, `list_repositories` | Espace actif « Moi » (`moi-30e114`, plan Free, rôle owner, choisi par `token_claim`). Un seul dépôt : `XBZ-E-Sport/xbz-web`, un autre projet. `remember` rattache chaque note à un dépôt : **aucune note écrite** (elle aurait atterri sur `xbz-web`). Notes prêtes dans `docs/decisions-graphify.md`. Étape humaine : ajouter le dépôt de ce projet à un espace Graphify (aucun outil MCP ne l'enregistre), puis rejouer les notes avec `remember` | 2026-10-19 |

## M1 — Task 16 : suite locale

Bac à sable, 2026-10-20, branche `claude/clever-cannon-59x0dj` (arbre du commit de passation, sur 5153b0f). Banc : PG16 jetable (`.cache/pg`), PostgREST v12.2.3, GoTrue v2.197.0 et Mailpit v1.31.0 de `scripts/get-tools.sh`, Chromium préinstallé (`PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`).

| Élément | Méthode | Résultat | Date |
|---|---|---|---|
| Lint | `npm run lint` | 0 erreur, 0 avertissement (l'avertissement `react-hooks/exhaustive-deps` de `global-client.tsx` est levé : `page` ajouté aux dépendances, sans effet puisque `query` contient déjà la page) | 2026-10-20 |
| Types | `npm run typecheck` | OK | 2026-10-20 |
| Tests unitaires | `npm test` | 21 fichiers, 236 tests | 2026-10-20 |
| Tests SQL | `npm run test:db` | 13 fichiers `ok` : 9 `.test.sql` (`00` à `24`) et 4 `.test.sh` (droits hérités, concurrence du portefeuille, des paquets et de la défausse) | 2026-10-20 |
| Build du banc | `npm run build:test` | OK | 2026-10-20 |
| Contrat HTTP | `npm run test:contract` | 82 cas | 2026-10-20 |
| E2E et axe | `npm run test:e2e` | 102 tests (2 workers, aucune relance) ; 20 passes axe sans violation *serious* ni *critical*, une seule exception connue (`nested-interactive` sur `[role=listbox] li[role=option]`, R21) ; animation réduite testée activée et désactivée | 2026-10-20 |
| Parcours complet | `e2e/journey.spec.ts` | Vert du premier coup (tout existait) ; `--repeat-each=5` : 5/5, ~4 s par passe. Inscription par le formulaire, code lu dans Mailpit, vérification anti-bot automatique du banc, 5 cartes, 5 tuiles, étiquette « départ » puis filtre : 1 tuile, défausse : solde 1 et 4 tuiles | 2026-10-20 |
| Couverture du recap | `npm run coverage:recap` | 28 routes couvertes sur 90 : toutes celles du R§3.1 au §3.4 ; les 62 manquantes relèvent du §3.5 au §3.10 (M3 à M5) | 2026-10-20 |

À prévoir au conseiller sécurité de la démo : un `WARN` 0011 `function_search_path_mutable` sur `wm_index.search_text`, sans danger (corps SQL standard `RETURN`, résolu à la création, sans `security definer` ; R14).

## M1 — Task 16 : démo en production

Projet `iggurckxmoagsajzrnwd`, 2026-10-20. Ordre suivi (R32) : base, puis variables Turnstile, puis fusion dans `develop`.

| Élément | Méthode | Résultat | Date |
|---|---|---|---|
| CI de la branche | `ci.yml` (`workflow_dispatch`) | Vert sur 5153b0f (run 11), 96dd8c7 (run 12), 18c4b68 (run 13) et la tête finale 3b2be6a (run 16). Le run 14 (d1f8474) était rouge sur une analyse axe faite pendant une transition de couleur : `expectNoSeriousViolations` attend désormais la fin des animations (3b2be6a) | 2026-10-20 |
| Migrations `0003`, `1100` | `apply_migration` (MCP) | Appliquées | 2026-10-20 |
| Migrations `1200`, `1300`, `1400` et catalogue d'essai | SQL Editor du tableau de bord (fichier unique, une transaction), « Run without RLS » | Le MCP Supabase demande une confirmation pour toute requête qui contient `DELETE` (même dans le corps d'une fonction) ; la confirmation n'arrivait pas et chaque appel expirait à 60 s sans rien appliquer. L'humain a lancé le fichier ; `rebuild_draw_pool` = 2000. Les sept tables créées sont toutes dans `wm`, schéma fermé à `anon` et `authenticated`. Historique : lignes `1200_wm_packs`, `1300_wm_collection`, `1400_wm_catalog` ajoutées à `supabase_migrations.schema_migrations` (`created_by = 'sql-editor'`) | 2026-10-20 |
| Catalogue d'essai | `select count(*) from public.cards` ; `wm.catalog_stats` | 2 000 cartes ; L 6, UR 24, SR 90, R 280, PC 600, C 1 000 ; `wm.check_invariants()` = `[]` | 2026-10-20 |
| Trigger d'inscription | `pg_trigger` sur `auth.users` | `wm_on_auth_user_created` | 2026-10-20 |
| Fonctions `wm` | `pg_proc`, `has_function_privilege`, `has_schema_privilege` | 38 fonctions, toutes `security definer`, aucune exécutable par `anon` ni `authenticated`, aucun `usage` de `wm` pour eux ; `wm_index.search_text`, `cards_title_prefix_idx`, `cards_search_trgm_idx`, `pg_trgm` et `unaccent` présents | 2026-10-20 |
| Conseiller sécurité | `get_advisors` `security` | `WARN` 0011 sur `wm_index.search_text` (prévu, R14). 0028/0029 sur `public.rls_auto_enable()` : fonction du déclencheur d'événement `ensure_rls` fourni par Supabase (RLS automatique sur `public`), elle renvoie `event_trigger` et ne peut pas être appelée en RPC ; pas la nôtre, laissée. 0029 sur `get_my_profile` et `sync_profile_packs` : les deux RPC publiques voulues (R§3.1), qui vérifient `auth.uid()`. « Leaked password protection » désactivée : réglage Auth, étape humaine facultative | 2026-10-20 |
| Cache de schéma de PostgREST | `curl` `POST /rest/v1/rpc/cards_page`, `Content-Profile: wm`, clé publiable, corps `{"p_uid": "0000…"}` | 401 `42501` « permission denied for schema wm » : fonction trouvée, refusée à `anon`. `GET /rest/v1/cards` en `anon` : 200, `content-range 0-999/2000` | 2026-10-20 |
| Variables Turnstile | `create_project_env` (Production et Preview), **avant** la fusion | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` = `1x00000000000000000000AA` (plain), `TURNSTILE_SECRET_KEY` = clé de test publique (encrypted) | 2026-10-20 |
| Fusion et déploiement | `git merge --no-ff` dans `develop` (247065d), build Vercel | `dpl_EPo32jCzs9Khpx6HYeuxHyQK8upY` READY en `dub1`, alias `wmr-ivm.vercel.app` ; aucune erreur d'exécution (`get_runtime_errors`, 1 h) | 2026-10-20 |
| `/api/health` et redirections | `curl` | `/api/health` 200 `{"db":"ok"}` ; `/signup` et `/pulls` 307 vers `/gate?next=…` ; `/api/cards` sans session 401 ; `X-Robots-Tag: noindex, nofollow, noarchive` ; `robots.txt` `Disallow: /` | 2026-10-20 |
| Porte | Playwright (Chromium) sur la production, mauvais mot de passe seulement | Reste sur `/gate?next=%2Fsignup`, « Mot de passe incorrect. », aucun cookie, aucune erreur de page | 2026-10-20 |
| Compte créé avant le trigger | `auth.users` sans `public.profiles` (inscription à 17:22 UTC sur la préversion de la branche, qui vise la même base, avant `1100` à 20:36) : `/pulls` affichait « Ton stock de paquets n'a pas pu être lu. » | Rattrapage par la règle de `wm.handle_new_user` (profil depuis `raw_user_meta_data` si consentement et pseudo valides, puis `wm.lock_user`) ; `sync_profile_packs` en `authenticated` rend 1/10, horloge démarrée ; plus aucun compte sans profil | 2026-10-20 |
| Parcours d'un étudiant, mot de passe, déconnexion | après les étapes humaines de `docs/superpowers/HANDOFF.md` | *(à faire par un étudiant)* | … |
| Clé JWT de la démo | en-tête `alg` d'une vraie session | *(après la première vraie inscription)* | … |

## M2 — Task 13 : taille du catalogue

Bac à sable, 2026-10-21, branche `claude/clever-cannon-59x0dj` (sur fd8aa9b). Banc : PG16 jetable de `scripts/db-test.sh --setup-only`, catalogue d'essai de 2 000 cartes compris (il s'annule dans les différences et sort du pool à la première finalisation). `measure` réplique 1 000 fois `catalog/fixtures/expected` (299 cartes, 181 médias) dans le stage (`page_id + k × 10^7`, titre suffixé de « (k) », URL de `_(k)`), fusionne par lots de 10 000, finalise et passe le `vacuum` du chargement, puis refait un passage « mensuel » où toutes les `pageviews` ont + 1.

```bash
eval "$(bash scripts/db-test.sh --setup-only)"
node catalog/src/cli.ts measure --db "$DATABASE_URL" --csv-dir catalog/fixtures/expected --copies 1000
bash scripts/db-test.sh --stop
```

Deux runs sur un banc neuf chacun (le second avec le code commité, qui ne relit plus la taille après le dernier `vacuum`) ; B varie avec l'autovacuum, le plus grand est retenu.

```
# run 1
base initiale : 36625484 octets
stage : 299000 lignes, base 256883788 octets
après fusion, finalisation et vacuum : base 479681612 octets, pic 724204620 octets
stage : 299000 lignes, base 699989068 octets
après fusion, finalisation et vacuum : base 711826508 octets, pic 954334284 octets
{"rows":299000,"stageBytesPerRow":737,"bytesPerCard":2259,"peakBytesPerRow":3070}
# run 2
base initiale : 36625484 octets
stage : 299000 lignes, base 256883788 octets
après fusion, finalisation et vacuum : base 480164940 octets, pic 724696140 octets
stage : 299000 lignes, base 700472396 octets
après fusion, finalisation et vacuum : base 702504012 octets, pic 954293324 octets
{"rows":299000,"stageBytesPerRow":737,"bytesPerCard":2228,"peakBytesPerRow":3070}
```

| Élément | Méthode | Résultat | Date |
|---|---|---|---|
| Durée | `time` | 2 min 34 s et 2 min 37 s | 2026-10-21 |
| Ligne de stage (S) | (taille après le stage − taille initiale) / lignes | 737 o, stage des médias compris ; 736,8 o au passage mensuel | 2026-10-21 |
| Carte après le premier chargement | (taille après `vacuum` − taille initiale) / lignes | 1 482 o (run 2 : 1 483 o) | 2026-10-21 |
| Carte après le passage mensuel (B) | même calcul après le second `vacuum` | 2 259 o (run 2 : 2 228 o), dont 776 o (744 o) de gonflement de la mise à jour complète (anciennes versions des lignes et des index : le `vacuum` rend la place sans réduire les fichiers) | 2026-10-21 |
| Pic | plus grande `SIZE_SQL` vue après le stage et après chaque lot | premier chargement : 2 300 o/ligne (run 2 : 2 302 o), stage, cartes et résultats ; passage mensuel : 3 070 o/ligne aux deux runs, le maximum, couvert par B + S retenus (3 296 o) | 2026-10-21 |
| Constantes | plus grandes mesures + 10 %, arrondies au-dessus | `BYTES_PER_CARD = 2_485`, `STAGE_BYTES_PER_ROW = 811` | 2026-10-21 |
| `base` de la démo | `SIZE_SQL` relevé par le contrôleur sur la démo (MCP) | 31 223 669 o, PostgreSQL 17.11 (banc : PG16) ; à relire avant le chargement | 2026-10-21 |
| `nFull` | total du catalogue complet | 2 773 461 (ajusté par le contrôleur si le `counts.json` du run de la Task 9 diffère). Run réel 39615766155 : 2 602 470 ; `rateFor` y donne aussi 0,045 (127 056 / 2 602 470 = 0,0488) | 2026-10-21 |
| Taux | `rateFor` | régime établi : (350e6 − base) / 2 485 = 128 280 cartes ; pic : (450e6 − base) / 3 296 = 127 056 cartes, qui limite ; 127 056 / 2 773 461 = 0,0458 → `sample_rate` = 0,045 (vaut jusqu'à `nFull` = 2 823 465) | 2026-10-21 |
| Projection de la démo | 0,045 × 2 773 461 ≈ 124 806 cartes | avec les constantes : 341,4 Mo établis, 442,6 Mo au pic ; avec les mesures brutes : 313,2 Mo établis, 318,3 Mo au pic du premier chargement, 414,4 Mo au pic d'un passage mensuel | 2026-10-21 |

## M2 — livraison

Dépôt `IVM-Projects/WM-Remake` (public, M2-R1), projet Supabase `iggurckxmoagsajzrnwd`, projet Vercel `wmr`, 2026-10-21. Ordre suivi (R32, M2-18) : secrets, migrations, fusion dans `develop`, chargement. Runs lus par le MCP GitHub et `gh run view` ; base par le MCP Supabase ; production par `curl`.

### Runs Actions et CI

| Élément | Méthode | Résultat | Date |
|---|---|---|---|
| Run `fixtures` | `catalog.yml` (`mode: fixtures`, `load: false`) sur 71d0db1, run 39571498963 | Vert en 80 min : dumps 3 min, pageviews 25 min, Cirrus 50 min, API 9 s. Artefact `fixtures-raw` (sha256 égal au condensé de l'API) → `catalog/fixtures` (commit 190804a) : 299 `page_id` (250 tirés par hachage, 10 de chacune des raretés L, UR, SR et R, 3 AdQ, 3 BA, 3 SVG), 1,9 Mo, README avec CC BY-SA 4.0 et la date de chaque source ; mois des vues 2026-09, instantané Cirrus 2026-10-18 | 2026-10-21 |
| Run de construction seule | `catalog.yml` (`mode: sample`, `sample_rate` forcé à 0,09, `load: false`) sur 7398414, run 39597929105 | dumps 3 min (12:13–12:16Z) ; pageviews 25 min ; select 1 min ; `text` 21 parts vertes sur 21, ≈ 3 min chacune, 10 en parallèle, 9 min en tout (12:42–12:51Z), gardes de Cirrus non déclenchées (ratio `incoming_links` compris) ; wikidata 47 min (12:42–13:29Z) ; commons 57 min (12:42–13:39Z, 2 requêtes en vol, M2-R8) ; `compute` lancé à 13:39Z puis **annulé** à 14:19Z : redondant, le run réel recalcule tout et n'écrit rien avant `load`, et les caches sont par branche. Valide le pipeline à 0,09 ; le chargement prend 0,045 (M2-3), et la garde aurait refusé 0,09 avant l'envoi | 2026-10-21 |
| CI de la branche | `ci.yml` (`workflow_dispatch`) | Vert sur d16e4db (39570856124), 8ff07e7 (39573186739, χ² sous `setseed` sur postgres:17), 5e29292 (39581904168), 7398414 (39597932919) et baafaf8 (39614871733, après la vague finale M2-R10). 79b46c6 (`??` → `||` et docs) n'a pas eu de run à lui : il est dans la fusion 0ac05cb | 2026-10-21 |
| CI de `develop` | `ci.yml` sur les fusions | Vert sur fa5d3c8 (39571493436, fusion précoce M2-8) et 0ac05cb (39615754311, fusion du M2) | 2026-10-21 |
| Suite locale | tête 79b46c6 | `npm test` : 39 fichiers, 379 tests ; `test:db` 17 fichiers, contrat 90 cas, E2E 127 tests (vague finale, baafaf8) | 2026-10-21 |

### Démo

Secrets posés par l'utilisateur vers 13:00Z ; migrations et contrôles de la base vers 13:25Z ; fusion à 14:18Z ; chargement lancé à 14:19Z, fini à 16:17Z ; relance d'idempotence de 16:19Z à 16:21Z.

| Élément | Méthode | Résultat | Date |
|---|---|---|---|
| Secrets | étape humaine (écrans du Step 2) | GitHub : secrets du dépôt `SUPABASE_DB_URL` et `CRON_SECRET` ; Vercel : `CRON_SECRET` (Production). Vercel a aussi reçu `SUPABASE_DB_URL` (Production), que l'app ne lit pas : retrait conseillé | 2026-10-21 |
| Propriétaire des objets `wm` | MCP, lecture seule | Schéma et fonctions `wm` à `postgres`, l'utilisateur du pooler (`postgres.<ref>`) : `EXECUTE` en propriétaire pour `psql` | 2026-10-21 |
| Migrations `1500`, `1510`, `1520` | SQL Editor, un seul fichier en une transaction (préparé depuis 315e106, répété sur une base du banc d'avant le M2 : 0 → 9 fonctions, `COMMIT`) ; `1520` y est passée aussi, au lieu du MCP prévu | 9 fonctions listées. Historique ajouté par le MCP : versions `20261021131700`, `…01`, `…02` (`created_by = 'sql-editor'`) ; note de `sample_rate` mise au texte de 1fd31c4 | 2026-10-21 |
| Configuration | `select key, value from wm.config where key in ('catalog_frozen', 'catalog_stats_frozen', 'sample_rate')` | `false`, `false`, `0.045` | 2026-10-21 |
| Invariants et pool avant chargement | `wm.check_invariants()` ; requête de densité de la Task 10 ; comptes | `[]` ; 2 000 cartes, pool 2 000 dense (min 1, max n, distinct = n = `catalog_stats.n` par rareté : C 1 000, PC 600, R 280, SR 90, UR 24, L 6) ; `card_source` 0, stage 0 ; `cards_page(null)` total 2 000 ; `pick_card` répond ; taille 31 723 381 o | 2026-10-21 |
| Cache de schéma de PostgREST | `curl` `POST /rest/v1/rpc/cards_overlay`, `cards_page_shared` et `card_credits`, `Content-Profile: wm`, clé publiable | 401 `42501` pour les trois : fonctions connues du cache, refusées à `anon` | 2026-10-21 |
| Conseiller sécurité | `get_advisors` `security` | Rien de nouveau du M2. Restent : `search_path` de `wm_index.search_text` (R14), fonctions `SECURITY DEFINER` du miroir `public` (voulues, M1), protection des mots de passe divulgués désactivée (réglage Auth) | 2026-10-21 |
| Fusion précoce (M2-8) | `git merge --no-ff` dans `develop` (fa5d3c8), build Vercel | `dpl_CkVo3qENkGkfCn2cXuCvmf1UGBNm` READY ; `/api/health` 200 (`db: ok`) ; seuls `lib/rarity.ts` et `HowItWorks.tsx` touchaient l'app | 2026-10-21 |
| Fusion du M2 | `git merge --no-ff` dans `develop` (0ac05cb, 14:18Z), après la CI verte sur baafaf8 | `dpl_6bKr6XuD1hX1C7BuVUqQJs25bVWP` READY | 2026-10-21 |
| `/api/health` et revalidation | `curl` | `/api/health` 200 ; `POST /api/cron/revalidate` sans en-tête → 401 `cron_unauthorized` (`CRON_SECRET` présent côté Vercel ; 503 voudrait dire absent) ; mauvais secret → 401 ; API des crédits et `/credits` derrière la porte (401 et 307 sans cookie de porte, voulu) | 2026-10-21 |
| Run de chargement | `catalog.yml` (`mode: sample`, `target: free`, `load: true`, `sample_rate` lu dans `wm.config` = 0,045) sur `develop` 0ac05cb, run 39615766155, lancé à 14:19Z ; dumps verts en 3 min avec le User-Agent du projet | Vert en 1 h 58 (14:19:39–16:17:33Z). `dumps` 3 min 19 s ; `pageviews` 24 min 32 s ; `select` 1 min 1 s (taux lu par `psql`) ; `text` 21 parts de 3 min environ chacune, en deux vagues (14:48–14:57Z) ; `wikidata` 27 min 57 s (2 337 lots, 0 sauté) ; `commons` 13 min 5 s (1 274 lots, 0 sauté) ; `compute` 57 min 1 s, dont ≈ 55 min de complément TextExtracts (≈ 3 210 appels, ≈ 58 par minute) ; `load` 3 min 51 s. `select` : 2 602 470 pages, 117 112 retenues (L 77, UR 534, SR 3 070, R 8 487, PC 24 940, C 80 004). `compute` : 117 112 cartes, 62 126 médias ; résumés Cirrus 52 582, TextExtracts 64 189, aucun 341 ; sur les 2 602 470 pages candidates, 250 absentes de Cirrus et 295 629 sans `incoming_links` (valeur inconnue, M2-R7) | 2026-10-21 |
| Essai `\copy` par le pooler | journal de `load` (`essai \copy : 10 lignes`) | `essai \copy : 10 lignes`, puis `stage : 117112 lignes dont 117112 nouvelles` | 2026-10-21 |
| Résumé du chargement | journal de `load` : résumé de `catalog_finalize`, taille après chaque lot, `curl` de revalidation | `inserted` 117 112, `updated` 0, `renamed` 0, `unchanged` 0, `conflicts` 0, `pool_out` 2 000 (les cartes d'essai). Taille : 31 747 957 o avant, 110 563 189 o stage plein, puis 12 lots (11 de 10 000, 1 de 7 112) jusqu'à 273 862 517 o au plus haut (≤ 450e6), 185 479 029 o après `vacuum` ; WAL 553 648 495 o en fin de chargement. Revalidation `{"revalidated":true}` | 2026-10-21 |
| Parts de rareté | `wm.catalog_stats` contre `counts.json` de `catalog-out` (`gh run download -n catalog-out`) | `wm.catalog_stats` = `selected` de `counts.json`, rareté par rareté. Parts plein / chargé : L 0,0656 / 0,0657 %, UR 0,4556 / 0,4560 %, SR 2,6214 / 2,6214 %, R 7,2467 / 7,2469 %, PC 21,2964 / 21,2959 %, C 68,3142 / 68,3141 %. Écart maximal 0,0006 point (≤ 1) ; écart relatif maximal +0,18 % (L, 77 cartes) ; `share_gap` du journal : 0,00057 point | 2026-10-21 |
| Pool et cartes d'essai | requête de densité de la Task 10 ; cartes d'essai au pool ; `count(*)` de `public.cards` ; copies du joueur de démo | Pool 117 112, dense ; 0 carte d'essai au pool ; `public.cards` 119 112 = 2 000 + 117 112 ; `card_source` 117 112. Copies : 80 (un joueur, 79 cartes distinctes, toutes sur des cartes d'essai), les mêmes avant et après. Le relevé du 2026-10-20 en comptait 18 ; d'après `obtained_at`, 64 ont été obtenues le 2026-10-21. 1 ligne de liste de souhaits, sur une carte d'essai | 2026-10-21 |
| Taille et disque | `SIZE_SQL` (MCP) ; taille du disque relevée par l'humain (**Project Settings → Database**) | 185 479 029 o (≤ 350e6 ; la projection de la Task 13 donnait 341,4 Mo pour 124 806 cartes, avec la marge de +10 %). Disque relevé par l'utilisateur (**Project Settings → Database → Disk**, après les deux chargements) : 0,85 Go utilisés sur 2 Go provisionnés (« Your plan includes up to 1 GB of gp3 storage ») ; d'après la barre, base ≈ 0,17 Go, WAL ≈ 0,52 Go, système ≈ 0,16 Go | 2026-10-21 |
| Licences | cartes du pool avec `image_url` sans ligne `wm.card_media` ; cartes du pool dont `card_media.license` est nul ; `wm.card_credits(<id d'une L avec image>)` | 0 et 0 (62 126 cartes du pool avec image, 62 126 lignes `card_media`). `card_credits` de la L « Harry Potter (série télévisée) » → `{file, image_author, image_license, license_url}`. Licences : domaine public 19 043, CC BY-SA 3.0 14 374, CC BY-SA 4.0 13 674, CC BY 3.0 2 620, CC BY-SA 2.0 2 575, CC BY 2.0 2 449, CC0 2 378, CC BY 4.0 1 538, puis les autres | 2026-10-21 |
| Idempotence | empreinte des ids (`md5(string_agg(card_id \|\| ':' \|\| page_id, ',' order by page_id))` de `wm.card_source`) et empreinte d'état (`public.cards`, `wm.card_media`, `wm.draw_pool`) avant et après une relance de `catalog.yml` avec `artifacts_run_id` = 39615766155 (job `load` seul) | Run 39633657505, `load` en 1 min 40 s : `stage : 117112 lignes dont 0 nouvelles` ; `unchanged` 117 112, `inserted` 0, `updated` 0, `pool_out` 0 ; revalidation `{"revalidated":true}`. Empreintes identiques avant et après : ids `2da03c08ca81ef9ccf7947064e6d610b` ; état `24a002b9c5214fef1a3d5f282871ac1a 7ff5a7829c1ba8117aaf7a859e192a38 7b21af271c8e57444fa4d49df8732386`. `wm.check_invariants()` = `[]` ; base 185 487 221 o | 2026-10-21 |
| χ² sur la démo (M2-11) | contenu de `supabase/tests/chi2.sql` et `select * from chi2` dans un seul `execute_sql`, sans `setseed` | 100 000 tirages : `chi2_rarity` 1,823 (5 ddl, seuil 20,515) ; `chi2_seq` 34,366 (19 ddl, seuil 43,82), α = 0,001 | 2026-10-21 |
| Vérification visuelle (Step 7) | humain, derrière la porte : `/global-collection`, modale d'une carte avec image, `/credits` | À faire par l'humain (étape humaine 7 de `HANDOFF.md`). Côté données : `cards_page_shared` sur la démo rend de vraies cartes (parcours page 0 en 46,5 ms, total 117 112 ; page 1 000 en 5,1 ms ; recherche « paris » en 106,5 ms ; filtre L et UR en 5,5 ms, 611 cartes) | … |

## M3 — Task 15 : benchs du marché en tables journalisées

Bac à sable, 2026-10-22, branche `claude/clever-cannon-59x0dj` (sur cf60a99). **Chiffres indicatifs (A5) ; le M8 mesure sur Pro.**

Méthode (M3-4, P14) :

- PG 16.15 local (`postgres` et `pgbench` 16.15 d'Ubuntu), 4 vCPU, 15 Go, ext4 sur `/dev/vda` (`pg_test_fsync` : `fdatasync` ≈ 270 µs par écriture de 8 ko) ;
- cluster de `PG_FSYNC=on bash scripts/db-test.sh --setup-only` : `fsync=on` et `synchronous_commit=on`, relevés par `run.sh`, qui refuse sinon ; vraies migrations, tables journalisées, seed de 2 000 cartes ;
- `pgbench -n -c 50 -j 4 -T 30`, 50 joueurs au solde de 10⁹ ; minimum de mise = mise + 1 (`bid_increment` à 1), rafales et limite d'enchères ouvertes ;
- `bench.bid` verrouille l'enchère, puis mise le minimum suivant ; un refus P0001 compte comme une transaction sans mise (`bench.bid` rend `false` sur tout P0001 ; on attend « Tu es déjà en tête », mais le motif n'est pas relevé) ;
- règlement : 500 vendeurs Pro × 10 enchères, chacune avec une mise, échues depuis une seconde, puis un seul `wm.settle_due_auctions(5000)` chronométré par `\timing`, pendant `pgbench -n -c 4 -T 5 -P 1` sur `wm.market_list()`, lancé 1,5 s avant le lot.

```bash
bash load/bench/run.sh
```

Deux runs, chacun sur un banc neuf. Trois runs de mise au point donnaient les mêmes ordres de grandeur (disputée 285 à 296 tps, réparties 1 232 à 1 306 tps, règlement 5 779 à 6 014 ms).

| Élément | Méthode | Résultat | Date |
|---|---|---|---|
| Mises sur l'enchère disputée | `bid_hot.sql` : les 50 clients sur la même enchère | 281,0 et 282,8 tps ; latence moyenne 177,9 et 176,8 ms ; mises réussies (Δ `bids_count`) 8 376 sur 8 390 et 8 453 sur 8 467 (99,8 %). D§9.6 : 589 mises/s, en tables `UNLOGGED` | 2026-10-22 |
| Mises réparties | `bid_spread.sql` : enchère tirée parmi 50 à chaque transaction | 1 236,0 et 1 264,8 tps ; 40,5 et 39,5 ms ; 36 102 sur 36 797 et 37 002 sur 37 648 (98,1 et 98,3 %) | 2026-10-22 |
| Repère : une mise à la fois | mesure ponctuelle, script jetable non commité : même banc, un seul client sur l'enchère disputée (miseur tiré parmi les 50), 10 s | 519 tps (1,9 ms par mise, `commit` compris) : la file de 50 clients sur une ligne coûte près de la moitié. Aucune mise à jour de `auctions` n'est HOT (0 sur 5 076) : `current_bid` est dans l'index de prix, et chaque mise écrit dans les 9 index de la table, GIN trigramme compris | 2026-10-22 |
| Règlement de 5 000 enchères | `settle.sql`, un seul lot | 6 145 et 5 969 ms, soit ≈ 1,2 ms par enchère. Contrôles verts : 5 000 `settled_sold`, 10 000 notifications (`auction_won` et `auction_sold` comptées ensemble), 5 000 copies neuves chez les gagnants. La ventilation, 5 000 `auction_won` et 5 000 `auction_sold`, n'a été vérifiée qu'au run du tour de correction (6 121,5 ms). D§9.6 : 5 000 en 97 ms, en `UNLOGGED`, sans copie ni notification | 2026-10-22 |
| Linéarité du règlement | mesure ponctuelle, script jetable non commité : même préparation, sans les benchs de mise, puis 10 `settle_due_auctions(500)` successifs (le lot du cron, C14) | 541 à 603 ms chacun : linéaire, et un lot du cron tient en ≈ 0,6 s sur ses 10 s. Temps propre par fonction (`track_functions = 'all'`, un lot de 1 000 en 1 014 ms) : `sync_rarity_counts` 225 ms, `notification_data` 207, `escrow_release` 125, `settle_auction` 124, `wallet_apply` 120, `notify_auction` 105, `lock_users` 88 ; aucun point chaud | 2026-10-22 |
| Lectures pendant le règlement (P9) | `read.sql` (4 clients), latence seconde par seconde (`--progress-timestamp`) | Seconde d'avant le lot : 9,7 et 9,9 ms (390 et 384 lectures/s). Pendant : 10,9 → 15,2 → 20,5 → 24,8 ms et 10,5 → 15,4 → 18,4 → 25,2 ms (jusqu'à 161 et 158 lectures/s). Hausse progressive au fil du lot, sans attente ni erreur. Cause non isolée : les instantanés débordés de P9 (au-delà de 64 sous-transactions) ou la concurrence CPU sur 4 vCPU (le lot, 4 lecteurs et pgbench). Les lectures (5 s) finissent avant le lot (6 s) | 2026-10-22 |
| Interblocages et invariants | `pg_stat_database.deadlocks` avant et après ; `wm.check_invariants()` | 0 interblocage et `[]` aux deux runs ; aucune transaction en échec dans pgbench | 2026-10-22 |
| Risque pour le M8 | durée du lot de 5 000 contre `lock_timeout` | Un lot de rattrapage de 5 000 enchères (appel manuel, ou limite du cron relevée au M8) tient les verrous des joueurs du lot ≈ 6 s, plus que les 2 s de `lock_timeout` d'une mise : ces joueurs recevraient un 503 `BUSY` pendant ce temps. Le cron règle par 500 (≈ 0,6 s) : sans effet aujourd'hui, à reprendre au M8 | 2026-10-22 |

## M3 — livraison

Répétition et CI le 2026-10-22 avant 08:05Z ; fichier lancé par l'utilisateur vers 08:09Z (premier run de `wm-settle` à 08:09:49Z) ; fusion à 08:11Z. Benchs : section « M3 — Task 15 » ci-dessus.

| Élément | Méthode | Résultat | Date |
|---|---|---|---|
| Répétition de `deploy-m3.sql` | fichier produit par concaténation (`begin`, `lock_timeout` 5 s, `0004`, `1600`…`1650`, `9000`, historique, `notify`, `commit`) depuis 8d66a5d ; base du banc montée depuis un worktree de `develop` (`0001`–`1520` + seed), `supabase_migrations` de remplacement | 1re passe `COMMIT` ; 2e passe `COMMIT` (NOTICE « already exists » seulement) ; `27_market.test.sql` de la branche vert contre la base répétée ; `check_invariants()` `[]` ; `market_list()` `{auctions: [], hasMore: false, total: 0}` ; `health()` `settle_lag_s` et `overdue_s` nuls ; historique `0004`…`1650` inscrit, `9000` absent sans pg_cron ; empreinte `md5` des fonctions `wm` identique à une base de la branche (`a4ad7232…`) | 2026-10-22 |
| Script M2-12 avec le marché | copies de la base répétée : avant le M3, puis après le M3 avec une enchère active avec mise, une sans mise et une réglée | Avant : 2 000 → 0 carte, relance sans effet. Après : enchères réglées (vendeur payé, copies rendues ou livrées), puis enchères, notifications, séquestre, file et copies supprimés ; invariants `[]` ; relance sans effet | 2026-10-22 |
| CI sur postgres:17 | `ci.yml` en `workflow_dispatch` sur c6467b7 (run 39744063469) | `checks` vert (34 s), `integration` vert (6 min 19 s) : migrations du M3, `test:db`, contrat et E2E sur PG17 | 2026-10-22 |
| Relevés d'avant le déploiement | MCP (07:05Z) | Base 185 732 981 o ; WAL 167 772 526 o ; aucun slot de réplication ; pg_cron 1.6.4 disponible et préchargé (`shared_preload_libraries`), non créé ; `postgres` non superutilisateur mais membre de `pg_read_all_settings` | 2026-10-22 |
| Migrations du M3 | SQL Editor, `deploy-m3.sql` par l'utilisateur | « Success. No rows returned ». Historique `20261022120000`…`07` (`9000` compris, pg_cron présent), `created_by = 'sql-editor'` | 2026-10-22 |
| pg_cron et jobs | `select jobname, schedule, command, active from cron.job` | pg_cron 1.6.4 ; `wm-settle` (10 s, `settle_due_auctions(500)`), `wm-wishlist-alerts` (10 s, `wishlist_alerts_fanout(5000)`), `wm-purge` (`7 * * * *`), `wm-cron-history` (`17 * * * *`), tous actifs | 2026-10-22 |
| Premiers runs | `cron.job_run_details` à 08:11Z | `wm-settle` : 8 runs `succeeded` en 80 s, 0 échec, durée max 22,6 ms, écart max 10,04 s ; `wm-wishlist-alerts` : idem | 2026-10-22 |
| Santé et invariants | `wm.health()`, `wm.check_invariants()`, `wm.market_list()` | `settle_lag_s` 4, `overdue_s` nul ; `[]` ; liste vide | 2026-10-22 |
| Droits | `information_schema.role_table_grants` (anon, authenticated) sur `auctions`, `auction_bids`, `notifications` ; `pg_proc` de `wm` | `authenticated` `SELECT` ×3, rien d'autre ; 74 fonctions `wm`, toutes `security definer` avec `search_path` vide, aucune exécutable par `anon` ni `authenticated`, aucun `usage` de `wm` | 2026-10-22 |
| Cache de schéma de PostgREST | `curl`, clé publiable : `POST /rest/v1/rpc/market_list` (`Content-Profile: wm`), `GET /rest/v1/auctions`, `auction_bids`, `notifications` | 401 `42501` pour les quatre (aucun 404 `PGRST202` ni `PGRST205`) | 2026-10-22 |
| Conseillers | `get_advisors` `security` et `performance` | Sécurité : rien de nouveau (0011 sur `wm_index.search_text`, 0028/0029 sur `rls_auto_enable` et les fonctions du miroir, mots de passe divulgués : connus). Performance : INFO « unindexed foreign keys » sur `wishlist_alert_queue.auction_id` (prévue) ; index neufs encore inutilisés | 2026-10-22 |
| Suppression des cartes d'essai (M2-12) | SQL Editor, `m2-12-delete-seed.sql` par l'utilisateur, après le déploiement | `cards` 117 112, `sourced` 117 112, `copies` 150, `wishlist` 1, invariants `[]` | 2026-10-22 |
| Fusion du M3 | `git merge --no-ff` de c6467b7 dans `develop` (36646a5) | `dpl_AtktHPnjNy6pUfUjQFcMG2h4cdzW` READY en 44 s ; `/api/health` 200 (`settle_lag_s` 8, `overdue_s` nul) ; `health.yml` vert (run 39746301002) ; aucune erreur d'exécution sur 1 h | 2026-10-22 |
| Délai de règlement, relevé intermédiaire | `cron.job_run_details` de `wm-settle` de 08:09:49Z à 08:36:45Z (27 min) ; `public.auctions` | 162 runs, 0 échec ; p99 de l'écart entre deux départs 10,316 s (max 10,363 s) ; p99 de la durée 0,045 s (max 0,112 s, le run qui a réglé) : borne du cron seul 10,36 s < 15 s. Vente réelle du joueur de démo (10 min, sans mise) : fin 08:28:59,358Z, réglée `settled_unsold` à 08:29:03,858Z par le run `wm-settle` de 08:29:03,839Z, soit 4,50 s après l'échéance ; invariants `[]` | 2026-10-22 |
| Délai de règlement, relevé final | `cron.job_run_details` de `wm-settle` de 08:09:49Z à 09:29:06Z (1 h 19) ; `public.auctions` | 475 runs, 0 échec ; p99 de l'écart entre deux départs 10,305 s (max 10,363 s) ; p99 de la durée 0,071 s (max 0,149 s) : borne du cron seul 10,38 s < 15 s. Deux ventes réelles du joueur de démo, réglées toutes deux par le cron : l'invendue en 4,50 s, la vendue (une mise, 80 wikibidous) en 2,60 s après l'échéance, par le run de 08:45:27,526Z ; invariants `[]` | 2026-10-22 |
| Jobs horaires | `cron.job_run_details` de `wm-purge` et `wm-cron-history` | `wm-cron-history` 08:17Z et 09:17Z `succeeded`, `wm-purge` 09:07Z `succeeded` | 2026-10-22 |
| Taille et WAL à +80 min | `SIZE_SQL`, `pg_ls_waldir()`, `pg_total_relation_size('cron.job_run_details')`, `pg_replication_slots` (09:29Z) | Base 186 961 781 o (+1,2 Mo depuis 07:05Z) ; WAL 134 218 094 o ; historique du cron 221 184 o pour 953 lignes ; aucun slot | 2026-10-22 |
