# M2 — Catalogue réel : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construire le catalogue de cartes depuis les dumps et les API Wikimedia dans GitHub Actions (`catalog.yml`, modes `fixtures`, `sample` et `full`), le fusionner dans la base sans jamais changer un id ni supprimer une carte (`wm.catalog_merge`, pool par *swap-with-last*), mettre en cache les pages partagées de `/api/cards`, et afficher l'auteur et la licence de chaque image. La démo Free reçoit un échantillon proportionnel chargé depuis Actions.

**Architecture:** Le pipeline est un ensemble de modules TypeScript sans dépendance (`catalog/src/*.ts`), lancés par `node catalog/src/cli.ts <commande>` grâce à l'effacement de types natif. Chaque job de `catalog.yml` lit en flux une source Wikimedia et écrit un TSV en artefact. Le job `load` copie `cards.csv` et `media.csv` dans `wm.catalog_stage` par `psql` (pooler en mode session), boucle sur `wm.catalog_merge` par lots, puis appelle `wm.catalog_finalize` et `POST /api/cron/revalidate`. Côté app, `/api/cards` sépare une partie partagée (`'use cache: remote'`, tag `catalog`) d'un overlay par joueur, et la modale lit les crédits de l'image dans `wm.card_media` par `/api/cards/{id}/credits`. Le bac à sable n'atteint pas Wikimedia : tous les tests tournent sur des échantillons écrits à la main, puis sur des tranches réelles produites une fois par Actions et commitées.

**Tech Stack:** celle du M1 (next 16.4.2, react 19.3.1, @supabase/supabase-js 2.118.0, zod 4.6.7, vitest 5.0.5, @playwright/test 1.64.1, @axe-core/playwright 4.14.0, PostgREST v12.2.3, GoTrue v2.197.0, Mailpit v1.31.0). Pipeline : Node 24 dans Actions (22.22 dans le bac à sable), `node:zlib`, `node:crypto`, `node:util` `parseArgs`, `psql` 16 du runner, `lbzip2` (apt). Aucune dépendance npm ajoutée.

**Spec:** `docs/superpowers/specs/2026-10-18-wikimasters-rebuild-design.md` (cité D§x), surtout D§10, §7.2, §7.4, §9.5, §6 ; `docs/rea-recap.md` (R§x). Jalon : D§13 ligne M2. Faits relevés : `.superpowers/sdd/2026-10-21-m2-catalogue-reel/notes-*.md` (non versionnés, résumés ici quand ils fixent une valeur).

## Global Constraints

- Toutes les contraintes globales des plans M0 et M1 restent en vigueur :
  - versions exactes ;
  - lire le guide de `node_modules/next/dist/docs/` avant de toucher une API Next (`AGENTS.md`) : `01-app/03-api-reference/01-directives/use-cache-remote.md`, `04-functions/cacheTag.md`, `cacheLife.md`, `revalidateTag.md` ;
  - fonctions `wm.*` en `security definer`, `set search_path = ''`, `EXECUTE` à `service_role` seul, et chaque migration `wm` finit par le couple `revoke`/`grant` de `1400_wm_catalog.sql:76-80` (scan de `10_wm_core.test.sql`) ;
  - migrations idempotentes, expand-only, compatibles PG16 et PG17, sans `MERGE … RETURNING` ;
  - chaînes d'erreur exactes du D§8.2, `error` = `message` ; aucune PII dans les logs ;
  - « tu » dans le jeu, « vous » dans les pages légales (dont `/credits`) ; thème sombre ; ports du banc du M1 ; aucun chemin de code réservé aux tests (seulement la configuration) ;
  - formes JSON : clés en plus permises, jamais de clé retirée ; le contrat de `/api/cards` ne change pas.
- **Pipeline TypeScript** : syntaxe effaçable seulement (ni `enum`, ni `namespace`, ni propriétés de paramètres) ; `import type` pour tout import de type ; imports relatifs avec l'extension `.ts`, jamais d'alias `@/` (comme `contract/`) ; aucun `npm ci` dans `catalog.yml`. Le seul import hors de `catalog/` est `lib/rarity.ts`, qui reste sans import.
- **Fichiers intermédiaires** : TSV sans en-tête, échappements `\\`, `\t`, `\n`, `\r`, `null` écrit `\N` (`catalog/src/tsv.ts`). Les titres y gardent les `_` du dump ; seul `emit` écrit les espaces. Sorties finales en CSV RFC 4180 lisibles par `\copy … with (format csv, header true)` (`null` = champ vide non guillemeté).
- **Valeurs déterministes** : deux exécutions sur les mêmes entrées produisent les mêmes octets. `pageviews_refreshed_at` = 1er jour du mois suivant la fenêtre à `00:00:00Z` ; `qscore_refreshed_at` = date de l'instantané Cirrus à `00:00:00Z`. Jamais `now()` dans les CSV.
- **Étiquette Wikimedia** (D§10.2, corrigée par M2-6) : User-Agent exact `WikiMastersCatalog/1.0 (https://github.com/IVM-Projects/wm-remake) node/24`, `Accept-Encoding: gzip`, 3 requêtes en vol au plus, 200 démarrages par minute au plus, `maxlag=5`, `Retry-After` respecté. Lots : 50 ids pour `wbgetentities`, 50 fichiers pour `imageinfo`, 20 pages pour TextExtracts.
- **Base** : jamais de `delete` sur `public.cards` ; tout `DELETE`/`UPDATE` garde un `WHERE` (`where true` pour vider, pg-safeupdate), contrôlé par `scripts/check-dml.ts` dès la Task 8. Plan Free : 500 Mo ; garde du chargement à `450e6` octets, cible de la démo `≤ 350e6` (M2-3).
- **Actions** : `persist-credentials: false` sur chaque `actions/checkout` ; budget 2 000 min/mois, 6 h par job ; artefacts intermédiaires `retention-days: 3`, `catalog-out` 7 jours. Les secrets `SUPABASE_DB_URL` et `CRON_SECRET` ne sont jamais imprimés.
- **Textes de licence exacts** : « Texte de l'article : CC BY-SA 4.0 — crédits sur la page Wikipédia. » (inchangé) ; « Projet indépendant de la Fondation Wikimedia » (D§10.6).

## Décisions (contrôleur, à consigner dans `docs/decisions-graphify.md`, Task 15)

- **M2-1. Échantillon par quota exact par rareté.** Dans chaque rareté, les pages sont classées par un hachage stable du `page_id` (FNV-1a 32 bits sur la chaîne décimale, implémenté dans `catalog/src/compute.ts`), et on garde les `round(rate × n_r)` premières (au moins 1 si `n_r > 0`). « ± 1 % » est lu **en points de part** et tenu par construction : l'écart relatif par rareté est ≤ 1 / n_r. Un hachage simple sous un seuil ferait varier les L d'environ 7,6 % relatif. Coût si faux : une fonction de sélection.
- **M2-2. `pct()` sur le catalogue complet**, calculé dans Actions avant l'échantillonnage : les statistiques d'une carte (ATK, DEF, Q-Score) ne dépendent pas du mode, et un passage `full` ultérieur donne les mêmes valeurs. Rang percentile = (rang − 1) / (n − 1) avec ex æquo au rang moyen ; n = 1 → 0,5. Coût si faux : une ligne de calcul.
- **M2-3. Taux d'échantillon mesuré, pas supposé.** Le design annonce ≈ 0,25 Go pour 9 % ; une estimation par carte donne 400 à 650 Mo, au-delà des 500 Mo du plan Free (passage en lecture seule, SQLSTATE 25006). Une tâche mesure les octets par carte sur le banc après chargement des fixtures (tas + index + `draw_pool` + `card_source` + `card_media`), en déduit le taux qui garde la base de démo **≤ 350 Mo**, et l'inscrit comme défaut de `catalog.yml` (`sample_rate`). Le job `load` refuse de charger si `taille actuelle + projection > 450 Mo` et `target != pro`. Si le taux retenu est < 9 %, l'écart à C9 est consigné (décision du §4.2 changée par les faits, §14). Coût si faux : une base en lecture seule, d'où la garde.
- **M2-4. Badge AdQ/BA par `page_props`** (`wikibase-badge-Q17437796` = AdQ → 1, `wikibase-badge-Q17437798` = BA → 0,6), pas par les modèles de Cirrus. Cirrus ne sert qu'à `text_bytes`, `incoming_links` et `opening_text`. Coût si faux : un parseur de modèles.
- **M2-5. Cirrus lu en entier pour les nombres, filtré pour le texte.** Le job `text` est une matrice sur les 21 parts du dump hebdomadaire `other/cirrus_search_index/<date>/index_name=frwiki_content/` : il garde `text_bytes` et `incoming_links` de toutes les pages (nécessaires à `pct()` sur le catalogue complet) et `opening_text` seulement pour les pages retenues par le mode. Repli TextExtracts (20 titres par appel, `exintro&explaintext`) si le format change. Coût si faux : un job plus long.
- **M2-6. Wikidata et Commons seulement pour les pages retenues.** 3 requêtes en parallèle au plus, ≈ 200 requêtes/min, User-Agent explicite (contact : le dépôt), `maxlag=5`, reprise par point de contrôle dans `actions/cache`. L'échantillon (≈ 5 000 appels de 50) tient en moins de 30 min ; le mode `full` (M8) se découpe en plusieurs runs reprenables. Image : `page_image_free` → Commons `imageinfo&iiprop=extmetadata|url&iiurlwidth=330` ; fichier absent de Commons → même requête sur l'API frwiki ; sinon `image_url` nul. Miniature : `…/thumb/x/xy/Nom/330px-Nom` (`.png` ajouté pour un SVG). `Artist` débarrassé de son HTML (texte brut).
- **M2-7. Fixtures en deux couches.**
  - `catalog/fixtures/raw/` : tranches **cohérentes** des vraies sources pour un même ensemble d'environ 300 `page_id` (≈ 250 tirés par hachage + 10 pages de chacune des raretés L, UR, SR, R d'après les vues, pour que toutes les raretés existent) : tuples de `page` et `page_props` réécrits en `INSERT` au format du dump, lignes de pageviews, paires index/document de Cirrus, réponses JSON de Wikidata et de Commons. Produites une fois par le mode `fixtures` de `catalog.yml` (artefact), téléchargées par le contrôleur et commitées, avec `catalog/fixtures/README.md` (attribution CC BY-SA 4.0, source et date de chaque tranche).
  - `catalog/fixtures/expected/` : `cards.csv` et `media.csv` produits par le pipeline à partir de `raw/`, fichiers de référence des tests.
  - Ordre : les parseurs `sqldump` et `pageviews` sont écrits d'abord sur des échantillons à la main conformes aux formats relevés (`notes-external.md`) ; le mode `fixtures` les utilise ; les autres parseurs se testent ensuite sur les vraies tranches.
- **M2-8. `catalog.yml` sur `develop` tôt.** `workflow_dispatch` exige que le fichier soit sur la branche par défaut (`develop`) tant que le workflow n'a jamais tourné. Dès que le mode `fixtures` est prêt, le contrôleur fusionne la branche dans `develop` (`--no-ff`, R3) ; ensuite le workflow se lance par l'API sur la branche de travail. `persist-credentials: false` sur chaque `actions/checkout` (aussi dans `ci.yml`). Coût si faux : un merge de plus.
- **M2-9. Fusion par lots, finalisation à part.** `wm.catalog_merge(p_mode text, p_limit int default 50000)` traite au plus `p_limit` lignes de `wm.catalog_stage` non traitées, en **une** transaction : correspondance (`card_source.page_id`, sinon `(lang, wikipedia_title)`), insertion des nouvelles cartes (`gen_random_uuid()`), mise à jour de la seule liste blanche du §6.3 (et `atk`, `def`, `q_score` seulement si `catalog_stats_frozen = false`), `card_media`, et le pool par *swap-with-last* avec `catalog_stats` dans la même transaction. Le script de chargement boucle jusqu'à 0. `wm.catalog_finalize(p_mode text)` sort du pool les cartes absentes du chargement courant (mode `full` : absentes du dump ; mode `sample` : hors échantillon), vide le stage et écrit un résumé dans `wm.catalog_runs`. Jamais de `delete` sur `public.cards`. `catalog_frozen = true` → les deux fonctions ne font rien et le disent. Deux passages identiques = même état, mêmes ids (test). Coût si faux : une boucle dans `load.ts`.
- **M2-10. Pool *swap-with-last*.** `wm.pool_add(p_card_id uuid, p_rarity public.rarity)` et `wm.pool_remove(p_card_id uuid)` (déplacer la dernière ligne de la rareté dans le trou, `n -= 1`), utilisées par le merge et la finalisation. `wm.rebuild_draw_pool()` reste pour le seed du banc. Un test vérifie que le pool reste dense (`seq` = 1..n sans trou, `n` = `catalog_stats.n`) après un mélange d'ajouts, de retraits et de changements de rareté. Coût si faux : aucun sur les tirages, `catalog_empty` sinon.
- **M2-11. Tirage pur et χ² déterministe.** Le choix d'une carte sort de `wm.draw_cards` dans `wm.pick_card(p_weights jsonb, p_exclude public.rarity[]) returns uuid` (sans écriture) ; `draw_cards` l'appelle. Test SQL : `setseed(0.42)`, 100 000 appels de `pick_card` sur le pool du banc, χ² de la rareté contre `n_r / N` (5 ddl, seuil 20,515 à α = 0,001) et uniformité de `seq` dans la plus grosse rareté en 20 classes (19 ddl, seuil 43,82). Le même contrôle, sans `setseed`, tourne une fois sur la démo après le chargement et est consigné. Coût si faux : un test instable, d'où `setseed`.
- **M2-12. Sort des cartes d'essai.** Démo : elles sortent du pool au premier vrai `catalog_finalize` (absentes du chargement), restent dans `public.cards` (18 copies d'un joueur les référencent, clés étrangères NO ACTION) et disparaissent du catalogue et de la recherche. Leur suppression, avec celle des copies, est une étape humaine différée (destructive en production). Banc : le seed reste le catalogue de développement (E2E et contrat en dépendent) ; les tests du merge tournent en transaction annulée. Coût si faux : 2 000 lignes inertes sur la démo.
- **M2-13. Catalogue = cartes du pool.** `wm.cards_page` (pages, filtres de rareté **et recherche**) ne renvoie que des cartes présentes dans `wm.draw_pool` ; aujourd'hui la recherche lit `public.cards` et montrerait les cartes d'essai et les cartes retirées. `rest/v1/cards` reste lisible tel quel (§3.4).
- **M2-14. Cache de `/api/cards`.** Partie partagée `wm.cards_page_shared(p_page int, p_sort text, p_q text, p_rarity public.rarity[])` (sans joueur), lue par le client service role dans une fonction auxiliaire `'use cache: remote'` avec `cacheTag('catalog')` et `cacheLife` d'une heure ; clé = page, tri, `q` normalisé (trim, minuscules), raretés triées. Overlay non caché `wm.cards_overlay(p_uid uuid, p_card_ids uuid[])` (`ownedCardIds`, `wishlistCardIds`, `friendOwners` vide au M2). Avec `wishlist=1` ou `missing=1`, chemin non caché par joueur. Le contrat de réponse ne change pas. Repli documenté (§9.5) si `'use cache: remote'` manque : cache mémoire de 1 à 3 s (`shortcut:`).
- **M2-15. `POST /api/cron/revalidate`.** En-tête `x-cron-secret` comparé à `CRON_SECRET` en temps constant ; secret absent → 503 (échec fermé) ; mauvais secret → 401 ; sinon `revalidateTag('catalog', 'max')` et 200 `{revalidated: true}`. Hors `route()` (aucun appel `wm`). La porte laisse déjà passer `/api/cron/*`. Appelée par `catalog.yml` en fin de `load`.
- **M2-16. Crédits.** `GET /api/cards/[id]/credits` → `{file, image_author, image_license, license_url}` depuis `wm.card_media` (404 « Carte introuvable » si absent), `Cache-Control: public, max-age=86400, s-maxage=2592000`. La modale affiche la ligne de licence du texte (CC BY-SA 4.0, chaîne exacte du recap) et, si la carte a une image, « Image : <auteur>, <licence> » avec le lien de licence. Page `/credits` (publique, derrière la porte comme tout le site) : sources (Wikipédia en français, Wikidata, Wikimedia Commons), licences, méthode des statistiques `stats_v1`, mention « Projet indépendant de la Fondation Wikimedia » (aussi dans le pied de page). Pas de liste des 250 k images.
- **M2-17. Secrets.** GitHub : `SUPABASE_DB_URL` (URI Supavisor en mode session, port 5432, avec mot de passe) et `CRON_SECRET` ; Vercel : `CRON_SECRET` (Production et Preview). Étapes humaines, demandées au moment de la tâche de chargement, avec les écrans exacts. `APP_URL` = `https://wmr-ivm.vercel.app` en dur dans le workflow. Le chargement fait d'abord un essai `\copy` de 10 lignes dans le stage (le passage de `\copy` par le pooler n'est pas vérifié), puis `set statement_timeout = 0` pour la session.
- **M2-18. Migrations sur la démo.** Par le MCP pour le SQL sans `DELETE` ; par le SQL Editor (fichier préparé par le contrôleur) pour celui qui en contient (`pool_remove`, finalisation), puis la ligne d'historique et `notify pgrst, 'reload schema'`. Ordre : migrations avant la fusion dans `develop` (R32).
- **M2-19. Pipeline en TypeScript sous Node 24**, par l'effacement de types natif (syntaxe effaçable seulement : ni `enum` ni `namespace`) : `node catalog/src/cli.ts <job> [options]`, sans nouvelle dépendance. Flux : `node:zlib` pour gzip ; `lbzip2 -d` (paquet apt) pour bz2 dans Actions ; les fixtures sont en clair. Tests : vitest, comme le reste.
- **M2-20. Points hérités pris au M2** : `persist-credentials: false` ; garde grep contre un `DELETE`/`UPDATE` sans `WHERE` dans `supabase/migrations/*.sql` (dans `test:db`) ; seuils de rareté en une seule constante TS partagée par le pipeline et « Comment ça marche ? » ; renommage d'article non répercuté (liste blanche) mais compté dans `catalog_runs`. Le reste de « Hérités du M0 » reste différé.

**Écarts au spec (la décision l'emporte) :**
- M2-1 : quota par rang de hachage au lieu de « hachage du `page_id` < 9 % » (D§10.2, C9).
- M2-3 : le taux de l'échantillon peut descendre sous les « ≈ 9 % » de C9 et de D§10.5.
- M2-4 : badge lu dans `page_props`, pas dans les modèles de Cirrus (D§10.2, ligne `text`).
- M2-5 : dump Cirrus au nouvel emplacement `other/cirrus_search_index/`, en 21 parts (D§10.2 dit « dump `cirrussearch` »).
- M2-6 : 3 requêtes Wikidata en parallèle au lieu de 4 (D§10.2), plafond 2026 de Wikimedia.
- M2-13 : une carte hors pool n'apparaît plus en recherche, en liste de souhaits ni en « manquantes » (le M1 la mettait en fin de rareté).
- M2-18 : une partie des migrations passe par le SQL Editor, pas par le MCP (C24).

## Décisions ajoutées par ce plan (à consigner avec les précédentes)

- **P1. Job `select`** entre `pageviews` et les jobs `text`, `wikidata` et `commons` : l'échantillon (M2-1) dépend des vues, et M2-5 et M2-6 en ont besoin avant de lire le texte, Wikidata et Commons.
- **P2. `sample_rate` vit dans `wm.config`** (C30 : constante réglable sans déploiement). Le job `select` le lit par `psql` ; l'entrée `sample_rate` de `catalog.yml` est un forçage facultatif, vide par défaut. La Task 11 écrit la valeur mesurée dans la migration (M2-3 la plaçait comme défaut du workflow).
- **P3. Deux tables de stage** (`wm.catalog_stage` pour `cards.csv`, `wm.catalog_stage_media` pour `media.csv`) et une colonne `result` par ligne, qui remplit le résumé de `catalog_runs`. `catalog_finalize` refuse un stage vide ou inachevé (409) : sans cela, un second appel viderait le pool.
- **P4. Garde de taille en deux temps** : avant `\copy` (`taille + lignes × STAGE_BYTES_PER_ROW`), puis après (`taille, stage compris, + nouvelles cartes × BYTES_PER_CARD`). Un second passage sans nouvelle carte passe donc toujours. La mesure de M2-3 donne les deux constantes et tient compte du pic stage + catalogue et du gonflement d'une mise à jour mensuelle.
- **P5. Miniatures (complète M2-6)** : une image matricielle de 330 px de large ou moins prend l'URL du fichier original (MediaWiki refuse d'agrandir) ; TIFF, PDF et DjVu → `image_url` nul (`shortcut:`).
- **P6. Drapeau image du staff** = `hide_image or nsfw_image` : le merge ne touche alors ni `image_url` ni `card_media`. `qscore_refreshed_at` suit `atk`, `def` et `q_score` (inchangé si `catalog_stats_frozen`).
- **P7. Titre repris par une autre page** : une nouvelle page dont le titre appartient déjà à une carte liée à un autre `page_id` n'est pas insérée (`result = 'conflict'`, compté) ; le renommage forcé est un outil staff (M6).
- **P8. Table `wm.card_removals`** créée vide (D§6.2) : le merge et la finalisation la respectent (D§10.3.3) ; son écriture arrive au M6.
- **P9. Trois migrations** selon le chemin de déploiement (M2-18) : `1500_wm_pool.sql` et `1510_wm_catalog_merge.sql` (avec `DELETE`, SQL Editor), `1520_wm_catalog_pages.sql` (sans `DELETE`, MCP).
- **P10. `route()` gagne deux options** : `call` (remplace l'appel RPC, pour le cache de `/api/cards`) et `headers` (posés sur un 200 seulement, pour les crédits). La route des crédits est `auth: false`, puisque sa réponse est publique et cachée au CDN.
- **P11. TextExtracts sert aussi de complément** : une page retenue sans `opening_text` dans Cirrus reçoit son résumé de TextExtracts. L'entrée `text_source: extracts` bascule tout le texte sur TextExtracts (repli de M2-5) ; `text_bytes` vaut alors `page_len` et `incoming_links` 0, et le résumé du run le dit.
- **P12. Le `schedule` mensuel** (le 3, D§10.2) n'est ajouté qu'après le premier chargement réussi (Task 15) : un run planifié avant les migrations et les secrets brûlerait environ 4 h de runner pour échouer au `load`.
- **P13. Fichiers d'aide** `catalog/src/tsv.ts` et `catalog/src/http.ts` en plus de la liste de D§5.2 : un seul format TSV et un seul client limité pour les trois API.

## Review Focus

- **Chargement interrompu puis relancé** (runner tué après un lot de 50, stage à moitié marqué, puis le job `load` relancé avec les mêmes CSV) : état final identique à un chargement d'un seul tenant, ids inchangés, pool dense, aucune ligne en double dans le stage. → `15_catalog_load.test.sh`, Task 10.
- **Article renommé, ancien titre repris** (page 101 « Ancien » devenue « Nouveau », nouvelle page 202 titrée « Ancien ») : la carte de 101 garde son id et son titre (`renamed`), 202 n'est pas insérée (`conflict`), le lot ne lève pas de `23505`. → `26_catalog_merge.test.sql`, Task 9.
- **Carte qui change de rareté alors que des joueurs la possèdent** (C → R) : `cards.rarity` = R, `snapshot_rarity` des copies et `wm.user_rarity_counts` intacts, carte déplacée de C à R dans le pool, `check_invariants()` = `[]`. → `26_catalog_merge.test.sql`, Task 9.
- **Base près de la limite Free** (400 Mo avant un premier chargement de 250 k lignes ; 440 Mo avant un second passage sans nouvelle carte ; cible `pro`) : refus avant toute écriture dans le premier cas, chargement accepté dans les deux autres. → `load.test.ts`, Task 10.
- **Wikimedia limite le débit** (429 avec `retry-after: 2`, 429 sans en-tête, `maxlag` en HTTP 200, 9 refus de suite, 10 appels lancés ensemble) : attente de l'en-tête puis de 5 s doublées, abandon après 8 nouvelles tentatives, jamais plus de 3 requêtes en vol. → `http.test.ts`, Task 3.

## Fichiers

| Fichier | Rôle |
|---|---|
| `lib/rarity.ts` | `MIN_VIEWS` et `rarityForViews`, partagés par le pipeline, « Comment ça marche ? » et `/credits` |
| `catalog/src/tsv.ts` | Lecture et écriture des TSV intermédiaires |
| `catalog/src/sqldump.ts` | Tuples MySQL de `page` et `page_props` → `pages.tsv`, `props.tsv` |
| `catalog/src/pageviews.ts` | Vues mensuelles `user` → `views.tsv` |
| `catalog/src/compute.ts` | Hachage, échantillon, `pct`, `stats_v1`, résumé ; commandes `select` et `compute` |
| `catalog/src/http.ts` | Client Wikimedia limité (concurrence, débit, 429, `maxlag`) |
| `catalog/src/cirrus.ts` | Instantané et parts du dump Cirrus ; documents → `text-<part>.tsv` |
| `catalog/src/extracts.ts` | TextExtracts (complément et repli) |
| `catalog/src/wikidata.ts` | Descriptions FR → `desc.tsv` |
| `catalog/src/commons.ts` | `extmetadata`, miniatures, auteur en texte brut → `media.tsv` |
| `catalog/src/emit.ts` | `cards.csv` et `media.csv` |
| `catalog/src/load.ts` | Gardes de taille, essai `\copy`, boucle de merge, finalisation ; mesure de taille |
| `catalog/src/fixtures.ts` | Choix des pages et tranches du mode `fixtures` |
| `catalog/src/cli.ts` | Point d'entrée `node catalog/src/cli.ts <commande>` |
| `.github/workflows/catalog.yml` | Jobs `fixtures`, `dumps`, `pageviews`, `select`, `text` (matrice), `wikidata`, `commons`, `compute`, `load` |
| `supabase/migrations/1500_wm_pool.sql`, `1510_wm_catalog_merge.sql`, `1520_wm_catalog_pages.sql` | Pool et tirage ; tables et fusion ; pages partagées, overlay, crédits |
| `lib/catalog-cache.ts` | Partie partagée cachée de `/api/cards` et overlay |
| `app/api/cron/revalidate/route.ts`, `app/api/cards/[id]/credits/route.ts` | Revalidation du tag `catalog` ; crédits d'une image |
| `components/card/ImageCredit.tsx`, `components/shell/Footer.tsx`, `app/(public)/credits/page.tsx` | Ligne de crédit de l'image, pied de page, page des crédits |

---

### Task 1: Seuils partagés, TSV, parseurs `sqldump` et `pageviews`, CLI

**Files:**
- Create: `catalog/src/tsv.ts`, `catalog/src/sqldump.ts`, `catalog/src/pageviews.ts`, `catalog/src/cli.ts`, `catalog/src/tsv.test.ts`, `catalog/src/sqldump.test.ts`, `catalog/src/pageviews.test.ts`, `lib/rarity.test.ts`
- Modify: `lib/rarity.ts`, `components/packs/HowItWorks.tsx:10` (importe `MIN_VIEWS`)

**Interfaces:**
- Produces :
  - `lib/rarity.ts` : `MIN_VIEWS = { L: 20_000, UR: 5_000, SR: 1_000, R: 250, PC: 50 } as const` ; `rarityForViews(views: number): RarityCode` (seuil inclus dans la rareté supérieure).
  - `tsv.ts` : `type Field = string | number | null` ; `tsvLine(fields: Field[]): string` ; `parseTsvLine(line: string): (string | null)[]` ; `readTsv(path: string): AsyncGenerator<(string | null)[]>` ; `writeTsv(path: string, rows: Iterable<Field[]> | AsyncIterable<Field[]>, opts?: { append?: boolean }): Promise<number>` (renvoie le nombre de lignes).
  - `sqldump.ts` : `type SqlValue = string | number | null` ; `PAGE_COLUMNS` (les 12 noms du `CREATE TABLE` de `page`, dans l'ordre de `notes-external.md` §1) et `PROPS_COLUMNS` (`pp_page`, `pp_propname`, `pp_value`, `pp_sortkey`) ; `sqlTuples(lines: AsyncIterable<string>, table: 'page' | 'page_props'): AsyncGenerator<SqlValue[]>` ; `openLines(path: string): AsyncIterable<string>` (gunzip par `node:zlib` si le chemin finit par `.gz`, sinon texte brut) ; `dumpsCommand(o: { page: string; props: string; dir: string }): Promise<{ pages: number; props: number }>`.
    - `pages.tsv` : `page_id, title, len`, pour `page_namespace = 0` et `page_is_redirect = 0`.
    - `props.tsv` : `page_id, image, qid, badge, disambig`, une ligne par page portant au moins une des propriétés `page_image_free`, `wikibase_item`, `disambiguation`, `wikibase-badge-Q17437796` (badge 1) ou `wikibase-badge-Q17437798` (badge 0.6) ; badge = le plus haut ; `page_image` (non libre) ignoré.
  - `pageviews.ts` : `pageviewsCommand(o: { input: AsyncIterable<string>; dir: string; minLines?: number }): Promise<{ lines: number; malformed: number }>` écrit `views.tsv` (`page_id|\N, title|\N, views`) : une ligne par `page_id` (somme des méthodes d'accès), plus une ligne par titre pour les lignes à `page_id` `null`.
  - `cli.ts` : `node catalog/src/cli.ts <commande> --option valeur` (`parseArgs`), commandes `dumps` et `pageviews` (lit l'entrée standard) ; erreur → message sur stderr, code 1.

- [ ] **Step 1: Tests qui échouent**
  - `lib/rarity.test.ts` : `rarityForViews` vaut `C` pour 0 et 49, `PC` pour 50 et 249, `R` pour 250 et 999, `SR` pour 1 000 et 4 999, `UR` pour 5 000 et 19 999, `L` pour 20 000.
  - `tsv.test.ts` : `parseTsvLine(tsvLine(['a\tb', 'c\nd\\e', null, 42]))` → `['a\tb', 'c\nd\\e', null, '42']` ; une chaîne vide reste `''`, distincte de `null`.
  - `sqldump.test.ts`, sur un échantillon écrit à la main conforme au dump réel : ligne `/*M!999999\- enable the sandbox mode */`, `-- MariaDB dump 10.19 …`, le `CREATE TABLE \`page\`` aux 12 colonnes exactes, `INSERT INTO \`page\` VALUES` seul sur sa ligne, puis les tuples réels 3, 16 et 21 de `notes-external.md` §1, un tuple de l'espace de noms 1, et le dernier terminé par `);` :
    - `pages.tsv` = `[['3', 'Antoine_Meillet', '16467'], ['16', "Arc_de_triomphe_de_l'Étoile", '67657']]` (la redirection 21 et l'espace de noms 1 sont exclus) ;
    - les trois mêmes tuples en une seule ligne `INSERT INTO \`page\` VALUES (…),(…),(…);` donnent le même résultat ;
    - la chaîne `'a\\b\"c\nd\0'` se décode en `a\b"c`, saut de ligne, `d` et le caractère NUL ;
    - un `CREATE TABLE` où `page_len` devient `page_length` lève `Colonnes inattendues pour page : …` ; un tuple de 11 valeurs lève `Tuple de 11 valeurs pour page (12 attendues)`.
  - Même fichier, `page_props`, avec les tuples réels de `notes-external.md` §1 : page 11 → image `Palacio_del_Congreso_in_Buenos_Aires_(6370115601).jpg` et qid `Q1154647` ; 12 → image `Hogan's_Flying_Column.gif` ; 18 → badge 1 ; 49 → badge 0.6 ; 48 → disambig 1 ; une ligne `page_image` seule et `kartographer_links` ne produisent rien.
  - `pageviews.test.ts` :
    - `fr.wikipedia Chat 1234 desktop 100 A50B50`, `fr.wikipedia Chat 1234 mobile-web 30 A30`, `fr.wikipedia Chat null mobile-app 5 A5` et la forme à 5 champs `fr.wikipedia Chien mobile-web 7 B7` (`minLines: 0`) → `views.tsv` = `[['1234', null, '130'], [null, 'Chat', '5'], [null, 'Chien', '7']]` ;
    - une ligne `fr.wikisource X 1 desktop 9 A9` est ignorée ;
    - 1 ligne mal formée (`fr.wikipedia Truc 99 desktop abc A1`) sur 200 passe et compte `malformed: 1` ; 3 sur 100 lèvent `Format des vues inattendu : 3 lignes mal formées sur 100` ;
    - 10 lignes avec `minLines: 1000` lèvent `Format des vues inattendu : 10 lignes (1000 attendues au moins)`.

- [ ] **Step 2: `npm test -- catalog lib/rarity`** → échec (modules absents).

- [ ] **Step 3: Implémenter**
  - Parseur de tuples : automate caractère par caractère (guillemets, échappements MySQL `\0 \' \" \b \n \r \t \Z \\`, `NULL`, nombres), indépendant des fins de ligne. Lignes hors `INSERT` et hors tuples ignorées. Le `CREATE TABLE` est comparé à `PAGE_COLUMNS` ou `PROPS_COLUMNS`.
  - `HowItWorks.tsx` importe `MIN_VIEWS` au lieu de sa constante (même rendu).

- [ ] **Step 4: `npm test && npm run typecheck && npm run lint`** → vert ; l'E2E existante de « Comment ça marche ? » n'est pas touchée.

- [ ] **Step 5: Commit** — `feat(catalog): seuils de rareté partagés, TSV, parseurs des dumps SQL et des vues mensuelles`

---

### Task 2: Calculs purs et commande `select`

**Files:**
- Create: `catalog/src/compute.ts`, `catalog/src/compute.test.ts`
- Modify: `catalog/src/cli.ts` (commande `select`)

**Interfaces:**
- Consumes : `readTsv`, `writeTsv` (Task 1) ; `rarityForViews` (Task 1).
- Produces (`compute.ts`) :
  - `type Mode = 'full' | 'sample'` ; `SUMMARY_MAX = { full: 1200, sample: 600 } as const` ;
  - `type CatalogRow = { page_id: number; title: string; len: number; views: number; rarity: RarityCode; image: string | null; qid: string | null; badge: number; selected: boolean }` ;
  - `type Counts = { mode: Mode; rate: number; full: Record<RarityCode, number>; selected: Record<RarityCode, number> }` ;
  - `fnv1a32(s: string): number` (FNV-1a 32 bits sur les octets UTF-8, non signé) ;
  - `joinCatalog(dir: string): Promise<CatalogRow[]>` : `pages.tsv` ⋈ `props.tsv` (homonymies exclues) ⋈ `views.tsv` (vues = ligne du `page_id` + ligne du titre à `page_id` nul) ; `selected = false` ;
  - `selectSample(rows: CatalogRow[], rate: number): Set<number>` (M2-1 ; tri par `(fnv1a32(String(page_id)), page_id)` ; `rate >= 1` → toutes) ;
  - `pct(values: number[]): number[]` (M2-2) ;
  - `statsV1(rows: { text_bytes: number; incoming_links: number; badge: number }[]): { atk: number; def: number; q_score: number }[]` (D§10.1 ; `pct` de DEF calculé sur les `q_score` arrondis) ;
  - `cleanOpening(text: string): string` ; `cutSummary(text: string, max: number): string` ; `hasOpening(text: string | undefined): boolean` = `cleanOpening(text ?? '') !== ''` (seule règle de « page sans résumé », partagée par `fixtures fetch` et `computeCommand`) ;
  - `selectCommand(o: { dir: string; mode: Mode; rate: number }): Promise<Counts>` écrit `catalog.tsv` (`page_id, title, len, views, rarity, image, qid, badge, selected` en 0/1) et `counts.json` (`Counts`) ; mode `full` → toutes les pages retenues, quel que soit `rate`.

- [ ] **Step 1: Tests qui échouent** (`compute.test.ts`)
  - `fnv1a32('')` = 2166136261, `fnv1a32('a')` = 3826002220, `fnv1a32('foobar')` = 3214735720.
  - `pct([10, 20, 20, 30])` = `[0, 0.5, 0.5, 1]` ; `pct([7])` = `[0.5]` ; `pct([])` = `[]`.
  - `statsV1([{text_bytes: 100, incoming_links: 0, badge: 0}, {200, 5, 0.6}, {300, 5, 1}])` → `q_score` `[0, 60.75, 91.25]`, `atk` `[1000, 5500, 10000]`, `def` `[1000, 5500, 10000]`.
  - `selectSample`, catalogue synthétique au dixième des comptes du R§ (L 176, UR 1 237, SR 6 679, R 17 966, PC 51 676, C 199 613 ; `page_id` 1..N), `rate` 0.09 :
    - comptes retenus exacts : L 16, UR 111, SR 601, R 1 617, PC 4 651, C 17 965 ;
    - pour chaque rareté, `|part échantillon − part complète| × 100 ≤ 1` (critère D§13 en points, M2-1) ;
    - deux appels donnent le même ensemble ; une rareté de 3 pages garde 1 page ; `rate` 1 garde tout.
  - `joinCatalog` sur trois TSV écrits dans un dossier temporaire : une homonymie est exclue ; 130 vues par id + 5 par titre → 135 → `R` ; une page sans vues → 0 → `C` ; image, qid et badge reportés.
  - `cleanOpening` :
    - « Pour les articles homonymes, voir Chat (homonymie). Le chat est un mammifère. » → « Le chat est un mammifère. » ;
    - les bandeaux retirés en tête, répétés : phrases commençant par « Pour les articles homonymes », « Pour l'article homonyme », « Pour les articles ayant des titres homonymes », « Ne doit pas être confondu », « Ne pas confondre », « Cet article concerne », « Pour un article plus général » ou « « … » redirige ici » ;
    - espaces multiples réduits à une, texte sans bandeau inchangé.
  - `cutSummary` : texte de longueur ≤ max inchangé ; `cutSummary('Un. Deux. Trois.', 10)` = `'Un. Deux.'` (dernière fin de phrase `[.!?…]` suivie d'un blanc ou de la fin, dans les `max` premiers caractères) ; sans fin de phrase, coupe au dernier blanc et ajoute `…` ; le résultat ne dépasse jamais `max` caractères.
  - `selectCommand` (mode `sample`, `rate` 0.5) écrit `counts.json` avec `full` et `selected` cohérents avec `catalog.tsv`.

- [ ] **Step 2: `npm test -- catalog/src/compute.test.ts`** → échec.

- [ ] **Step 3: Implémenter.** `pct` trie les indices une fois et donne le rang moyen aux ex æquo. `q_score = Math.round(100 × (…) × 100) / 100`.

- [ ] **Step 4: `npm test`** → vert.

- [ ] **Step 5: Commit** — `feat(catalog): hachage, échantillon par quota, rang percentile, stats_v1, résumé, commande select`

---

### Task 3: Client Wikimedia, outils du mode `fixtures`, `catalog.yml` (fixtures)

**Files:**
- Create: `catalog/src/http.ts`, `catalog/src/http.test.ts`, `catalog/src/fixtures.ts`, `catalog/src/fixtures.test.ts`, `catalog/src/cirrus.ts`, `catalog/src/wikidata.ts`, `catalog/src/commons.ts`, `catalog/src/extracts.ts` (constructeurs d'URL et listings ; les parseurs arrivent aux Tasks 5 et 6), `.github/workflows/catalog.yml`
- Modify: `catalog/src/cli.ts` (commandes `fixtures …`, `cirrus-list`), `.github/workflows/ci.yml` (`persist-credentials: false` sur les deux `actions/checkout`)

**Interfaces:**
- Consumes : `dumpsCommand`, `pageviewsCommand`, `sqlTuples`, `openLines` (Task 1) ; `joinCatalog`, `fnv1a32`, `hasOpening` (Task 2).
- Produces :
  - `http.ts` : `USER_AGENT` (chaîne du Global Constraints) ; `type Client = { get(url: string): Promise<unknown> }` ; `createClient(o?: { concurrency?: number; perMinute?: number; maxRetries?: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number }): Client` (défauts 3, 200, 8). 429 ou 503 → attente de `Retry-After` (secondes), sinon 5 s doublées à chaque essai jusqu'à 120 s ; HTTP 200 avec `error.code = 'maxlag'` → même attente ; autre statut ≥ 400 → erreur immédiate `Wikimedia : HTTP <statut> sur <url>` ; épuisé → `Wikimedia : abandon après 8 nouvelles tentatives (<statut>) sur <url>`.
  - Constructeurs d'URL (ids dédoublonnés et triés : qids par valeur numérique, fichiers par ordre des unités de code, `page_id` croissant ; puis lots) :
    - `wikidata.ts` : `entitiesUrls(qids: string[]): string[]`, lots de 50, `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&formatversion=2&maxlag=5&props=descriptions&languages=fr&ids=…` ;
    - `commons.ts` : `imageInfoUrls(files: string[], host: 'commons.wikimedia.org' | 'fr.wikipedia.org'): string[]`, lots de 50, `https://<host>/w/api.php?action=query&format=json&formatversion=2&maxlag=5&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=330&iiextmetadatafilter=Artist|LicenseShortName|LicenseUrl&iiextmetadatalanguage=fr&titles=File:…` ; `missingFiles(body: unknown): string[]` (pages `missing`, noms ramenés à la forme demandée par `query.normalized`) ;
    - `extracts.ts` : `extractsUrls(pageIds: number[]): string[]`, lots de 20, `https://fr.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&maxlag=5&prop=extracts&exintro=1&explaintext=1&exlimit=20&pageids=…`.
  - `cirrus.ts` : `cirrusListing(fetchText: (url: string) => Promise<string>): Promise<{ date: string; parts: string[] }>` : le plus récent dossier `YYYYMMDD/` de `https://dumps.wikimedia.org/other/cirrus_search_index/` dont `index_name%3Dfrwiki_content/` contient `_SUCCESS` ; `parts` = noms `frwiki_content-<date>-NNNNN.json.bz2` triés.
  - `fixtures.ts` :
    - `pickFixtureIds(rows: CatalogRow[]): Map<number, string>` (`page_id` → raison) : les 250 plus petits `fnv1a32`, puis 10 pages de chacune des raretés L, UR, SR et R, 3 AdQ, 3 BA et 3 pages dont l'image finit par `.svg` (à chaque fois les plus petits hachages non encore pris) ;
    - `sliceSql(lines: AsyncIterable<string>, table: 'page' | 'page_props', keep: Set<number>, extras?: { redirects: number; otherNs: number; disambiguation: Set<number> }): Promise<{ text: string; ids: Set<number> }>` : en-tête du dump recopié tel quel jusqu'au premier `INSERT`, puis `INSERT INTO \`<table>\` VALUES` et un tuple par ligne, le dernier terminé par `;` ; pour `page`, garde aussi les `redirects` premières redirections de l'espace 0, les `otherNs` premières pages d'un autre espace et les homonymies données ;
    - `slicePageviews(lines: AsyncIterable<string>, ids: Set<number>, titles: Set<string>): Promise<string[]>` ;
    - `CIRRUS_KEEP` = `page_id, namespace, title, page_type, redirect_target, opening_text, text_bytes, incoming_links, template, wikibase_item, version, timestamp, index_name, wiki` ; `sliceCirrus(lines: AsyncIterable<string>, ids: Set<number>): AsyncGenerator<string>` (paires index/document gardées, document réduit à `CIRRUS_KEEP`) ;
    - `fetchRaw(client: Client, urls: string[]): Promise<Record<string, unknown>>` (objet `{url: corps}`) ;
    - `fixturesReadme(meta: { runDate: string; sources: { name: string; url: string; date: string }[] }): string`.
  - Commandes `fixtures pick | slice-sql | slice-pageviews | slice-cirrus | fetch | readme`. Disposition de `catalog/fixtures/` : `README.md` et `raw/{ids.tsv, meta.json, page.sql, page_props.sql, pageviews.txt, cirrus.ndjson, wikidata.json, commons.json, extracts.json}` ; `meta.json` = `{run_date, month, cirrus_date}`.
  - `fetch` rejoue exactement les requêtes que feront les commandes des Tasks 6 et 7, pour que le test de bout en bout les retrouve par URL : `entitiesUrls` des qids des pages choisies ; `imageInfoUrls` de leurs images sur Commons, puis sur frwiki pour les `missingFiles` ; `extractsUrls` des pages choisies sans `hasOpening` (document Cirrus absent compris), plus `extractsUrls` des 40 premiers ids pour les tests du parseur.

- [ ] **Step 1: Tests qui échouent** (`http.test.ts`, `fetchImpl` et `sleep` simulés ; *Review Focus*)
  - 429 avec `retry-after: 2`, puis 200 → la promesse rend le corps, `sleep` a reçu 2000, la requête porte `User-Agent` = `USER_AGENT` et `Accept-Encoding: gzip`.
  - 429 sans en-tête trois fois, puis 200 → attentes 5000, 10000, 20000.
  - 200 `{"error": {"code": "maxlag"}}` avec `Retry-After: 3`, puis 200 → attente 3000.
  - 9 réponses 429 → rejet `Wikimedia : abandon après 8 nouvelles tentatives (429) sur <url>`.
  - 404 → rejet immédiat, sans `sleep`.
  - 10 `get` lancés ensemble sur un `fetch` qui ne répond pas → au plus 3 en vol ; chaque réponse libère une place.
  - `perMinute: 2` avec une horloge simulée : le 3e démarrage dans la même minute attend le reste de la minute.
- [ ] **Step 2: Tests qui échouent** (`fixtures.test.ts`)
  - `entitiesUrls(['Q42', 'Q1', 'Q42'])` = une URL exacte se terminant par `ids=Q1%7CQ42` ; 120 qids → 3 URL ; `extractsUrls` de 45 ids → 3 URL ; `imageInfoUrls` encode `File:Arc_de_Triomphe_-_Août_2026.jpg`.
  - `missingFiles` sur une réponse écrite à la main (`normalized` `from` `File:A_b.jpg` `to` `File:A b.jpg`, page `missing: true`) → `['A_b.jpg']`.
  - `cirrusListing` sur trois pages HTML simulées : le dossier le plus récent sans `_SUCCESS` est sauté ; `parts` liste 21 noms.
  - `pickFixtureIds` sur un catalogue synthétique : au moins 10 pages par rareté L à R, 3 AdQ, 3 BA et 3 SVG ; au plus 310 ids ; résultat stable.
  - `sliceSql` sur l'échantillon `page` de la Task 1 → le texte rendu, relu par `sqlTuples`, donne exactement les tuples gardés ; l'en-tête `CREATE TABLE` est intact.
  - `sliceCirrus` sur trois paires écrites à la main → seule la paire d'un id gardé reste, sans `source_text`.

- [ ] **Step 3: `npm test -- catalog`** → échec.

- [ ] **Step 4: Implémenter**, puis `catalog.yml` (mode `fixtures` seulement) :
  - `name: Catalogue` ; `on: workflow_dispatch` avec les entrées `mode` (choix `sample` | `full` | `fixtures`, défaut `sample`), `target` (`free` | `pro`, défaut `free`), `sample_rate` (texte, défaut vide), `text_source` (`cirrus` | `extracts`), `load` (booléen, défaut `true`) et `artifacts_run_id` (texte, défaut vide). Les jobs lisent `${{ inputs.mode || 'sample' }}` et `${{ inputs.target || 'free' }}`. Pas de `schedule` (P12).
  - `concurrency: { group: catalog, cancel-in-progress: false }` ; `permissions: { contents: read, actions: read }`.
  - Job `fixtures` (`if: inputs.mode == 'fixtures'`, `ubuntu-24.04`, `timeout-minutes: 240`) : checkout (`persist-credentials: false`), `setup-node` (`.nvmrc`), `sudo apt-get install -y lbzip2`, puis :
    1. `curl -fsSL --retry 3` de `frwiki-latest-page.sql.gz` et `frwiki-latest-page_props.sql.gz`, puis `dumps` ;
    2. mois `M` = mois civil précédent (`date -u`), `curl … pageviews-M-user.bz2 | lbzip2 -dc | grep '^fr.wikipedia ' > work/fr.pv`, puis `pageviews < work/fr.pv` ;
    3. `fixtures pick`, `slice-sql`, `slice-pageviews` ;
    4. `cirrus-list`, puis pour chaque part `curl | lbzip2 -dc | node catalog/src/cli.ts fixtures slice-cirrus >> catalog/fixtures/raw/cirrus.ndjson` ;
    5. `fixtures fetch`, puis `fixtures readme` (écrit aussi `raw/meta.json`) ;
    6. `actions/upload-artifact@v7` `fixtures-raw` (`catalog/fixtures/`, `retention-days: 7`).
  - Le `README.md` généré nomme chaque source, son URL et sa date ; il dit que les textes sont sous CC BY-SA 4.0 (Wikipédia), les descriptions sous CC0 (Wikidata), les métadonnées d'images sous la licence de chaque fichier, et que les champs lourds de Cirrus sont retirés.

- [ ] **Step 5: `npm test && npm run typecheck && npm run lint`** → vert. Relire `catalog.yml` et `ci.yml` (les deux `checkout` ont `persist-credentials: false`).

- [ ] **Step 6: Commit** — `feat(catalog): client Wikimedia limité, mode fixtures de catalog.yml, persist-credentials: false`

---

### Task 4 (contrôleur): Fusion précoce dans `develop`, run `fixtures`, fixtures commitées

**Files:**
- Create: `catalog/fixtures/README.md`, `catalog/fixtures/raw/*` (téléchargés)

- [ ] **Step 1 (contrôleur): CI de la branche.** Pousser la branche, lancer `ci.yml` en `workflow_dispatch` sur elle (MCP GitHub). Attendu : `checks` et `integration` verts.
- [ ] **Step 2 (contrôleur): Fusion `--no-ff` dans `develop`** (M2-8), puis push. Contrôle R32 : aucun code de l'app ne dépend d'une migration du M2 à ce stade (seul `HowItWorks.tsx` change, sans effet visible). Vérifier ensuite que le déploiement Vercel est READY et que `/api/health` répond 200.
- [ ] **Step 3 (contrôleur): Lancer `catalog.yml`** avec `mode: fixtures`, sur la branche de travail ; si l'API refuse (workflow jamais lancé), sur `develop`. Suivre le job (≤ 4 h). Attendu : vert, artefact `fixtures-raw`.
- [ ] **Step 4 (contrôleur): Télécharger** (`gh run download <run_id> -n fixtures-raw -D catalog/fixtures`), puis contrôler :
  - `raw/ids.tsv` compte environ 300 ids, dont au moins 10 de chaque rareté L à R, 3 AdQ, 3 BA et 3 SVG ;
  - `du -sh catalog/fixtures` < 10 Mo ;
  - le `README.md` contient l'attribution CC BY-SA 4.0 et une date par source.
- [ ] **Step 5 (contrôleur): Relire les tranches avec les parseurs des Tasks 1 et 2** : `node catalog/src/cli.ts dumps --page catalog/fixtures/raw/page.sql --props catalog/fixtures/raw/page_props.sql --dir /tmp/fx`, puis `pageviews` et `select --rate 1`. Attendu : toutes les pages choisies sont dans `catalog.tsv`, sauf les redirections, les homonymies et les autres espaces de noms.
- [ ] **Step 6: Commit** — `test(catalog): fixtures Wikimedia réelles (≈ 300 pages, CC BY-SA 4.0)`

Si le job échoue : corriger dans un commit sur la branche et relancer sur elle (le workflow a déjà tourné une fois) ; une nouvelle fusion n'est nécessaire que si `develop` doit lancer le run.

---

### Task 5: Texte — Cirrus et TextExtracts sur les vraies tranches

**Files:**
- Create: `catalog/src/cirrus.test.ts`, `catalog/src/extracts.test.ts`
- Modify: `catalog/src/cirrus.ts`, `catalog/src/extracts.ts`, `catalog/src/cli.ts` (commande `cirrus`)

**Interfaces:**
- Consumes : `catalog.tsv` et `cleanOpening`, `cutSummary`, `SUMMARY_MAX`, `Mode` (Task 2) ; `fixtures/raw/cirrus.ndjson`, `extracts.json` (Task 4).
- Produces :
  - `cirrus.ts` : `type CirrusDoc = { page_id: number; namespace: number; page_type?: string; opening_text?: string; text_bytes: number; incoming_links?: number }` ; `cirrusDocs(lines: AsyncIterable<string>): AsyncGenerator<CirrusDoc>` ; `cirrusCommand(o: { dir: string; part: string; mode: Mode; input: AsyncIterable<string> }): Promise<{ docs: number; rows: number }>` écrit `text-<part>.tsv` (`page_id, text_bytes, incoming_links, summary|\N`) pour les documents de l'espace 0 qui ne sont pas des redirections ; `summary` seulement pour une page `selected`, égal à `cutSummary(cleanOpening(opening_text), SUMMARY_MAX[mode])`.
  - Garde de format : une ligne impaire qui n'est pas `{"index": {"_id": …}}` lève `Format Cirrus inattendu : ligne d'index <n>` ; moins de 95 % de documents avec `page_id` et `text_bytes` entiers lève `Format Cirrus inattendu : <k> documents sur <n> sans text_bytes`.
  - `extracts.ts` : `parseExtracts(body: unknown): { page_id: number; extract: string }[]` (`query.pages[]` de `formatversion=2` ; pages manquantes ou sans extrait ignorées).

- [ ] **Step 1: Tests qui échouent**
  - Sur `raw/cirrus.ndjson`, avec un `catalog.tsv` issu des tranches (comme au Step 5 de la Task 4, toutes les pages `selected`) :
    - chaque id de catalogue présent dans la tranche, hors redirection, donne une ligne ; aucun document `page_type: 'redirect'` n'en donne ;
    - chaque `summary` fait au plus 600 caractères et ne commence par aucun bandeau de `cleanOpening` ;
    - `text_bytes` est un entier ≥ 0 ; `incoming_links` absent → `0`.
  - Format : la tranche où chaque `text_bytes` est renommé `textBytes` lève la garde ; une ligne d'index `{"create": …}` aussi.
  - Une page non `selected` a `summary` `null` mais garde ses nombres.
  - `parseExtracts` sur les corps de `raw/extracts.json` : chaque page demandée qui a un extrait donne une ligne, avec un texte non vide.

- [ ] **Step 2: `npm test -- catalog/src/cirrus.test.ts catalog/src/extracts.test.ts`** → échec.

- [ ] **Step 3: Implémenter.** `JSON.parse` par ligne ; la ligne d'index donne l'id attendu du document suivant.

- [ ] **Step 4: `npm test`** → vert.

- [ ] **Step 5: Commit** — `feat(catalog): texte depuis Cirrus (21 parts) et TextExtracts, gardes de format`

---

### Task 6: Wikidata et Commons sur les vraies tranches

**Files:**
- Create: `catalog/src/wikidata.test.ts`, `catalog/src/commons.test.ts`
- Modify: `catalog/src/wikidata.ts`, `catalog/src/commons.ts`, `catalog/src/cli.ts` (commandes `wikidata`, `commons`)

**Interfaces:**
- Consumes : `Client`, `createClient` (Task 3) ; `entitiesUrls`, `imageInfoUrls`, `missingFiles` (Task 3) ; `catalog.tsv` (Task 2) ; `readTsv`, `writeTsv` (Task 1).
- Produces :
  - `wikidata.ts` : `parseEntities(body: unknown): Map<string, string | null>` (qid demandé → description FR ou `null` ; redirection suivie, clé = id demandé) ; `wikidataCommand(o: { dir: string; client: Client; deadlineMin?: number; now?: () => number }): Promise<{ done: number; skipped: number; finished: boolean }>` : qids des pages `selected`, `desc.tsv` (`qid, description|\N`) écrit en ajout, qids déjà présents sautés (reprise, M2-6).
  - `commons.ts` :
    - `stripHtml(html: string): string` (balises retirées, entités `&amp; &lt; &gt; &quot; &#39; &nbsp; &#NNN; &#xHH;` décodées, blancs réduits, `trim`) ;
    - `thumbUrl(file: string, o: { repo: 'commons' | 'fr'; mime: string; width: number }): string | null` (M2-6 et P5) ;
    - `type Media = { file: string; author: string | null; license: string | null; license_url: string | null; image_url: string | null }` ;
    - `parseImageInfo(body: unknown, repo: 'commons' | 'fr'): { media: Media[]; missing: string[] }` (noms ramenés à la forme demandée ; `imagerepository: 'local'` → dépôt `fr`) ;
    - `commonsCommand(o: { dir: string; client: Client; deadlineMin?: number; now?: () => number }): Promise<{ done: number; skipped: number; finished: boolean }>` : images des pages `selected` ; Commons d'abord, puis frwiki pour les `missing`, puis une ligne `file, \N, \N, \N, \N` pour un fichier introuvable ; `media.tsv` (`file, author, license, license_url, image_url`) en ajout avec reprise.
  - CLI : `--per-minute` (défaut 200) passé à `createClient` ; `--deadline-min` (défaut 330) atteint → les commandes rendent `finished: false` et le CLI sort avec le code 3 et le message `Délai atteint : reprendre au prochain run`.

- [ ] **Step 1: Tests qui échouent**
  - `stripHtml` :
    - `<a href="//commons.wikimedia.org/wiki/User:NuclearVacuum" title="User:NuclearVacuum">NuclearVacuum</a>` → `NuclearVacuum` ;
    - `<span class="int-own-work" lang="fr">Travail personnel</span>` → `Travail personnel` ;
    - `<a>A</a>, <a>B</a>` → `A, B` ; `Jean &amp; Marie&nbsp;Curie` → `Jean & Marie Curie` ; `&#233;t&#xE9;` → `été` ; `<b>x</b>\n  <i>y</i>` → `x y`.
  - `thumbUrl` :
    - `EU-Austria.svg` (`commons`, `image/svg+xml`, 512) → `https://upload.wikimedia.org/wikipedia/commons/thumb/9/9d/EU-Austria.svg/330px-EU-Austria.svg.png` ;
    - le même SVG de 100 px de large → même forme (un vectoriel s'agrandit) ;
    - `Arc_de_Triomphe_-_Août_2026.jpg` (`image/jpeg`, 4 000) → `https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Arc_de_Triomphe_-_Ao%C3%BBt_2026.jpg/330px-Arc_de_Triomphe_-_Ao%C3%BBt_2026.jpg` ;
    - ce JPEG à 330 px de large → original `https://upload.wikimedia.org/wikipedia/commons/1/1a/Arc_de_Triomphe_-_Ao%C3%BBt_2026.jpg` ;
    - dépôt `fr` → `…/wikipedia/fr/thumb/9/9d/…` ; un nom avec des espaces est haché avec des `_` ; `image/tiff` et `application/pdf` → `null`.
  - Sur `raw/commons.json` :
    - aucun `author` ne contient `<` ;
    - au moins 90 % des médias ont `license` ;
    - chaque fichier SVG de la tranche a un `image_url` qui finit par `.svg.png` ;
    - chaque `image_url` non nul correspond à `^https://upload\.wikimedia\.org/wikipedia/(commons|fr)/(thumb/)?[0-9a-f]/[0-9a-f]{2}/` ;
    - les noms rendus sont ceux demandés (avec `_`).
  - Sur `raw/wikidata.json` : chaque qid demandé a une entrée ; au moins 80 % ont une description non vide.
  - Reprise : `desc.tsv` contient déjà les 50 premiers qids → `wikidataCommand` (client simulé qui sert `raw/wikidata.json` par URL) ne demande que les URL suivantes ; une horloge qui dépasse `deadlineMin` après le premier lot rend `finished: false`.

- [ ] **Step 2: `npm test -- catalog/src/wikidata.test.ts catalog/src/commons.test.ts`** → échec.

- [ ] **Step 3: Implémenter.** md5 (`node:crypto`) du nom UTF-8 avec `_` ; nom encodé par `encodeURIComponent` ; image matricielle (`image/jpeg`, `png`, `gif`, `webp`) de largeur ≤ 330 → URL de l'original ; `shortcut:` formats paginés (TIFF, PDF, DjVu) sans miniature, à traiter si leur part compte.

- [ ] **Step 4: `npm test`** → vert.

- [ ] **Step 5: Commit** — `feat(catalog): descriptions Wikidata et métadonnées Commons reprenables, miniatures 330 px, auteur en texte brut`

---

### Task 7: `emit`, commande `compute`, fichiers de référence, jobs de construction

**Files:**
- Create: `catalog/src/emit.ts`, `catalog/src/emit.test.ts`, `catalog/src/pipeline.test.ts`, `catalog/fixtures/expected/cards.csv`, `catalog/fixtures/expected/media.csv`, `catalog/fixtures/expected/counts.json`
- Modify: `catalog/src/compute.ts` (`computeCommand`), `catalog/src/cli.ts`, `.github/workflows/catalog.yml`

**Interfaces:**
- Consumes : tout ce qui précède.
- Produces :
  - `emit.ts` :
    - `CARD_CSV_COLUMNS` = `page_id, wikipedia_title, wikipedia_url, lang, rarity, atk, def, q_score, pageviews, pageviews_refreshed_at, qscore_refreshed_at, category, summary, image_url` : les colonnes miroir de `cards` (D§10.2) sans celles que la base possède (`id`, `hide_image`, `nsfw_image`, `created_at`), plus `page_id` ;
    - `MEDIA_CSV_COLUMNS` = `page_id, file, author, license, license_url` ;
    - `csvField(v: string | number | null): string` ; `wikipediaUrl(title: string): string` (`https://fr.wikipedia.org/wiki/` + `encodeURIComponent` du titre, espaces en `_`, comme `seed.sql`).
  - `compute.ts` : `computeCommand(o: { dir: string; out: string; mode: Mode; month: string; textDate: string; textSource: 'cirrus' | 'extracts'; client?: Client }): Promise<Counts>`.
    - Il lit `catalog.tsv`, les `text-*.tsv`, `desc.tsv` et `media.tsv` ; `category` = description Wikidata du qid (`null` sinon) ; `image_url` et la ligne de `media.csv` viennent de la ligne `media.tsv` de l'image.
    - Complément (P11) : pages `selected` dont le texte Cirrus ne passe pas `hasOpening` → TextExtracts, écrit en ajout dans `extracts.tsv`.
    - `textSource: 'extracts'` : `text_bytes` = `len`, `incoming_links` = 0, tous les résumés viennent de TextExtracts.
    - Page absente de Cirrus : `text_bytes` = `len` (`shortcut:` unités différentes, rare).
    - `statsV1` sur **toutes** les lignes de `catalog.tsv` (M2-2) ; sortie pour les seules lignes `selected`.
    - Il écrit `out/cards.csv`, `out/media.csv` (une ligne par carte dont le média a un `image_url`) et `out/counts.json` (`Counts` + `month`, `text_date`, `text_source`).
  - Artefacts de `catalog.yml` : `dumps` (`pages.tsv`, `props.tsv`), `views`, `select` (`catalog.tsv`, `counts.json`), `text-<NNNNN>`, `desc`, `media`, `catalog-out` (`cards.csv`, `media.csv`, `counts.json`).

- [ ] **Step 1: Tests qui échouent**
  - `emit.test.ts` : `csvField(null)` = `` ; `csvField('')` = `""` ; `csvField('a"b')` = `"a""b"` ; `csvField(3)` = `3` ; `csvField('x,y\nz')` = `"x,y\nz"` ; `wikipediaUrl("Arc de triomphe de l'Étoile")` = `https://fr.wikipedia.org/wiki/Arc_de_triomphe_de_l'%C3%89toile`.
  - `pipeline.test.ts`, de `raw/` vers un dossier temporaire : `dumps` (fichiers en clair), `pageviews` (`raw/pageviews.txt`, `minLines: 0`), `select` (`sample`, `rate` 1), `cirrus` (`raw/cirrus.ndjson`, part `fixtures`), puis `wikidata`, `commons` et `compute`. Le client simulé sert les corps de `raw/*.json` par URL et fait échouer le test sur une URL inconnue. `month` et `textDate` viennent de `raw/meta.json`.
    - `cards.csv`, `media.csv` et `counts.json` égalent `toMatchFileSnapshot('../fixtures/expected/…')` ;
    - les lignes sont exactement les ids de catalogue de `raw/ids.tsv` : aucune redirection, homonymie ni page d'un autre espace ;
    - pour chaque ligne : `rarity` = `rarityForViews(pageviews)` ; `atk` et `def` dans [1000, 10000] ; `q_score` dans [0, 100] ; `summary` ≤ 600 caractères ; `wikipedia_title` sans `_` ;
    - les AdQ ont `q_score` ≥ 20 et les BA ≥ 12 ;
    - `pageviews_refreshed_at` = 1er du mois suivant `month` à `T00:00:00Z` ;
    - les `page_id` de `media.csv` sont inclus dans ceux de `cards.csv` ;
    - deux exécutions donnent les mêmes octets.

- [ ] **Step 2: `npm test -- catalog`** → échec.

- [ ] **Step 3: Implémenter**, puis lancer `npx vitest run catalog/src/pipeline.test.ts` hors CI (les fichiers de référence s'écrivent). Relire `cards.csv` (titres, résumés, rareté des pages choisies pour L et UR, URLs d'images) et corriger avant de les figer.

- [ ] **Step 4: Jobs de `catalog.yml`** (tous `if: (inputs.mode || 'sample') != 'fixtures' && inputs.artifacts_run_id == ''`, checkout `persist-credentials: false`, `setup-node`, sans `npm ci`, `ubuntu-24.04`) :

  | Job | `needs` | Contenu | `timeout-minutes` |
  |---|---|---|---|
  | `dumps` | — | `curl` des deux dumps, `dumps` ; sorties `month` (mois civil précédent) et `cirrus_date`, `cirrus_parts` (JSON, `cirrus-list`) | 60 |
  | `pageviews` | `dumps` | `lbzip2`, `curl … pageviews-<month>-user.bz2 \| lbzip2 -dc \| grep '^fr.wikipedia ' \| node catalog/src/cli.ts pageviews --dir work` | 120 |
  | `select` | `dumps`, `pageviews` | taux = `inputs.sample_rate`, sinon `psql "$SUPABASE_DB_URL" -qAtX -c "select value from wm.config where key = 'sample_rate'"` (P2) ; `select` ; `NODE_OPTIONS: --max-old-space-size=6144` | 30 |
  | `text` | `dumps`, `select` | matrice `part: ${{ fromJSON(needs.dumps.outputs.cirrus_parts) }}`, `max-parallel: 10`, `curl \| lbzip2 -dc \| cirrus` ; sauté si `text_source = extracts` | 60 |
  | `wikidata` | `select` | `actions/cache/restore@v6` puis `actions/cache/save@v6` (`if: always()`, clé `wikidata-<month>-<run_id>`, préfixe de restauration `wikidata-<month>-`) autour de `wikidata --per-minute 100` (les deux jobs d'API tournent ensemble : leur somme reste à 200/min) | 345 |
  | `commons` | `select` | même schéma, préfixe `commons-<month>-`, `--per-minute 100` | 345 |
  | `compute` | `dumps`, `select`, `text`, `wikidata`, `commons` | `if: always()` sans `needs` en échec (`text` peut être sauté) ; télécharge `text-*` (`merge-multiple: true`), `compute` ; `NODE_OPTIONS` comme `select` ; artefact `catalog-out` | 120 |

  Artefacts intermédiaires en `retention-days: 3`, `catalog-out` en 7.

- [ ] **Step 5: `npm test && npm run typecheck && npm run lint`** → vert.

- [ ] **Step 6: Commit** — `feat(catalog): cards.csv et media.csv, fichiers de référence, jobs de construction de catalog.yml`

- [ ] **Step 7 (contrôleur): Run de construction seule** sur la branche : `mode: sample`, `sample_rate: 0.09`, `load: false`. Attendu : tous les jobs verts. Noter pour la Task 11 et `docs/verifications.md` : durée de chaque job, taille des artefacts, nombre de lignes de `cards.csv`, `counts.json` (comptes complets par rareté). Un échec ici se corrige avant la Task 8.

---

### Task 8: Pool *swap-with-last*, `pick_card`, χ², garde DML

**Files:**
- Create: `supabase/migrations/1500_wm_pool.sql`, `supabase/tests/25_pool.test.sql`, `supabase/tests/chi2.sql`, `scripts/check-dml.ts`, `scripts/check-dml.test.ts`
- Modify: `scripts/db-test.sh` (lance `node scripts/check-dml.ts` avant les migrations), `supabase/migrations/1300_wm_collection.sql:63` (`where true`), `supabase/migrations/1200_wm_packs.sql:64` (commentaire `shortcut:` : la reconstruction ne sert plus qu'au seed du banc)

**Interfaces:**
- Produces :
  - `wm.pool_add(p_card_id uuid, p_rarity public.rarity) returns void` : verrouille la ligne de `catalog_stats` de la rareté (créée à 0 si absente), insère `(p_rarity, n + 1)`. Déjà au pool avec cette rareté → rien ; avec une autre → `pool_remove`, puis ajout.
  - `wm.pool_remove(p_card_id uuid) returns boolean` : `false` si la carte n'est pas au pool ; sinon verrou de la ligne de stats, `delete` de `(r, k)`, la ligne `(r, n)` passe à `seq = k` si `k < n`, puis `n − 1`.
  - `wm.pick_card(p_weights jsonb, p_exclude public.rarity[] default '{}') returns uuid` : une **seule** instruction SQL (deux `random()` tirés une fois dans un CTE `materialized`), donc `catalog_stats` et `draw_pool` lus dans le même instantané ; poids non objet → `n_r` ; `null` si rien n'est tirable.
  - `wm.draw_cards` : même signature et même réponse, le choix passe par `pick_card` ; `null` → 503 `catalog_empty`.
  - `supabase/tests/chi2.sql` : `create temp view chi2 as …` sur 100 000 appels `wm.pick_card(null, '{}')`, colonnes `draws, chi2_rarity, df_rarity, chi2_seq, df_seq`. `chi2_seq` porte sur la rareté la plus nombreuse en 20 classes égales de `seq`, l'attendu de chaque classe étant proportionnel à sa largeur.
  - `scripts/check-dml.ts` : `unguardedDml(sql: string): string[]` (commentaires `--` retirés, découpe sur `;`, instruction `delete from …` ou `update <table> set …` sans `where`) ; en CLI, sur `supabase/migrations/*.sql`, imprime `fichier : instruction` et sort avec 1.

- [ ] **Step 1: Tests qui échouent**
  - `check-dml.test.ts` : `delete from t;` et `update wm.x set a = 1;` sont signalés ; `delete from t where true;`, `update t set a = 1\n where id = 2;` et `insert … on conflict (k) do update set v = excluded.v;` ne le sont pas ; un `-- delete from t;` en commentaire non plus.
  - `25_pool.test.sql` (transaction annulée) :
    - **densité (M2-10)** : 5 C, 3 R et 1 L ajoutées, retrait d'une C du milieu, R passée en L, retrait de la dernière C, remise de la première → pour chaque rareté, `array_agg(seq order by seq)` = `1..n`, `n` = `catalog_stats.n`, `card_id` uniques, total = `count(*)` du pool ;
    - `pool_remove` d'une carte absente → `false`, rien ne bouge ; `pool_add` répété → une seule ligne ;
    - `pick_card('{"L":1}')` ne rend que des L ; `pick_card(null, '{C,PC,R,SR,UR,L}')` → `null` ; avec `draw_weights.free` à `{"L":1}` et aucune L au pool, `draw_cards` lève 503 `catalog_empty` (branche « pool manqué ») ;
    - une carte `hide_image` et une carte `nsfw_image`, seules au pool, sortent de `pick_card` ;
    - **χ² (M2-11)** : `\ir ../seed.sql`, `select setseed(0.42)`, `\ir chi2.sql`, puis `chi2_rarity < 20.515` avec `df_rarity = 5`, et `chi2_seq < 43.82` avec `df_seq = 19`.
  - Les fichiers existants (`22_packs`, `12_packs_concurrency`, `14_claims_concurrency`) restent verts sans modification.

- [ ] **Step 2: `npm run test:db`** → `FAIL` (garde DML sur `1300:63`, puis `25_pool.test.sql`).

- [ ] **Step 3: Implémenter** `1500_wm_pool.sql` (en-tête ADDITIVE, compatible pg-safeupdate, fin `revoke`/`grant`) et la garde. Une ligne de commentaire dans `pool_add` sur l'ordre des verrous (une rareté à la fois ; un déplacement verrouille l'ancienne puis la nouvelle, sans risque tant que le merge est seul à déplacer).

- [ ] **Step 4: `npm test && npm run test:db`** → `ok 25_pool.test.sql` et tous les autres `ok`.

- [ ] **Step 5: Commit** — `feat(db): pool par swap-with-last, tirage pur pick_card, χ² sur 100 k tirages, garde DML sans WHERE`

---

### Task 9: Tables du catalogue, `catalog_merge` et `catalog_finalize`

**Files:**
- Create: `supabase/migrations/1510_wm_catalog_merge.sql`, `supabase/tests/26_catalog_merge.test.sql`

**Interfaces:**
- Consumes : `wm.pool_add`, `wm.pool_remove` (Task 8) ; `wm.raise_err`, `wm.check_invariants` (M0, M1) ; `CARD_CSV_COLUMNS`, `MEDIA_CSV_COLUMNS` (Task 7).
- Produces :

  | Objet | Contenu |
  |---|---|
  | `wm.card_source` | `card_id uuid pk → public.cards`, `page_id bigint not null unique` |
  | `wm.card_media` | `card_id uuid pk → public.cards`, `file text not null`, `author text`, `license text`, `license_url text` |
  | `wm.card_removals` (P8) | `card_id uuid pk → public.cards`, `reason text`, `removed_by uuid`, `removed_at timestamptz not null default now()` |
  | `wm.catalog_stage` | `page_id bigint pk`, les 13 autres colonnes de `CARD_CSV_COLUMNS` dans le même ordre (types de `public.cards`, `atk`, `def` et `pageviews` `not null`), puis `result text` |
  | `wm.catalog_stage_media` | `page_id bigint pk`, `file text not null`, `author`, `license`, `license_url` |
  | `wm.catalog_runs` | `id bigint identity pk`, `mode text not null`, `finished_at timestamptz not null default now()`, `summary jsonb not null` |

  Clés `wm.config` (avec `note`) : `catalog_frozen` `false` (bascule, D§10.3.5) ; `catalog_stats_frozen` `false` (`true` en option A, D§10.1) ; `sample_rate` `0.09` (provisoire, mesuré à la Task 11 ; lu par le job `select`, P2).

  | Fonction | Rôle |
  |---|---|
  | `wm.catalog_merge(p_mode text, p_limit int default 50000) returns jsonb` | `{processed, frozen: false}` ou `{processed: 0, frozen: true}` ; `p_mode` hors `full`/`sample` → 400 `invalid_request` « Mode de chargement inconnu » |
  | `wm.catalog_finalize(p_mode text) returns jsonb` | Résumé `{mode, staged, inserted, updated, unchanged, renamed, conflicts, pool_out, pool: {L, UR, SR, R, PC, C}}`, aussi écrit dans `catalog_runs` ; `{frozen: true}` si gelé ; stage vide → 409 `catalog_stage_empty` « Aucun chargement à finaliser » ; lignes sans `result` → 409 `catalog_stage_pending` « Chargement inachevé : relancer catalog_merge » |

  **Règles de `catalog_merge`**, sur les `p_limit` premières lignes `result is null` par `page_id`, en une transaction :
  1. Carte = `card_source.page_id`, sinon une carte de même `(lang, wikipedia_title)` **sans** `card_source` (option A, D§10.3.1), qui reçoit alors son `card_source`.
  2. Sans carte : si le titre appartient à une carte liée à un autre `page_id` → `conflict` (P7) ; sinon insertion (toutes les colonnes, `gen_random_uuid()`) et `card_source` → `inserted`.
  3. Avec carte : mise à jour de la liste blanche (D§6.3) seulement où une valeur diffère (`is distinct from`). `atk`, `def`, `q_score` et `qscore_refreshed_at` restent si `catalog_stats_frozen` ; `image_url` reste si `hide_image or nsfw_image` (P6). Résultat `renamed` si le titre du stage diffère (titre jamais réécrit, M2-20), sinon `updated` ou `unchanged`.
  4. `card_media` (sauf drapeau image) : upsert depuis `catalog_stage_media`, suppression de la ligne si la page n'a plus de média ; seulement si une valeur diffère.
  5. Pool : carte dans `card_removals` → `pool_remove` ; sinon `pool_add(carte, rareté)`.

  **`catalog_finalize`** : `pool_remove` de chaque carte du pool dont le `page_id` (par `card_source`) n'est pas dans le stage, cartes sans `card_source` comprises (le seed sur la démo, M2-12) ; résumé compté sur `result` ; `truncate` des deux tables de stage. Aucune ligne de `public.cards` n'est supprimée.

- [ ] **Step 1: Test qui échoue** (`26_catalog_merge.test.sql`, transaction annulée, stage rempli par `insert` dans le test, `pg_temp.err` repris de `10_wm_core.test.sql`) :
  - Premier passage sur 6 pages (une par rareté, dont 3 avec média) : 6 cartes, 6 `card_source`, 3 `card_media`, pool et `catalog_stats` à 1 par rareté. `finalize` → `inserted: 6`, stage vide, une ligne dans `catalog_runs`.
  - **Idempotence** : le même stage rechargé → `unchanged: 6`, ids identiques (`array_agg(card_id order by page_id)`), `md5` de `public.cards`, `card_media` et `draw_pool` identiques.
  - **Liste blanche** : un stage avec un autre titre, une autre URL et une autre langue pour une carte existante, après avoir mis `hide_image` et `nsfw_image` à `true` sur une autre → `id`, `wikipedia_title`, `wikipedia_url`, `lang`, `hide_image`, `nsfw_image` et `created_at` inchangés (comparaison par `md5`) ; `rarity`, `pageviews`, `summary` et `category` mis à jour.
  - `catalog_stats_frozen = true` → `atk`, `def`, `q_score` et `qscore_refreshed_at` inchangés, `rarity` et `pageviews` mis à jour.
  - Carte `hide_image` → `image_url` et `card_media` inchangés malgré un autre média dans le stage.
  - ***Review Focus*, renommage** : page 101 liée à la carte « Ancien » ; le stage contient 101 « Nouveau » et une nouvelle page 202 « Ancien » → la carte de 101 garde son id et le titre « Ancien », `result` `renamed` ; 202 → `conflict`, aucune carte créée, aucune erreur ; le résumé compte `renamed: 1, conflicts: 1`.
  - Carte sans `card_source` de même titre que le stage → même id, `card_source` créé.
  - ***Review Focus*, rareté qui change sur une carte possédée** : un joueur (`tests.make_user`) a une copie de la carte X (`snapshot_rarity` `C`, par `wm.grant_copy`) ; le stage passe X en `R` → `cards.rarity` = `R`, `snapshot_rarity` = `C`, `wm.user_rarity_counts` inchangé, X en `R` au pool, densité vérifiée comme à la Task 8, `wm.check_invariants()` = `'[]'`.
  - Carte de `card_removals` présente dans le stage → hors pool après le merge.
  - `catalog_frozen = true` → `catalog_merge` rend `{processed: 0, frozen: true}` et `catalog_finalize` `{frozen: true}`, rien ne change.
  - Lots : `p_limit` 2 sur 5 lignes → `processed` 2, 2, 1, puis 0.
  - Finalisation : une carte au pool absente du stage et une carte sans `card_source` sortent du pool, `count(*)` de `public.cards` est inchangé ; deuxième `finalize` → 409 `catalog_stage_empty` ; `finalize` avec une ligne sans `result` → 409 `catalog_stage_pending`.
  - `catalog_merge('x')` → 400 « Mode de chargement inconnu ».

- [ ] **Step 2: `npm run test:db`** → `FAIL 26_catalog_merge.test.sql`.

- [ ] **Step 3: Implémenter `1510_wm_catalog_merge.sql`** : étapes 1 à 4 ensemblistes, boucle seulement pour le pool (étape 5) ; fin `revoke`/`grant` du M0.

- [ ] **Step 4: `npm run test:db`** → tout `ok`.

- [ ] **Step 5: Commit** — `feat(db): card_source, card_media, stage, catalog_merge par lots et catalog_finalize (liste blanche, ids stables)`

---

### Task 10: `load.ts`, chargement de bout en bout, job `load`

**Files:**
- Create: `catalog/src/load.ts`, `catalog/src/load.test.ts`, `supabase/tests/15_catalog_load.test.sh`
- Modify: `catalog/src/cli.ts` (commande `load`), `.github/workflows/catalog.yml` (job `load`)

**Interfaces:**
- Consumes : `CARD_CSV_COLUMNS`, `MEDIA_CSV_COLUMNS`, `Counts` (Tasks 2 et 7) ; `wm.catalog_merge`, `wm.catalog_finalize` (Task 9).
- Produces :
  - `MAX_BYTES = 450e6` ; `BYTES_PER_CARD = 2_000` et `STAGE_BYTES_PER_ROW = 1_500` (provisoires, prudents, remplacés à la Task 11) ;
  - `guardBeforeCopy(size: number, rows: number, target: 'free' | 'pro'): string | null` et `guardAfterCopy(size: number, newRows: number, target: 'free' | 'pro'): string | null` (`null` = accepté ; sinon `Base trop pleine pour la cible free : <projection> octets projetés (limite 450000000)`) ;
  - `maxShareGap(pool: Record<RarityCode, number>, full: Record<RarityCode, number>): number` (écart maximal en points de part) ;
  - `loadCommand(o: { dir: string; mode: Mode; target: 'free' | 'pro'; db: string; batch?: number }): Promise<Record<string, unknown>>`, dans l'ordre :
    1. taille (`pg_database_size(current_database())`) et `guardBeforeCopy` ;
    2. essai : les 10 premières lignes de `cards.csv` copiées par `\copy` dans le stage, compte vérifié, `truncate` (journal : `essai \copy : 10 lignes`) ;
    3. `truncate` des deux stages, puis `\copy … with (format csv, header true)` de `cards.csv` et `media.csv` ;
    4. `guardAfterCopy` avec les lignes du stage sans `card_source` ; refus → `truncate` des stages et erreur ;
    5. boucle `select wm.catalog_merge(<mode>, <batch>)` jusqu'à `processed = 0` (défaut 50 000) ; `frozen` → `truncate` des stages, sortie 0 avec `Catalogue gelé : rien chargé` ;
    6. `catalog_finalize`, puis `vacuum (analyze) public.cards, wm.draw_pool, wm.card_source, wm.card_media` ;
    7. `maxShareGap(catalog_stats, counts.full)` > 1 → erreur `Parts de rareté hors tolérance : <écart> points` ;
    8. impression du résumé JSON.
  - Chaque appel passe par `psql <db> -qAtX -v ON_ERROR_STOP=1 -c 'set statement_timeout = 0' -c …` (M2-17), et l'URL n'est jamais journalisée.

- [ ] **Step 1: Tests qui échouent** (`load.test.ts`, *Review Focus*)
  - `guardBeforeCopy(400e6, 100_000, 'free')` → message (400e6 + 100 000 × 1 500 > 450e6) ; `guardBeforeCopy(400e6, 100_000, 'pro')` → `null`.
  - `guardAfterCopy(440e6, 0, 'free')` → `null` (second passage sans nouvelle carte) ; `guardAfterCopy(440e6, 10_000, 'free')` → message.
  - `maxShareGap({L: 1, C: 99, …0}, {L: 2, C: 98, …0})` = 1 ; des parts égales → 0.
- [ ] **Step 2: Test de bout en bout qui échoue** (`15_catalog_load.test.sh`, gabarit de `12_packs_concurrency.test.sh` : `set -euo pipefail`, `q()`, `trap cleanup EXIT` qui retire du pool, puis supprime `card_media`, `card_source`, `catalog_runs` et les cartes chargées, et relance `wm.rebuild_draw_pool()`) :
  - Chargement de `catalog/fixtures/expected` (`--mode sample --target free --db "$DATABASE_URL"`) → `inserted` = nombre de lignes de `cards.csv`, journal contenant `essai \copy : 10 lignes` ; noter `ids1` (`string_agg(card_id || ':' || page_id, ',' order by page_id)` de `card_source`) et `state1` (`md5` de `public.cards`, `card_media` et `draw_pool`).
  - Second chargement, pendant que 200 `select wm.pick_card(null, '{}') is null` tournent en arrière-plan → `unchanged` = nombre de lignes, `inserted: 0` ; `ids` = `ids1`, `state` = `state1`, aucun tirage `t` (pas de 503 pendant une fusion).
  - ***Review Focus*, interruption** : copie de `expected` où chaque `summary` finit par ` v2` ; `\copy` dans le stage, un seul `catalog_merge('sample', 50)` (interruption simulée), puis `load` complet sur cette copie → toutes les cartes ont ` v2`, `ids` = `ids1`, pool dense, stage vide, `updated` + `unchanged` = nombre de lignes.
  - `wm.check_invariants()` = `[]`.

- [ ] **Step 3: `npm test -- catalog/src/load.test.ts && npm run test:db`** → échec.

- [ ] **Step 4: Implémenter**, puis le job `load` de `catalog.yml` :
  - `needs: compute`, `if: always() && (inputs.mode || 'sample') != 'fixtures' && (inputs.load || github.event_name == 'schedule') && (needs.compute.result == 'success' || inputs.artifacts_run_id != '')` ; `timeout-minutes: 120` ; `env: APP_URL: https://wmr-ivm.vercel.app` (M2-17) ;
  - checkout, `setup-node`, `actions/download-artifact@v7` `catalog-out` (de ce run, ou de `inputs.artifacts_run_id` avec `run-id` et `github-token`) ;
  - `node catalog/src/cli.ts load --dir out --mode … --target … --db "$SUPABASE_DB_URL"` ;
  - `curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" "$APP_URL/api/cron/revalidate"` (la route arrive à la Task 13 ; le job ne tourne pour de vrai qu'à la Task 15).

- [ ] **Step 5: `npm test && npm run test:db && npm run typecheck && npm run lint`** → `ok 15_catalog_load.test.sh`, tout vert.

- [ ] **Step 6: Commit** — `feat(catalog): chargement psql (gardes de taille, essai \copy, fusion par lots, finalisation, contrôle des parts), job load`

---

### Task 11: Mesure de la taille par carte et taux de l'échantillon (M2-3)

**Files:**
- Modify: `catalog/src/load.ts` (`measureCommand`, `rateFor`, constantes), `catalog/src/load.test.ts`, `catalog/src/cli.ts`, `supabase/migrations/1510_wm_catalog_merge.sql` (valeur de `sample_rate`), `docs/verifications.md`

**Interfaces:**
- Produces :
  - `rateFor(o: { base: number; bytesPerCard: number; stageBytesPerRow: number; nFull: number }): number` = plus grand multiple de 0,005 qui tient à la fois `base + N × B ≤ 350e6` (régime établi) et `base + N × (B + S) ≤ 450e6` (pic du premier chargement), avec `N = rate × nFull` ;
  - `measureCommand(o: { db: string; csvDir: string; copies: number }): Promise<{ rows: number; stageBytesPerRow: number; bytesPerCard: number }>`.
    1. Il réplique `copies` fois les lignes de `cards.csv` et `media.csv` (`page_id + k × 10^7`, titre suffixé de ` (k)`, URL recalculée), mesure la base après `\copy` (S), puis après merge, finalisation et `vacuum`.
    2. Il refait un passage « mensuel » où toutes les `pageviews` ont +1, suivi d'un `vacuum` (le gonflement d'une mise à jour complète entre dans B).
    3. B = (taille finale − taille initiale) / lignes.

- [ ] **Step 1: Test qui échoue** : `rateFor({base: 16e6, bytesPerCard: 1400, stageBytesPerRow: 900, nFull: 2_773_461})` = 0.065 (le pic limite à 188 695 cartes) ; avec `stageBytesPerRow: 0`, la limite du régime établi s'applique (0.085).
- [ ] **Step 2: Implémenter**, puis `npm test -- catalog/src/load.test.ts` → vert.
- [ ] **Step 3: Mesurer sur le banc**
  ```bash
  eval "$(bash scripts/db-test.sh --setup-only)"
  node catalog/src/cli.ts measure --db "$DATABASE_URL" --csv-dir catalog/fixtures/expected --copies 1000
  bash scripts/db-test.sh --stop
  ```
  Attendu : un JSON `{rows ≈ 300 000, stageBytesPerRow, bytesPerCard}` ; durée de quelques minutes.
- [ ] **Step 4: Inscrire les résultats**
  - `BYTES_PER_CARD` et `STAGE_BYTES_PER_ROW` = valeurs mesurées arrondies au-dessus (+10 %).
  - `sample_rate` de `1510` = `rateFor` avec `base` = 16e6 (taille de la démo du 2026-10-20) et `nFull` = total de `counts.json` du run de la Task 7 (sinon 2 773 461) ; `note` = « Part de chaque rareté chargée sur le plan Free (C9, M2-3), mesurée le <date> : <B> o/carte, <S> o/ligne de stage ».
  - `docs/verifications.md`, section « M2 — Task 11 : taille du catalogue » : commande, sortie, calcul du taux.
  - Taux < 0,09 → une ligne dans `docs/decisions-graphify.md`, section « Écart au design » : « C9 : échantillon de <taux> au lieu de ≈ 9 % (M2-3, mesure du <date>) ».
- [ ] **Step 5: `npm test && npm run test:db`** → vert (`15_catalog_load` passe avec les nouvelles constantes).
- [ ] **Step 6: Commit** — `feat(catalog): taille par carte mesurée sur le banc, taux de l'échantillon Free`

---

### Task 12: Pages partagées, overlay, pool seulement, crédits (SQL)

**Files:**
- Create: `supabase/migrations/1520_wm_catalog_pages.sql`
- Modify: `supabase/tests/24_catalog.test.sql`

**Interfaces:**
- Consumes : `wm.draw_pool`, `wm.catalog_stats` (M1) ; `wm.card_media` (Task 9) ; `wm.pool_add` (Task 8).
- Produces :
  - `wm.cards_page_shared(p_page int default 0, p_sort text default 'rarity', p_q text default null, p_rarity public.rarity[] default null) returns jsonb` → `{cards, total, rarityCounts?, searchHasMore?}` : le parcours et la recherche de `1400` sans joueur, recherche jointe à `wm.draw_pool` (M2-13) ; `p_sort` autre que `rarity` → 400 `invalid_request` « Tri inconnu » ; même message que `1400` pour un `q` d'un caractère.
  - `wm.cards_overlay(p_uid uuid, p_card_ids uuid[]) returns jsonb` → `{ownedCardIds, wishlistCardIds, friendOwners: {}}`, dans l'ordre de `p_card_ids`, limité à ces ids.
  - `wm.cards_page` : même signature et même réponse. Sans `wishlist` ni `missing`, il vaut `cards_page_shared(…) || cards_overlay(p_uid, ids)` ; avec l'un des deux, l'ancien chemin restreint au pool (`join` au lieu de `left join`, ordre `rarity desc, seq, id`), puis l'overlay.
  - `wm.card_credits(p_card_id uuid) returns jsonb` → `{file, image_author, image_license, license_url}` ; pas de ligne `card_media` → 404 « Carte introuvable ».

- [ ] **Step 1: Tests qui échouent** (`24_catalog.test.sql`)
  - Pour le parcours page 0 et 1, `p_rarity '{UR,C}'` et une recherche : `cards_page(uid, …)` = `cards_page_shared(…) || cards_overlay(uid, ids de la page)`.
  - `cards_overlay(uid, array[b, a])` rend `[b, a]` filtrés sur ce que le joueur possède ou souhaite ; un id hors liste n'y est jamais.
  - Le bloc option A (`tests_cards_writer`, lignes 170-190) : la carte 131 écrite par le rôle n'est pas trouvée tant qu'elle est hors pool ; après `wm.pool_add(card(131), 'L')`, `GEOGRAPHIE TARDIVE` la trouve. L'assertion « hors pool en dernier » devient : `p_missing` ne rend que des cartes du pool.
  - Une carte hors pool n'apparaît ni en recherche, ni avec `p_wishlist`, ni avec `p_missing`.
  - `cards_page_shared(0, 'xyz')` → 400 « Tri inconnu ».
  - `card_credits` d'une carte avec média → les quatre clés ; d'une carte sans média ou d'un id inconnu → 404 « Carte introuvable ».

- [ ] **Step 2: `npm run test:db`** → `FAIL 24_catalog.test.sql`.
- [ ] **Step 3: Implémenter `1520_wm_catalog_pages.sql`** (sans `DELETE`, M2-18) ; fin `revoke`/`grant`.
- [ ] **Step 4: `npm run test:db && npm run build:test && npm run test:contract`** → vert (contrat de `/api/cards` inchangé).
- [ ] **Step 5: Commit** — `feat(db): page partagée du catalogue et overlay joueur, catalogue limité au pool, crédits d'une image`

---

### Task 13: Routes — cache de `/api/cards`, `/api/cron/revalidate`, `/api/cards/[id]/credits`

**Files:**
- Create: `lib/catalog-cache.ts`, `lib/catalog-cache.test.ts`, `app/api/cron/revalidate/route.ts`, `app/api/cron/revalidate/route.test.ts`, `app/api/cards/[id]/credits/route.ts`, `contract/spec/cron.ts`, `contract/spec/credits.ts`
- Modify: `lib/route.ts`, `lib/route.test.ts`, `app/api/cards/route.ts`, `contract/harness.ts` (`CRON_SECRET: 'test-cron'` pour les deux serveurs Next), `contract/spec/catalog.ts`, `contract/spec/index.ts`

**Interfaces:**
- Consumes : fonctions de la Task 12.
- Produces :
  - `lib/route.ts` exporte `type RpcResult = { data: unknown; error: { code?: string; message?: string; details?: string | null } | null }`, et `route()` (P10) gagne :
    - `call?: (args: Record<string, unknown>) => Promise<RpcResult>` (défaut : `createAdminClient().schema('wm').rpc(opts.fn, args)` ; `fn` reste le nom journalisé) ;
    - `headers?: Record<string, string>` (ajoutés à une réponse 200 seulement).
  - `lib/catalog-cache.ts` :
    - `type SharedPage = { cards: { id: string }[]; total: number | null; rarityCounts?: Record<string, number>; searchHasMore?: boolean }` ;
    - `normalizeQ(q: string | undefined): string | null` (`trim`, minuscules, vide → `null`) ;
    - `sharedCardsPage(page: number, sort: 'rarity', q: string | null, rarity: string[] | null): Promise<SharedPage>` : `'use cache: remote'`, `cacheTag('catalog')`, `cacheLife('hours')`, RPC `cards_page_shared` ; les arguments forment la clé (M2-14) ; une erreur PostgREST est levée (rien n'est mis en cache) ;
    - `cardsCall(args: Record<string, unknown>): Promise<RpcResult>` : `p_wishlist` ou `p_missing` → RPC `cards_page` ; sinon `sharedCardsPage(p_page, 'rarity', normalizeQ(p_q), raretés triées et dédoublonnées ou null)` puis RPC `cards_overlay({p_uid, p_card_ids})`, fusionnés ; une erreur levée devient `{data: null, error}`.
  - `app/api/cards/route.ts` : même `route({ fn: 'cards_page', input, args })` + `call: cardsCall`.
  - `POST /api/cron/revalidate` (M2-15) : `CRON_SECRET` absent → 503 `{code: 'cron_disabled', error: 'Tâche planifiée non configurée.'}` ; `x-cron-secret` absent ou faux (`timingSafeEqual` des SHA-256) → 401 `{code: 'unauthorized', error: 'Secret de tâche planifiée invalide.'}` ; sinon `revalidateTag('catalog', 'max')` → 200 `{revalidated: true}`. Corps d'erreur construits par `fail()` (`error` = `message`).
  - `GET /api/cards/{id}/credits` : `route({ fn: 'card_credits', auth: false, params: z.object({ id: z.uuid() }), args: (_, { params }) => ({ p_card_id: params.id }), headers: { 'Cache-Control': 'public, max-age=86400, s-maxage=2592000' } })`.

- [ ] **Step 1: Tests unitaires qui échouent**
  - `route.test.ts` : `headers` présents sur un 200 et absents sur un 404 ; `call` remplace la RPC (l'admin simulé n'est pas appelé) et son `error` P0001 est traduit comme une RPC.
  - `catalog-cache.test.ts` (`next/cache` simulé : `cacheTag`, `cacheLife` sans effet) :
    - `{p_page: 0, p_q: '  ChAt ', p_rarity: ['UR', 'L', 'UR'], p_uid: 'u'}` → `cards_page_shared` reçoit `{p_page: 0, p_sort: 'rarity', p_q: 'chat', p_rarity: ['L', 'UR']}`, puis `cards_overlay` les ids de la page, et la réponse a les clés des deux ;
    - `p_wishlist: true` → `cards_page` seul ;
    - erreur P0001 de `cards_page_shared` → `{data: null, error}`, aucun overlay ; `normalizeQ('   ')` = `null`.
  - `revalidate/route.test.ts` (`revalidateTag` simulé) : sans `CRON_SECRET` → 503 et aucun appel ; mauvais secret, secret de longueur différente ou en-tête absent → 401 ; bon secret → 200, avec `revalidateTag('catalog', 'max')` appelé une fois.
- [ ] **Step 2: Specs de contrat qui échouent**
  - `catalog.ts`, cas « page en cache jusqu'à la revalidation » :
    1. `GET /api/cards` page 0 ;
    2. psql ajoute ` (revalidé)` au `summary` de la première carte ;
    3. nouveau `GET` → ancien résumé ;
    4. `POST /api/cron/revalidate` avec `x-cron-secret: test-cron` → 200 ;
    5. `GET` répété toutes les 250 ms, au plus 5 s → nouveau résumé (le profil `max` sert d'abord la page périmée) ;
    6. restauration du résumé et nouvelle revalidation.
  - `cron.ts` (`source: 'D§5.3'`, `confidence: 'ajouté'`) : sans en-tête → 401 ; faux → 401 ; bon → 200 `{revalidated: true}` ; par le serveur à porte (3101), sans cookie de porte et avec le bon secret → 200.
  - `credits.ts` (`source: 'D§7.4'`, `confidence: 'ajouté'`) :
    - carte du seed avec une ligne `card_media` insérée par psql (`file 'Test.jpg'`, `author 'Jean Dupont'`, `license 'CC BY-SA 4.0'`, `license_url 'https://creativecommons.org/licenses/by-sa/4.0'`) → 200 avec exactement ces quatre valeurs, et `cache-control` = `public, max-age=86400, s-maxage=2592000`, sans session ;
    - carte sans média → 404 `{error: 'Carte introuvable'}`, sans cet en-tête ; `id=abc` → 400 `invalid_request`.
  - `index.ts` ajoute `cron` et `credits`.
- [ ] **Step 3: `npm test && npm run build:test && npm run test:contract`** → les nouveaux cas échouent.
- [ ] **Step 4: Implémenter.** Lire d'abord les guides Next du Global Constraints. Si `next build` refuse `'use cache: remote'` dans ce contexte : repli du D§9.5, cache mémoire de 2 s par instance dans `catalog-cache.ts` (`shortcut:` cache distant absent, à reprendre quand `cacheHandlers` est disponible), et ligne dans `docs/verifications.md`.
- [ ] **Step 5: `npm run lint && npm run typecheck && npm test && npm run build:test && npm run test:contract && npm run coverage:recap`** → vert ; couverture inchangée (28/90, routes hors recap).
- [ ] **Step 6: Commit** — `feat(api): page du catalogue en cache partagé et overlay, revalidation par secret, crédits d'une image avec cache CDN`

---

### Task 14: Licence dans la modale, page `/credits`, pied de page

**Files:**
- Create: `components/card/ImageCredit.tsx`, `components/shell/Footer.tsx`, `app/(public)/credits/page.tsx`, `e2e/credits.spec.ts`
- Modify: `components/card/CardModal.tsx:93-109` (lecture des crédits) et `:279-280` (ligne), `components/card/CardModal.test.tsx`, `app/(game)/layout.tsx` (`<Footer />` à la fin de `main`), `e2e/a11y.spec.ts`

**Interfaces:**
- Consumes : `GET /api/cards/{id}/credits` (Task 13) ; `api()` (`lib/api.ts`) ; `MIN_VIEWS` (Task 1) ; `formatInt`.
- Produces :
  - `type Credit = { file: string; image_author: string | null; image_license: string | null; license_url: string | null }` ;
  - `<ImageCredit credit={Credit} />` → `<p>Image : {image_author ?? 'auteur inconnu'}{image_license && <>, <licence></>}</p>`. La licence est un lien `target="_blank" rel="noopener noreferrer"` quand `license_url` existe, du texte sinon.
  - `CardModal` : si `card.image_url`, lecture des crédits à l'ouverture (même garde `live` que la méta) ; un 404 ou une erreur n'affiche rien. La ligne « Texte de l'article : CC BY-SA 4.0 — crédits sur la page Wikipédia. » reste, suivie de `ImageCredit` ; le `shortcut:` de la ligne 279 disparaît.
  - `<Footer />` : `<footer>` en `text-xs text-[var(--color-foreground)]/60`, « Projet indépendant de la Fondation Wikimedia · » et le lien `/credits` « Crédits » (`inline-flex min-h-11 items-center`). Il reste hors de la `nav` (le contrat `nav.hidden a` compte 13 entrées).
  - `/credits` (gabarit de `rules/page.tsx`, `metadata.title` « Crédits », « vous ») :
    - h1 « Crédits et licences » ;
    - h2 « Sources » : « Les textes des cartes viennent de Wikipédia en français, sous licence CC BY-SA 4.0. » (lien `https://creativecommons.org/licenses/by-sa/4.0/deed.fr`) ; « Les descriptions courtes viennent de Wikidata, sous licence CC0. » (lien `https://creativecommons.org/publicdomain/zero/1.0/deed.fr`) ; « Les images viennent de Wikimedia Commons : l'auteur et la licence de chaque image sont indiqués dans la fiche de la carte. » ;
    - h2 « Statistiques des cartes » : la rareté selon les vues humaines du mois civil précédent, seuils lus dans `MIN_VIEWS` (« L : 20 000 vues ou plus », …, « C : moins de 50 ») ; ATK, DEF et Q-Score par la méthode `stats_v1` décrite en mots (longueur du texte, liens entrants, label « Article de qualité » ou « Bon article », rang dans tout le catalogue) ; « Sur la démo, le catalogue est un échantillon proportionnel de chaque rareté : les totaux affichés sont ceux des cartes chargées. » ;
    - paragraphe final « Projet indépendant de la Fondation Wikimedia. ».

- [ ] **Step 1: Tests qui échouent**
  - `CardModal.test.tsx` (`renderToStaticMarkup`) :
    - `ImageCredit` avec auteur, licence et URL → `Image : Jean Dupont, ` puis `<a href="https://creativecommons.org/licenses/by-sa/4.0" target="_blank" rel="noopener noreferrer"…>CC BY-SA 4.0</a>` ;
    - sans URL → texte simple ; sans auteur → « Image : auteur inconnu, CC BY-SA 4.0 » ;
    - la ligne du texte de l'article reste identique (test existant).
  - `e2e/credits.spec.ts` :
    - `/credits` sans session → h1 « Crédits et licences », « Projet indépendant de la Fondation Wikimedia. », « L : 20 000 vues ou plus » ;
    - `/pulls` connecté → le pied de page contient la mention et un lien vers `/credits` ;
    - modale d'une copie avec image : psql insère une carte C « Zz crédits e2e <id> » avec `image_url` = `http://127.0.0.1:3100/icon` (Wikimedia est injoignable du banc) et sa ligne `card_media` (Jean Dupont, CC BY-SA 4.0, URL), puis une copie pour le joueur. Ouvrir la copie dans `/collection` → « Image : Jean Dupont, CC BY-SA 4.0 », lien de licence avec le bon `href`. Une copie sans image n'a pas de ligne « Image : ». Nettoyage : copie, `card_media`, carte.
  - `e2e/a11y.spec.ts` : `/credits` ajouté à la boucle.
- [ ] **Step 2: `npm test && npm run build:test && npx playwright test e2e/credits.spec.ts e2e/a11y.spec.ts`** → échec.
- [ ] **Step 3: Implémenter.** États de chargement et d'erreur de la ligne de crédit : rien n'est affiché tant que la réponse manque.
- [ ] **Step 4: `npm run lint && npm run typecheck && npm test && npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e`** → vert, axe à 0 violation *serious* ou *critical* sur `/credits`.
- [ ] **Step 5: Commit** — `feat(ui): auteur et licence de l'image dans la modale, page /credits, mention dans le pied de page`

---

### Task 15 (contrôleur): Livraison — démo chargée, critères de fin vérifiés, passation

**Files:**
- Modify: `.github/workflows/catalog.yml` (`schedule`), `docs/superpowers/HANDOFF.md`, `docs/suivi.md`, `docs/verifications.md`, `docs/decisions-graphify.md`
- Create (non versionné) : `.superpowers/sdd/2026-10-21-m2-catalogue-reel/deploy-m2.sql`

> Ordre (R32, M2-18) : secrets, puis migrations, puis fusion, puis chargement. `develop` est la branche de production de Vercel, et le nouveau `/api/cards` appelle `cards_page_shared`.

- [ ] **Step 1: Suite locale complète et revue de branche.** `npm run lint && npm run typecheck && npm test && npm run test:db && npm run build:test && npm run test:contract && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e && npm run coverage:recap` → tout vert ; `git ls-files catalog/fixtures` liste `README.md`, `raw/*` et `expected/*`. Puis la revue finale de la branche (R31) et ses corrections.
- [ ] **Step 2 (humain, demandé maintenant): Secrets** (M2-17), écrans exacts à donner :
  1. Supabase, projet `iggurckxmoagsajzrnwd` → bouton **Connect** → **Session pooler** → copier l'URI `postgresql://postgres.iggurckxmoagsajzrnwd:[YOUR-PASSWORD]@aws-…pooler.supabase.com:5432/postgres`. Remplacer `[YOUR-PASSWORD]` par le mot de passe encodé en pourcentage. S'il est perdu : **Project Settings → Database → Reset database password** (l'app n'utilise que les clés d'API).
  2. GitHub, dépôt `IVM-Projects/wm-remake` → **Settings → Secrets and variables → Actions → New repository secret** : `SUPABASE_DB_URL` (l'URI) et `CRON_SECRET` (`openssl rand -hex 32`, tiré en local).
  3. Vercel, projet `wmr` → **Settings → Environment Variables** : `CRON_SECRET` avec la même valeur, Production et Preview, « Sensitive ».
- [ ] **Step 3 (contrôleur): Migrations sur la démo**
  - `1500` et `1510` contiennent `DELETE` : préparer `deploy-m2.sql` (les deux fichiers en une transaction, puis les deux lignes de `supabase_migrations.schema_migrations` avec `created_by = 'sql-editor'`, puis `notify pgrst, 'reload schema'`), sur le modèle de `deploy-m1-reste.sql`. L'humain le lance dans le SQL Editor.
  - `1520` passe par le MCP `apply_migration`, puis `execute_sql` `notify pgrst, 'reload schema'`.
  - Contrôles par le MCP :
    - `select key, value from wm.config where key in ('catalog_frozen', 'catalog_stats_frozen', 'sample_rate')` → `false`, `false`, taux mesuré ;
    - sonde du cache de schéma : `POST /rest/v1/rpc/cards_overlay` avec `Content-Profile: wm`, la clé publiable et `p_uid` → 401 `42501` ;
    - `get_advisors` `security` → aucune nouvelle alerte à nous ;
    - `wm.check_invariants()` = `[]`.
- [ ] **Step 4 (contrôleur): Fusion `--no-ff` dans `develop`**, push, déploiement READY. Contrôles par `curl` : `/api/health` 200 ; `POST https://wmr-ivm.vercel.app/api/cron/revalidate` sans en-tête → **401** (503 voudrait dire que `CRON_SECRET` manque côté Vercel).
- [ ] **Step 5 (contrôleur): Chargement de l'échantillon.** Lancer `catalog.yml` (MCP GitHub) avec `mode: sample`, `target: free` sur `develop`. Suivre les jobs ; attendu : tous verts en environ 4 h. Le journal de `load` montre `essai \copy : 10 lignes`, puis le résumé (`inserted` ≈ lignes de `cards.csv`, `pool_out` ≥ 2 000 pour les cartes d'essai), un écart de parts ≤ 1 point, et un `curl` de revalidation à 200.
- [ ] **Step 6 (contrôleur): Critères de fin sur la démo** (MCP `execute_sql`), consignés dans `docs/verifications.md` :
  - parts : `wm.catalog_stats` comparé à `counts.json` de `catalog-out` (`gh run download -n catalog-out`) → écart ≤ 1 point par rareté ;
  - pool dense (requête de densité de la Task 8) ; aucune carte d'essai au pool ; `public.cards` = 2 000 + cartes chargées ; les 18 copies du joueur de démo intactes ;
  - `pg_database_size` ≤ 350e6 ;
  - **idempotence** : noter `md5(string_agg(card_id || ':' || page_id, ',' order by page_id))` de `wm.card_source`, relancer `catalog.yml` avec `artifacts_run_id: <run du Step 5>` (job `load` seul) → résumé `unchanged` = lignes, `inserted: 0` ; même empreinte ;
  - **χ² (M2-11)** : le contenu de `supabase/tests/chi2.sql` puis `select * from chi2`, sans `setseed` → `chi2_rarity < 20.515` et `chi2_seq < 43.82`, valeurs consignées. Un dépassement à α = 0,001 se traite comme un défaut à chercher, sans relance.
- [ ] **Step 7 (humain): Vérification visuelle** derrière la porte : `/global-collection` montre de vraies cartes et les vrais totaux ; la modale d'une carte avec image affiche « Image : <auteur>, <licence> » et un lien de licence qui marche ; `/credits` s'affiche. Résultat consigné.
- [ ] **Step 8: `schedule` mensuel** (P12) dans `catalog.yml` : `- cron: '41 5 3 * *'` (le 3 à 05:41 UTC, après les dumps du 1er).
- [ ] **Step 9: Passation**
  - `HANDOFF.md` : état du M2 (runs, durées, taille, taux), étapes humaines faites et restantes. Restant : suppression des 2 000 cartes d'essai et de leurs copies (M2-12, destructive, différée, à faire sur accord), et vérification visuelle si elle n'est pas faite.
  - `docs/suivi.md` : section M2 soldée. Reportés :
    - gonflement mensuel du tas sur Free (mesuré à la Task 11, à surveiller au premier run planifié) ;
    - mode `full` : artefacts `text` d'environ 2 Go, et Wikidata en plusieurs runs (M8) ;
    - formats d'image paginés sans miniature (P5) ;
    - écriture de `card_removals` et renommage forcé (M6) ;
    - `explain analyze` des modes de `cards_page_shared` sur l'échantillon.
  - `docs/decisions-graphify.md` : M2-1 à M2-20, les écarts au spec et P1 à P13.
  - `docs/verifications.md` : essai `\copy` par le pooler, durées, résumé du chargement, χ², parts, taille.
- [ ] **Step 10: CI** — lancer `ci.yml` sur la branche → vert ; fusionner ces commits dans `develop`.
- [ ] **Step 11: Commit** — `docs: M2 livré — catalogue échantillon chargé depuis Actions, idempotence, parts, χ², licences, passation`
