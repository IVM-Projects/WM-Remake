# M4a — Amis et échanges : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ouvrir les amitiés et les échanges de bout en bout. On cherche un joueur par le début de son pseudo, on lui envoie une demande, il l'accepte. Entre amis, on propose un échange de copies et de wikibidous, avec contre-offre, acceptation, refus, annulation et expiration après 168 h. L'acceptation déplace jusqu'à 100 copies par côté et les WB nets en une transaction, en moins de 500 ms au banc journalisé. Une erreur injectée annule tout, et un rejeu d'`Idempotency-Key` rend la réponse stockée. Une copie engagée dans un échange en attente ne peut plus être défaussée ni mise en vente. La cloche lit enfin les notifications : celles du marché, déjà écrites au M3, et celles des échanges et des amitiés. Contrat : les 7 routes du R§3.6 et les 8 routes du R§3.7 qui relèvent du M4a, soit `coverage:recap` 39 → 54.

**Architecture:** `trades`, `trade_items` et `friendships` entrent dans le miroir `public`. Seuls les participants les lisent sous RLS, et aucun client n'y écrit. Chaque opération est une fonction `wm.*` en une transaction, dans l'ordre C4 : ligne métier (échange, parent, amitié), puis profils par `wm.lock_users`, puis copies `for update order by id`, le tout sous un `lock_timeout` de 2 s. Il n'y a pas de séquestre : un verrou au niveau `card_id` bloque la défausse et la mise en vente, et la possession est revérifiée à l'acceptation, qui déplace les copies en cinq instructions ensemblistes (`wm.trade_move`). Les WB passent par un seul `wm.wallet_apply('trade', 'trade:<id>')` net par joueur. Un job pg_cron horaire (`9010_wm_trade_cron.sql`) expire les échanges, et une garde `expires_at > clock_timestamp()` couvre l'heure qui précède son passage. Les routes `app/api/{friends,trades,notifications}/**` font 1 à 3 lignes autour de `route()`, sans cache partagé. Les pages `/friends`, `/trades`, `/trades/[id]` et `/trades/new` sont des coquilles statiques avec un composant client, et `/trades` comme le détail interrogent toutes les 20 s, onglet visible. La cloche lit PostgREST en direct toutes les 30 s, par un seul poller partagé.

**Tech Stack:** celle du M3 (next 16.4.2, react 19.3.1, @supabase/supabase-js 2.118.0, zod 4.6.7, vitest 5.0.5, @playwright/test 1.64.1, @axe-core/playwright 4.14.0, PostgREST v12.2.3, GoTrue v2.197.0) ; pg_cron 1.6.4 sur la démo (PostgreSQL 17.11) ; `pgbench` 16 du banc local (`/usr/lib/postgresql/16/bin`). Aucune dépendance npm ajoutée (`web-push` arrive au M4b).

**Spec:** `docs/superpowers/specs/2026-10-18-wikimasters-rebuild-design.md` (cité D§x ou D:ligne), surtout D§7.0, §7.6, §7.9 (amis, notifications, cloche), §8 (D:651-753), §9.4 à §9.6 ; `docs/rea-recap.md` (R§x), surtout R§3.6, §3.7 (amis, notifications), §4.1, §4.2, §5.6, §5.8, §6.8. Jalon : D§13 ligne M4 (D:1083). Décisions du contrôleur et faits relevés : `.superpowers/sdd/2026-10-22-m4-echanges-social/` (`decisions.md`, `research-*.md`, `open-questions.md`). Ces fichiers ne sont pas versionnés : ce plan recopie chaque valeur dont une tâche a besoin.

## Global Constraints

- Toutes les contraintes globales des plans M0 à M3 restent en vigueur :
  - versions exactes ;
  - lire le guide de `node_modules/next/dist/docs/` avant de toucher une API Next (`AGENTS.md`) : `01-app/03-api-reference/04-functions/use-search-params.md` et `use-params.md` (sous `Suspense`), `03-file-conventions/dynamic-routes.md:155-181`, `01-app/02-guides/preserving-ui-state.md` (Activity) ;
  - fonctions `wm.*` en `security definer` et `set search_path = ''`, sans aucune autre entrée dans `proconfig`, avec `EXECUTE` à `service_role` seul. Chaque migration `wm` finit par les cinq lignes `revoke`/`grant` de `1400_wm_catalog.sql:76-80`, et le scan de `10_wm_core.test.sql:140-155` le vérifie. Seules exceptions : `9000_wm_cron.sql` et `9010_wm_trade_cron.sql`, qui ne créent aucune fonction `wm` (dit en tête du fichier) ;
  - migrations idempotentes, expand-only, PG16 et PG17, sans `MERGE … RETURNING` ;
  - une fonction redéfinie garde sa signature et sa réponse ;
  - tout `DELETE`/`UPDATE` garde un `WHERE` (`where true` pour vider), contrôlé par `scripts/check-dml.ts` ;
  - chaînes d'erreur exactes, avec `error` = `message`, levées par `wm.raise_err` et recopiées par `route()` ; aucune PII dans les logs ;
  - « tu » dans le jeu ; thème sombre ; ports du banc du M1 ; aucun chemin de code réservé aux tests (seulement la configuration) ;
  - formes JSON : clés en plus permises, jamais de clé retirée ; les contrats existants ne changent pas.
- **La CI reste verte après chaque tâche.** Chaque tâche finit par l'un de ces deux jeux de contrôles, ceux que lance `ci.yml` :
  - **contrôles rapides** (job `checks`) : `npm run typecheck && npm run lint && npm test && npm run coverage:recap` ;
  - **contrôles complets** (`checks` + `integration`) : les rapides, puis `npm run test:db && npm run build:test && npm run test:contract && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e`.
  Une tâche qui touche une migration, `supabase/tests/`, `scripts/db-test.sh`, l'app ou le contrat lance les contrôles complets.
- **Verrous (C4, M3-11, M3-12, M4-2)** :
  - d'abord la ligne métier `for update` : l'échange ; pour une contre-offre, le parent ; l'amitié pour `friend_action`, `friend_remove` et `friend_accept_all` ;
  - puis les profils et leurs `user_state` par `wm.lock_users`, une seule fois, avec tous les joueurs de l'opération ;
  - puis les copies `for update order by id`, seulement celles des joueurs dont le profil est tenu (P25).
  `wm.actor` ne verrouille rien et passe avant tout verrou (après `idem_claim`). `perform set_config('lock_timeout', '2s', true)` précède le premier verrou de `create_trade`, `trade_action`, `expire_trades`, `friend_request`, `friend_action`, `friend_remove`, `friend_accept_all`, `bulk_discard` (M4-2) et `create_auction` (inchangé). Toute comparaison à `expires_at` faite après un verrou lit `clock_timestamp()`, jamais `now()`.
  - `create_auction` et `bulk_discard` lisent `trades` et `trade_items` sans `for update` ni `for share`, sous le verrou du profil déjà tenu (M4-2).
  - **Toute insertion de `public.notifications`** est une seule instruction `order by user_id` : sa clé étrangère prend `FOR KEY SHARE` sur `profiles`, qui entre en conflit avec le `FOR UPDATE` de `lock_users` (P28).
- **Argent** :
  - seul `wm.wallet_apply` écrit un solde. Raison `trade`, référence `trade:<trade_id>`, un seul appel par joueur dont le delta net est non nul, par id croissant, profils déjà tenus (M4-4) ;
  - aucune commission ;
  - un test de chaque fonction monétaire finit par `wm.check_invariants()` = `'[]'`.
- **Copies** : `wm.escrow_put` et `wm.escrow_release` (enchères) et `wm.trade_move` (acceptation, M4-3) sont les seuls à déplacer une copie hors défausse. L'`update … set user_id` interdit au M3 n'est permis que dans `wm.trade_move`. Une copie ou une unité déplacée arrive avec `starred = false`, sans étiquettes, et son avatar est effacé.
- **Notifications** : `data` est construit par `wm.notify_trade` ou `wm.notify_friend` seules, en snake_case et sans texte : `{trade_id, user_id, username}` ou `{friendship_id, user_id, username}`, où `user_id` et `username` désignent l'auteur de l'action. Les lignes sont insérées dans la transaction qui les cause. Les lignes du M3 (`auction_*`, `wishlist_listed`) se lisent telles quelles. Aucun push au M4a.
- **Erreurs du M4a** (corps `{status, code?, error, message, …extra}` levé par `wm.raise_err` ; apostrophe ASCII, comme au M3 ; « 10 000 » avec une espace simple) :

  | Statut | `code` | Message |
  |---|---|---|
  | 400 | `invalid_request` | « Tu ne peux pas échanger avec toi-même » · « Un échange contient au moins une carte » · « Au plus 100 cartes par côté » · « Entre 0 et 10 000 wikibidous par côté » · « Élément d'échange invalide » · « La contre-offre s'adresse à l'initiateur de l'échange » · « Action inconnue » · « Tu ne peux pas t'ajouter toi-même en ami » · « La recherche demande au moins 2 caractères » |
  | 403 | `FORBIDDEN` | « Vous devez être amis pour échanger » · « Seul le destinataire peut accepter cet échange » · « Seul le destinataire peut refuser cet échange » · « Seul l'initiateur peut annuler cet échange » · « Seul le destinataire peut faire une contre-offre » · « Seul le destinataire peut accepter cette demande » · « Seul le destinataire peut refuser cette demande » |
  | 403 | `42501` | « Vous ne possédez pas cette carte » |
  | 404 | — | « Échange introuvable » · « Joueur introuvable » · « Demande d'ami introuvable » |
  | 409 | — | « Cet échange n'est plus en attente (déjà traité) » · « Une carte de cet échange n'est plus disponible » · « Cette carte est déjà engagée dans un échange en attente » |
  | 409 | `insufficient_balance` | « Solde insuffisant » |
  | 409 | `ALREADY_FRIENDS` | « Vous êtes déjà amis » |
  | 409 | `REQUEST_PENDING` | « Une demande d'ami est déjà en attente » |
  | 409 | `FRIEND_LIMIT` | « Limite d'amis atteinte ({n}) » (désactivée par défaut) |
  | 503 | `BUSY` | « Le site est très sollicité, réessaie dans un instant. » + `Retry-After: 1` (55P03, 57014, 40P01, `PGRST000`, `PGRST003`) |

- **DOM du contrat** (R§6.8, R:127, M4-15) :
  - `/trades` : `[role=tablist][aria-label="Vues des échanges"]` avec « Reçues », « Envoyées » et « Historique », l'onglet actif en `border-b-2 border-[var(--color-accent)] text-[var(--color-accent)]` ;
  - chaque offre est un `div.card-frame.p-4` qui contient un `button[aria-label="Voir le détail de l'échange"]` ;
  - dans le bouton : « De <pseudo> » ; le statut « · Accepté » en `text-green-400` et « · Refusé » en `text-red-400` (P17 pour les autres) ; la date courte « 20 sept. » dans un `time[datetime]` ; les colonnes « <pseudo> offre » et « En échange de », séparées par l'icône `ArrowLeftRight` (`svg.lucide-arrow-left-right`) ;
  - puces `span[title=<titre complet>]` avec le style `background-color: var(--color-rarity-<r>)22`, et pour texte « SR · <titre tronqué à 20 caractères>… » (P15) ;
  - `/friends` : `input#friend-list-search`, rendu une seule fois ;
  - cloche : `button.relative.p-2.rounded-xl[aria-label="Notifications"]` inchangé, badge « 9+ » dès 10.
  Hors de `#friend-list-search`, aucun `id` fixe (les ids de `useId()` restent permis, comme les onglets du marché). Cibles ≥ 44 px (`min-h-11`), nombres par `formatInt`, montants par `` `${formatInt(n)} ${wikibidous(n)}` `` (`wikibidous(n)` ne rend que l'unité, `lib/format.ts:7`). Les boutons d'action sont inactifs pendant leur requête : `aria-disabled` et garde, jamais `disabled`. Le focus ne tombe jamais sur `body` : un élément qui disparaît sous le focus (offre traitée par l'autre, notification lue) passe le focus au suivant, ou à l'état vide (`tabIndex={-1}`). Pas de bouton « Message » ni « Message à <pseudo> » au M4a (M4-1).
- **E2E** : les workers partagent la base du banc. Chaque test crée ses propres joueurs (`makePlayer`, `login`), prend ses copies dans le seed (`giveCopies`, Task 11), et supprime ses `auth.users` à la fin : profils, échanges, éléments, amitiés et notifications suivent en cascade. L'amitié se prépare par SQL, sauf dans le parcours du jalon (M4-17). Les assertions portent sur les éléments visibles (Activity). Toujours `routeOnce`, jamais `{ times: 1 }`.
- **Points hérités pris au M4a** (`docs/suivi.md:31-37`) : verrou d'échange dans `create_auction`, `discard` et `bulk_discard` (`:33`) ; lecteur des notifications (`:34`, sans le push) ; amitié pour `wishlisted_by` et `owned_by` (`:36`) ; « owner change must clear avatar_user_card_id and the old owner's tag links » (`:37`, par `wm.trade_move`). L'empreinte de `idem_claim` (`:35`) reste au suivi (M4-8).

## Décisions (contrôleur, à consigner dans `docs/decisions-graphify.md`, Task 16)

Règles de conduite inchangées : aucune question à l'utilisateur sauf confirmation destructive en production ; décider et avancer ; textes pour l'utilisateur en français ; exécution par sous-agents avec revue de conformité et revue adverse par tâche, revue finale de branche (R31), ordre de déploiement R32. Format : décision — pourquoi — coût si faux.

- **M4-1. Deux plans pour le jalon M4.** M4a « Amis et échanges » (ce plan), puis M4b « Profil, vitrine, messages, signalements, Web Push », chacun livré sur la démo dans l'ordre R32. Numéros réservés : `0005_mirror_trades.sql` (`trades`, `trade_items`, `friendships`) ; `0006_mirror_social.sql` au M4b ; `17xx` pour `wm` au M4a, `18xx` au M4b ; `9010_wm_trade_cron.sql` (expiration) au M4a, `9020_*` (push) au M4b ; `9000` ne se modifie pas. Pas de bouton « Message » ni « Message à <pseudo> » au M4a (O1 : aucun bouton factice) — pourquoi : deux plans de la taille du M3, et le risque du push isolé — coût si faux : une passation de plus.
- **M4-2. Verrou seul, sans séquestre**, au niveau `card_id`, des deux côtés (`trade_items.offered_by`). Le solde de l'initiateur est vérifié à la création (409 `insufficient_balance` « Solde insuffisant »). Une même copie peut figurer dans deux échanges en attente : le second échoue à l'acceptation en 409 « Une carte de cet échange n'est plus disponible ». `wm.lock_users(array[initiateur, destinataire])` passe avant la vérification de possession, et pour une contre-offre le parent est pris `for update` d'abord (C4). `create_auction`, `discard` et `bulk_discard` lisent `trades` sans `for update`, sous le verrou du profil, et après le `set_config('lock_timeout')` — coût si faux : de la nuisance (verrou trop large), ou un échange mort en attente jusqu'à son expiration.
- **M4-3. Déplacement des copies à l'acceptation selon D:512**, exception consignée à la règle M3 « jamais d'`update … set user_id` » (qui visait le séquestre). Si k = n : `update set user_id` sur la ligne (même id, même `count`). Si k < n : une ligne neuve de `count = k` (snapshots, `is_shiny` et `obtained_at` copiés de la source) et un décrément de la source, sans fusion. Dans les deux cas : `starred = false`, étiquettes supprimées, vitrine et avatar effacés explicitement ; copies des deux joueurs prises `for update order by id` — coût si faux : un `obtained_at` discutable. Écrire k lignes au lieu d'une serait l'anti-objectif A2, exclu.
- **M4-4. WB : un delta net par joueur.** Un appel `wallet_apply('trade', 'trade:<id>')` par joueur dont le net est non nul, par id croissant, profils déjà tenus ; les soldes doivent suffire en net — coût si faux : réécriture du grand livre.
- **M4-5. Expiration : cron horaire et garde.** `wm.expire_trades(p_batch int default 5000)` passe les échanges à `expired`, sans argent et sans `lock_users`. Job `wm-trade-expire` en `'27 * * * *'` dans `9010_*`, conditionnel comme `9000`. Garde `expires_at > clock_timestamp()` après le verrou dans `accept`, `decline`, `cancel` et la contre-offre (409 « Cet échange n'est plus en attente (déjà traité) »). Pas de notification d'expiration. Le job tourne aussi pendant la maintenance — coût si faux : un type `trade_expired` à ajouter.
- **M4-6. « Acceptation 100 ↔ 100 < 500 ms »** prouvée par `load/bench/trade_accept.sql` dans `load/bench/run.sh` (PG16 journalisé, fsync on) : 10 acceptations parallèles × R tours, 20 joueurs, chaque côté 100 copies (piles, étiquettes, `starred`, vitrine/avatar, WB), des milliers d'échanges en attente en fond. Échec si le p95 atteint 500 ms ou au premier `40P01` ; invariants `[]` ; un 10 ↔ 10 en témoin. S'y ajoutent une mesure réelle sur la démo à la livraison (journal `ms` de `route()`), présentée comme « démo Free, une mesure » (A5), et un test fonctionnel 100 ↔ 100 dans `db-test` — coût si faux : un chiffre local optimiste, refait au M8.
- **M4-7. Atomicité prouvée de trois façons.** (A) Un trigger de test `raise exception` dans le fichier SQL, après les déplacements puis sur l'insertion de la notification, annulé par le rollback du banc. (B) Un cas de contrat HTTP qui pose le même trigger par `psql`, filtré sur l'id de l'échange et retiré en `finally` : 500 « Erreur interne, réessaie dans un instant. », état complet inchangé, puis la même `Idempotency-Key` sans trigger → 200 `accepted`. (C) Défausse pendant l'acceptation (bloqueur `for update`, 55P03 → 503 `BUSY`) dans le test de concurrence. L'état complet est affirmé après chaque échec : copies, `count`, étiquettes, `starred`, vitrine, avatar, soldes, grand livre, statut, notifications, clés d'idempotence. Aucun drapeau de test dans `wm.config` — coût si faux : une atomicité prouvée pour le seul bloc SQL.
- **M4-8. Idempotence : `wm.idem_claim` inchangé** ; l'empreinte serveur est reportée au suivi, à faire seule. Côté client : une intention par action et par corps complet (`apiOnce`). Cas obligatoires sur chaque écriture du M4a : même clé deux fois → corps identiques et un seul effet ; `accept` rejoué après succès → réponse stockée ; `accept` répété sans clé → 409 « déjà traité » ; deux sessions, même clé : la seconde attend puis rejoue (gabarit `16_market_concurrency.test.sh`) — coût si faux : la classe « même clé, autre action » reste ouverte, atténuée par l'UI.
- **M4-9. Formes des routes d'échange.** Création en 200 (défaut de `route()`, inféré) ; `PATCH` → `{status, trade}` ; `active=1` et `count=1` acceptés sans effet ; `p_tz` passé à `wm.create_trade` et `wm.trade_action`, inutilisé (C30) ; de 0 à 100 cartes par côté, au moins 1 carte au total (WB seuls des deux côtés → 400) ; au plus 10 000 WB par côté. Messages : hors amitié 403 `FORBIDDEN` « Vous devez être amis pour échanger » ; `decline` par l'initiateur 403 « Seul le destinataire peut refuser cet échange » ; `cancel` par le destinataire 403 « Seul l'initiateur peut annuler cet échange » ; contre-offre sur un parent clos 409 « déjà traité » ; contre-offre sur un parent non adressé à l'appelant 403 `FORBIDDEN` ; plus de 100 cartes ou plus de 10 000 WB par côté 400 `invalid_request` ; soi-même 400 ; échange inconnu ou étranger 404 « Échange introuvable » ; copie non possédée 403 `42501` « Vous ne possédez pas cette carte » — coût si faux : un outil tiers qui teste le statut exact.
- **M4-10. Défausse d'une copie verrouillée.** `bulk_discard` met l'id dans `failed` avec `reason: 'Cette carte est déjà engagée dans un échange en attente'`, et le reste du lot passe. `discard` (qui appelle `bulk_discard`) convertit en 409 avec le même message ; `create_auction` refuse en 409 avec ce message — coût si faux : un client qui attend une 409 sur le lot.
- **M4-11. Amitiés.** Un refus supprime la ligne. Une demande vers quelqu'un qui m'a déjà demandé → 409 `REQUEST_PENDING` (pas d'acceptation implicite). 409 `ALREADY_FRIENDS` ; 409 `FRIEND_LIMIT` avec `friend_limit: null` dans `wm.config` (désactivé) ; 400 pour soi-même ; 404 « Joueur introuvable ». Réponses : `POST` et `PATCH accept` → `{friendship}`, `PATCH decline` → `{ok: true}`, `DELETE` → `{ok: true}`, `accept-all` → `{accepted: n}`. Retrait d'un ami : les échanges en attente entre les deux passent à `cancelled` dans la même transaction, et l'acceptation exige aussi l'amitié (403 `FORBIDDEN`). Recherche par préfixe sur `lower(username) text_pattern_ops` (index simple sur la démo), 20 résultats, soi-même exclu, `EXPLAIN` au banc. `owned_by` et `wishlisted_by` s'ouvrent aux amis (S:36) — coût si faux : un écart non observable.
- **M4-12. Notifications du M4a.** `trade_received` (destinataire) ; `trade_countered` (initiateur du parent, à la place de `trade_received`) ; `trade_accepted` et `trade_declined` (initiateur) ; `trade_cancelled` (destinataire) ; `friend_request` et `friend_accepted` (l'autre joueur). `data` `{trade_id, user_id, username}` ou `{friendship_id, user_id, username}`, en snake_case, sans texte. Une aide `wm.notify_trade` sur le modèle de `wm.notify_auction` ; insertion en une instruction `order by user_id` (P28) — coût si faux : un type de plus coûte une ligne.
- **M4-13. Cloche par polling PostgREST toutes les 30 s**, un seul poller partagé par les deux cloches (store de module et `useSyncExternalStore`), avec le jeton de la session du navigateur : `select=id&read=eq.false&limit=10`, badge « 9+ » dès 10. Le panneau lit `GET /api/notifications` (les 50 dernières) à l'ouverture ; `PATCH /api/notifications` `{ids}` ou `{}` (tout lire), puis relecture du badge. Nom accessible figé, compte par `aria-describedby`. `EXPLAIN` au banc, index partiel `where read = false` si besoin. Liens par type (`/trades/<id>`, `/friends`, `/marketplace/<id>`) — coût si faux : aucun côté parité.
- **M4-14. Couverture du contrat du M4a** : les 7 routes du §3.6 et les 8 routes du §3.7 du M4a (6 d'amis, `GET` et `PATCH /api/notifications`), soit `coverage:recap` 39 → 54. `rest/v1/trades` (POST, PATCH, DELETE) est refusé et affirmé par une spec par méthode, sans lecture directe. Cas minimaux par route : 401 sans session, succès au schéma strict, chaque erreur au corps entier, rejeu sur chaque écriture, RLS avec un authentifié étranger — coût si faux : un outil tiers qui écrivait dans `trades`.
- **M4-15. Écrans du M4a.** `/trades` (contrat R:127 verbatim : onglets « Reçues », « Envoyées », « Historique », `div.card-frame.p-4`, `button[aria-label="Voir le détail de l'échange"]`, « De <pseudo> », « · Refusé » `text-red-400`, « · Accepté » `text-green-400`, date courte `fr-FR`, colonnes « <pseudo> offre » / « En échange de » séparées par `lucide-arrow-left-right`, puces `span[title]` « SR · <titre tronqué ~20 car.>… » sur fond `var(--color-rarity-<r>)22` ; statuts non vus « · En attente », « · Annulé », « · Expiré », « · Contre-offre »). `/trades/[id]` (h1 « Détail de l'échange », Accepter/Refuser/Annuler/Contre-offre selon le rôle, échéance par `Countdown`, lien parent/enfant). Composer `/trades/new?with=<userId>` (`&parent=<tradeId>` pour une contre-offre préremplie à l'inverse), panneaux « Tu offres » / « Tu demandes », quantité par pile, WB sur 5 chiffres, compteur « n/100 », copies verrouillées marquées mais offrables. `/friends` (`input#friend-list-search` rendu une fois, « Tout accepter », sections « Demandes reçues », « Demandes envoyées », « Amis », « Ajouter », « Retirer », « Échanger »). Panneau de la cloche. Règles de la maison : `PageHeader`, aucun id sauf `#friend-list-search`, `Modal`, `aria-disabled` + garde, focus jamais sur `body`, états vide/erreur/chargement, axe par route, ≥ 44 px, 360 px sans défilement horizontal. Polling 20 s sur `/trades` et `/trades/[id]`. `/trades` et `/friends` sortent de la liste « Cette section arrive bientôt. » de `e2e/shell.spec.ts` — coût si faux : aucun contrat de référence pour les écrans jamais capturés.
- **M4-16. Plafonds** : échanges, « tous ceux en attente et les 200 derniers clos » ; notifications, 50 ; amis, tous ; recherche, 20 ; aucun quota inventé — coût si faux : une troncature chez un gros compte.
- **M4-17. Parcours du jalon** `e2e/trade-journey.spec.ts`, au clavier : A cherche B et l'ajoute, B accepte ; A clique « Échanger », compose, envoie ; B fait une contre-offre ; A l'accepte ; copies, soldes et cloche vérifiés des deux côtés. SQL admis : copies et soldes au départ. Dans les autres specs : l'amitié par SQL, et `expires_at` ramené puis `wm.expire_trades` — coût si faux : faible.
- **M4-18. Livraison du M4a** comme au M3 : `deploy-m4a.sql` produit par concaténation (`0005`, `17xx`, `9010`, historique, `notify`), répété sur une base de `develop`, lancé par l'utilisateur au SQL Editor, contrôles MCP, CI postgres:17, puis fusion `--no-ff` dans `develop` (R32) ; passation et décisions comme au M3.

**Écarts au spec (la décision l'emporte) :**
- M4-1 : pas de « Message à <pseudo> » (R:127) ni de « Message » (R:132) avant le M4b.
- M4-2 : les deux côtés verrouillés et le solde de l'initiateur vérifié à la création, alors que D:505 ne parle que de possession.
- M4-5 : une garde d'échéance en plus du cron, alors que D:328 n'exige que `status = 'pending'`.
- M4-9 : de 0 à 100 cartes par côté avec au moins une au total, contre « De 1 à 100 cartes […] par côté » (D:504) ; `PATCH` → `{status, trade}` au lieu de `{ status }` (R:231, clé en plus).
- M4-10 : `bulk_discard` refuse la copie verrouillée par une entrée de `failed`, pas par une 409 (S:33).
- M4-11 : `FRIEND_LIMIT` désactivé (valeur inconnue, R:1014, C30).
- P13 : l'acceptation n'efface au M4a que l'avatar ; la vitrine n'existe qu'au M4b (D:512).
- P3 : un échange `pending` échu est lu `expired` avant le passage du cron (D:518 : seul le cron expire).

## Décisions ajoutées par ce plan (à consigner avec les précédentes)

- **P1. Fichiers.** `1700_wm_trade_core.sql` (socle, verrou, redéfinitions de la collection et de la vente), `1710_wm_friends.sql`, `1720_wm_trade_create.sql`, `1730_wm_trade_action.sql`, `1740_wm_trade_read.sql`, `9010_wm_trade_cron.sql` ; tests `supabase/tests/28_trades.test.sql` et `supabase/tests/17_trades_concurrency.test.sh`. Index de performance en `1700` et `1710` (ADDITIVE ; `CONCURRENTLY` par le runbook en option A), index unique de paire dans le miroir `0005` (intégrité).
- **P2. `trade_items`** : `id uuid` en clé primaire ajoutée (plusieurs éléments peuvent viser la même ligne, D:504) ; `user_card_id` sans clé étrangère, comme `auctions.user_card_id` : l'élément est l'historique de l'échange, et une copie défaussée après la clôture ne doit pas l'effacer. `card_id`, `snapshot_rarity` et `is_shiny` sont pris sur la copie à la création, et le `card_id` envoyé par le client est ignoré.
- **P3. « En attente » = `status = 'pending'` et `expires_at > clock_timestamp()`** partout : `wm.card_locked`, `pendingTradeCardIds`, les gardes. L'objet `Trade` rend `status: 'expired'` pour une ligne `pending` échue, que le cron n'a pas encore passée : sans cela, la liste du banc et de la CI, qui n'ont pas de cron, garderait des offres « En attente » qu'aucune action n'accepte.
- **P4. Verrous des amitiés.** `friend_request` prend `lock_users(array[demandeur, destinataire])`, ce qui sérialise deux demandes croisées (sinon un 23505 sur l'index de paire, donc un 500). `friend_action`, `friend_remove` et `friend_accept_all` prennent les lignes d'amitié (`order by id` pour un lot), jamais les profils. `friend_remove` annule les échanges par un `update` (verrou des lignes d'échange) sans toucher aux profils, donc sans cycle avec `trade_action` (échange, puis profils, puis lecture de l'amitié sans verrou). `create_trade` lit l'amitié sans verrou : un échange créé pendant un retrait reste en attente et sera refusé à l'acceptation (403). La course est admise. Une suppression d'étiquette en cascade (`rest/v1/tags`) peut aussi parcourir les liens de deux copies déplacées dans l'autre ordre que l'instruction (4) de `trade_move` : un 40P01 rare, rendu en 503 `BUSY` et rejouable, de la même classe que la défausse du M1 (admis).
- **P5. Test du `lock_timeout`.** Le contrôle `prosrc` de `27_market.test.sql:72-83` est recopié dans `28_trades.test.sql`, avec les marqueurs `for update`, `wm.lock_users(` et `wm.lock_user(`, sur la liste des Global Constraints. Chaque tâche ajoute ses fonctions au tableau. Pour `create_trade` et `trade_action`, le même bloc vérifie aussi que le premier `for update` précède `wm.lock_users(` (ligne métier avant les profils, M4-2, C4).
- **P6. Aides de notification** :
  - `wm.notify_trade(p_users uuid[], p_type text, p_trade_id uuid, p_actor uuid) returns int` ;
  - `wm.notify_friend(p_friendship_ids uuid[], p_type text, p_actor uuid) returns int`, une ligne pour l'autre participant de chaque amitié.
  Aucune notification pour une expiration (M4-5), ni pour les annulations causées par un retrait d'ami (inféré : le retrait est l'événement, et il n'a pas de type).
- **P7. Un seul constructeur de l'objet `Trade`** : `wm.trade_json(t public.trades)`. Il rend les 13 colonnes, `initiator {id, username}`, `recipient {id, username}`, `items` et `counter_trade_id` (l'id de la contre-offre la plus récente dont il est le parent, sinon `null` : c'est le lien enfant du détail). Les éléments viennent d'abord ceux de l'initiateur, puis par `snapshot_rarity desc`, titre et id. Chaque élément a exactement `{offered_by, card_id, user_card_id, snapshot_rarity, is_shiny, card: {id, wikipedia_title, image_url, rarity}}`.
- **P8. Invariant `trade_money`** ajouté à `wm.check_invariants` : pour chaque référence `trade:<id>`, Σ `delta` = 0 → sinon `{"check":"trade_money","ref":"trade:<id>","sum":n}`. Même `shortcut:` que `market_money` (le grand livre cascade par joueur).
- **P9. Plafonds dans `wm.config`** (D§6.5) : `list_caps` `{"trades_closed": 200, "notifications": 50, "friend_search": 20}`.
- **P10. `PATCH /api/notifications`** : `{}` ou `ids` absent → toutes les non-lues du joueur ; des ids d'un autre sont ignorés ; au plus 100 ids (zod `.max(100)`) ; réponse `{ok: true, updated: n}` (inférée, R:974).
- **P11. zod pour la forme, SQL pour les règles.** Les routes valident les uuid et les `int32` ; plafonds, rôles et actions sont des règles SQL aux messages français. `action` est un `pgText`, et une valeur inconnue donne 400 « Action inconnue », jamais un message zod en anglais.
- **P12. Recherche de pseudo** : préfixe de `lower(btrim(q))`, avec `\`, `%` et `_` échappés par `\` (l'échappement par défaut de LIKE) ; moins de 2 caractères après `btrim` → 400. Ordre `lower(username), id`, 20 lignes, soi-même exclu. Requête en SQL dynamique à littéraux, comme `wm.collection_filter` (`1300:80`) : un motif en paramètre d'un plan générique ne se sert pas de l'index de préfixe.
- **P13. Vitrine absente au M4a** : `wm.trade_move` efface `profiles.avatar_user_card_id` des lignes déplacées, rien d'autre. Le M4b (`0006`, `showcase`) redéfinit `wm.trade_move` pour vider aussi les emplacements de vitrine. Le bench pose un avatar, pas de vitrine.
- **P14. Cloche** :
  - composant client ; store pur `createUnreadStore` dans `lib/notifications.ts`, avec une lecture immédiate au premier abonné, puis toutes les 30 s, onglet visible ;
  - panneau dans `components/ui/Modal.tsx` (label « Notifications ») ;
  - textes et liens par type dans `notificationView`, une seule fonction ;
  - l'élément de `aria-describedby` reçoit son id de `useId()` ;
  - `unreadStore()` ne crée le client Supabase qu'au premier `fetchUnread`, et `subscribe` et `get` sont des fonctions liées (sans `this`) : le rendu serveur du layout les lit sans rien créer.
  La disposition actuelle ne rend qu'une cloche (`app/(game)/layout.tsx:17`) : le store sert N abonnés, et la seconde cloche du R:138 reste au M7 (`selectors.spec.ts`).
- **P15. Puces** : `style={{ backgroundColor: \`var(--color-rarity-${css})22\` }}`, la même forme littérale que `components/ui/RarityChips.tsx:21`. Texte `` `${code} · ${titre.length > 20 ? titre.slice(0, 20) + '…' : titre}` `` ; `title` = le titre complet (`card.wikipedia_title`).
- **P16. Identité par la session du navigateur** (P18 du M3) : onglets « Reçues » et « Envoyées », boutons du détail et sections de `/friends`, d'après `createBrowserSupabase().auth.getSession()`.
- **P17. Statuts affichés** : `pending` « · En attente » `text-amber-600` ; `accepted` « · Accepté » `text-green-400` ; `declined` « · Refusé » `text-red-400` ; `cancelled` « · Annulé » et `expired` « · Expiré » `text-[var(--color-foreground)]/60` ; `countered` « · Contre-offre » `text-sky-400`. Au détail, le même libellé sans « · ».
- **P18. Composer** : des champs `input type="number" min=0 max=count` par copie ; pages de 50 de `/api/my-collection` (moi) et de `?owned_by=<ami>`, avec un filtre `q` et « Charger la suite » ; intention `apiOnce` = `JSON.stringify` du corps complet, éléments triés par `user_card_id`. La table `cardOf` (`user_card_id` → `card_id`) réunit les pages chargées et, pour une contre-offre, les éléments du parent ; on n'en retire jamais une entrée. Sous chaque panneau, la liste des choix (titre, quantité, « Retirer ») montre aussi les copies choisies hors des pages chargées.
- **P19. Textes ajoutés** (absents du R§) :
  - toasts : « Demande envoyée à {pseudo}. », « {pseudo} fait maintenant partie de tes amis. », « Demande refusée. », « Demande retirée. », « {pseudo} a été retiré de tes amis. », « {n} demande(s) acceptée(s). » (« 1 demande acceptée. », « 3 demandes acceptées. »), « Échange proposé à {pseudo}. », « Contre-offre envoyée. », « Échange accepté. », « Échange refusé. », « Échange annulé. » ;
  - états vides : « Aucune demande reçue. », « Aucune demande envoyée. », « Tu n'as pas encore d'amis. Cherche un joueur par son pseudo. », « Aucun joueur ne correspond. », « Aucune offre reçue en attente. », « Aucune offre envoyée en attente. », « Aucun échange terminé. », « Aucune notification. » ;
  - erreurs de chargement : « Impossible de charger cette page. » + « Réessayer » ;
  - modale de retrait : « Retirer {pseudo} de tes amis ? Les échanges en attente entre vous seront annulés. », boutons « Retirer » et « Annuler » ;
  - composer : « Tu offres ({n}/100) », « Tu demandes ({n}/100) », « Wikibidous offerts », « Wikibidous demandés », « Déjà dans un échange », « Proposer l'échange », « Envoyer la contre-offre », « Échange avec {pseudo} » ;
  - détail : « Expire dans », « De {pseudo} à {pseudo} », « Voir l'offre d'origine », « Voir la contre-offre », « Retour aux échanges ». Le 409 « Solde insuffisant » d'une acceptation vaut aussi quand l'initiateur est à court (M4-4) : le détail l'affiche tel quel.
- **P20. Préparation des E2E** : `giveCopies(u, rarity, n)` ajouté à `e2e/fixtures.ts` (le `giveCards` du contrat) et `befriend(a, b)` (une ligne `accepted` par `sql`). Les échéances sont posées par `sql` (`expires_at`), puis `select wm.expire_trades()`. C'est un écart à consigner, comme le P22 du M3.
- **P21. Reportés au M4b, avec le profil** : `friendOwners` de `/api/cards` (`1400:62`, `1520:83`), le lien de la pastille « ami possède » (`Card.tsx:140`) et la collection d'un profil privé pour ses amis (`1300:175`).
- **P22. `restSpecs`** : `spec()` (`contract/spec/rest.ts:51-52`) gagne un 5e paramètre `confidence = 'conf.'` ; les trois refus de `rest/v1/trades` y entrent en `inc.` (modèle du P23 du M3).
- **P23. `tests.trade_snapshot(p_trade uuid) returns jsonb` et `tests.boom()`** vivent dans `supabase/tests/helpers.sql`, schéma `tests`, absent de la démo. Un même état complet sert ainsi au fichier SQL, au test de concurrence et au contrat.
- **P24. Le 503 de l'atomicité (C).** La correspondance 55P03 → 503 `BUSY` + `Retry-After: 1` est celle de `lib/route.ts:32-36` (`BUSY_CODES`), déjà testée par `lib/route.test.ts:99`. Le test de concurrence prouve la 55P03 et l'état inchangé, en SQL.
- **P25. Copies d'un tiers jamais verrouillées.** L'acceptation ne prend `for update` que les copies `where user_id in (initiator_id, recipient_id)` : une copie partie chez un tiers (même copie dans deux échanges, M4-2) manque au compte, d'où la 409, sans attendre ni verrouiller le tiers dont le profil n'est pas tenu (C4). `bulk_discard` prend ses copies `order by id`.
- **P26. Poll de `/trades`** : chaque passage relit aussi les 200 clos (jusqu'à environ 40 000 éléments à 200 par échange). Admis à l'échelle de la démo (A5), à revoir au M8.

## Review Focus

- **Concurrence autour d'une copie promise ou d'un même échange.** A offre la copie X à B, puis défausse X ou la met en vente pendant que B accepte : refus 409 « Cette carte est déjà engagée dans un échange en attente », ou 403 une fois X chez B. X engagée aussi vers C : une fois X chez B, l'acceptation de C échoue aussitôt en 409 « Une carte de cet échange n'est plus disponible », sans attendre la copie de B ; ce second échange n'est prouvé qu'en séquence, ce qui suffit, puisque deux acceptations se sérialisent sur `lock_users`. Contre-offre, acceptation et annulation du même parent en même temps : une seule passe, les autres 409 « déjà traité ». Partout : 0 `40P01`, 0 `55P03`, invariants vides. → `28_trades.test.sql` (Tasks 2 et 5), `17_trades_concurrency.test.sh` (Task 7, scénarios 1, 6 et 7).
- **Pile partiellement échangée, favorite, étiquetée et en avatar.** A donne 2 unités d'une pile de 3, favorite et étiquetée, et une copie seule, favorite, à deux étiquettes, qui est son avatar. Attendu : la pile reste chez A avec `count` 1, son étoile et son étiquette ; B reçoit une ligne neuve de `count` 2, sans étoile ni étiquette, à l'`obtained_at` et aux snapshots de la source ; la copie seule garde son id, passe chez B sans étoile ni étiquette, et l'avatar de A devient nul ; compteurs par rareté justes. → Task 5.
- **WB des deux côtés.** A offre 300 et B 500 : une seule ligne `trade:` par joueur (A −300 + 500 = +200, B −200). B à 250 passe (net −200) ; B à 150 reçoit 409 `insufficient_balance`, et rien ne bouge. Avec 100 contre 100, aucune ligne de grand livre. → Task 5.
- **Échéance passée, cron pas encore passé** (banc, CI, ou l'heure qui précède `:27`). Accepter, refuser, annuler ou contrer → 409 « déjà traité » ; la liste et le détail le montrent « Expiré » ; ses cartes sont libres (défausse permise) ; `wm.expire_trades()` le passe à `expired` sans argent ni notification. → Tasks 2, 4, 5 et 6 ; `e2e/trades.spec.ts` (Task 12).
- **Ami retiré avec des échanges en cours dans les deux sens.** Les deux passent à `cancelled` dans la même transaction et leurs cartes sont libérées ; un échange entre deux joueurs qui ne sont plus amis est refusé à l'acceptation (403 `FORBIDDEN`) ; une nouvelle demande est possible après un retrait ou un refus. → Tasks 3 et 5 ; `e2e/friends.spec.ts` (Task 11).

## Fichiers

| Fichier | Rôle |
|---|---|
| `supabase/migrations/0005_mirror_trades.sql` | Miroir : `trade_status`, `friendship_status`, `trades`, `trade_items`, `friendships`, RLS des participants, droits |
| `supabase/migrations/1700_wm_trade_core.sql` | Config, index, `card_locked`, `pending_trade_card_ids`, `trade_json`, `notify_trade`, redéfinitions de `my_collection`, `create_auction`, `bulk_discard`, `discard`, `check_invariants` |
| `supabase/migrations/1710_wm_friends.sql` | Amitiés, recherche et son index, `notify_friend`, `collection_filter` ouvert aux amis |
| `supabase/migrations/1720_wm_trade_create.sql` | `create_trade`, contre-offre comprise |
| `supabase/migrations/1730_wm_trade_action.sql` | `trade_move`, `trade_action`, `expire_trades` |
| `supabase/migrations/1740_wm_trade_read.sql` | `trades_list`, `trade_detail`, `notifications_list`, `notifications_read` |
| `supabase/migrations/9010_wm_trade_cron.sql` | Job `wm-trade-expire`, seulement si pg_cron existe |
| `supabase/tests/28_trades.test.sql`, `supabase/tests/17_trades_concurrency.test.sh`, `supabase/tests/helpers.sql` | Tests SQL, concurrence, état complet et trigger de faute |
| `app/api/friends/**`, `app/api/trades/**`, `app/api/notifications/route.ts` | Douze routes (quinze routes de contrat avec les trois refus de `rest/v1/trades`) |
| `contract/spec/{friends,trades,notifications}.ts`, `contract/spec/rest.ts` | Contrat |
| `lib/notifications.ts`, `components/shell/{Bell,NotificationPanel}.tsx` | Cloche et panneau (Task 10, avec les routes de notifications) |
| `app/(game)/friends/*`, `app/(game)/trades/**`, `components/trades/*` | Pages |
| `e2e/{notifications,friends,trades,trade-journey}.spec.ts` | Pages, a11y et critère du jalon |
| `load/bench/{trade_setup.sql,trade_accept.sql,run.sh}` | Bench d'acceptation journalisé |

---

### Task 1: Miroir des échanges et des amitiés, RLS des participants

**Files:**
- Create: `supabase/migrations/0005_mirror_trades.sql`
- Modify: `supabase/tests/02_mirror_rls.test.sql` (fixtures, compte de tables, chaîne des droits, Carol), `supabase/tests/02_mirror_rls_legacy_grants.test.sh` (`-f "$d/../migrations/0005_mirror_trades.sql"` après `0004`)

**Interfaces:**
- Produces (`0005`, en-tête `-- MIRROR : échanges et amitiés (R§3.6, R§3.7, R§4.1, R§4.2, D§6.2, M4-1). Idempotente.`) :

  | Objet | Contenu |
  |---|---|
  | `public.trade_status` | enum `('pending', 'accepted', 'declined', 'cancelled', 'expired', 'countered')`, sous garde comme `0004:5-9` |
  | `public.friendship_status` | enum `('pending', 'accepted')` |
  | `public.trades` | `id uuid pk default gen_random_uuid()`, `status public.trade_status not null default 'pending'`, `initiator_id uuid not null → profiles on delete cascade`, `recipient_id uuid not null → profiles on delete cascade`, `initiator_wikibidous int not null default 0`, `recipient_wikibidous int not null default 0`, `parent_trade_id uuid → trades on delete set null`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`, `accepted_at timestamptz`, `completed_at timestamptz`, `closed_at timestamptz`, `expires_at timestamptz not null`, `check (initiator_id <> recipient_id)` |
  | `public.trade_items` | `id uuid pk default gen_random_uuid()`, `trade_id uuid not null → trades on delete cascade`, `offered_by uuid not null → profiles on delete cascade`, `user_card_id uuid not null` (sans FK, P2), `card_id uuid not null → cards`, `snapshot_rarity public.rarity not null`, `is_shiny boolean not null default false` |
  | `public.friendships` | `id uuid pk default gen_random_uuid()`, `requester_id uuid not null → profiles on delete cascade`, `addressee_id uuid not null → profiles on delete cascade`, `status public.friendship_status not null default 'pending'`, `created_at timestamptz not null default now()`, `check (requester_id <> addressee_id)` ; `create unique index if not exists friendships_pair_key on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id))` (D:593) |

  - RLS activée sur les trois tables. `revoke all … from public, anon, authenticated`, `grant select … to authenticated`, `grant all … to service_role`.
  - Politiques créées si absentes, par la boucle de `0004:62-72` : `trades_select_participant` (`(select auth.uid()) in (initiator_id, recipient_id)`), `trade_items_select_participant` (`exists (select from public.trades t where t.id = trade_id and (select auth.uid()) in (t.initiator_id, t.recipient_id))`), `friendships_select_participant` (`(select auth.uid()) in (requester_id, addressee_id)`).

- [ ] **Step 1: Tests qui échouent** (`02_mirror_rls.test.sql`)
  - Fixtures, à la suite de celles d'Alice et Bob : `tests.make_user('Carol')` ; une amitié Alice–Bob `accepted` ; un échange Alice → Bob avec deux éléments (la copie d'Alice, offerte par Alice ; celle de Bob, offerte par Bob), `expires_at = now() + interval '168 hours'`.
  - Tables de `public` : `'{12, 0}'` (12 tables, toutes sous RLS).
  - **Droits exacts**, la chaîne du M3 avec trois entrées de plus, triée en `collate "C"` : `anon cards SELECT, authenticated auction_bids SELECT, authenticated auctions SELECT, authenticated cards SELECT, authenticated friendships SELECT, authenticated notifications SELECT, authenticated profiles SELECT, authenticated tags DELETE, authenticated tags INSERT, authenticated tags SELECT, authenticated tags.color UPDATE, authenticated tags.name UPDATE, authenticated trade_items SELECT, authenticated trades SELECT, authenticated user_card_tags DELETE, authenticated user_card_tags INSERT, authenticated user_card_tags SELECT, authenticated user_cards SELECT, authenticated user_cards.starred UPDATE, authenticated wishlist_items DELETE, authenticated wishlist_items INSERT, authenticated wishlist_items SELECT`.
  - Bob (`tests.login`) lit l'échange, ses deux éléments et l'amitié. Carol, l'authentifiée étrangère, en lit 0 de chacun (M4-14).
  - Bob : `insert`, `update` et `delete` sur chacune des trois tables → `insufficient_privilege`. `anon` : `select` sur `trades` → `insufficient_privilege`.
  - En superutilisateur : une amitié Bob → Alice → `unique_violation` (index de paire) ; un échange d'Alice vers elle-même → `check_violation`.
  - `02_mirror_rls_legacy_grants.test.sh`, qui rejoue `0005`, obtient les mêmes droits exacts.
- [ ] **Step 2: `npm run test:db`** → `FAIL 02_mirror_rls.test.sql` (tables absentes).
- [ ] **Step 3: Implémenter `0005`.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(db): miroir des échanges et des amitiés (trades, trade_items, friendships), lecture par les participants sous RLS, droits exacts`

---

### Task 2: Socle `wm` des échanges — config, index, verrou d'échange, objet `Trade`, notifications, invariant

**Files:**
- Create: `supabase/migrations/1700_wm_trade_core.sql`, `supabase/tests/28_trades.test.sql`
- Modify: `supabase/tests/13_discard_concurrency.test.sh:22` (bloqueur à `pg_sleep(1)`, la moitié du nouveau `lock_timeout` de `bulk_discard` ; à 2 s, les dernières défausses dépasseraient 2 s d'attente)

**Interfaces:**
- Consumes : tables de la Task 1 ; `wm.raise_err`, `wm.idem_claim`, `wm.idem_store`, `wm.actor`, `wm.lock_user`, `wm.lock_users`, `wm.wallet_apply`, `wm.market_guard`, `wm.escrow_put`, `wm.market_tick` (M0 à M3).
- Produces (`1700`, en-tête ADDITIVE et ligne pg-safeupdate de `1600:1-3`) :

  | Objet | Contenu |
  |---|---|
  | Clés `wm.config` | `trade_limits` `{"cards": 100, "wb": 10000, "expiry_h": 168}`, note « Par côté : cartes et wikibidous au plus ; expiration en heures (D§7.6, prob. ; 48 h vient du clone) » ; `friend_limit` `'null'::jsonb` (la colonne `value` est `not null`), note « Désactivée : valeur inconnue (R§10.5, C30, M4-11) » ; `list_caps` (P9), note « Plafonds des listes sans pagination (D§7.6, D§7.9, M4-16) » |
  | Index (D:810) | `trades_initiator_idx (initiator_id, status, created_at desc)`, `trades_recipient_idx (recipient_id, status, created_at desc)`, `trades_pending_expiry_idx (expires_at) where status = 'pending'`, `trades_parent_idx (parent_trade_id) where parent_trade_id is not null`, `trade_items_trade_idx (trade_id)`, `trade_items_offered_idx (offered_by, card_id)`, `friendships_requester_idx (requester_id)`, `friendships_addressee_idx (addressee_id)` |

  | Fonction | Rôle |
  |---|---|
  | `wm.card_locked(p_uid uuid, p_card_id uuid) returns boolean` | `exists` d'un `trade_items` `offered_by = p_uid` et `card_id = p_card_id` dont l'échange est en attente au sens du P3 (`clock_timestamp()`). Volatile. |
  | `wm.pending_trade_card_ids(p_uid uuid) returns jsonb` | Tableau trié et dédoublonné (en `text`) de l'union des `card_id` et des `user_card_id` des éléments offerts par `p_uid` dans un échange en attente (C13). |
  | `wm.my_collection(...)` | Même signature et même corps que `1300:128-161`, sauf `'pendingTradeCardIds'` : `wm.pending_trade_card_ids(p_uid)` quand `coalesce(p_owned_by, p_uid) = p_uid`, sinon `'[]'` (les échanges d'un autre ne le regardent pas). |
  | `wm.trade_json(t public.trades) returns jsonb` | `stable`, P7 ; `status` lu `expired` pour une ligne `pending` dont `expires_at <= clock_timestamp()` (P3 ; `stable` reste permis). |
  | `wm.notify_trade(p_users uuid[], p_type text, p_trade_id uuid, p_actor uuid) returns int` | Une ligne par id non nul, `data = {trade_id, user_id: p_actor, username: <pseudo de p_actor>}`, une instruction `order by user_id`. Renvoie le nombre de lignes. |
  | `wm.create_auction(...)` | Même signature et même corps que `1610:4-53`. Le `shortcut:` des lignes 27-28 est remplacé, après le 403 `42501`, par : `wm.card_locked(p_uid, k.card_id)` → 409 sans code « Cette carte est déjà engagée dans un échange en attente ». |
  | `wm.bulk_discard(...)` | Même signature et même réponse que `1300:224-252`. `perform set_config('lock_timeout', '2s', true)` avant `wm.lock_user`. `v_done` exclut les copies dont le `card_id` est verrouillé pour `p_uid`, et son `select … for update` gagne `order by id` (P25). Chaque id de `failed` porte « Cette carte est déjà engagée dans un échange en attente » si la copie est à `p_uid`, sinon « Vous ne possédez pas cette carte », toujours dans l'ordre reçu (M4-10). Le `shortcut:` de la ligne 242 disparaît. |
  | `wm.discard(...)` | Même signature et même réponse que `1300:255-267`. `discarded_count = 0` et la `reason` de `failed -> 0` vaut le message du verrou → 409 sans code avec ce message ; sinon le 403 `42501` d'aujourd'hui. |
  | `wm.check_invariants()` | Les checks de `1600:222-269` tels quels, plus `trade_money` (P8). |

- [ ] **Step 1: Test qui échoue** (`28_trades.test.sql`)
  - En tête : `pg_temp.err` et `pg_temp.inv` repris de `27_market.test.sql:5-16` ; `pg_temp.card(p_title text, p_rarity public.rarity default 'R') returns uuid` ; `pg_temp.player(p_name text, p_balance int default 0) returns uuid` (`tests.make_user`, puis `wm.set_human_verified`) ; `pg_temp.copy(p_uid uuid, p_card uuid, p_count int default 1) returns uuid` (une ligne `user_cards` aux snapshots de la carte) ; `pg_temp.friends(p_a uuid, p_b uuid) returns void` (une ligne `accepted`) ; `pg_temp.trade(p_from uuid, p_to uuid, p_copies uuid[], p_status public.trade_status default 'pending', p_expires interval default '168 hours') returns uuid`. Ce dernier insère l'échange et un élément par id de copie, offert par le propriétaire de la copie, aux snapshots de la copie ; il sert jusqu'à la Task 4. Chaque bloc filtre sur ses propres joueurs : le fichier tourne en une seule transaction (`db-test.sh:69-70`), où `now()` reste figé : les échéances se posent par rapport à `clock_timestamp()`, et les dates à trier sont posées explicitement.
  - Config : `jsonb_object_agg` de `trade_limits`, `friend_limit` et `list_caps` = les valeurs exactes ; aucune note vide.
  - Index : l'`indexdef` complet des huit index, comparé comme `27_market.test.sql:44-63` (nom et `ON <table> USING btree (<colonnes>) [WHERE …]` exacts).
  - `card_locked` : A offre une copie de X et demande à B une copie de Y.
    - vrai pour `(A, X)` et pour `(B, Y)` (les deux côtés, M4-2) ;
    - faux pour `(B, X)` ;
    - faux une fois l'échange `declined` ;
    - faux pour un échange `pending` dont `expires_at = clock_timestamp() - interval '1 second'` (P3, *Review Focus*).
  - `pendingTradeCardIds` :
    - `wm.my_collection(A) -> 'pendingTradeCardIds'` = `(select jsonb_agg(x order by x) from unnest(array[X::text, <copie de A>::text]) x)` ;
    - `wm.my_collection(B, p_owned_by => A)` (A public) → `'[]'`.
  - `create_auction` (A vérifié) :
    - la copie verrouillée de X → détail exact `{"status":409,"error":"Cette carte est déjà engagée dans un échange en attente","message":"Cette carte est déjà engagée dans un échange en attente"}` ;
    - une seconde copie de X, libre, par son id de copie → même 409 (niveau `card_id`) ; par l'id catalogue X → même 409 ;
    - la copie d'un autre → 403 `42501` d'abord ;
    - une copie de Z, sans échange → `{auction_id, id, end_at}`.
  - `bulk_discard(A, array[<copie verrouillée>, <copie libre de W>, <copie de B>])` → exactement `{"discarded_count":1,"failed":[{"id":<verrouillée>,"reason":"Cette carte est déjà engagée dans un échange en attente"},{"id":<copie de B>,"reason":"Vous ne possédez pas cette carte"}]}`, et la copie verrouillée est intacte (même `count`).
  - `discard(A, <copie verrouillée>)` → le 409 exact ci-dessus ; `discard(A, <copie de B>)` → 403 `42501`. Échange `pending` échu → `discard` passe.
  - `trade_json` :
    - clés triées = les 13 colonnes + `counter_trade_id`, `initiator`, `items`, `recipient` ;
    - chaque élément a exactement les six clés du P7, et `card` exactement ses quatre ;
    - les éléments de l'initiateur viennent d'abord ;
    - `counter_trade_id` est `null` ;
    - `status` vaut `'expired'` pour une ligne `pending` échue (`expires_at = clock_timestamp() - interval '1 second'`).
  - Ordre des éléments (P7), sur un fixture inséré dans le désordre : `pg_temp.trade(A, B, array[<copie de B>, <copie C de A>, <copie UR de A>])` → `items` = exactement [A-UR, A-C, B], dans cet ordre.
  - `notify_trade(array[B, null], 'trade_received', t, A)` → 1, et `data` = exactement `{"trade_id": t, "user_id": A, "username": <pseudo de A>}`.
  - Invariant : `wallet_apply(A, 5, 'trade', 'trade:' || t)` → `wm.check_invariants()` = exactement `[{"check":"trade_money","ref":"trade:<t>","sum":5}]` ; puis `wallet_apply(B, -5, 'trade', 'trade:' || t)` (B au solde de 10) → `'[]'`.
  - `lock_timeout` (P5) : le contrôle `prosrc` sur `create_auction` et `bulk_discard`.
- [ ] **Step 2: `npm run test:db`** → `FAIL 28_trades.test.sql`.
- [ ] **Step 3: Implémenter `1700`** ; fin `revoke`/`grant`.
- [ ] **Step 4: Contrôles complets** → vert (`23_collection`, `27_market`, `16_market_concurrency` et les specs `collection.ts` et `market.ts` inchangés et verts ; `13_discard_concurrency` vert avec son bloqueur à 1 s).
- [ ] **Step 5: Commit** — `feat(db): socle des échanges (config, index, verrou d'échange au niveau card_id dans la vente et la défausse, pendingTradeCardIds réel, objet Trade, notify_trade, invariant trade_money)`

---

### Task 3: Amitiés — demande, acceptation, refus, retrait, tout accepter, recherche, collection des amis

**Files:**
- Create: `supabase/migrations/1710_wm_friends.sql`
- Modify: `supabase/tests/28_trades.test.sql`

**Interfaces:**
- Consumes : Task 2 ; `wm.collection_filter` (`1300:81-104`).
- Produces :

  | Fonction | Réponse, règles |
  |---|---|
  | `wm.are_friends(p_a uuid, p_b uuid) returns boolean` | `stable` ; une ligne `accepted` sur la paire |
  | `wm.friendship_json(f public.friendships) returns jsonb` | `stable` ; `to_jsonb(f)` + `requester {id, username, avatar_url}` + `addressee {id, username, avatar_url}` |
  | `wm.notify_friend(p_friendship_ids uuid[], p_type text, p_actor uuid) returns int` | P6 ; `data = {friendship_id, user_id: p_actor, username}` ; destinataire = l'autre participant ; une instruction `order by user_id` |
  | `wm.friend_request(p_uid uuid, p_addressee_id uuid, p_idem text default null) returns jsonb` | `{friendship}`. Ordre : `idem_claim`, `actor`, soi-même → 400, destinataire inconnu → 404 « Joueur introuvable », `lock_timeout`, `lock_users(array[p_uid, p_addressee_id])` (P4), ligne `accepted` → 409 `ALREADY_FRIENDS`, ligne `pending` dans un sens ou dans l'autre → 409 `REQUEST_PENDING`, `friend_limit` non nul (`value <> 'null'::jsonb`) et amis acceptés de `p_uid` ≥ limite → 409 `FRIEND_LIMIT` `format('Limite d''amis atteinte (%s)', n)`, insertion, `notify_friend(…, 'friend_request', p_uid)`, `idem_store` |
  | `wm.friend_action(p_uid uuid, p_friendship_id uuid, p_action text, p_idem text default null) returns jsonb` | `accept` → `{friendship}`, `decline` → `{ok: true}`. Ordre : `idem_claim`, `actor`, action hors `accept` et `decline` → 400 « Action inconnue », `lock_timeout`, amitié `for update` (inconnue ou sans `p_uid` → 404 « Demande d'ami introuvable »), `accepted` → 409 `ALREADY_FRIENDS`, `p_uid` ≠ `addressee_id` → 403 (accepter ou refuser « cette demande »), puis `accept` (limite comme ci-dessus, pour les deux joueurs ; `status = 'accepted'` ; `notify_friend(…, 'friend_accepted', p_uid)`) ou `decline` (`delete`, M4-11), et `return wm.idem_store(…)` |
  | `wm.friend_remove(p_uid uuid, p_friendship_id uuid, p_idem text default null) returns jsonb` | `{ok: true}`. Ordre : `idem_claim`, `actor`, `lock_timeout`, amitié `for update` (404 comme ci-dessus), `update public.trades set status = 'cancelled', closed_at = clock_timestamp(), updated_at = clock_timestamp() where status = 'pending' and expires_at > clock_timestamp() and` la paire dans un sens ou dans l'autre (un échu reste à l'expiration), puis `delete` de l'amitié, et `return wm.idem_store(…)`. Aucune notification, aucun profil verrouillé (P4, P6). Vaut pour un ami, et pour une demande en attente des deux côtés. |
  | `wm.friend_accept_all(p_uid uuid, p_idem text default null) returns jsonb` | `{accepted: n}`. Ordre : `idem_claim`, `actor`, `lock_timeout`, demandes reçues en attente `order by id for update` ; limite pour le lot entier (409 `FRIEND_LIMIT`) ; `update` en `accepted`, puis un seul `notify_friend(<ids>, 'friend_accepted', p_uid)`, et `return wm.idem_store(…)` |
  | `wm.friends_list(p_uid uuid) returns jsonb` | `stable` ; `{friendships: [friendship_json…]}`, toutes les lignes de `p_uid`, `created_at desc, id` |
  | `wm.friend_search(p_uid uuid, p_q text) returns jsonb` | `stable` ; `{users: [{id, username, avatar_url}]}` (P12), au plus `list_caps.friend_search` |
  | `wm.collection_filter(...)` | Même signature : un `owned_by` d'un autre passe si son profil est public **ou** si `wm.are_friends(p_uid, p_owned_by)` ; un `wishlisted_by` d'un autre passe si `wm.are_friends`. Messages de refus inchangés. Le `shortcut:` de la ligne 86 disparaît. |
  | Index | `profiles_username_prefix_idx on public.profiles (lower(username) text_pattern_ops)` (M4-11) |

- [ ] **Step 1: Tests qui échouent** (`28_trades.test.sql`)
  - Demande :
    - A → B → `{friendship}` avec `status` `pending` et `requester_id` A ; une `friend_request` pour B dont `data` = exactement `{friendship_id, user_id: A, username: <A>}` ;
    - A → B une seconde fois → `{"status":409,"code":"REQUEST_PENDING","error":"Une demande d'ami est déjà en attente","message":"Une demande d'ami est déjà en attente"}` ;
    - B → A → la même 409, et la ligne reste `pending` (pas d'acceptation implicite) ;
    - A → A → 400 « Tu ne peux pas t'ajouter toi-même en ami » ; A → id inconnu → 404 « Joueur introuvable » ;
    - même `p_idem` deux fois → même réponse, une seule ligne, une seule notification.
  - Action :
    - A (le demandeur) accepte → 403 `FORBIDDEN` « Seul le destinataire peut accepter cette demande » ; refuse → « Seul le destinataire peut refuser cette demande » ;
    - B accepte → `{friendship}` en `accepted` ; une `friend_accepted` pour A avec `user_id` B ;
    - accepter de nouveau → 409 `ALREADY_FRIENDS` « Vous êtes déjà amis » ; A → B → la même 409 ;
    - Carol sur l'amitié A–B → 404 « Demande d'ami introuvable » ; `p_action 'xyz'` → 400 « Action inconnue » ;
    - C → D, puis D refuse avec `p_idem` → `{"ok":true}`, et le même `p_idem` rejoué → `{"ok":true}` sans 404 ; la ligne a disparu et une nouvelle demande C → D passe (*Review Focus*).
  - Limite, `friend_limit` à `'1'::jsonb` :
    - A a un ami, A → E → `{"status":409,"code":"FRIEND_LIMIT","error":"Limite d'amis atteinte (1)","message":"Limite d'amis atteinte (1)"}` ;
    - une demande en attente vers A, déjà à sa limite, acceptée par A → la même 409 ; `friend_accept_all(A)` avec deux demandes en attente → la même 409, et les deux restent `pending` ;
    - remise à `'null'::jsonb`.
  - Tout accepter : C, D et E demandent F → `friend_accept_all(F, 'k-all')` → `{"accepted":3}`, trois `friend_accepted` (pour C, D et E) ; le même `p_idem` → `{"accepted":3}` ; sans clé → `{"accepted":0}`.
  - ***Review Focus*, retrait** : A et B amis, deux échanges `pending` (A → B et B → A, par `pg_temp.trade`) et un `accepted` :
    - `friend_remove(B, f, 'k-rm')` → `{"ok":true}` ;
    - les deux `pending` passent à `cancelled` avec `closed_at` ; l'`accepted` reste ;
    - un troisième échange `pending` déjà échu (`expires_at = clock_timestamp() - interval '1 second'`) reste `pending` (lu `expired`) ;
    - `card_locked` est faux pour les cartes des deux échanges, et l'amitié a disparu ;
    - le même `p_idem` rejoué → `{"ok":true}`, sans 404 ; Carol → 404 ; un demandeur retire sa propre demande en attente → `{"ok":true}`.
  - `maintenance` à `true` → 503 `maintenance` pour `friend_remove` et `friend_accept_all`.
  - Recherche (joueurs `ZetaAlpha`, `zetabeta`, `Zeta_1`, `Zetab2` et 25 `zz_<n>`) :
    - `q 'ZETA'` → les quatre `Zeta…`, ordre `lower(username)` ;
    - `q 'zeta_'` → `Zeta_1` seul (`_` échappé) ; `q 'z%'` → aucune ligne ;
    - `q 'zz'` → 20 lignes ; le chercheur `zz_0` n'y est pas ;
    - `q 'z'` et `q '  z '` → 400 « La recherche demande au moins 2 caractères » ;
    - `set local enable_seqscan = off`, puis `explain (format json) select id from public.profiles where lower(username) like 'ze%'` → le plan nomme `profiles_username_prefix_idx`.
  - Collection des amis : A au profil privé et B amis :
    - `my_collection(B, p_owned_by => A)` passe ; pour Carol → 403 « Cette collection est privée » ;
    - `my_collection(B, p_wishlisted_by => A)` passe ; pour Carol → 403 « Vous devez être amis pour voir sa liste de souhaits ».
  - Volatilité : `are_friends`, `friends_list` et `friend_search` ont `provolatile = 's'` (M3-R5).
  - `lock_timeout` (P5) : ajouter `friend_request`, `friend_action`, `friend_remove` et `friend_accept_all`.
- [ ] **Step 2: `npm run test:db`** → `FAIL 28_trades.test.sql`.
- [ ] **Step 3: Implémenter `1710`.**
- [ ] **Step 4: Contrôles complets** → vert (`23_collection` inchangé : ses joueurs ne sont pas amis).
- [ ] **Step 5: Commit** — `feat(db): amitiés (demande, acceptation, refus qui supprime, retrait qui annule les échanges, tout accepter), recherche par préfixe indexée, collection et souhaits ouverts aux amis`

---

### Task 4: Création d'un échange et contre-offre

**Files:**
- Create: `supabase/migrations/1720_wm_trade_create.sql`
- Modify: `supabase/tests/28_trades.test.sql`

**Interfaces:**
- Consumes : Tasks 2 et 3.
- Produces : `wm.create_trade(p_uid uuid, p_recipient_id uuid, p_items jsonb, p_initiator_wikibidous int default 0, p_recipient_wikibidous int default 0, p_parent_trade_id uuid default null, p_tz text default null, p_idem text default null) returns jsonb` → `wm.trade_json` de l'échange créé (D:506 « `{id, …trade}` »). `p_items` = `[{user_card_id, card_id, offered_by}]`. `p_tz` est reçu, sans effet (C30).

  **Ordre** :
  1. `idem_claim`, puis `actor(p_uid)` ;
  2. `p_recipient_id = p_uid` → 400 « Tu ne peux pas échanger avec toi-même » ;
  3. WB nuls lus comme 0 ; un côté hors de `[0, trade_limits.wb]` → 400 « Entre 0 et 10 000 wikibidous par côté » ;
  4. un `offered_by` hors de `{p_uid, p_recipient_id}` → 400 « Élément d'échange invalide » ;
  5. aucun élément → 400 « Un échange contient au moins une carte » ; plus de `trade_limits.cards` éléments d'un côté → 400 « Au plus 100 cartes par côté » ;
  6. `lock_timeout` ;
  7. contre-offre : parent `for update`. S'il est inconnu, ou si `p_uid` n'y participe pas → 404 « Échange introuvable ». S'il n'est plus `pending`, ou si `expires_at <= clock_timestamp()` → 409 « déjà traité ». Si `p_uid` ≠ `recipient_id` → 403 `FORBIDDEN` « Seul le destinataire peut faire une contre-offre ». Si `p_recipient_id` ≠ son `initiator_id` → 400 « La contre-offre s'adresse à l'initiateur de l'échange » ;
  8. destinataire inconnu → 404 « Joueur introuvable » ;
  9. `lock_users(array[p_uid, p_recipient_id])` ;
  10. `not wm.are_friends(…)` → 403 `FORBIDDEN` « Vous devez être amis pour échanger » ;
  11. possession, en une requête : éléments groupés par `(user_card_id, offered_by)`. Une copie absente, à un autre joueur, ou au `count` inférieur au nombre d'éléments → 403 `42501` ;
  12. solde de `p_uid` < `p_initiator_wikibidous` → 409 `insufficient_balance` « Solde insuffisant » (le solde du destinataire n'est jamais lu) ;
  13. `insert` de l'échange (`expires_at = clock_timestamp() + make_interval(hours => expiry_h)`, `parent_trade_id`), puis des éléments, aux snapshots de la copie (P2) ;
  14. parent : `status = 'countered'`, `closed_at` et `updated_at` = `clock_timestamp()` ;
  15. `notify_trade(array[p_recipient_id], <'trade_countered' si contre-offre, sinon 'trade_received'>, id, p_uid)`, puis `idem_store`.

- [ ] **Step 1: Tests qui échouent** (`28_trades.test.sql` ; `pg_temp.trade` reste pour les blocs précédents)
  - A (500 WB) et B, amis. A offre a1 (count 1) et 2 unités de a2 (count 3), demande b1 ; WB 300 et 0 ; `p_items` envoyés avec b1 en premier ; le `card_id` envoyé pour a1 est celui d'une autre carte :
    - réponse = `trade_json` : `pending`, quatre éléments, ceux de A d'abord malgré l'ordre d'envoi, `card_id` de a1 = sa vraie carte (P2) ;
    - `expires_at` est entre `clock_timestamp()` lu avant + 168 h et lu après + 168 h ;
    - une `trade_received` pour B (`user_id` A) ; aucune ligne de grand livre ; soldes inchangés ; `card_locked(A, <carte de a2>)` vrai.
  - Refus exacts :
    - Carol, qui n'est pas amie de A → 403 `{"status":403,"code":"FORBIDDEN","error":"Vous devez être amis pour échanger","message":"Vous devez être amis pour échanger"}` ;
    - A vers A → 400 ; destinataire inconnu → 404 « Joueur introuvable » ;
    - `[]` avec 10 et 10 WB → 400 « Un échange contient au moins une carte » ;
    - pile de A au `count` 150 : 100 éléments passent, 101 → 400 « Au plus 100 cartes par côté » ;
    - `p_recipient_wikibidous` 10 001 ou −1 → 400 « Entre 0 et 10 000 wikibidous par côté » ; 10 000 côté B passe, même si B n'a rien ;
    - un élément `offered_by` Carol → 400 « Élément d'échange invalide » ;
    - trois éléments sur une copie au `count` 2, ou b1 déclarée offerte par A → 403 `42501` exact ;
    - A au solde de 100 qui offre 101 → 409 `insufficient_balance` exact.
  - La même copie dans un second échange en attente → créé (M4-2).
  - Un seul côté (M4-9) : A offre a3 seule et demande 50 WB, sans élément de B → créé ; B offre b2 seule et ne demande rien → créé (acceptés à la Task 5).
  - Contre-offre de B sur T1 (de A vers B) :
    - T2 `pending`, `initiator_id` B, `parent_trade_id` T1 ; T1 en `countered` avec `closed_at` ; `trade_json(T1) ->> 'counter_trade_id'` = T2 ;
    - une `trade_countered` pour A et aucune `trade_received` de plus ;
    - A contre T1 → 403 « Seul le destinataire peut faire une contre-offre » ; Carol → 404 « Échange introuvable » ;
    - contre T1 déjà `countered` → 409 « Cet échange n'est plus en attente (déjà traité) » ; contre un T3 dont `expires_at` est passé → même 409 (*Review Focus*) ;
    - `p_recipient_id` Carol → 400 « La contre-offre s'adresse à l'initiateur de l'échange ».
  - Même `p_idem` deux fois → même réponse, un seul échange, une seule notification. `p_tz 'Europe/Paris'` accepté.
  - `lock_timeout` (P5) : ajouter `create_trade`, et vérifier que son premier `for update` (le parent) précède `wm.lock_users(`.
- [ ] **Step 2: `npm run test:db`** → `FAIL 28_trades.test.sql`.
- [ ] **Step 3: Implémenter `1720`.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(db): création d'un échange entre amis (possession, plafonds, solde de l'initiateur) et contre-offre qui clôt le parent`

---

### Task 5: Acceptation, refus, annulation, expiration — atomicité prouvée dans le fichier SQL

**Files:**
- Create: `supabase/migrations/1730_wm_trade_action.sql`, `supabase/migrations/9010_wm_trade_cron.sql`
- Modify: `supabase/tests/28_trades.test.sql`, `supabase/tests/helpers.sql` (P23)

**Interfaces:**
- Consumes : Tasks 2 à 4.
- Produces :

  | Objet | Rôle |
  |---|---|
  | `wm.trade_move(p_trade public.trades) returns void` | M4-3, copies déjà verrouillées et vérifiées. Ids de copie et k (nombre d'éléments par `user_card_id`) en une requête, puis cinq instructions : (1) k = n : `update public.user_cards set user_id = <l'autre joueur>, starred = false where id = any (v_full)` ; (2) k < n : `insert` d'une ligne `count = k`, `starred = false`, pour l'autre joueur, avec `card_id`, `is_shiny`, `snapshot_title`, `snapshot_rarity`, `snapshot_category`, `snapshot_atk`, `snapshot_def` et `obtained_at` de la source ; (3) `update … set count = count - x.k from unnest(v_part, v_k) x (id, k) where user_cards.id = x.id` ; (4) `delete from public.user_card_tags where user_card_id = any (v_full)` ; (5) `update public.profiles set avatar_user_card_id = null where avatar_user_card_id = any (v_full) and id in (initiator_id, recipient_id)` (P13 ; aucun profil hors de `lock_users` n'est écrit). |
  | `wm.trade_action(p_uid uuid, p_trade_id uuid, p_action text, p_tz text default null, p_idem text default null) returns jsonb` | `{status, trade}` (M4-9) |
  | `wm.expire_trades(p_batch int default 5000) returns int` | `lock_timeout` ; `update public.trades set status = 'expired', closed_at = clock_timestamp(), updated_at = clock_timestamp() where id in (select id … where status = 'pending' and expires_at <= clock_timestamp() order by expires_at limit p_batch for update skip locked)` ; renvoie le nombre. Ni `actor`, ni argent, ni notification (M4-5). |
  | `9010_wm_trade_cron.sql` | En tête : ADDITIVE, exception aux migrations `wm` comme `9000:2-3`. Un bloc `do`, et dedans un `begin … exception when others then raise warning '9010_wm_trade_cron : … (% : %)'` autour de `if exists (select from pg_extension where extname = 'pg_cron') then perform cron.schedule('wm-trade-expire', '27 * * * *', 'select wm.expire_trades(5000)'); end if;`. |
  | `tests.trade_snapshot(p_trade uuid) returns jsonb` | P23. Avec I et R, l'initiateur et le destinataire : `{trade: to_jsonb(<ligne>), copies: [{id, user_id, count, starred}] des copies de I et R par id, tags: [[user_card_id, tag_id]] de leurs copies, triés, profiles: [{id, avatar_user_card_id, wikibidous_balance}] par id, ledger: <nombre de lignes de ref 'trade:'‖id>, notifications: <nombre de lignes dont data ->> 'trade_id' = id>, idem: <nombre de clés de I et R dans wm.idempotency_keys>, invariants: wm.check_invariants()}` |
  | `tests.boom() returns trigger` | `raise exception 'erreur injectée' using errcode = 'XX000'` |

  **Ordre de `trade_action`** :
  1. `idem_claim`, puis `actor(p_uid)` ;
  2. action hors `accept`, `decline` et `cancel` → 400 « Action inconnue » ;
  3. `lock_timeout`, puis échange `for update`. S'il est inconnu, ou si `p_uid` n'y participe pas → 404 « Échange introuvable » ;
  4. statut ≠ `pending`, ou `expires_at <= clock_timestamp()` → 409 « Cet échange n'est plus en attente (déjà traité) » ;
  5. rôle → 403 `FORBIDDEN` : `accept` et `decline` sont réservés au destinataire, `cancel` à l'initiateur ;
  6. `decline` et `cancel` : statut `declined` ou `cancelled`, `closed_at` et `updated_at` = `clock_timestamp()` ; `notify_trade` vers l'autre joueur (`trade_declined` à l'initiateur, `trade_cancelled` au destinataire) ; aucun profil verrouillé ;
  7. `accept` :
     - `lock_users(array[initiator_id, recipient_id])`, puis `not are_friends` → 403 « Vous devez être amis pour échanger » ;
     - copies des éléments `where id = any (<ids>) and user_id in (initiator_id, recipient_id) order by id for update` (P25) ; une copie absente du résultat ou au `count` inférieur au nombre de ses éléments, ou un `user_id` différent de son `offered_by` → 409 « Une carte de cet échange n'est plus disponible », sans toucher au tiers ;
     - `trade_move` ;
     - `wallet_apply(<joueur>, <net>, 'trade', 'trade:' || id)` pour chaque net non nul, par id croissant (net de l'initiateur = `recipient_wikibidous − initiator_wikibidous`) ;
     - `status = 'accepted'`, et `accepted_at`, `completed_at`, `closed_at`, `updated_at` = `clock_timestamp()` ;
     - `notify_trade(array[initiator_id], 'trade_accepted', id, p_uid)` ;
  8. `return wm.idem_store(p_uid, p_idem, jsonb_build_object('status', <statut>, 'trade', wm.trade_json(<ligne relue>)))`.

- [ ] **Step 1: Tests qui échouent** (`28_trades.test.sql` ; échanges créés par `wm.create_trade`)
  - ***Review Focus*, pile et WB.** A (1 000) offre a1 (count 1, `starred`, deux étiquettes, avatar de A) et 2 unités de a2 (count 3, `starred`, une étiquette) ; B (1 000) offre b1 (count 1) ; WB 300 et 500. B accepte → `{status: 'accepted', trade}` avec `accepted_at` = `completed_at` = `closed_at`. Ensuite :
    - a1 garde son id, est chez B, `count` 1, `starred` false, sans étiquette ; l'avatar de A est nul ;
    - a2 est chez A, `count` 1, `starred` true, avec son étiquette ;
    - B a une ligne neuve de la carte de a2 : `count` 2, `starred` false, sans étiquette, `obtained_at`, snapshots et `is_shiny` de a2 ;
    - b1 garde son id et est chez A ;
    - exactement deux lignes `trade:<id>` : A +200, B −200 ; soldes 1 200 et 800 ;
    - une `trade_accepted` pour A (`user_id` B) ; `pg_temp.inv`.
  - WB 100 et 100 → aucune ligne `trade:` ; soldes inchangés.
  - Un seul côté (M4-9), les deux échanges de la Task 4 : acceptés → a3 chez B, A +50, B −50 ; b2 chez A, sans ligne `trade:`.
  - ***Review Focus*, solde net** : B à 250 → accepté, B à 50 ; B à 150 → 409 `insufficient_balance` exact, et `tests.trade_snapshot` est égal à celui d'avant, statut `pending`.
  - Initiateur à court (M4-4) : A (1 000) offre 300 dans T ; puis `wm.wallet_apply(A, -950, 'test', 'test:drain')` ; B accepte → 409 `insufficient_balance` exact, et l'instantané de T ne change pas.
  - ***Review Focus*, copie promise deux fois** : a1 dans T1 et T2, tous deux vers B ; T1 accepté ; T2 → 409 « Une carte de cet échange n'est plus disponible », T2 reste `pending` et son instantané ne change pas. Même chose avec T2 vers C : a1, désormais chez B, n'est pas verrouillée par l'acceptation de C (P25 ; prouvé sous verrou à la Task 7, scénario 7).
  - Amitié supprimée à la main (`delete from public.friendships where id = …`), puis accepter → 403 « Vous devez être amis pour échanger ».
  - Rôles :
    - A accepte → 403 « Seul le destinataire peut accepter cet échange » ; A refuse → 403 « Seul le destinataire peut refuser cet échange » ; B annule → 403 « Seul l'initiateur peut annuler cet échange » ;
    - Carol, ou un id inconnu → 404 « Échange introuvable » ; `'counter'` → 400 « Action inconnue ».
  - B refuse → `{status: 'declined'}` avec `closed_at`, une `trade_declined` pour A, et `card_locked` est faux ensuite. A annule un autre échange → `cancelled`, une `trade_cancelled` pour B.
  - Rejeu (M4-8) : `accept` répété sans clé → 409 « déjà traité » exact ; avec la clé du succès → la réponse stockée, identique.
  - ***Review Focus*, échéance** : d'abord `perform wm.expire_trades()`, qui vide les échus laissés par les blocs précédents ; puis trois échanges `pending` dont `expires_at = clock_timestamp() - interval '1 second'` :
    - `accept`, `decline` et `cancel` → 409 « déjà traité » ;
    - avec `maintenance` à `true` : `expire_trades(2)` → 2, puis `expire_trades()` → 1, puis 0 ;
    - les trois ids passent à `expired` avec `closed_at`, et aucun autre statut ne change ; aucune notification, aucune ligne de grand livre.
  - `\ir ../migrations/9010_wm_trade_cron.sql` → aucune erreur, et `to_regnamespace('cron')` reste nul. Ce test ne voit pas un mauvais job : sa seule preuve est `cron.job` sur la démo (Task 16 Step 4).
  - **100 ↔ 100 fonctionnel** (M4-6) : chaque côté donne 70 copies seules, 2 unités de 10 piles de 3 et 1 unité de 10 piles de 2, soit 100 éléments ; WB 500 et 300. Accepté ; Σ `count` de chaque joueur inchangé (100 donnés, 100 reçus) ; 10 lignes neuves de `count` 2 et 10 de `count` 1 chez chacun ; `pg_temp.inv`.
  - **Erreur injectée (M4-7 A)**, deux fois, avec chaque fois l'instantané d'avant, un échange neuf à WB, et l'appel `wm.trade_action(B, t, 'accept', null, 'k-inj-<n>')` dans un bloc `begin … exception when sqlstate 'XX000' then … end` :
    1. `create trigger zz_boom after insert on wm.wb_ledger for each row when (new.ref = 'trade:<t>') execute function tests.boom()` (après les déplacements) ;
    2. `create trigger zz_boom after insert on public.notifications for each row when (new.data ->> 'trade_id' = '<t>') execute function tests.boom()` (dernière instruction).
    Attendu chaque fois : l'exception est levée ; `tests.trade_snapshot(t)` est égal à celui d'avant (copies, `count`, étiquettes, `starred`, avatar, soldes, grand livre, statut, notifications, clés) ; puis `drop trigger zz_boom on …` et le même appel, avec la même clé → `accepted`.
  - `lock_timeout` (P5) : ajouter `trade_action` et `expire_trades`, et vérifier que le premier `for update` de `trade_action` (l'échange) précède `wm.lock_users(`.
- [ ] **Step 2: `npm run test:db`** → `FAIL 28_trades.test.sql`.
- [ ] **Step 3: Implémenter `1730`, `9010` et les deux aides de `helpers.sql`.** Relire `9010` : aucune fonction `wm`, et `node scripts/check-dml.ts` ne signale rien.
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(db): acceptation atomique (copies déplacées en cinq instructions, WB nets, possession revérifiée), refus, annulation, expiration horaire et garde d'échéance, erreur injectée qui annule tout`

---

### Task 6: Lectures des échanges et des notifications

**Files:**
- Create: `supabase/migrations/1740_wm_trade_read.sql`
- Modify: `supabase/tests/28_trades.test.sql`

**Interfaces:**
- Consumes : `wm.trade_json` (Task 2) ; `public.notifications` et `notifications_unread_idx` (`1600:30`).
- Produces :

  | Fonction | Réponse |
  |---|---|
  | `wm.trades_list(p_uid uuid) returns jsonb` | `stable` ; `{trades: Trade[]}` : tous les `pending` (au statut stocké) de `p_uid`, `created_at desc, id`, puis les `list_caps.trades_closed` derniers clos, `closed_at desc nulls last, id` |
  | `wm.trade_detail(p_uid uuid, p_trade_id uuid) returns jsonb` | `stable` ; `{trade}` ; inconnu ou étranger → 404 « Échange introuvable » |
  | `wm.notifications_list(p_uid uuid) returns jsonb` | `stable` ; `{notifications: [{id, type, data, read, created_at}]}`, les `list_caps.notifications` dernières, `created_at desc, id desc` |
  | `wm.notifications_read(p_uid uuid, p_ids uuid[] default null, p_idem text default null) returns jsonb` | `idem_claim`, `actor` ; `update … set read = true where user_id = p_uid and not read and (p_ids is null or id = any (p_ids))` ; `{ok: true, updated: n}` (P10), par `idem_store` |

- [ ] **Step 1: Tests qui échouent** (`28_trades.test.sql` ; lignes insérées à la main, hors grand livre)
  - A : trois `pending`, dont un échu (`expires_at = clock_timestamp() - interval '1 second'`), aux `created_at = now() - make_interval(mins => n)` distincts, insérés du plus ancien au plus récent (l'ordre du tas n'est pas l'ordre attendu) ; 201 clos aux `closed_at` distincts (statuts mêlés), dont les `created_at` vont dans l'ordre inverse des `closed_at` ; et un échange B–Carol.
    - `trades_list(A)` → 203 lignes : d'abord les trois `pending` (créations décroissantes), dont l'échu lu `expired` (P3), puis 200 clos par `closed_at` décroissant ; le plus ancien clos et l'échange B–Carol sont absents ;
  - `trade_detail` : participant → `{trade}` ; Carol → 404 exact ; id inconnu → 404.
  - Notifications de A : 55 lignes aux `created_at = now() - make_interval(secs => 55 - i)`, insérées de la plus ancienne à la plus récente, dont un `auction_outbid` au `data` du M3, plus 3 de B.
    - `notifications_list(A)` → exactement les 50 plus récentes, dans l'ordre, chacune avec exactement `{created_at, data, id, read, type}` ; les 5 plus anciennes et celles de B absentes ;
    - `notifications_read(A, array[<2 de A>, <1 de B>])` → `{"ok":true,"updated":2}`, et celle de B reste non lue ;
    - `notifications_read(A)` → `updated` = le reste des non-lues de A ; un second appel → `0` ;
    - trois non-lues neuves, puis `notifications_read(A, null, 'k-read')` deux fois → `{"ok":true,"updated":3}` deux fois (sans clé, le second rendrait `0`) ;
    - `maintenance` à `true` → 503 `maintenance`.
  - Requête de la cloche (M4-13), en `tests.login(A)` avec `set local enable_seqscan = off` : `explain (format json) select id from public.notifications where read = false limit 10` → le plan nomme `notifications_unread_idx`. PG réécrit `read = false` en `NOT read`, le prédicat de l'index. Seulement si cette assertion échoue, la migration ajoute le partiel `notifications_unread_eq_idx (user_id) where read = false` de D:811 (M4-13), et l'assertion vise alors ce nom.
  - Volatilité : `trades_list`, `trade_detail` et `notifications_list` ont `provolatile = 's'`, `notifications_read` a `'v'`.
- [ ] **Step 2: `npm run test:db`** → `FAIL 28_trades.test.sql`.
- [ ] **Step 3: Implémenter `1740`.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(db): lectures des échanges (en attente et 200 derniers clos, détail) et des notifications (50 dernières, marquage lu par ids ou en bloc)`

---

### Task 7: Concurrence des échanges

**Files:**
- Create: `supabase/tests/17_trades_concurrency.test.sh`

**Interfaces:**
- Consumes : `wm.create_trade`, `wm.trade_action`, `wm.discard`, `wm.create_auction`, `tests.trade_snapshot` (Tasks 2 à 6) ; les aides `q`, `bg`, `waitall`, `refusals`, `quiet` et `fail` de `16_market_concurrency.test.sh:13-60`, recopiées.
- Produces : le fichier de test. En tête, la liste des sept scénarios, comme `16_market_concurrency.test.sh:2-12`.

- [ ] **Step 1: Écrire le test**
  - Préparation :
    - `tag="trd_$RANDOM$RANDOM"`, et un `cleanup` dans un `trap` qui supprime les `auth.users` des joueurs `${tag}_%`, puis les cartes `'$tag %'`, et restaure `market_list_burst` et `max_concurrent_auctions` (relevés d'abord, comme `16_market_concurrency.test.sh:15-30`), passés à `{"count": 100000, "window_s": 60}` et `{"free": 1000, "pro": 1000}` ;
    - joueurs A, B et C au solde de 1 000 000, vérifiés (`wm.set_human_verified`), amis deux à deux (lignes `accepted` par SQL) ;
    - une carte `'$tag c<i>'` par copie créée, chaque copie seule (`count` 1) ;
    - `money()` = Σ des soldes de A, B et C ; `m0` relevé après la préparation ;
    - `waiting(n)` : tant que le bloqueur dort, attendre `select count(*) from pg_stat_activity where wait_event_type = 'Lock'` ≥ n, avec une échéance de 0,9 s depuis son `PgSleep` ; sinon échec (preuve que les appels attendent vraiment le bloqueur, L:98 du registre M3).
  - **1. Défausse et mise en vente pendant l'acceptation**, 2 × 30 (60 et non 100 connexions : le `max_connections` de 100 du banc et de la CI, comme `16_market_concurrency.test.sh:63-64`) :
    - 15 échanges A → B et 15 B → A, une copie par côté, chacune d'une carte distincte ;
    - un bloqueur tient A et B (`select from public.profiles where id in (…) for update; select pg_sleep(1)`), et le test attend son `PgSleep` ;
    - lancés ensemble : les 30 `accept` (par chaque destinataire), 20 `discard` et 10 `wm.create_auction(<initiateur>, <copie offerte>, 10, 60)` de la copie offerte par chaque initiateur ; puis `waiting(55)`.
    Attendu :
    - aucun `40P01` ni `55P03` ;
    - aucune erreur côté `accept` ;
    - chaque erreur de défausse ou de mise en vente contient « Cette carte est déjà engagée dans un échange en attente » ou « Vous ne possédez pas cette carte », et aucune enchère n'est créée ;
    - chaque copie offerte est chez l'autre joueur ; `money` = `m0` ; invariants vides.
  - **2. Acceptation bloquée après sa première écriture (M4-7 C, P24)** : T, avec a1 (étiquetée, `starred`, avatar de A), b1 et des WB à 300 et 500 ; `s0 = tests.trade_snapshot(T)`.
    - Un bloqueur tient les compteurs des deux joueurs (`select from wm.user_rarity_counts where user_id in (A, B) for update; select pg_sleep(3)`), que prend le trigger de l'instruction (1) de `trade_move` : la 55P03 tombe donc après la mise à jour de `user_cards` ; le test attend le `PgSleep` du bloqueur ;
    - `wm.trade_action(B, T, 'accept', null, 'k-busy')` échoue avec `55P03` après 1,9 à 2,9 s : c'est l'attente réelle du `lock_timeout` ;
    - l'instantané est égal à `s0` ;
    - le bloqueur fini, le même appel → `"status": "accepted"`.
  - **3. Double acceptation** : T2 à WB 3 et 5 ; 20 `wm.trade_action(B, T2, 'accept')` sans clé, ensemble → exactement 1 succès, et 19 erreurs qui contiennent « Cet échange n'est plus en attente (déjà traité) » ; exactement 2 lignes `trade:<T2>` ; les copies n'ont bougé qu'une fois.
  - **4. Même clé, deux sessions (M4-8)** :
    - la session 1 lance `begin; select wm.trade_action(B, T3, 'accept', null, 'k-dup')::text; select pg_sleep(1); commit;` en arrière-plan, et le test attend son `PgSleep` ;
    - la session 2 lance le même `select … 'k-dup'` : elle attend au moins 0,5 s, puis sa sortie est identique à celle de la session 1 ;
    - T3 à WB 3 et 5 : 2 lignes `trade:<T3>`.
  - **5. Acceptations croisées sans interblocage** :
    - 30 échanges, 10 par paire (A–B, B–C, C–A), moitié dans chaque sens, deux copies par côté, WB 3 et 5 (30 et non 60 : chaque paire partage un joueur avec les deux autres, donc tout se sérialise, et 60 acceptations approcheraient les 2 s du `lock_timeout`) ;
    - un bloqueur tient les trois profils pendant 1 s, puis les 30 `accept` partent ensemble ; `waiting(25)`.
    Attendu : aucun `40P01` ni `55P03`, aucune erreur, 30 `accepted`, `money` = `m0`, invariants vides.
  - **6. Contre-offre, acceptation et annulation du même parent (M4-2)** :
    - 10 parents A → B ;
    - derrière un bloqueur de 1 s sur A et B, lancés ensemble pour chaque parent P : `wm.trade_action(B, P, 'accept')`, `wm.create_trade(B, A, <items inversés>, 0, 0, P)` et `wm.trade_action(A, P, 'cancel')` ; `waiting(25)`.
    Attendu par parent : exactement un succès, les deux autres en 409 « Cet échange n'est plus en attente (déjà traité) » ; aucun `40P01` ni `55P03` ; invariants vides.
  - **7. Copie partie chez un tiers (P25), déterministe** :
    - T1 (A → B) et T2 (A → C) offrent tous deux X ; T1 accepté, donc X est chez B ;
    - un bloqueur tient X (`select from public.user_cards where id = '<X>' for update; select pg_sleep(3)`), et le test attend son `PgSleep` ;
    - `wm.trade_action(C, T2, 'accept')` → 409 « Une carte de cet échange n'est plus disponible » en moins de 0,5 s ; T2 reste `pending`, et son instantané ne change pas.
- [ ] **Step 2: Éprouver rouge** (L:60 du registre M3 : un test doit pouvoir échouer), chaque mutation retirée ensuite :
  - dans `trade_action`, `wm.lock_users(array[…])` remplacé par deux `wm.lock_user` (initiateur, puis destinataire) → le scénario 5 voit un `40P01` ;
  - dans `bulk_discard`, la clause du verrou d'échange retirée → le scénario 1 échoue : une défausse passe, et l'`accept` du même échange reçoit 409 ;
  - dans `create_auction`, le contrôle `card_locked` retiré → le scénario 1 échoue : une enchère est créée ;
  - dans `create_trade`, `lock_users` avant le parent `for update` → le scénario 6 voit un `40P01` ;
  - dans `trade_action`, le filtre `user_id in (initiator_id, recipient_id)` retiré → le scénario 7 attend 2 s, puis lève 55P03.
- [ ] **Step 3: `npm run test:db`** sans mutation → vert. Un échec est un défaut des Tasks 2 à 6, corrigé dans leur migration (rien n'est encore déployé).
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `test(db): concurrence des échanges (défausse et vente pendant l'acceptation, acceptation bloquée en 55P03 qui ne laisse rien, double acceptation, même clé en deux sessions, acceptations croisées, contre-offre contre acceptation, copie partie chez un tiers)`

---

### Task 8: Routes des amis et leur contrat

**Files:**
- Create: `app/api/friends/route.ts` (GET, POST), `app/api/friends/search/route.ts`, `app/api/friends/accept-all/route.ts`, `app/api/friends/[friendshipId]/route.ts` (PATCH, DELETE), `contract/spec/friends.ts`
- Modify: `lib/schemas.ts` (`FriendshipParams`), `contract/spec/index.ts`

**Interfaces:**
- Consumes : `route()` (`lib/route.ts:80-94`) ; les fonctions de la Task 3.
- Produces :
  - `lib/schemas.ts` : `FriendshipParams = z.object({ friendshipId: z.uuid() })`.
  - Routes (toutes les écritures en `idem: true`) :
    - `GET /api/friends` : `route({ fn: 'friends_list' })` ;
    - `POST /api/friends` : `route({ fn: 'friend_request', input: z.object({ addressee_id: z.uuid() }), idem: true, args: (i) => ({ p_addressee_id: i.addressee_id }) })` ;
    - `GET /api/friends/search` : `route({ fn: 'friend_search', input: z.object({ q: pgText.optional() }), args: (i) => ({ p_q: i.q ?? null }) })` ;
    - `POST /api/friends/accept-all` : `route({ fn: 'friend_accept_all', idem: true })` ;
    - `PATCH /api/friends/{friendshipId}` : `fn: 'friend_action'`, `params: FriendshipParams`, `input: z.object({ action: pgText })` (P11), `args: (i, { params }) => ({ p_friendship_id: params.friendshipId, p_action: i.action })` ;
    - `DELETE /api/friends/{friendshipId}` : `fn: 'friend_remove'`, `params: FriendshipParams`, `args: (_, { params }) => ({ p_friendship_id: params.friendshipId })`.
  - `contract/spec/friends.ts` :
    - schémas `Friendship` (`{id, status: 'pending' | 'accepted', requester_id, addressee_id, requester: {id, username, avatar_url}, addressee: {…}, created_at: Iso}`, `loose()`) et `UserHit` (`{id, username, avatar_url}`) ;
    - aide `befriend(env, a, b)` (ligne `accepted` par `psql`), exportée pour `trades.ts` ;
    - six `RouteSpec`, `source: 'R§3.7'`, `confidence` du recap : `conf.` pour `GET`, `search` et `POST` ; `prob.` pour `accept-all`, `PATCH` et `DELETE`.

- [ ] **Step 1: Specs de contrat qui échouent** (chaque erreur comparée au corps entier par `failed` et `error`)
  - `GET /api/friends` : `noSession` ; une demande reçue, une envoyée et un ami → `{friendships}` de trois lignes au schéma `Friendship`, avec les pseudos exacts ; celles de deux autres joueurs n'y sont pas.
  - `GET /api/friends/search` :
    - `noSession` ;
    - `q=` + les 6 premiers caractères d'un pseudo unique → `{users}` avec ce joueur, sans le chercheur ;
    - `q=a` → 400 « La recherche demande au moins 2 caractères » ; sans `q` → la même 400.
  - `POST /api/friends` :
    - `noSession` ;
    - succès → `{friendship}` en `pending`, et une `friend_request` (psql) pour le destinataire ;
    - une seconde fois → 409 `REQUEST_PENDING` ; déjà amis → 409 `ALREADY_FRIENDS` ; soi-même → 400 ; id inconnu → 404 « Joueur introuvable » ; `{}` → 400 `invalid_request` ;
    - même `Idempotency-Key` deux fois → corps identiques, une seule ligne.
  - `POST /api/friends/accept-all` : `noSession` ; deux demandes reçues → `{accepted: 2}`, puis `{accepted: 0}` ; même clé deux fois → `{accepted: 2}` deux fois.
  - `PATCH /api/friends/{id}` :
    - `noSession` ; `abc` → 400 ;
    - le destinataire accepte → `{friendship}` en `accepted` ; le demandeur accepte → 403 `FORBIDDEN` « Seul le destinataire peut accepter cette demande » ;
    - refuser → `{ok: true}`, et la ligne a disparu ; la même clé rejouée → `{ok: true}`, sans 404 ; `{action: 'xyz'}` → 400 « Action inconnue » ; un étranger → 404 « Demande d'ami introuvable » ;
    - même clé deux fois sur `accept` → corps identiques.
  - `DELETE /api/friends/{id}` :
    - `noSession` ;
    - un ami, avec un échange en attente dans chaque sens (`wm.create_trade` par psql) → `{ok: true}` ; les deux échanges sont `cancelled` (psql) ;
    - un étranger → 404 ; même clé deux fois → `{ok: true}` deux fois, sans 404 au second.
  - `index.ts` ajoute `...friends`.
- [ ] **Step 2: `npm run build:test && npm run test:contract`** → les nouveaux cas échouent (404 de Next).
- [ ] **Step 3: Implémenter** (chaque handler tient en 1 à 3 lignes).
- [ ] **Step 4: Contrôles complets** → vert ; `coverage:recap` passe de 39 à 45.
- [ ] **Step 5: Commit** — `feat(api): amis (liste, recherche, demande, tout accepter, accepter ou refuser, retirer) et leur contrat`

---

### Task 9: Routes des échanges, refus de `rest/v1/trades`, erreur injectée par HTTP

**Files:**
- Create: `app/api/trades/route.ts` (GET, POST), `app/api/trades/[tradeId]/route.ts` (GET, PATCH), `contract/spec/trades.ts`
- Modify: `lib/schemas.ts` (`TradeParams`, `TradeBody`), `contract/spec/rest.ts` (P22), `contract/spec/index.ts`

**Interfaces:**
- Consumes : `create_trade`, `trade_action`, `trades_list` et `trade_detail` (Tasks 4 à 6) ; `befriend` (Task 8) ; `tests.trade_snapshot` et `tests.boom` (Task 5).
- Produces :
  - `lib/schemas.ts` :
    - `TradeParams = z.object({ tradeId: z.uuid() })` ;
    - `TradeBody = z.object({ recipient_id: z.uuid(), items: z.array(z.object({ user_card_id: z.uuid(), card_id: z.uuid(), offered_by: z.uuid() })), initiator_wikibidous: z.int32().default(0), recipient_wikibidous: z.int32().default(0), parent_trade_id: z.uuid().nullish() })`, avec `items` borné par `.max(200)` (deux côtés × 100 : le 400 français de 101 à 200 éléments reste celui du SQL) ; partagé avec le composer (Task 13).
  - Routes :
    - `GET /api/trades` : `route({ fn: 'trades_list' })`, sans `input` : `active` et `count` sont acceptés et ignorés (M4-9), comme `pending` de `app/api/my-collection/route.ts:4` ;
    - `POST /api/trades` : `route({ fn: 'create_trade', input: TradeBody, idem: true, args: (i, { tz }) => ({ p_recipient_id: i.recipient_id, p_items: i.items, p_initiator_wikibidous: i.initiator_wikibidous, p_recipient_wikibidous: i.recipient_wikibidous, p_parent_trade_id: i.parent_trade_id ?? null, p_tz: tz }) })` ;
    - `GET /api/trades/{tradeId}` : `fn: 'trade_detail'`, `params: TradeParams`, `args` → `{ p_trade_id }` ;
    - `PATCH /api/trades/{tradeId}` : `fn: 'trade_action'`, `params: TradeParams`, `input: z.object({ action: pgText })`, `idem: true`, `args: (i, { params, tz }) => ({ p_trade_id: params.tradeId, p_action: i.action, p_tz: tz })`.
  - `contract/spec/trades.ts` :
    - schéma `Trade` : les 13 colonnes (`status` dans les six valeurs, dates `Iso`, nullables comme au miroir), `initiator` et `recipient` `{id, username}`, `items` `[{offered_by, card_id, user_card_id, snapshot_rarity: Rarity, is_shiny, card: {id, wikipedia_title, image_url: nullable, rarity: Rarity}}]`, `counter_trade_id: z.uuid().nullable()`, tout en `loose()` ;
    - aides `pair(env)` (deux joueurs amis à 1 000 WB, une copie `C` et une `PC` chacun), `proposed(env, a, b, opts)` (`wm.create_trade` par psql, renvoie l'id) et `snap(env, id)` (`select tests.trade_snapshot(:'id')`) ;
    - quatre `RouteSpec`, `source: 'R§3.6'` : `GET /api/trades` `conf.`, `GET …/{tradeId}` `prob.`, `POST` `prob.`, `PATCH` `conf.`.
  - `contract/spec/rest.ts` : `spec(method, path, source, cases, confidence = 'conf.')`, plus trois specs `rest/v1/trades` (`POST`, `PATCH`, `DELETE`), `R§3.6`, `inc.`.

- [ ] **Step 1: Specs de contrat qui échouent**
  - `GET /api/trades` : `noSession` ; un échange en attente et un refusé → `{trades}` au schéma `Trade` ; `?active=1&count=1` → le même corps ; l'échange de deux autres joueurs n'y est pas.
  - `GET /api/trades/{id}` : `noSession` ; `abc` → 400 ; un participant → `{trade}` ; un étranger → 404 « Échange introuvable ».
  - `POST /api/trades` (avec l'en-tête `x-wiki-calendar-tz: Europe/Paris`) :
    - `noSession` ;
    - succès → 200 (`ok`, M4-9), corps `Trade` en `pending`, et une `trade_received` (psql) ; un seul côté (une copie de A, 50 WB demandés, aucun élément de B) → 200 ;
    - pas amis → 403 `FORBIDDEN` « Vous devez être amis pour échanger » ; copie d'un autre → 403 `42501` ;
    - `items: []` → 400 « Un échange contient au moins une carte » ; 101 éléments → 400 « Au plus 100 cartes par côté » ; `recipient_wikibidous: 10001` → 400 « Entre 0 et 10 000 wikibidous par côté » ;
    - soi-même → 400 ; solde trop bas → 409 `insufficient_balance` ; `{}` → 400 `invalid_request` ;
    - contre-offre par le destinataire → 200 avec `parent_trade_id`, et le `GET` du parent rend `countered` et `counter_trade_id` ;
    - même `Idempotency-Key` deux fois → corps identiques, un seul échange (psql).
  - `PATCH /api/trades/{id}` :
    - `noSession` ;
    - `accept` → 200 `{status: 'accepted', trade}` ; `/api/my-collection` du destinataire liste la copie reçue sous son id ; `GET /api/wikibidous` des deux joueurs suit les WB nets ;
    - la même clé après ce succès → corps identique (M4-8) ; sans clé → 409 « Cet échange n'est plus en attente (déjà traité) » exact ;
    - `decline` par l'initiateur → 403 « Seul le destinataire peut refuser cet échange » ; `cancel` par le destinataire → 403 « Seul l'initiateur peut annuler cet échange » ;
    - `decline` → `{status: 'declined'}` ; `cancel` → `{status: 'cancelled'}` ; même clé deux fois sur `decline`, puis sur `cancel` → corps identiques ;
    - inconnu → 404 ; `{action: 'counter'}` → 400 « Action inconnue » ; `expires_at` passé (psql) → 409 « déjà traité ».
  - ***Erreur injectée (M4-7 B)*** sur `PATCH … accept` :
    - `s0 = snap(env, id)`, puis par psql : `create trigger contract_boom_<8 premiers hex de l'id> after insert on public.notifications for each row when (new.data ->> 'trade_id' = '<id>') execute function tests.boom()` ;
    - `PATCH` avec la clé K → `failed(res, 500)`, `error` « Erreur interne, réessaie dans un instant. » ; `snap` égal à `s0` ;
    - `finally` : `drop trigger if exists contract_boom_<…> on public.notifications` ;
    - la même clé K → 200 `accepted`.
  - `rest/v1/trades`, en joueur participant : `POST` → 403 `42501` ; `PATCH ?id=eq.<id>` `{status: 'accepted'}` → 403 `42501`, de même par un non-participant ; `DELETE ?id=eq.<id>` → 403 `42501` ; anon → 401 ; l'échange reste `pending` (psql).
  - `index.ts` ajoute `...trades`.
- [ ] **Step 2: `npm run build:test && npm run test:contract`** → les nouveaux cas échouent.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert ; `coverage:recap` passe de 45 à 52, et plus aucune route du §3.6 n'y manque.
- [ ] **Step 5: Commit** — `feat(api): échanges (liste, détail, création 200, action PATCH), rest/v1/trades refusé ; erreur injectée par HTTP qui annule tout et rejeu de la même clé`

---

### Task 10: Routes des notifications et cloche — poller partagé, badge, panneau

**Files:**
- Create: `app/api/notifications/route.ts` (GET, PATCH), `contract/spec/notifications.ts`, `lib/notifications.ts`, `lib/notifications.test.ts`, `components/shell/NotificationPanel.tsx`, `e2e/notifications.spec.ts`
- Modify: `contract/spec/index.ts`, `components/shell/Bell.tsx` (client), `components/shell/Bell.test.tsx`, `e2e/a11y.spec.ts`

**Interfaces:**
- Consumes : `notifications_list` et `notifications_read` (Task 6) ; `createPoller` (`lib/poll.ts:7`), `createBrowserSupabase` (`lib/supabase/browser.ts`), `api` (`lib/api.ts`), `Modal`, `Loading`, `formatDateTime` (`lib/format.ts:25`), `formatInt`, `wikibidous`, `routeOnce`.
- Produces :
  - Routes : `GET /api/notifications` : `route({ fn: 'notifications_list' })` ; `PATCH /api/notifications` : `fn: 'notifications_read'`, `input: z.object({ ids: z.array(z.uuid()).max(100).optional() })`, `idem: true`, `args: (i) => ({ p_ids: i.ids ?? null })`.
  - `contract/spec/notifications.ts` : deux `RouteSpec`, `source: 'R§3.7'`, `prob.`.
  - `lib/notifications.ts` :
    - `type Notification = { id: string; type: string; data: Record<string, unknown>; read: boolean; created_at: string }` ;
    - `createUnreadStore(o: { fetchUnread: () => Promise<number>; delay?: number; doc?; setTimer?; clearTimer? }): { subscribe(cb: () => void): () => void; get(): number; refresh(): Promise<void> }`. Le premier abonné lance `refresh()` tout de suite et `createPoller({ run: refresh, delay: () => delay, doc, setTimer, clearTimer })`, avec `delay` à 30 000 par défaut ; le dernier qui part l'arrête. Une lecture en échec garde le compte précédent ;
    - `unreadStore()`, singleton paresseux (P14). `fetchUnread` = `createBrowserSupabase().from('notifications').select('id').eq('read', false).limit(10)` → `data.length`, le client n'étant créé qu'au premier appel ; l'erreur est levée ;
    - `notificationView(n: Notification): { text: string; href: string | null }`, avec `{u}` = `data.username` et `{c}` = `data.card_title ?? data.wikipedia_title` :

      | `type` | Texte | Lien |
      |---|---|---|
      | `trade_received` | « {u} te propose un échange » | `/trades/<trade_id>` |
      | `trade_countered` | « {u} a fait une contre-offre » | idem |
      | `trade_accepted` | « {u} a accepté ton échange » | idem |
      | `trade_declined` | « {u} a refusé ton échange » | idem |
      | `trade_cancelled` | « {u} a annulé son échange » | idem |
      | `friend_request` | « {u} veut devenir ton ami » | `/friends` |
      | `friend_accepted` | « {u} a accepté ta demande d'ami » | `/friends` |
      | `auction_outbid` | « Tu as été surenchéri sur {c} » | `/marketplace/<auction_id>` |
      | `auction_won` | « Tu as remporté {c} pour {formatInt(amount)} {wikibidous(amount)} » | idem |
      | `auction_sold` | « {c} vendue pour {formatInt(amount)} {wikibidous(amount)} » | idem |
      | `auction_unsold` | « {c} n'a pas trouvé preneur » | idem |
      | `wishlist_listed` | « {c}, de ta liste de souhaits, est en vente » | idem |
      | autre | « Nouvelle notification » | `null` |

  - `components/shell/Bell.tsx` (`'use client'`) :
    - `BellButton({ unread, onClick, describedBy })`, pur : le bouton du contrat, le badge (`unread >= 10 ? '9+' : unread`, rien à 0) et `aria-describedby={describedBy}` ;
    - `Bell()` : `useSyncExternalStore(store.subscribe, store.get, () => 0)`. Un `span.sr-only` dont l'id vient de `useId()` porte « Aucune notification non lue », « 1 notification non lue », « {n} notifications non lues » ou « Plus de 9 notifications non lues ». Le clic ouvre `NotificationPanel`.
  - `NotificationPanel({ onClose })` :
    - `Modal` au label « Notifications » ; lit `GET /api/notifications` à l'ouverture ; `Loading label="Chargement des notifications"` ; erreur → « Impossible de charger cette page. » + « Réessayer » ; vide → « Aucune notification. » ;
    - `<ul aria-label="Notifications récentes">` : texte (en gras si non lue), `time` par `formatDateTime`, `Link` si `href` (le clic ferme la modale), et « Marquer comme lu » sur une non-lue ;
    - « Tout marquer comme lu » (`aria-disabled` sans non-lue) ;
    - chaque marquage fait `api('/api/notifications', { method: 'PATCH', body, idem: true })`, met la ligne à jour, puis `store.refresh()`. Le focus d'un « Marquer comme lu » qui disparaît passe au suivant, ou à « Tout marquer comme lu ».

- [ ] **Step 1: Specs de contrat et tests unitaires qui échouent**
  - `GET /api/notifications` : `noSession` ; 55 lignes aux `created_at = now() - make_interval(secs => 55 - i)`, insérées de la plus ancienne à la plus récente (dont un `auction_outbid` au `data` du M3), et 3 d'un autre joueur → exactement les 50 plus récentes, dans l'ordre, chacune `{id, type, data, read, created_at}`, aucune de l'autre joueur.
  - `PATCH /api/notifications` :
    - `noSession` ;
    - `{ids: [x, y]}` → `{ok: true, updated: 2}` ; l'id d'une notification d'un autre → `{ok: true, updated: 0}`, et la sienne reste non lue ; `{}` → le reste ; `{ids: ['abc']}` → 400 ;
    - trois non-lues neuves, puis `{}` avec la même clé deux fois → `{ok: true, updated: 3}` deux fois (sans clé, le second rendrait `updated: 0`) ;
    - lecture de la cloche : `rest/v1/notifications?select=id&read=eq.false&limit=10` par le joueur → au plus 10 lignes, toutes à lui ; par un autre joueur → `[]` (RLS, authentifié étranger).
  - `index.ts` ajoute `...notifications`.
  - `notifications.test.ts` (minuteurs simulés, document simulé par un `EventTarget`) :
    - deux abonnés → un seul `fetchUnread` tout de suite, puis un seul à 30 s ;
    - les deux désabonnés → aucun appel pendant 60 s ;
    - `refresh()` → un appel immédiat, et les abonnés reçoivent le nouveau compte ;
    - un `fetchUnread` rejeté garde le compte précédent ;
    - `notificationView` rend le texte et le lien exacts pour les 12 types du tableau et pour un type inconnu (`amount` 1 234 → « 1 234 wikibidous », espace fine).
  - `Bell.test.tsx` (`renderToStaticMarkup` de `BellButton`) : `aria-label="Notifications"` et les classes `relative p-2 rounded-xl` ; 0 → aucun badge ; 3 → « 3 » ; 10 → « 9+ » ; `aria-describedby` posé.
- [ ] **Step 2: Tests E2E qui échouent** (`e2e/notifications.spec.ts`, notifications insérées par `sql`)
  - 3 `trade_received` non lues (`username` « Alice ») :
    - `/pulls` → badge « 3 » ;
    - la requête observée vise `/rest/v1/notifications?select=id&read=eq.false&limit=10`, et aucun `/api/notifications` avant l'ouverture ;
    - Tab jusqu'à la cloche, puis Entrée → dialogue « Notifications » avec trois « Alice te propose un échange » ;
    - « Marquer comme lu » au clavier sur la première → badge « 2 », et le focus est sur le « Marquer comme lu » suivant ; sur la dernière → le focus est sur « Tout marquer comme lu » ; « Tout marquer comme lu » → plus de badge ;
    - Échap → le focus revient sur la cloche.
  - 12 non lues → « 9+ ». Le lien d'une `trade_received` a pour `href` `/trades/<trade_id>` (le clic jusqu'au détail est à la Task 12).
  - Erreur : `routeOnce(page, '**/api/notifications', (r) => r.fulfill({ status: 500 }))` → « Impossible de charger cette page. » et « Réessayer » ; « Réessayer » → la liste.
  - Une `auction_outbid` au `data` du M3 → « Tu as été surenchéri sur <card_title> ».
  - Vide → « Aucune notification. » ; la cloche et « Tout marquer comme lu » font au moins 44 px.
  - `e2e/a11y.spec.ts` : axe sur `/pulls` avec le panneau ouvert (3 notifications) → 0 violation *serious* ou *critical*.
- [ ] **Step 3: `npm test && npm run build:test && npm run test:contract && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/notifications.spec.ts e2e/shell.spec.ts e2e/a11y.spec.ts`** → échec.
- [ ] **Step 4: Implémenter.** Le `shortcut:` de `Bell.tsx:3-4` disparaît.
- [ ] **Step 5: Contrôles complets** → vert ; `coverage:recap` passe de 52 à 54 ; au §3.7, seules restent les douze routes du M4b.
- [ ] **Step 6: Commit** — `feat(api,ui): notifications (liste, marquage lu) et cloche (poller PostgREST partagé de 30 s, badge 9+, compte par aria-describedby, panneau, liens par type)`

---

### Task 11: Page `/friends`

**Files:**
- Create: `app/(game)/friends/friends-client.tsx`, `e2e/friends.spec.ts`
- Modify: `app/(game)/friends/page.tsx` (coquille au lieu de `ComingSoon`), `e2e/fixtures.ts` (`giveCopies`, `befriend`, P20), `e2e/shell.spec.ts:94` (+ `/friends`), `e2e/a11y.spec.ts` (`/friends`, `READY` `'main [data-ready]'`)

**Interfaces:**
- Consumes : les six routes d'amis (Task 8) ; `PageHeader`, `navEntry('/friends')`, `Modal`, `toast`, `Loading`, `apiOnce`, `userMessage` ; `createBrowserSupabase` (P16).
- Produces :
  - `e2e/fixtures.ts` : `giveCopies = (u: User, rarity: string, n = 1) => giveCards(backend().databaseUrl, u.uid, rarity, n)` et `befriend = (a: User, b: User) => sql(<insert accepted>, …)`.
  - `FriendsClient` :
    - `PageHeader` « Amis » ; `data-ready` sur la racine après la première lecture ;
    - recherche : un `form` avec `input#friend-list-search` (`type="search"`, `aria-label="Rechercher un joueur"`), envoyé par Entrée ; un seul caractère → « La recherche demande au moins 2 caractères », sans requête ; les résultats en liste, chacun avec « Ajouter » (`apiOnce`, intention `add:<id>`) → toast « Demande envoyée à {pseudo}. », ou le message du refus ;
    - section « Demandes reçues » (h2) : « Accepter » et « Refuser » par ligne, et « Tout accepter » s'il y en a au moins une ;
    - « Demandes envoyées » : « Retirer » (sans confirmation) ;
    - « Amis » : `Link` « Échanger » vers `/trades/new?with=<id>`, et « Retirer », qui ouvre la modale de retrait (P19) ;
    - intentions `apiOnce` : `add:<id>`, `accept:<id>`, `decline:<id>`, `remove:<id>` et `accept-all` ;
    - chaque action relit `GET /api/friends`. États vides et toasts du P19 ; lecture en échec → « Impossible de charger cette page. » + « Réessayer » ; sans polling (Q25 : la cloche signale les demandes) ;
    - le focus d'une ligne qui disparaît passe à la ligne suivante de sa section, ou à son état vide ; après « Tout accepter », au premier ami ajouté ; après le retrait confirmé, une fois la modale démontée (effet sur la liste relue, modèle `collection-client.tsx:196-209`), à la ligne d'ami suivante ou à l'état vide de « Amis ».

- [ ] **Step 1: Tests E2E qui échouent** (`e2e/friends.spec.ts`)
  - h1 « Amis » ; `#friend-list-search` présent une seule fois dans le document.
  - Recherche du pseudo d'un joueur neuf → la ligne apparaît → « Ajouter » → toast « Demande envoyée à <pseudo>. », et la ligne sous « Demandes envoyées » ; « Retirer » → « Aucune demande envoyée. ».
  - Une recherche d'un caractère affiche le message, sans requête `/api/friends/search` (observée).
  - Demande reçue (posée par `sql`) → « Accepter » → toast « <pseudo> fait maintenant partie de tes amis. », la ligne sous « Amis », et un « Échanger » dont le `href` vaut `/trades/new?with=<id>`.
  - Deux demandes reçues → « Tout accepter » au clavier → « 2 demandes acceptées. », et `document.activeElement` est le premier ami ajouté, jamais `body`.
  - ***Review Focus*, retrait** : un ami (`befriend`) et un échange en attente (`sql` `wm.create_trade`) → « Retirer » → modale au texte exact → « Retirer » → toast « <pseudo> a été retiré de tes amis. », et le focus est sur l'état vide de « Amis », pas sur `body` ; l'échange est `cancelled` (sql) ; une nouvelle recherche et « Ajouter » passent ensuite.
  - Une ligne d'ami a « Échanger » et aucun bouton « Message » (M4-1).
  - Erreur : `routeOnce(page, '**/api/friends', (r) => r.fulfill({ status: 500 }))` → « Impossible de charger cette page. » et « Réessayer » ; « Réessayer » → les sections.
  - **Clavier** : Tab jusqu'à la recherche, saisie, Entrée, Tab jusqu'à « Ajouter », Entrée → toast. Après un « Refuser », le focus n'est pas sur `body`.
  - 360 px, avec un ami au pseudo de 24 caractères sans coupure (`makePlayer({ username })`) : aucun défilement horizontal (`scrollWidth <= clientWidth` de `main`) ; boutons d'au moins 44 px.
  - `e2e/a11y.spec.ts` : `axe /friends`, avec une demande reçue et un ami, à 0 violation grave.
- [ ] **Step 2: `npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/friends.spec.ts e2e/shell.spec.ts e2e/a11y.spec.ts`** → échec.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(ui): page /friends (recherche #friend-list-search, demandes reçues et envoyées, tout accepter, amis, échanger, retrait confirmé)`

---

### Task 12: Pages `/trades` et `/trades/[id]`

**Files:**
- Create: `app/(game)/trades/trades-client.tsx`, `app/(game)/trades/[id]/page.tsx`, `app/(game)/trades/[id]/trade-client.tsx`, `components/trades/types.ts`, `components/trades/TradeCard.tsx`, `components/trades/TradeCard.test.tsx`, `components/trades/ItemChips.tsx`, `e2e/trades.spec.ts`
- Modify: `app/(game)/trades/page.tsx` (coquille), `lib/format.ts` (+ `formatShortDate`), `lib/format.test.ts`, `e2e/shell.spec.ts:94` (+ `/trades`), `e2e/a11y.spec.ts` (`/trades`, `/trades/<id>`)

**Interfaces:**
- Consumes : `GET /api/trades`, `GET` et `PATCH /api/trades/{id}` (Task 9) ; `usePoll`, `Countdown` (`components/market/Countdown.tsx:10`), `rarityOf` (`lib/rarity.ts`), `formatInt`, `wikibidous`, `apiOnce`, `routeOnce`, `calendarTz`, `toast`, `PageHeader`, `navEntry('/trades')` ; le clavier des onglets de `market-client.tsx:115-123`.
- Produces :
  - `formatShortDate(iso: string): string` = `new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(iso))`.
  - `components/trades/types.ts` : `type TradeStatus` (les six), `type TradeItem`, `type Trade` (le schéma de la Task 9) ; `STATUS_LABEL: Record<TradeStatus, { text: string; className: string }>` (P17) ; `chipText(item: TradeItem): string` (P15).
  - `<ItemChips items={TradeItem[]} />` : une puce `span[title]` par élément (P15).
  - `<TradeCard trade={Trade} onOpen={() => void} />` :
    - `div.card-frame.p-4 > button[aria-label="Voir le détail de l'échange"]` ;
    - dans le bouton : « De {initiator.username} », `STATUS_LABEL` dans son `span` coloré, `<time dateTime={created_at}>{formatShortDate}</time>` ; `aria-describedby` vers un `span.sr-only` (id de `useId()`) « De {pseudo} · {statut} · {date} », qui distingue les offres sans toucher au nom du contrat ;
    - colonnes « {initiator.username} offre » et « En échange de », séparées par `ArrowLeftRight`, chacune avec ses puces et `` `${formatInt(n)} ${wikibidous(n)}` `` si n > 0.
  - `TradesClient` :
    - `PageHeader` « Échanges » ; onglets du DOM du contrat, un seul panneau monté ;
    - « Reçues » = `status === 'pending'` et destinataire = moi ; « Envoyées » = `pending` et initiateur = moi ; « Historique » = le reste, dans l'ordre de la réponse ;
    - `usePoll(read, 20_000)` ; clic → `router.push('/trades/<id>')` ; états vides du P19 ; lecture en échec → « Impossible de charger cette page. » + « Réessayer » ; règle de focus ; `data-ready`.
  - `[id]/page.tsx` : coquille, `metadata.title` « Échange », `<Suspense fallback={<Loading label="Chargement de l'échange" />}>` ; le client lit l'id par `useParams()`.
  - `TradeClient` :
    - h1 « Détail de l'échange » ; « De {initiator} à {recipient} » ; statut (P17) ; « Expire dans » + `<Countdown endAt={expires_at} over={status !== 'pending'} />` ; les deux colonnes de `TradeCard` ;
    - en attente, pour le destinataire : « Accepter », « Refuser », et `Link` « Contre-offre » vers `/trades/new?with=<initiator_id>&parent=<id>` ; pour l'initiateur : « Annuler » ;
    - liens « Voir l'offre d'origine » (`parent_trade_id`) et « Voir la contre-offre » (`counter_trade_id`) ;
    - chaque action : `apiOnce(keys, \`${action}:${id}\`, …, { method: 'PATCH', body, headers: calendarTz() })` → la réponse remplace l'échange, puis le toast du P19. Un refus affiche son message en `role="alert"`, puis l'échange est relu. Une action ou un poll qui retire les boutons pose le focus sur le statut (`p` à `tabIndex={-1}`) ;
    - `usePoll(read, 20_000, status === 'pending')` ; 404 → « Échange introuvable » + « Retour aux échanges » ; autre échec de lecture → « Impossible de charger cette page. » + « Réessayer » ; `data-ready`.

- [ ] **Step 1: Tests unitaires qui échouent**
  - `format.test.ts` : `formatShortDate('2026-09-20T12:00:00Z')` = `'20 sept.'`.
  - `TradeCard.test.tsx` (`renderToStaticMarkup`) :
    - racine `<div class="card-frame p-4 …">`, premier enfant `<button aria-label="Voir le détail de l'échange" …>` ;
    - « De Alice » ; `accepted` → « · Accepté » dans un élément de classe `text-green-400`, `declined` → « · Refusé » en `text-red-400`, `countered` → « · Contre-offre » en `text-sky-400`, `pending` → « · En attente » en `text-amber-600`, `cancelled` et `expired` → « · Annulé » et « · Expiré » en `text-[var(--color-foreground)]/60` ;
    - le bouton a un `aria-describedby`, et le rendu ne contient pas « Message » (M4-1) ;
    - `<time datetime="2026-09-20T12:00:00Z">20 sept.</time>` ;
    - « Alice offre », « En échange de », et un `svg` de classe `lucide-arrow-left-right` ;
    - la puce SR « Théorème de Pythagore » → `<span title="Théorème de Pythagore" style="background-color:var(--color-rarity-sr)22"…>SR · Théorème de Pythagor…</span>` ; « Électricité statique » (20 caractères) → sans « … » ;
    - « 300 wikibidous » dans la colonne de l'initiateur.
- [ ] **Step 2: Tests E2E qui échouent** (`e2e/trades.spec.ts` ; joueurs, amitié et échanges préparés par `sql` `wm.create_trade`)
  - `/trades` → h1 « Échanges », trois onglets, « Reçues » actif dans la classe du contrat. Une offre reçue a son `div.card-frame.p-4`, son bouton au label exact, « De <pseudo> », « · En attente », la date courte et ses puces `span[title]`. Une offre envoyée est sous « Envoyées ». Un refusé et un accepté sont sous « Historique », avec « · Refusé » (`text-red-400`) et « · Accepté » (`text-green-400`).
  - ***Review Focus*, échéance** : `expires_at` passé (sql), sans cron → l'offre passe sous « Historique » en « · Expiré », et son détail n'a plus de bouton d'action. `select wm.expire_trades()` → toujours « · Expiré ».
  - **Polling** : `page.clock.install()` avant `goto` (modèle `collection.spec.ts:44-57`) ; le focus sur le bouton d'une offre reçue ; l'initiateur annule par `sql` `wm.trade_action`, puis `page.clock.runFor(20_000)` → l'offre sort de « Reçues », et le focus est sur l'offre suivante ou sur l'état vide, jamais sur `body`.
  - Détail, en destinataire :
    - h1 « Détail de l'échange », un compte à rebours, « Accepter », « Refuser » et « Contre-offre » (`href` exact) ;
    - « Accepter » au clavier → toast « Échange accepté. », statut « Accepté », plus de bouton d'action, et `document.activeElement` est ce statut, jamais `body` ;
    - dans un second échange, « Refuser » → « Échange refusé. » ;
    - polling du détail : `page.clock.install()` avant `goto`, l'initiateur annule par `sql`, puis `page.clock.runFor(20_000)` → « Annulé », sans bouton, et le focus n'est pas sur `body`.
  - En initiateur : seul « Annuler » → « Échange annulé. ».
  - Un échange accepté ailleurs entre la lecture et le clic (sql ; `page.clock.install()` avant `goto`, pour qu'aucun poll ne passe entre les deux) → « Accepter » affiche « Cet échange n'est plus en attente (déjà traité) » en alerte, puis le statut relu.
  - Clé gardée (M4-8) : `routeOnce` rend 503 au premier `PATCH /api/trades/<id>` après l'avoir laissé partir au serveur (`r.fetch()`, modèle `collection.spec.ts:555-560`) ; la relance de « Accepter » porte la même `Idempotency-Key` et rend `accepted` ; « Refuser » sur un autre échange en porte une autre.
  - Depuis la cloche, le clic sur une `trade_received` réelle → h1 « Détail de l'échange ».
  - Parent `countered` → « Voir la contre-offre » mène à l'enfant, qui a « Voir l'offre d'origine ».
  - `/trades/<uuid inconnu>` → « Échange introuvable » et « Retour aux échanges ».
  - **Clavier** : Tab jusqu'à l'offre, Entrée → détail ; Tab jusqu'à « Accepter », Entrée → toast.
  - Erreur : `routeOnce(page, '**/api/trades', (r) => r.fulfill({ status: 500 }))` → « Impossible de charger cette page. » et « Réessayer » ; « Réessayer » → les onglets.
  - 360 px, avec un initiateur au pseudo de 24 caractères et une carte au titre long : aucun défilement horizontal ; boutons et onglets d'au moins 44 px.
  - `e2e/a11y.spec.ts` : `axe /trades` (une offre par onglet) et `axe /trades/<id>` à 0 violation grave.
- [ ] **Step 3: `npm test && npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/trades.spec.ts e2e/shell.spec.ts e2e/a11y.spec.ts`** → échec.
- [ ] **Step 4: Implémenter.**
- [ ] **Step 5: Contrôles complets** → vert.
- [ ] **Step 6: Commit** — `feat(ui): page /trades (onglets, offres et puces du contrat, statuts, polling 20 s) et détail d'un échange (accepter, refuser, annuler, contre-offre, échéance, parent et enfant)`

---

### Task 13: Composer `/trades/new` et contre-offre

**Files:**
- Create: `app/(game)/trades/new/page.tsx`, `components/trades/TradeComposer.tsx`, `components/trades/compose.ts`, `components/trades/compose.test.ts`
- Modify: `e2e/trades.spec.ts`, `e2e/a11y.spec.ts` (`/trades/new?with=<id>`, `READY` `'main [data-ready]'`)

**Interfaces:**
- Consumes : `GET /api/my-collection` (`?owned_by=`, `q`, `page`, `pendingTradeCardIds`), `GET /api/friends`, `GET` et `POST /api/trades` (Tasks 8 et 9) ; `TradeBody` (`lib/schemas.ts`) ; `apiOnce`, `calendarTz`, `toast`, `userMessage`, `routeOnce`.
- Produces :
  - `components/trades/compose.ts` :
    - `type Picks = Record<string, number>` (`user_card_id` → quantité) ;
    - `buildBody(o: { recipientId: string; me: string; offer: Picks; ask: Picks; cardOf: Record<string, string>; wbOffer: number; wbAsk: number; parentId?: string }): z.input<typeof TradeBody>` : un élément par unité, les miens puis ceux de l'ami, triés par `user_card_id`, quantités nulles retirées ; `parent_trade_id` seulement s'il est donné ;
    - `invertTrade(parent: Trade, me: string): { withId: string; offer: Picks; ask: Picks; cardOf: Record<string, string>; wbOffer: number; wbAsk: number }` : j'offre ce que le parent me demandait, je demande ce qu'il m'offrait, `wbOffer = recipient_wikibidous`, `wbAsk = initiator_wikibidous`, et `cardOf` = `user_card_id` → `card_id` de tous les éléments du parent ;
    - `sideCount(p: Picks): number`.
  - `new/page.tsx` : coquille, `metadata.title` « Nouvel échange », `Suspense` autour de `TradeComposer` (`useSearchParams`).
  - `TradeComposer` :
    - lit `with` et `parent` ; trouve le pseudo dans `GET /api/friends` (pas ami → « Vous devez être amis pour échanger » + lien « Amis ») ; lecture en échec → « Impossible de charger cette page. » + « Réessayer » ; `data-ready` sur la racine après la première lecture ;
    - h1 « Nouvel échange », ou « Contre-offre » avec `parent` ; sous-titre « Échange avec {pseudo} » ;
    - deux panneaux (P18) : « Tu offres ({n}/100) » sur `/api/my-collection`, « Tu demandes ({n}/100) » sur `?owned_by=<with>`. Chacun a un filtre `input type="search"` (« Filtrer mes cartes », « Filtrer ses cartes ») et « Charger la suite » tant que `(page + 1) × 50 < total`. Chaque copie montre son titre, sa rareté, `×count` et `input type="number" min=0 max=count aria-label="Quantité de {titre}"`. Une copie dont l'id ou le `card_id` figure dans `pendingTradeCardIds` porte « Déjà dans un échange » et reste choisissable (M4-2) ;
    - « Wikibidous offerts » et « Wikibidous demandés » : `inputMode="numeric"`, `maxLength={5}` (R:600) ;
    - envoi (« Proposer l'échange » ou « Envoyer la contre-offre ») : `aria-disabled` tant qu'aucune carte n'est choisie ; `apiOnce(keys, JSON.stringify(body), '/api/trades', { method: 'POST', body, headers: calendarTz() })` → toast (P19), puis `router.push('/trades/<id>')`. Un refus affiche son message en `role="alert"` ;
    - contre-offre : `GET /api/trades/<parent>`, puis `invertTrade`, dont le `cardOf` est fusionné avec celui des pages chargées (P18) ; les copies préremplies hors des pages chargées figurent dans la liste des choix de leur panneau. Un parent qui n'est plus `pending` → « Cet échange n'est plus en attente (déjà traité) ».

- [ ] **Step 1: Tests unitaires qui échouent** (`compose.test.ts`)
  - `buildBody` avec `offer {b: 2, a: 1, z: 0}` et `ask {c: 1}` → `items` = `[a, b, b]` puis `[c]`, `offered_by` corrects, `card_id` tirés de `cardOf`, aucun pour `z`, aucune clé `parent_trade_id` sans `parentId`.
  - `invertTrade` d'un parent (A offre a1 ×1 et a2 ×2, demande b1 ; WB 300 et 0), vu par B → `{withId: A, offer: {b1: 1}, ask: {a1: 1, a2: 2}, cardOf: {a1: <carte de a1>, a2: <carte de a2>, b1: <carte de b1>}, wbOffer: 0, wbAsk: 300}`.
  - `sideCount({a: 2, b: 1})` = 3.
- [ ] **Step 2: Tests E2E qui échouent** (`e2e/trades.spec.ts`)
  - **Clavier** : A et B amis (`befriend`), copies par `giveCopies`, des `PC` pour A et des `C` pour B (aucun titre en double entre les panneaux ; sélecteurs bornés à leur panneau). `/trades/new?with=<B>` → « Échange avec <B> » ; Tab jusqu'à la quantité d'une copie de A, saisie 1 ; même chose pour une copie de B ; « Wikibidous offerts » 10 ; Tab jusqu'à « Proposer l'échange », Entrée. Le `POST /api/trades` observé a 2 éléments, `initiator_wikibidous` 10 et l'en-tête `x-wiki-calendar-tz` ; URL `/trades/<uuid>`, toast « Échange proposé à <B>. ».
  - Compteur : une pile de 3, quantité 3 → « Tu offres (3/100) ».
  - Sans carte : « Proposer l'échange » a `aria-disabled="true"`, et Entrée n'envoie rien : aucun `POST /api/trades` dans la borne de 2 s de `settings.spec.ts:188-190` (`waitForRequest`) ; puis une carte choisie et Entrée → un `POST` part (témoin).
  - Verrou : une copie de A déjà dans un échange en attente (sql) → « Déjà dans un échange », toujours choisissable.
  - Contre-offre : B ouvre `/trades/new?with=<A>&parent=<T1>` → quantités et WB inversés, préremplis ; « Envoyer la contre-offre » → URL de l'enfant ; le détail de T1 montre « Contre-offre ».
  - ***Contre-offre hors de la première page*** : B a 51 copies (`giveCopies(B, 'C', 51)`), et T1 lui demande la copie qui sort en 51e dans l'ordre de `my_collection` (`snapshot_rarity desc, obtained_at desc, id`, lue par `sql`), donc en page 2 → la contre-offre part ; le `POST /api/trades` observé a ses éléments, chacun avec un `card_id` uuid.
  - Erreur : `routeOnce(page, '**/api/friends', (r) => r.fulfill({ status: 500 }))` → « Impossible de charger cette page. » et « Réessayer » ; « Réessayer » → le composer.
  - `?with=` d'un non-ami → « Vous devez être amis pour échanger ».
  - Champ WB : `maxLength` 5 ; 10 001 → l'alerte « Entre 0 et 10 000 wikibidous par côté ».
  - 360 px, avec un ami au pseudo de 24 caractères et une carte au titre long : aucun défilement horizontal ; champs et boutons d'au moins 44 px.
  - `e2e/a11y.spec.ts` : `axe /trades/new?with=<id>` à 0 violation grave.
- [ ] **Step 3: `npm test && npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/trades.spec.ts e2e/a11y.spec.ts`** → échec.
- [ ] **Step 4: Implémenter.**
- [ ] **Step 5: Contrôles complets** → vert.
- [ ] **Step 6: Commit** — `feat(ui): composer d'échange (Tu offres / Tu demandes, quantité par pile, WB sur 5 chiffres, n/100, copies engagées marquées) et contre-offre préremplie à l'inverse`

---

### Task 14: Parcours du jalon — amitié → échange → contre-offre → acceptation

**Files:**
- Create: `e2e/trade-journey.spec.ts`

**Interfaces:**
- Consumes : toutes les pages (Tasks 10 à 13) ; `makePlayer`, `sql`, `cookieFor`, `giveCopies` (`e2e/fixtures.ts`) ; le modèle de `e2e/market-journey.spec.ts:28-33` (un contexte par joueur).

- [ ] **Step 1: Test qui échoue** (un seul `test`, critère M4-17, tout au clavier : `focus()` ou Tab, puis Entrée ou saisie ; chaque étape d'un joueur commence par un `page.goto`, donc par une lecture neuve de la cloche)
  0. `test.setTimeout(120_000)` ; un `browser.newContext()` par joueur, avec `addCookies([{ ...cookieFor(u), url: baseURL! }])`, fermés en fin de test, puis les `auth.users` des deux joueurs supprimés.
  1. Seules écritures SQL : A et B par `makePlayer({ balance: 100 })` ; `giveCopies(A, 'C', 1)` (Z) et `giveCopies(B, 'PC', 2)` (X et Y), titres relevés par `sql`.
  2. A : `/friends` → `#friend-list-search` ← pseudo de B, Entrée → « Ajouter » → toast « Demande envoyée à <B>. ».
  3. B : `/friends` → sous « Demandes reçues », « Accepter » → toast.
  4. A : `/friends` → « Échanger » de B → `/trades/new?with=<B>` ; Z ×1 offerte, X ×1 demandée, « Wikibidous offerts » 10 → « Proposer l'échange » → URL `/trades/<T1>`.
  5. B : `/pulls` → badge « 2 » (`friend_request` et `trade_received`) ; `/trades` → « Reçues » → l'offre « De <A> » → détail → « Contre-offre » → Z demandée et X offerte (préremplis), « Wikibidous demandés » 10 ; B ajoute Y ×1 → « Envoyer la contre-offre » → URL `/trades/<T2>`.
  6. A : `/trades` → « Historique » montre T1 en « · Contre-offre » ; « Reçues » montre T2 « De <B> » → détail → « Accepter » → toast « Échange accepté. », statut « Accepté ».
  7. A : `/collection` contient X et Y, pas Z, et affiche « 90 wikibidous ». B : `/collection` contient Z, et affiche « 110 wikibidous ». Σ = 200 (M conservé).
  8. Cloches : A ouvre la sienne → « <B> a fait une contre-offre » ; B la sienne → « <A> a accepté ton échange » (et « <A> veut devenir ton ami » plus bas).
- [ ] **Step 2: `npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/trade-journey.spec.ts`** → vert du premier coup si les Tasks 10 à 13 sont justes ; sinon le défaut se corrige dans le code, jamais dans le parcours.
- [ ] **Step 3: Contrôles complets** → vert.
- [ ] **Step 4: Commit** — `test(e2e): parcours des échanges au clavier, de la demande d'ami à l'acceptation d'une contre-offre (copies, soldes et cloches des deux côtés)`

---

### Task 15: Bench d'acceptation 100 ↔ 100 en tables journalisées

**Files:**
- Create: `load/bench/trade_setup.sql`, `load/bench/trade_accept.sql`
- Modify: `load/bench/run.sh`, `docs/verifications.md` (section « M4a — Task 15 : acceptation d'échange en tables journalisées »)

**Interfaces:**
- Consumes : toutes les migrations du M4a ; `run.sh` du M3 (`PG_FSYNC=on`, gardes `fsync` et `synchronous_commit`, `deadlocks()`, invariants).
- Produces :
  - `trade_setup.sql`, sur la base du banc seulement (`current_database() = 'wm_test'`, sinon `raise exception`) :
    - `bench.trade_players(n int primary key, uid uuid)` : 20 joueurs au solde de 1 000 000 000, en 10 paires amies ; `client` va de 0 à 9, comme `:client_id` de pgbench (client k = paire k) ;
    - `bench.trades(client int, size int, round int, id uuid, recipient uuid, done boolean not null default false, primary key (client, size, round))` : pour chaque paire, `size` ∈ {100, 10} et `round` de 1 à 10, un échange créé par `wm.create_trade`, l'initiateur alternant à chaque tour, sur des copies propres au tour ;
    - composition d'un côté à 100 : 70 copies seules (dont 10 `starred`, chacune avec une étiquette), 10 piles de 3 (2 éléments chacune, `starred`) et 10 piles de 2 (1 élément) ; à 10 : 7 copies seules, une pile de 3 (2 éléments) et une pile de 2 (1 élément). Avant chaque acceptation, `bench.accept_next` pose l'avatar de chaque joueur sur une copie seule de l'échange du tour, pour que l'instruction (5) de `trade_move` travaille à chaque tour. WB : 500 de l'initiateur, 300 du destinataire ;
    - fond : 100 autres joueurs amis deux à deux et 5 000 échanges `pending` de deux éléments chacun, insérés directement (schéma `bench`, jamais une migration) ;
    - `bench.accept_next(p_client int, p_size int) returns boolean` : la première ligne non faite de `(client, size)` par `round`, `for update`, mise à `done`, puis les avatars du tour (ci-dessous), puis `perform wm.trade_action(recipient, id, 'accept')`. Aucun refus avalé : un P0001 fait échouer la transaction.
  - `trade_accept.sql` : `select bench.accept_next(:client_id, :size)`.
  - `run.sh`, après le règlement :
    - `q -f trade_setup.sql` ;
    - pour `size` 100, puis 10 : `"$pgbench" -n -c 10 -j 10 -t 10 -D size=$size -l --log-prefix="$tmp/acc$size" -f "$here/trade_accept.sql"`, avec `number of failed transactions: 0` exigé ;
    - `count(*)` des échanges `accepted` de `bench.trades` à cette taille = 100 ;
    - p50, p95 et max relevés dans la 3e colonne des journaux (µs, `sort -n`) ; échec si p95 ≥ 500 000 µs ;
    - le résumé ajoute les deux lignes et le rapport des p95 (100 ↔ 100 sur 10 ↔ 10) ;
    - les 5 000 échanges de fond reçoivent ensuite `expires_at = clock_timestamp() - interval '1 second'`, puis `\timing on` et `select wm.expire_trades(5000)` : durée relevée (le lot tient ses verrous de ligne ; au-delà de 1 s, une ligne au suivi) ;
    - les contrôles finaux du M3 (`deadlocks` inchangé, `wm.check_invariants()` = `[]`) couvrent aussi ce bench.

- [ ] **Step 1: `bash -n load/bench/run.sh`**, puis `bash load/bench/run.sh` → échec tant que les scripts manquent.
- [ ] **Step 2: Implémenter**, puis `bash load/bench/run.sh` → le résumé, p95 < 500 ms à 100 ↔ 100, 0 interblocage, invariants vides.
- [ ] **Step 3: Consigner** dans `docs/verifications.md` :
  - la méthode : PG 16 local, 4 vCPU, `fsync=on`, `synchronous_commit=on`, vraies migrations, 10 acceptations parallèles × 10 tours, 20 joueurs, 5 000 échanges en attente en fond, piles, étiquettes, `starred`, avatar et WB, pas de vitrine (P13) ; la durée de `expire_trades(5000)` ;
  - les chiffres, à côté des 2,3 ms de D§9.6 (UNLOGGED, optimiste) ;
  - « chiffres indicatifs (A5) ; le M8 mesure S5 sur Pro ».
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `perf(db): bench d'acceptation d'échange 100 ↔ 100 et 10 ↔ 10 en tables journalisées (p95, 10 en parallèle, 5 000 échanges en attente en fond)`

---

### Task 16 (contrôleur): Livraison — migrations sur la démo, cron vérifié, mesure d'une acceptation, passation

**Files:**
- Modify: `docs/superpowers/HANDOFF.md`, `docs/suivi.md`, `docs/verifications.md`, `docs/decisions-graphify.md`, `docs/DESIGN.md` (section « Amis et échanges » : onglets, carte d'offre, puces, détail, composer, cloche)
- Create (non versionné) : `.superpowers/sdd/2026-10-22-m4-echanges-social/deploy-m4a.sql`

> Ordre (R32, M4-18) : migrations, puis fusion. `develop` est la branche de production de Vercel, et la nouvelle cloche lit `rest/v1/notifications`, tandis que `/api/trades` appelle `wm.trades_list`.

- [ ] **Step 1: Contrôles complets, revue de branche, PG17.**
  - Tout vert, `coverage:recap` à 54/90. Puis la revue finale de la branche (R31) et ses corrections.
  - Pousser la branche et lancer `ci.yml` sur sa tête (`workflow_dispatch`, MCP GitHub) : `checks` et `integration` verts sur `postgres:17`.
  - Une correction SQL arrivée après le Step 3 est une nouvelle migration `1750+`, par le SQL Editor si elle contient `delete`.
- [ ] **Step 2 (contrôleur): Préparer `deploy-m4a.sql`.**
  - Produit par concaténation, jamais à la main : `begin`, `set local lock_timeout = '5s'`, `cat` de `0005`, `1700`, `1710`, `1720`, `1730`, `1740` et `9010` dans cet ordre, les lignes d'historique, `notify pgrst, 'reload schema'`, `commit`.
  - Lignes d'historique : `insert into supabase_migrations.schema_migrations (version, name, created_by) values (…, 'sql-editor') on conflict (version) do nothing`, une par fichier, avec pour version un horodatage du jour suivi du rang. Celle de `9010` est un `insert … select … where exists (select from pg_extension where extname = 'pg_cron')`.
  - **Répétition** sur une base du banc d'avant le M4a, comme au M3 (P3:1138-1146) :
    - `db-test.sh --stop` dans l'arbre principal ;
    - un worktree de `develop` dans le scratchpad, avec un lien vers `.cache/gotrue` ;
    - `db-test.sh --setup-only`, puis le schéma `supabase_migrations` de remplacement ;
    - `psql -v ON_ERROR_STOP=1 -f deploy-m4a.sql` deux fois → `COMMIT` ;
    - `psql -v ON_ERROR_STOP=1 -f <branche>/supabase/tests/helpers.sql` (idempotent ; `tests.trade_snapshot` et `tests.boom` n'existent que dans celui de la branche, et ses fonctions `language sql` exigent `public.trades`) ;
    - `28_trades.test.sql` de la branche entre `begin` et `rollback` → vert ;
    - `md5` des définitions des fonctions `wm` = celui d'une base de la branche.
  - Attendu : `wm.check_invariants()` = `[]`, et `wm.trades_list(<un profil>)` → `{"trades": []}`.
- [ ] **Step 3 (humain, demandé maintenant): Lancer `deploy-m4a.sql`** dans le SQL Editor du projet `iggurckxmoagsajzrnwd` (« Run without RLS »), sans rien sélectionner. En cas d'erreur, rien n'est appliqué : l'utilisateur colle le message, et le contrôleur relit l'historique `created_by = 'sql-editor'` avant toute relance.
- [ ] **Step 4 (contrôleur): Contrôles par le MCP** (`execute_sql`), consignés :
  - `select jobname, schedule, command, active from cron.job where jobname = 'wm-trade-expire'` → `27 * * * *`, `select wm.expire_trades(5000)`, actif ; après :27, un run `succeeded` dans `cron.job_run_details` ;
  - droits : `role_table_grants` sur `trades`, `trade_items` et `friendships` pour `anon` et `authenticated` → seulement `authenticated SELECT` ×3 ;
  - sondes avec la clé publiable : `POST /rest/v1/rpc/trades_list` avec `Content-Profile: wm` → 401 `42501` (404 `PGRST202` = cache périmé) ; `GET /rest/v1/trades` → 401 `42501` (404 `PGRST205` = cache périmé) ;
  - `wm.check_invariants()` = `[]` ; `get_advisors` `security` → aucune nouvelle alerte à nous ; `performance` → seulement l'INFO « unindexed foreign key » sur `trade_items.card_id` et les INFO « unused index » des index du M4a ;
  - taille de la base et du WAL, avant et après, comme au M3.
- [ ] **Step 5 (contrôleur): Fusion `--no-ff` dans `develop`** de la tête validée au Step 1 (nouveau run de `ci.yml` si elle a bougé), push, déploiement Vercel READY, `/api/health` → 200, et `health.yml` lancé en `workflow_dispatch` → vert.
- [ ] **Step 6 (humain et contrôleur): Une acceptation 100 ↔ 100 mesurée sur la démo** (M4-6) :
  - l'utilisateur choisit deux comptes de démo et les rend amis par `/friends` ;
  - le contrôleur donne 100 copies à chacun par `select wm.grant_copy(…)` (MCP ; ni `delete` ni extension), puis crée l'échange par `select wm.create_trade(…)` (100 éléments par côté, WB 500 et 300 si les soldes le permettent, sinon 0 et 0, consigné) ;
  - l'utilisateur ouvre `/trades/<id>` et clique « Accepter » ;
  - le contrôleur lit le `ms` de la ligne `PATCH /api/trades/[tradeId]` dans les journaux d'exécution Vercel (`get_runtime_logs`), et le consigne tel quel, comme « démo Free, une mesure » (A5), avec `wm.check_invariants()` = `[]`.
  Si l'utilisateur décline, la mesure devient une ligne de `HANDOFF.md`.
- [ ] **Step 7: Passation**
  - `HANDOFF.md` :
    - état du M4a : migrations, job, bench, mesure ;
    - chaque critère du D§13 qui relève du M4a, et sa preuve : 100 ↔ 100 (Task 15 et Step 6), atomicité (Task 5 A, Task 9 B, Task 7 C), rejeu (Tasks 5, 7 et 9), contrat (54/90, §3.6 complet) ;
    - arrêt d'urgence du job : `select cron.alter_job(jobid, active := false) from cron.job where jobname = 'wm-trade-expire'` ;
    - étape suivante : le M4b.
  - `docs/suivi.md` : section M4a soldée, `suivi.md:33`, `:34` (moins le push), `:36` et `:37` rayés. Reportés :
    - au M4b : profil, vitrine (et son nettoyage dans `wm.trade_move`, P13), messages, signalements, Web Push ; le P21 ;
    - au M7 : seconde cloche (R:138, P14) et `selectors.spec.ts` ;
    - au M8 : S5 sur Pro ;
    - au suivi, seule : l'empreinte serveur de l'`Idempotency-Key` (M4-8) ;
    - au script de suppression des cartes d'essai (M2-12) : `trade_items.card_id` sans cascade, donc les éléments de ces cartes à supprimer d'abord.
  - `docs/decisions-graphify.md` : M4-1 à M4-18, les écarts au spec, P1 à P23.
  - `docs/verifications.md` : répétition de `deploy-m4a.sql`, passage PG17, contrôles MCP, job, mesure du Step 6, et renvoi au bench de la Task 15.
- [ ] **Step 8: Commit** — `docs: M4a livré — amis et échanges sur la démo, acceptation 100 ↔ 100 mesurée, expiration par pg_cron, passation`
- [ ] **Step 9 (contrôleur): Push et CI.** Pousser, lancer `ci.yml` → vert, fusion `--no-ff` dans `develop`, push.

---

## Auto-revue

- **Couverture du spec.**
  - D§7.6 : création (Task 4) ; contre-offre (Tasks 4 et 13) ; acceptation en une transaction, avec verrou, revérification ensembliste et déplacements en quelques instructions (Task 5) ; refus et annulation réservés à leur rôle (Task 5) ; verrou `card_locked` dans la défausse et la vente (Task 2) ; idempotence et `trade:<id>` (Tasks 5, 7 et 9) ; `trade_limits` et expiration horaire (Tasks 2 et 5) ; `x-wiki-calendar-tz` lu sans effet (Task 9).
  - D§7.9, amis et notifications : `friendships` à l'index `(least, greatest)`, recherche par préfixe, « Tout accepter », `PATCH`, `DELETE` et codes (Tasks 1, 3 et 8) ; `GET /api/notifications` (50), `PATCH {ids}` ou `{}`, cloche par PostgREST toutes les 30 s et index partiel (Tasks 6 et 10) ; notification dans la transaction de l'événement (Tasks 3 à 5). Le Web Push est au M4b (M4-1).
  - D§8 : contrat et refus de `rest/v1/trades` (Tasks 8 à 10 : 39 → 45 → 52 → 54) ; DOM du R§6.8 (Tasks 10 à 12) ; a11y par route et parcours d'échange au clavier (Tasks 10 à 14).
  - D§9 : index du D:810-811 (Tasks 2 et 6), polling de 20 s et de 30 s (Tasks 10 et 12), mesure de 500 ms (Task 15 et Task 16 Step 6).
  - D§13, ce qui relève du M4a : Tasks 5, 7, 9 et 15. Le push en CI est au M4b.
  - Les deux revues du plan : chaque Important a son test dans la tâche qui possède le code (ordre des verrous de la contre-offre et copies d'un tiers : Task 7, scénarios 6 et 7 ; un seul côté : Tasks 4, 5 et 9 ; focus, erreur et polling : Tasks 10 à 13 ; contre-offre hors de la première page : Task 13).
  - Héritages S:33, S:34, S:36 et S:37 : Tasks 2, 3, 5 et 10.
- **Cohérence des noms.** Ce que les tâches 8 à 14 consomment est défini par les tâches 2 à 6 :
  - `create_trade(p_uid, p_recipient_id, p_items, p_initiator_wikibidous, p_recipient_wikibidous, p_parent_trade_id, p_tz, p_idem)` ;
  - `trade_action(p_uid, p_trade_id, p_action, p_tz, p_idem)` ;
  - `friend_action(p_uid, p_friendship_id, p_action, p_idem)` ;
  - `notifications_read(p_uid, p_ids, p_idem)` ;
  - `friend_remove(p_uid, p_friendship_id, p_idem)` et `friend_accept_all(p_uid, p_idem)`, qui passent par `idem_claim`, `actor` et `idem_store` comme les autres écritures ;
  - les routes passent exactement ces noms d'arguments ; les routes de notifications sont à la Task 10, qui seule les consomme ;
  - `tests.trade_snapshot` et `tests.boom` sont définis à la Task 5 et repris aux Tasks 7, 9 et 16 (répétition) ; `befriend`, défini à la Task 8 (contrat) puis à la Task 11 (E2E), porte le même nom dans deux modules distincts ;
  - le schéma `Trade` du contrat (Task 9) suit les 17 clés du P7 (Task 2), et `TradeBody` sert la route et le composer ; `invertTrade` rend `cardOf`, que `buildBody` consomme ;
  - les montants affichés passent partout par `` `${formatInt(n)} ${wikibidous(n)}` ``.
- **Proportion.** Seize tâches, comme au M3, pour douze routes (quinze de contrat), quatre pages et la cloche. Les corps n'apparaissent que pour l'algorithme de `trade_move` (les cinq instructions) et pour l'ordre des refus, que les tests seuls ne fixent pas.
