# M4b — Profil, vitrine, messages, signalements, Web Push : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finir le jalon M4. Chaque joueur a un profil public ou réservé aux amis : une bio de 280 caractères au plus, un avatar tiré d'une copie qu'il possède et une vitrine de 4 emplacements. Un tiers voit un profil privé réduit et peut y demander l'amitié. Deux amis s'écrivent en privé, au plus 30 messages par minute, et le fil se marque lu par un `PATCH` direct sur `rest/v1/chat_messages`. On signale un joueur, une fois par couple, et le signalement reste modifiable. Un joueur abonné reçoit en Web Push les types de notification qu'il a activés : tout de suite par `after()` pour un événement né d'une requête, et par un réveil pg_cron de 15 s pour un événement né d'un cron. La pastille « ami possède » du catalogue se remplit et mène au profil. Critère du jalon (D:1083) : un push reçu sur un point d'entrée de test en CI, et le contrat §3.7 vert, soit `coverage:recap` 54 → 66 sur 90, avec le §3.6 qui reste vert.

**Architecture:** Les tables `chat_messages`, `showcase`, `reports` et `push_subscriptions` entrent dans le miroir `public`.
- Le seul droit client d'écriture qu'ajoute le M4b est `UPDATE (read)` sur `chat_messages`, réservé au destinataire. Tout le reste passe par une fonction `wm.*` en une transaction : `profile_*`, `showcase_*`, `chat_*`, `report_*`, `push_*`.
- Ordre des verrous C4. `chat_send` tient les deux profils par `wm.lock_users`, ce qui ferme l'interblocage des messages croisés et rend sûre la notification dédoublonnée. Vitrine et avatar tiennent le profil de l'écrivain avant de revérifier la copie.
- Un trigger *statement-level* sur `notifications` alimente `wm.push_outbox` pour les abonnés qui ont activé le type. `lib/push.ts` réserve au plus 500 lignes, chiffre avec `web-push` 3.6.7 (`generateRequestDetails`) et envoie par `fetch`, par vagues de 50. Le drain part de `after()`, par une option `push` de `route()`, et de `POST /api/cron/push`, que `wm.push_wake()` appelle par pg_net seulement si l'outbox n'est pas vide (`9020`).
- La preuve de D:1083 est `contract/spec/push.ts` : la passerelle du banc reçoit le push en HTTP, et la spec le déchiffre (RFC 8291) et vérifie le JWT VAPID.
- Les pages `/profile` (éditeur), `/profile/[username]` (vue publique, signalement) et `/dms` (conversations, fil interrogé toutes les 5 s) sont des coquilles statiques avec un composant client. La section « Notifications » de `/settings` enregistre `public/sw.js`.

**Tech Stack:** celle du M4a (next 16.4.2, react 19.3.1, @supabase/supabase-js 2.118.0, zod 4.6.7, vitest 5.0.5, @playwright/test 1.64.1, @axe-core/playwright 4.14.0, PostgREST v12.2.3, GoTrue v2.197.0, pg_cron 1.6.4 sur la démo en PostgreSQL 17.11, `pgbench` 16 du banc local). Dépendances ajoutées, en épingles exactes : `web-push` **3.6.7** (publiée le 2024-01-16, D:74) et, en dev, `@types/web-push` **3.6.4** (publiée le 2024-10-22). Sur la démo : pg_net 0.20.4, préchargé, dont l'extension est à créer, et `supabase_vault` 0.3.1, déjà installé.

**Spec:** `docs/superpowers/specs/2026-10-18-*-rebuild-design.md`, le seul fichier de ce dossier, cité D§x ou D:ligne. Surtout D§7.0, §7.9 (D:591-604), §7.12, §8 (D:648-755), §9.4, §9.5, §12, §13 (D:1083). Le récap `docs/rea-recap.md` est cité R§x ou R:ligne : surtout R§2.2 (R:126-137), §3.7 (R:246-259), §4.1, §4.2 (R:358-376, R:464-473), §5.8 (R:620-638), §6.7, §6.8. Le plan du M4a est cité P4a:ligne, `docs/decisions-graphify.md` DG:ligne, `docs/suivi.md` S:ligne. Les rapports de repérage et les décisions du contrôleur ne sont pas versionnés : ce plan recopie chaque valeur dont une tâche a besoin.

## Global Constraints

- **Toutes les contraintes globales des plans M0 à M4a restent en vigueur** (P4a:15-24) :
  - versions exactes ;
  - lire le guide de `node_modules/next/dist/docs/` avant de toucher une API Next (`AGENTS.md`), et en plus pour le M4b :
    - `01-app/03-api-reference/04-functions/after.md` (exécuté même si la réponse a échoué, borné par `maxDuration`) ;
    - `03-file-conventions/02-route-segment-config/maxDuration.md` ;
    - `03-file-conventions/public-folder.md` ;
    - `01-app/02-guides/progressive-web-apps.md` (enregistrement du SW et `pushManager.subscribe`) ;
  - fonctions `wm.*` en `security definer` et `set search_path = ''`, sans aucune autre entrée dans `proconfig`, avec `EXECUTE` à `service_role` seul. Chaque migration `wm` finit par les cinq lignes `revoke`/`grant` de `1400_wm_catalog.sql:76-80`, et le scan de `10_wm_core.test.sql:139-155` le vérifie. Exceptions : `9000`, `9010` et `9020`, qui ne créent aucune fonction `wm` (dit en tête du fichier) ;
  - migrations idempotentes, expand-only, PG16 et PG17, sans `MERGE … RETURNING` ;
  - une fonction redéfinie garde sa signature et sa réponse (exception unique : M4b-18) ;
  - tout `DELETE`/`UPDATE` garde un `WHERE` (`where true` pour vider), contrôlé par `scripts/check-dml.ts` ;
  - chaînes d'erreur exactes, avec `error` = `message`, levées par `wm.raise_err` et recopiées par `route()` ;
  - aucune PII dans les logs : ni contenu de message, ni endpoint push, ni clé ;
  - « tu » dans le jeu ; thème sombre ; ports du banc du M1 (aucun port de plus) ; aucun chemin de code réservé aux tests (seulement la configuration) ;
  - formes JSON : clés en plus permises, jamais de clé retirée ; les contrats existants ne changent pas, et le §3.6 (`contract/spec/trades.ts`) n'est pas touché.
- **Dépôt public** (M2-R1, DG:150) : aucun nouveau fichier ne nomme la marque du jeu d'origine, son domaine, son exploitant ni le pitch. `public/sw.js` reste neutre : le titre arrive dans la charge, depuis `lib/brand.ts`. Aucune clé VAPID ni aucun secret dans le dépôt, les journaux de CI ou la conversation.
- **La CI reste verte après chaque tâche.** Chaque tâche finit par l'un de ces deux jeux de contrôles, ceux que lance `ci.yml` :
  - **contrôles rapides** (job `checks`) : `npm run typecheck && npm run lint && npm test && npm run coverage:recap` ;
  - **contrôles complets** (`checks` + `integration`) : les rapides, puis `npm run test:db && npm run build:test && npm run test:contract && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e`.
  Une tâche qui touche une migration, `supabase/tests/`, `scripts/db-test.sh`, l'app ou le contrat lance les contrôles complets.
- **Verrous (C4, P4a:29-35, M4b-2, M4b-31)** :
  - d'abord la ligne métier (aucune au M4b), puis les profils et leur `user_state` par `wm.lock_users` (deux joueurs) ou `wm.lock_user` (un seul), une seule fois, puis les copies ;
  - `perform set_config('lock_timeout', '2s', true)` précède le premier verrou de `chat_send`, `profile_update`, `showcase_put`, `showcase_delete` et `report_upsert` ;
  - `wm.actor` ne verrouille rien et passe après `idem_claim` ;
  - **une insertion qui référence deux profils** (une notification, un message, un signalement) a ses `FOR KEY SHARE` pris dans l'ordre des id : par `lock_users` déjà tenu, par une instruction `order by user_id` (P28), ou par un `for key share order by id` explicite (`report_upsert`, M4b-31).
- **Notifications** :
  - `data` reste en snake_case, sans texte. Le seul type nouveau est `chat_message`, avec `{user_id, username}` de l'expéditeur ;
  - le trigger d'outbox tourne dans la transaction qui insère : un échec annule l'événement ;
  - **la charge d'un push ne contient jamais le contenu d'un message**.
- **Erreurs du M4b** (corps `{status, code?, error, message, …extra}` levé par `wm.raise_err` ; apostrophe ASCII comme au M3 ; « 2 000 » avec une espace simple) :

  | Statut | `code` | Message |
  |---|---|---|
  | 400 | `invalid_request` | « La bio fait au plus 280 caractères » · « Cette carte n'a pas d'image utilisable en avatar » · « Une image sensible ne peut pas servir d'avatar » · « Emplacement de vitrine inconnu (0 à 3) » · « Cette carte est déjà dans ta vitrine » · « Tu ne peux pas t'écrire à toi-même » · « Le message est vide » · « Un message fait au plus 2 000 caractères » · « Tu ne peux pas te signaler toi-même » · « Motif de signalement inconnu » · « Les détails font au plus 500 caractères » · « Service de notifications non pris en charge » · « Type de notification inconnu » · « Abonnement push invalide » (zod) |
  | 403 | `FORBIDDEN` | « Tu ne peux modifier que ton profil » · « Ce profil est privé » (`1300_wm_collection.sql:177`) · « Vous devez être amis pour vous écrire » (D:595) |
  | 403 | `42501` | « Vous ne possédez pas cette carte » (D:675) |
  | 404 | — | « Joueur introuvable » (`1300:173`) |
  | 429 | — | « Le site demande de ralentir » + `retry_after` (D:685, M4b-29) |
  | 503 | `push_disabled` | « Notifications push non configurées. » (route du cron, M4b-16) ; `cron_disabled` et `cron_unauthorized` inchangés (`app/api/cron/revalidate/route.ts:12-15`) |

- **DOM** : aucun sélecteur du R§6.8 ne vise ces pages (R:736). Règles de la maison (P4a:57-64, M4-15) :
  - aucun `id` fixe sauf `#friend-list-search` et les ids de section de `/settings` (`settings-notifications` s'y ajoute) ; les ids de `useId()` restent permis ;
  - jamais `placeholder="Rechercher par titre ou catégorie..."` ni `aria-label="Fermer"` dans les nouvelles pages (contrats des extensions) ;
  - `Card` pour toute copie affichée ;
  - cibles d'au moins 44 px ; nombres par `formatInt` ;
  - `aria-disabled` et une garde, jamais `disabled` ;
  - focus jamais sur `body` ; 360 px sans défilement horizontal ;
  - `alt=""` pour un avatar placé à côté du pseudo (D:753).
- **Motifs imposés à chaque page nouvelle** (DG:459-463) :
  - lectures ordonnées (génération ou `hold`) ;
  - un corps 2xx illisible est une lecture en échec ;
  - une issue incertaine est dite comme telle, prise au départ et effacée quand l'état affiché change ;
  - `data-ready` ;
  - clés `apiOnce` oubliées après une relecture réussie ;
  - formulaire figé (`readOnly`) pendant l'envoi ;
  - relecture à chaque affichage (Activity).
- **E2E** (P4a:65) :
  - chaque test crée ses joueurs (`makePlayer`, `login`), ses copies (`giveCopies`, `imageCopy`) et ses amitiés (`befriend`), puis supprime ses `auth.users`, ce qui emporte tout en cascade ;
  - toujours `routeOnce`, jamais `{ times: 1 }` ;
  - le parcours du jalon, `e2e/social-journey.spec.ts`, n'écrit en SQL qu'à sa préparation ; les autres specs posent amitiés, messages et notifications par `sql`.
- **Points hérités pris au M4b** (S:40-44) :
  - `0006`, `18xx` et `9020` ;
  - `wm.trade_move` qui vide la vitrine (P13 du M4a) ;
  - P21 a, b et c (`friendOwners`, lien de la pastille, collection d'un profil privé ouverte à ses amis) ;
  - les boutons « Message » (R:132) et « Message à <pseudo> » (R:127, M4b-24) ;
  - le Web Push (S:36, M3-8).

## Décisions (contrôleur, à consigner dans `docs/decisions-graphify.md`, Task 17)

Règles de conduite inchangées (DG:339). Format : décision — pourquoi — coût si faux. M4b-1 à M4b-27 viennent du contrôleur. M4b-28 à M4b-33 sont tranchées par ce plan, là où le contrôleur l'a laissé faire.

- **M4b-1. Un plan, une livraison** `deploy-m4b.sql` (`0006`, `1800`–`1850`, `9020`) dans l'ordre R32, avec les tâches du push en dernier. Si la sonde de réveil échoue sur la démo, on livre quand même : `after()` couvre les événements nés d'une requête — pourquoi : M4-1 a déjà coupé le jalon en deux, et D:1083 réunit le push et le §3.7 — coût si faux : une seconde répétition et une seconde fenêtre du SQL Editor.
- **M4b-2. Verrous.**
  - `chat_send` : `idem_claim` → `actor` → validations (pair inconnu 404, soi-même 400, contenu 400) → `lock_timeout` → `wm.lock_users(array[moi, pair])` → `are_friends`, sinon 403 `FORBIDDEN` « Vous devez être amis pour vous écrire » → garde de débit → insertion du message, puis de la notification.
  - `showcase_put`, `showcase_delete` et `profile_update` : `wm.lock_user(moi)`, puis la copie revérifiée sous ce verrou. `trade_action` et la défausse tiennent ce même profil avant de déplacer une copie.
  - Signalement et abonnement push : `actor` seul, sans `lock_user` (voir M4b-31 pour les clés étrangères du signalement).
  - Toutes ces fonctions entrent dans le contrôle `prosrc` du P5 du M4a.
  - Pourquoi : chaque envoi tient son profil, et l'insertion prend `FOR KEY SHARE` sur le profil de l'autre (FK de `chat_messages` et de `notifications`). Deux messages croisés s'interbloquent donc, ce qui est reproduit sur PG16.
  - Coût si faux : des 503 `BUSY` sur `40P01` dès que deux amis s'écrivent en même temps.
- **M4b-3. Débit des messages : fenêtre fixe dans `wm.user_state`** (`chat_window_start`, `chat_window_count`), sous la config `chat_burst` `{"count": 30, "window_s": 60}`, sur le modèle de `market_guard`/`market_tick` (`1600_wm_market_core.sql:68-119`).
  - Le refus est un 429 au corps du D§8.2 (M4b-29). `retry_after` vaut les secondes qui restent dans la fenêtre, au moins 1, et `route()` le recopie dans `Retry-After` (`lib/route.ts:40-44`).
  - Le compteur s'incrémente après l'insertion, sous le verrou du profil.
  - Pourquoi : C17 (D:142) et D:595, sans index de plus.
  - Coût si faux : un `count(*)` indexé par envoi.
- **M4b-4. Notification `chat_message`.**
  - `data` = `{user_id, username}` de l'expéditeur, sans texte (M4-12).
  - Au plus une non lue par couple (expéditeur, destinataire) : rien n'est inséré s'il en existe déjà une. C'est sans course grâce à M4b-2.
  - Lien de la cloche `/dms?with=<user_id>`, dans `notificationView` (P14).
  - Synchronisation : un trigger `after update on public.chat_messages referencing old table as o new table as n for each statement`, **sans liste de colonnes**. PG refuse une table de transition sur un trigger à liste de colonnes, ce qui est prouvé. Le trigger filtre `o.read is distinct from n.read` et marque lues les `chat_message` du couple.
  - Le contenu n'entre jamais dans la charge du push.
  - Pourquoi : sans type, le push ne couvre pas le cas d'usage le plus fréquent ; sans regroupement, on aurait 30 notifications par minute.
  - Coût si faux : un type à retirer, sans migration de données.
- **M4b-5. Profil privé vu d'un tiers.**
  - `GET /api/profile/{u}` rend 200 `{profile: {id, username, avatar_url, is_public: false, created_at}, isOwn, isFriend, friendship}`, sans `bio`.
  - La vitrine et la collection d'un profil privé, lues par un non-ami, rendent 403 `FORBIDDEN` « Ce profil est privé ». Un ami voit tout : `profile_collection` est redéfinie à signature inchangée (P21 c).
  - `lastSeenAt` est omis : `last_seen_at` n'a aucun écrivain, et en écrire un verrouillerait `profiles` à chaque requête.
  - Clé en plus `friendship` = `{id, status, requester_id}` ou `null`.
  - Pourquoi : une 403 rendrait « Ajouter en ami » inatteignable (R:134).
  - Coût si faux : un profil privé montre son pseudo et son avatar, que la recherche d'amis montre déjà.
- **M4b-6. Avatar.**
  - Un trigger `before update of avatar_user_card_id on public.profiles` vide `avatar_url` quand l'id passe d'une copie à null. Il couvre `trade_move`, la défausse et le séquestre, puisque l'`on delete set null` est une mise à jour de la colonne (prouvé).
  - Sa clause `when (old.avatar_user_card_id is not null and new.avatar_user_card_id is null)` est tranchée par ce plan. Elle protège l'`avatar_url` d'un profil migré sans copie, quand une écriture remet la colonne à sa valeur nulle.
  - Le `PATCH` écrit `avatar_url = cards.image_url` de la copie validée, ou `null` pour un retrait.
  - Refus : copie non possédée → 403 `42501` ; sans image ou en `hide_image` → 400 ; en `nsfw_image` → 400, un écart inféré et consigné ; `avatar_user_card_id: null` retire l'avatar.
  - `shortcut:` : une image de catalogue changée après coup reste en avatar.
  - Coût si faux : une carte cédée qui reste en avatar.
- **M4b-7. Vitrine.**
  - Table `public.showcase(user_id → profiles on delete cascade, position smallint check (position between 0 and 3), user_card_id → user_cards on delete cascade, primary key (user_id, position))`, avec un index **non unique** `(user_card_id)` en `1800`.
  - Une même copie dans deux emplacements → 400. Un `PUT` sur un emplacement occupé le remplace.
  - `wm.trade_move` gagne une 6ᵉ instruction, `delete from public.showcase where user_card_id = any (v_full)`, à signature inchangée : une pile donnée en partie garde son emplacement.
  - `GET /api/showcase` rend `galleries: []` en constante.
  - Le §3.6 ne change pas, et `tests.trade_snapshot` gagne la vitrine et l'outbox.
  - Coût si faux : un index unique ajouté plus tard, après un contrôle des doublons.
- **M4b-8. Réponses des écritures** (« inféré » dans la matrice) :
  - `PATCH /api/profile/{u}` → la forme du `GET` ;
  - `PUT` et `DELETE /api/showcase` → la forme du `GET` (`{showcase, galleries: []}`) ;
  - `POST /api/chat/{peerId}` → **201** `{message}` ;
  - `POST /api/reports` → `{report: {reason, details}}` ;
  - `POST /api/push/subscribe` → `{ok: true}` ; `DELETE /api/push/subscribe` → `{ok: true}`, même si l'endpoint est inconnu ;
  - `POST /api/cron/push` → `{sent, gone, failed}`.
  Chaque écriture prend `idem: true`, avec les cas M4-8, et l'UI passe par `apiOnce`.
  Coût si faux : des clés en plus, toujours permises (D:695).
- **M4b-9. Fils.**
  - `GET /api/chat/{peerId}` : pair inconnu → 404 « Joueur introuvable » ; non-ami → 200 avec l'historique (seule l'écriture exige l'amitié).
  - Clés en plus `peer {id, username, avatar_url}` et `isFriend`.
  - Les 100 derniers messages, en ordre croissant ; aucun marquage lu côté serveur.
  - `GET /api/chat` : 50 conversations. Plafonds dans `list_caps`.
  - Index : `(sender_id, recipient_id, created_at desc)` (D:811), `(recipient_id, sender_id, created_at desc)` et un partiel `(recipient_id) where not read`.
  - Coût si faux : un historique tronqué au-delà de 100 messages.
- **M4b-10. Contraintes du miroir `0006`** : `check (char_length(content) <= 2000)`, `check (char_length(details) <= 500)`, `unique (reporter_id, reported_user_id)`, enum `report_reason` (`cheating`, `inappropriate_content`, `spam`, R:341). Le message français vient de la fonction `wm`, qui valide avant (P11) — coût si faux : un `CHECK` que le DUMP-S contredirait, retiré au M7.
- **M4b-11. Chiffrement et transport du push** : `web-push@3.6.7` (D:74) fait aes128gcm et le JWT VAPID par `generateRequestDetails`, exportée (`web-push/src/index.js:19`) et sans `this`, ce qui est vérifié sur la copie du paquet. Puis `fetch` avec `AbortSignal.timeout(5000)`.
  - Le faux service de push est **HTTP**, dans la passerelle du banc, sur le modèle de Turnstile (`contract/harness.ts:94-102`). Il répond 201, ou 410 sous `/push/gone/`.
  - `@types/web-push` est épinglé exactement (M4b-30).
  - Pourquoi : D:74 et D:602 tenus, sans certificat de test ni variable d'environnement de plus.
  - Coût si faux : passer à `sendNotification` derrière un faux service HTTPS, environ une heure.
- **M4b-12. Liste blanche des endpoints dans `wm.config.push_origins`** : origines `https://fcm.googleapis.com`, `https://updates.push.services.mozilla.com` et `https://web.push.apple.com`, plus le suffixe `.notify.windows.com`.
  - `wm.push_subscribe` la contrôle et refuse en 400 français. zod contrôle la forme : URL de 2 048 caractères au plus, `p256dh` de 65 octets en base64url commençant par 0x04, `auth` de 16 octets.
  - Le test ajoute `http://127.0.0.1:54321` par psql : c'est de la configuration.
  - Pourquoi : SSRF, et un service s'ajoute sans redéployer.
  - Coût si faux : un navigateur non listé ne peut pas s'abonner, jusqu'à une ligne de config.
- **M4b-13. Préférences push en opt-in par type**, à la lettre de D:600 et avec le consentement de R:637.
  - Table `wm.notification_prefs(user_id pk → profiles on delete cascade, push_types text[] not null default '{}')`, nommée par D:259. Route ajoutée `GET`/`POST /api/settings/notifications`. `get_prefs` et `set_prefs` sont inchangés.
  - Au premier « Activer sur cet appareil », l'UI active les 13 types. Ensuite, chaque famille s'écrit en bloc : Messages (`chat_message`), Échanges (`trade_*`), Amis (`friend_*`), Marché (`auction_*`, `wishlist_listed`).
  - Coût si faux : un type du M5 demande une case ou un `update`.
- **M4b-14. Clé publique VAPID dérivée de `VAPID_PRIVATE` à l'exécution** (`createECDH('prime256v1')`), rendue par `GET /api/settings/notifications` sous la clé `vapid_public` (`null` si le push est coupé). `VAPID_PUBLIC` devient facultatif, un écart de nom consigné — pourquoi : une seule source de vérité, et rien de figé au build — coût si faux : une variable et un redéploiement.
- **M4b-15. `VAPID_SUBJECT` obligatoire** (env serveur) ; sans lui, le push est coupé. Production : `https://wmr-ivm.vercel.app` ; banc : `mailto:push@example.invalid`, posé par le harnais. L'origine de la requête ne convient pas : web-push refuse un sujet `http:` (`vapid-helper.js:68-87`) — coût si faux : Apple refuse le sujet (403 sur iOS seulement).
- **M4b-16. Échec fermé.**
  - Sans `VAPID_PRIVATE` ou sans `VAPID_SUBJECT`, le drain ne réserve rien et `/api/cron/push` répond 503 `push_disabled`.
  - `wm.push_wake()` purge d'abord l'outbox de plus d'une heure. `wm.purge_expired()` est inchangée.
  - Pourquoi : la base est partagée, et un déploiement sans clés détruirait les lignes d'un autre.
  - Coût si faux : les push d'une heure de panne sont perdus ; la cloche reste juste.
- **M4b-17. Réveil.**
  - `wm.push_wake()` vit en `1840`, sous le scan des droits. Son URL est dans `wm.config.push_wake_url` (`null` par défaut, posée par `deploy-m4b.sql`).
  - Secret lu dans `vault.decrypted_secrets where name = 'CRON_SECRET'`, une entrée qui existe déjà sur la démo : ne pas la recréer.
  - `9020_wm_push_cron.sql`, sans fonction `wm` : si pg_cron est présent et pg_net préchargé, `create extension if not exists pg_net`, puis `cron.schedule('wm-push-wake', '15 seconds', 'select wm.push_wake()')`.
  - Test SQL avec de faux schémas `net` et `vault`. Sonde après le SQL Editor : `net._http_response.status_code` = 200 dans les 15 s.
  - Coût si faux : les push nés d'un cron attendent le prochain `after()`, ou la purge.
- **M4b-18. Règle des fonctions redéfinies.** Une clé en plus est permise sur une fonction redéfinie quand D l'exige, et le test d'égalité stricte est élargi dans la même tâche. Au M4b, la règle vaut seulement pour `wm.health()` (`push_lag_s`, `null` si l'outbox est vide, D:1059) et pour `health.yml` (`(.push_lag_s // 0) <= 120`) — coût si faux : un test de forme à revoir.
- **M4b-19. Au plus 500 lignes réservées par appel** (`delete … returning`, `skip locked`), envoi par vagues de 50, sans boucle. `shortcut:` dans `lib/push.ts` — pourquoi : la lettre de D:602 — coût si faux : quelques minutes de retard sur une carte très souhaitée.
- **M4b-20. 10 abonnements par joueur** (`wm.config.push_max_subscriptions`), consigné en écart à C30 et à M4-16 : c'est une validation à une frontière de confiance, contre l'amplification. Au-delà, l'upsert garde les 10 plus récents — coût si faux : un onzième appareil fait tomber le plus ancien.
- **M4b-21. `friendOwners`** (P21 a et b) : `{[cardId]: [{id, username}]}`, au plus 3 par carte (`list_caps.friend_owners`), tous les amis.
  - Calculé dans l'overlay par joueur, jamais dans le cache partagé (M2-14).
  - `Card` montre le premier pseudo, en lien vers `/profile/<pseudo>`.
  - Mesure de l'overlay avec un joueur à beaucoup d'amis (Task 16). Les assertions `friendOwners: {}` existantes restent vraies sans ami.
  - Coût si faux : un lecteur qui attend des chaînes ignore la clé.
- **M4b-22. Maintenance** : le drain et le réveil ignorent `maintenance`. L'arrêt d'urgence est `cron.alter_job(jobid, active := false)` sur `wm-push-wake`, dans une section « Exploitation du push » de HANDOFF — coût si faux : quelques push pendant une maintenance.
- **M4b-23. `/sw.js`** :
  - le chemin entre dans `EXEMPT` (`lib/gate.ts:4`), avec un test unitaire et un cas de contrat (serveur à porte, sans cookie → 200 JavaScript) ;
  - `public/sw.js` est écrit à la main, sans gestionnaire `fetch` ;
  - pas d'E2E CDP : l'E2E de `/settings` simule `PushManager` par `addInitScript`. La preuve de D:1083 est `contract/spec/push.ts`.
  - Coût si faux : `sw.js` n'est couvert que par l'essai manuel sur la démo.
- **M4b-24. Écrans du M4b.**
  - Pages :
    - `/profile` : l'éditeur de son profil, h1 « Profil » (titre « Profil — », `e2e/shell.spec.ts:89-95`) ;
    - `/profile/[username]` : la vue publique, h1 = le pseudo, `metadata` statique « Profil » ;
    - `/dms` : les conversations, et `/dms?with=<id>` le fil.
  - Boutons :
    - « Message » sur `/friends` et sur le profil d'un ami ;
    - « Message à <pseudo> » sur `/trades/[id]` ;
    - « Proposer un échange » sur le profil d'un ami ;
    - « Ajouter en ami » sur le profil d'un non-ami ;
    - « Signaler » : une modale avec Triche, Contenu inapproprié et Spam, des détails de 500 caractères au plus, préremplie par `GET /api/reports`.
  - U8 : la visibilité se règle dans `/settings` et sur `/profile`, relue à chaque affichage, et l'aide de `settings-client.tsx:20` est corrigée. U9 : Entrée envoie, Maj+Entrée va à la ligne, la composition IME est ignorée.
  - Motifs imposés du M4a ; poll du fil à 5 s, qui s'arrête au masquage.
  - a11y : `/profile`, `/profile/<pseudo>` (soi, ami, privé), `/dms`, `/dms?with=…`, et le `READY` de `/settings` attend la section push.
  - Coût si faux : aucun contrat de référence pour ces écrans jamais capturés.
- **M4b-25. Contrat** : `coverage:recap` 54 → 66 ; une `RouteSpec` aussi pour chaque route ajoutée (`/api/push/subscribe`, `/api/settings/notifications`, `/api/cron/push`, `confidence: 'ajouté'`), même si le compteur ne les voit pas ; le §3.6 reste vert, et `PATCH rest/v1/chat_messages` a son test RLS (D:1018) — coût si faux : un outil tiers qui écrit `content`.
- **M4b-26. Bench** : relancer `load/bench/run.sh` avec 4 emplacements de vitrine posés des deux côtés et un abonnement push par joueur, types d'échange activés. Le trigger d'outbox tourne ainsi dans la transaction d'acceptation. p95 100 ↔ 100 < 500 ms (D:1083) — coût si faux : un M4 qui ne tient plus son critère du M4a.
- **M4b-27. Livraison** comme au M4a :
  - `deploy-m4b.sql` est produit par concaténation et répété sur une base de `develop`, en deux passes ;
  - relevé en lecture seule avant : pg_net préchargé, `net` absent, `CRON_SECRET` présent dans Vault, `max_worker_processes` ;
  - l'utilisateur pose `VAPID_PRIVATE` et `VAPID_SUBJECT` dans Vercel (Production), avec une paire générée hors du dépôt et jamais collée dans la conversation ;
  - contrôles MCP ; fusion `--no-ff` dans `develop` après la base (R32) ;
  - réception d'un vrai push sur un navigateur de l'utilisateur, facultative et consignée.
  Coût si faux : une étape humaine de plus.
- **M4b-28. Droits exacts des quatre tables** (tranché par ce plan).
  - `chat_messages` : `grant select, update (read) … to authenticated`. Politiques `chat_messages_select_participant` (`(select auth.uid()) in (sender_id, recipient_id)`) et `chat_messages_update_recipient` (`for update`, `using` et `with check` à `recipient_id = (select auth.uid())`).
  - `showcase`, `reports` et `push_subscriptions` : RLS activée, **aucun droit ni politique client** ; tout passe par les routes.
  - Pourquoi : la vitrine d'un profil privé dépend de l'amitié, que `wm.are_friends` ne peut pas exprimer en RLS (`EXECUTE` à `service_role` seul). Un signalement et un endpoint (URL-capacité) ne regardent que le serveur.
  - Coût si faux : une lecture directe à ouvrir plus tard, sous une politique.
- **M4b-29. Corps exact du 429** : `wm.raise_err(429, null, 'Le site demande de ralentir', jsonb_build_object('retry_after', n))`, donc un HTTP `{"error":"Le site demande de ralentir","message":"Le site demande de ralentir","retry_after":n}`, sans `code`, avec `Retry-After: n`. C'est la ligne « Limite de débit générale » du D§8.2 (D:685, D:347), et non `rate_limited`, réservé aux paquets — coût si faux : un client qui lit `code` n'y trouve rien, comme dans l'original.
- **M4b-30. `@types/web-push` 3.6.4**, publiée le 2024-10-22, et la seule version des `dist-tags` (`ts5.6` à `ts7.1`). Ses déclarations couvrent `generateRequestDetails` et `RequestDetails` — coût si faux : une `declare module` locale.
- **M4b-31. Le signalement prend ses deux profils `for key share order by id`** avant l'insertion. Cela précise M4b-2 : ce n'est pas un `lock_user`, et ce n'est jamais un `FOR UPDATE`.
  - Pourquoi : l'insertion d'un signalement vérifie deux clés étrangères vers `profiles`, dans l'ordre de leurs triggers et non dans l'ordre des id. Une acceptation d'échange entre les deux mêmes joueurs les prend `FOR UPDATE` dans l'ordre des id, d'où un cycle dans l'un des deux sens. La règle est celle du P28 ; les repérages n'y voyaient aucun cycle, faute de compter ces deux clés étrangères.
  - Prouvé par le scénario 3 de `18_social_concurrency.test.sh` (Task 5), qui doit voir un `40P01` sans cette ligne.
  - Coût si faux : un 503 `BUSY` rare sur un signalement.
- **M4b-32. La passerelle enregistre, la spec déchiffre.**
  - `POST /push/<id>` garde la requête (en-têtes et corps) et répond 201 ; `POST /push/gone/<id>` répond 410 ; `GET /push/<id>` rend les livraisons reçues.
  - Le déchiffrement (RFC 8291) et la vérification du JWT VAPID vivent dans `contract/push-crypto.ts`, avec un test unitaire aller-retour contre `webpush.encrypt`.
  - Pourquoi : la clé privée de l'abonnement est une donnée du test, et la passerelle n'en garde aucune.
  - Coût si faux : aucun.
- **M4b-33. Découpage ajusté.** `public/sw.js` et l'exemption de la porte vont à la Task 14, avec la section qui enregistre le SW. `health.yml` va à la Task 6, avec `push_lag_s`. La Task 10 reste ainsi la preuve serveur seule, et chaque tâche garde un livrable qu'un relecteur peut rejeter seul — coût si faux : aucun.

**Écarts au spec (la décision l'emporte) :**
- M4b-6 : un avatar en `nsfw_image` est refusé, alors que D:594 ne cite que `hide_image`.
- M4b-13 : `wm.notification_prefs` est une table neuve, à côté de `wm.user_prefs`, la table du M1.
- M4b-14 : `VAPID_PUBLIC` (D:1053) est facultatif et dérivé de la clé privée. `VAPID_SUBJECT` s'ajoute.
- M4b-20 : un plafond de 10 abonnements, contre C30.
- M4b-24 : « Message à <pseudo> » est sur le détail `/trades/[id]` (R:127 le place sur l'offre de la liste) : le bouton du contrat reste seul dans `div.card-frame.p-4`.
- M4b-5 : `lastSeenAt` est omis (R:246 le donne facultatif).
- D:302 dit que `9000` exige pg_net : pg_net naît dans `9020`, et `9000` ne se modifie pas (M4-1).

## Décisions ajoutées par ce plan (à consigner avec les précédentes)

Numérotées Bn, pour ne pas se confondre avec les P1 à P30 cités ici tels qu'ils sont dans DG.

- **B1. Fichiers SQL.**
  - `1800_wm_social_core.sql` : config, `user_state`, tables `wm`, index, trigger d'avatar, `trade_move`.
  - `1810_wm_profile.sql` : profil, vitrine, `profile_collection`.
  - `1820_wm_chat.sql`, `1830_wm_reports.sql`.
  - `1840_wm_push.sql` : préférences, abonnements, outbox, réveil, `health`.
  - `1850_wm_catalog_friends.sql` : `cards_overlay`.
  - `9020_wm_push_cron.sql`.
  - Tests : `supabase/tests/29_social.test.sql`, `supabase/tests/30_push.test.sql` et `supabase/tests/18_social_concurrency.test.sh`. Le M4b ne déborde pas sur `19xx` (`1900_wm_moderation.sql` au M6, D:209).
- **B2. Formes.**
  - Profil : `{id, username, avatar_url, bio, is_public, created_at}` en entier, ou sans `bio` réduit (M4b-5).
  - Copie d'un autre joueur (vitrine et collection d'un profil) : `{id, card, count, is_shiny, snapshot_rarity}`, où `card` est l'objet `card` de `wm.my_collection` (`1700_wm_trade_core.sql:58-60`). C'est la forme des éléments de `profile_collection` (`1300:180-181`).
  - Emplacement : `{position, user_card_id, user_card}`, triés par `position`. Un emplacement vide n'a pas d'entrée.
  - Message : `{id, sender_id, recipient_id, content, read, created_at}` (R:253).
  - Conversation : `{peer_id, peer_username, peer_avatar_url, last_message, last_message_at, unread_count}` (R:252).
- **B3. Plafonds** : `list_caps` gagne `{"conversations": 50, "messages": 100, "friend_owners": 3}`, par `update wm.config set value = '{…}'::jsonb || value where key = 'list_caps'` (les valeurs déjà posées gagnent ; idempotent).
- **B4. `notificationView` déménage dans `lib/notification-view.ts`** : un module pur, qui n'importe que `lib/format.ts`. `lib/notifications.ts` le réexporte. Raison : `lib/notifications.ts` importe `lib/poll.ts`, qui importe des crochets React, et le client navigateur. Le même module exporte `PUSH_FAMILIES` (M4b-13) et `pushTypes()`, la liste triée des 13 types.
- **B5. Modules serveur.**
  - `lib/vapid.ts` : `vapidConfig()`, sans web-push, lu aussi par la route des préférences ;
  - `lib/push.ts` : `pushPayload`, `drainPush` ;
  - `lib/cron.ts` : `cronDenied(req)`, la garde de `app/api/cron/revalidate/route.ts:5-16`, déplacée telle quelle et partagée par les deux routes du cron.
- **B6. `push: true`** sur les huit routes dont la RPC insère des notifications : `POST /api/friends`, `PATCH /api/friends/{friendshipId}`, `POST /api/friends/accept-all`, `POST /api/trades`, `PATCH /api/trades/{tradeId}`, `POST /api/marketplace/{auctionId}/bid`, `POST /api/marketplace/{auctionId}/settle` et `POST /api/chat/{peerId}`. Le règlement paresseux du `GET` d'une enchère tourne sous `'use cache: remote'` : il est laissé au réveil, avec un `shortcut:` près de `sharedAuction` (`lib/market-cache.ts:36-37`).
- **B7. `import webpush from 'web-push'`**, l'import par défaut : en ESM, Node ne voit que `WebPushError` et `supportedContentEncodings` en exports nommés de ce paquet CommonJS (mesuré). `esModuleInterop` est déjà vrai.
- **B8. Charge du push** : `JSON.stringify({title: brand.name, body: notificationView(n).text, url: notificationView(n).href ?? '/', tag})`, avec `tag` = `dm:<user_id>` pour un `chat_message`, sinon l'id de la notification. Options : `TTL` 86 400 et `vapidDetails` par appel, sans état global. Les en-têtes passés à `fetch` sont en chaînes, sans `Content-Length` (fetch le calcule).
- **B9. Origine d'un endpoint en SQL** : l'autorité est ce qui suit `://` jusqu'au premier `/`, `?` ou `#`. Elle est passée en minuscules et refusée si elle contient `@`. Une origine listée doit être égale à `scheme://autorité`. Un suffixe exige `https:` et une autorité sans port qui finit par le suffixe.
- **B10. Aides de test** (`supabase/tests/helpers.sql`, schéma `tests`, absent de la démo) :
  - `tests.image_card(p_title text) returns uuid` : une carte R, ATK et DEF à 10, `image_url` = `data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7`. Les cartes du seed n'ont pas d'image ; elle sert au SQL, au contrat (psql) et aux E2E (`imageCopy`) ;
  - `tests.trade_snapshot` gagne `showcase` (`[[user_id, position, user_card_id]]` des deux joueurs, trié) et `push_outbox` (lignes dont la notification porte `data ->> 'trade_id'` = l'échange).
- **B11. E2E** : `imageCopy(u: User): string` dans `e2e/fixtures.ts`, qui crée par `sql` une `tests.image_card` et une copie, puis renvoie l'id de la copie. `stubPush(page, opts)` est dans `e2e/push-stub.ts` (Task 14).
- **B12. Textes ajoutés** (absents du R§, au format P19) :
  - profil :
    - « Modifier mon profil », « Voir comme les autres », « Membre depuis {mois année} » ;
    - « Ce profil est réservé aux amis. », « Aucune carte en vitrine. », « Sa collection est vide. » ;
    - « Ajouter en ami », « Demande envoyée », « Accepter sa demande », « Proposer un échange », « Retour aux amis » ;
  - éditeur :
    - « Avatar », « Changer l'avatar », « Retirer l'avatar », « Choisir ton avatar », « Sans image », « Avatar changé. », « Avatar retiré. » ;
    - « À propos », « {n} / 280 », « Enregistrer », « Profil enregistré. », « Visibilité » ;
    - aide de « Profil public », la même sur `/profile` et dans `/settings` : « Décochée, seuls tes amis voient ta bio, ta vitrine et ta collection. » ;
    - « Vitrine ({n}/4) », « Choisir une carte pour la vitrine », « Ajouter une carte à l'emplacement {n} », « Changer », « Retirer », « Vitrine mise à jour. », « Carte retirée de la vitrine. » ;
  - signalement :
    - « Signaler », « Signaler {pseudo} », « Motif », « Triche », « Contenu inapproprié », « Spam », « Détails (facultatif) », « {n} / 500 » ;
    - « Un seul signalement par joueur : tu peux le modifier. » ;
    - « Envoyer le signalement », « Modifier le signalement », « Signalement envoyé. », « Signalement modifié. » ;
  - messages :
    - « Conversations », « ← Conversations », « Choisis une conversation. », « Aucune conversation. », « Écris à un ami depuis la page Amis. » ;
    - « {n} message non lu » / « {n} messages non lus », « Messages avec {pseudo} », « Toi : », « Aucun message pour l'instant. » ;
    - « Ton message », « {n} / 2 000 », « Envoyer », « Entrée pour envoyer, Maj+Entrée pour aller à la ligne. », « Retour aux messages » ;
    - issue incertaine : « Le message n'a pas été confirmé : il a peut-être été envoyé. La conversation se met à jour. » ;
  - push (`/settings`) :
    - « Notifications », « Ces choix valent pour tous tes appareils. » ;
    - « Activer sur cet appareil », « Désactiver sur cet appareil », « Notifications activées sur cet appareil. » ;
    - « Les notifications sont bloquées pour ce site : autorise-les dans les réglages de ton navigateur. », « Ton navigateur ne gère pas les notifications push. », « Les notifications push ne sont pas disponibles pour l'instant. », « L'activation a échoué, réessaie. » ;
    - familles « Messages », « Échanges », « Amis », « Marché » ;
  - cloche : « {u} t'a écrit ».
  Chargements : « Chargement du profil », « Chargement de la vitrine », « Chargement de la collection », « Chargement des conversations », « Chargement des messages », « Chargement des notifications push ».
- **B13. Sauté, dit ici** :
  - « Défier » (M5) et « Nouvelle conversation » ;
  - `lastSeenAt` ; les `galleries` et une 2ᵉ rangée de vitrine ;
  - « En vitrine » dans la modale de `/collection` ;
  - un push de test ; une pastille de non-lus sur « Messages » ;
  - `pushsubscriptionchange` ; la seconde cloche (R:138, M7) ;
  - l'onglet du profil dans l'adresse (même `shortcut:` que `/trades`) ; le titre de document au pseudo ;
  - les liens de pseudo vers le profil sur `/friends` (le focus de ses lignes est réglé sur leur premier contrôle) ;
  - `user_agent` dans `push_subscriptions` (« appareil » de R:470, sans lecteur) ;
  - le désabonnement avant la déconnexion : l'upsert par endpoint réattribue le navigateur (Review Focus).
- **B14. Mesure de l'overlay** (Task 16) : un joueur à 1 000 amis, dont chacun possède les 50 cartes d'une page. Le plan de la requête de `friendOwners` est lu par `auto_explain` (`log_nested_statements`, `client_min_messages = log`) : `user_cards_card_user_idx` par carte, jamais `Seq Scan on user_cards`. p95 de `wm.cards_overlay` sur 200 appels < 50 ms, un seuil indicatif (A5) choisi ici.

## Review Focus

- **Endpoint d'abonnement hostile ou voisin.** `https://fcm.googleapis.com@evil.example/x`, `https://fcm.googleapis.com.evil.example/x`, `http://fcm.googleapis.com/x`, `https://fcm.googleapis.com:8443/x`, `https://notify.windows.com/x` et `https://evilnotify.windows.com/x` → 400 « Service de notifications non pris en charge », et aucune ligne. `https://FCM.GOOGLEAPIS.COM/fcm/send/x` et `https://wns2-par02p.notify.windows.com/w/?token=x` passent. → `30_push.test.sql` (Task 6) ; route : Task 10.
- **Navigateur partagé.** A s'abonne avec l'endpoint E, se déconnecte, puis B s'abonne avec E : une seule ligne, à B. Une notification de A n'écrit plus rien pour E, une de B en écrit une. `DELETE` par A de E → `{ok: true}`, et la ligne de B reste. → Task 6.
- **Débit aux bornes de la fenêtre.** Le 31ᵉ message de la minute → 429, avec `retry_after` entre 1 et 60 et `Retry-After` égal. Une fenêtre échue repart à 1. Un message refusé (vide, non-ami, trop long) ne compte pas, ni un rejeu de la même clé. Le compte est par expéditeur, tous pairs confondus. → Task 4 ; HTTP : Task 9.
- **Contenu aux bornes.** Blancs seuls (`'  \n\t '`) → 400 « Le message est vide ». 2 000 émojis (2 000 points de code, 4 000 unités UTF-16) passent, 2 001 `é` sont refusés. `\0` → 400 « Caractère invalide » à la route. Espaces de tête et de fin gardés tels quels. Le compteur de l'UI suit `value.length`, donc il est plus strict que le serveur, jamais plus large. → Task 4, Task 9, Task 13.
- **Pseudo hérité aux caractères spéciaux** (C28 ne s'applique pas aux pseudos existants). `Élise Ü`, `a%b` et `x?y#z` s'ouvrent sur `/profile/<encodeURIComponent>`, depuis la pastille, le fil et un lien tapé. La route rend le bon profil, et `maskPath` le masque dans le journal. → Task 8 (contrat et `maskPath`), Task 11 (E2E).

## Fichiers

| Fichier | Rôle |
|---|---|
| `supabase/migrations/0006_mirror_social.sql` | Miroir : `report_reason`, `chat_messages`, `showcase`, `reports`, `push_subscriptions`, RLS, droits |
| `supabase/migrations/1800_wm_social_core.sql` | Config, `user_state`, `notification_prefs`, `push_outbox`, index, trigger d'avatar, `trade_move` |
| `supabase/migrations/1810_wm_profile.sql` | Profil, vitrine, `profile_collection` ouverte aux amis |
| `supabase/migrations/1820_wm_chat.sql` | Conversations, fil, envoi, synchronisation « lu » |
| `supabase/migrations/1830_wm_reports.sql` | Signalements |
| `supabase/migrations/1840_wm_push.sql` | Préférences, abonnements, trigger d'outbox, réservation, réveil, `health` |
| `supabase/migrations/1850_wm_catalog_friends.sql` | `cards_overlay` avec `friendOwners` |
| `supabase/migrations/9020_wm_push_cron.sql` | pg_net et le job `wm-push-wake`, seulement si possible |
| `supabase/tests/29_social.test.sql`, `30_push.test.sql`, `18_social_concurrency.test.sh`, `helpers.sql` | Tests SQL et concurrence |
| `app/api/{profile/[username],profile/[username]/showcase,showcase,reports,chat,chat/[peerId],push/subscribe,settings/notifications,cron/push}/route.ts` | Routes |
| `lib/{push,vapid,cron,notification-view}.ts`, `lib/route.ts` | Push côté serveur et option `push` |
| `contract/spec/{profile,reports,chat,push}.ts`, `contract/push-crypto.ts`, `contract/harness.ts` | Contrat, faux service de push |
| `app/(game)/profile/**`, `app/(game)/dms/*`, `components/{profile,dms}/*`, `app/(game)/settings/push-section.tsx`, `public/sw.js` | Pages |
| `e2e/{profile,dms,social-journey}.spec.ts`, `e2e/push-stub.ts` | E2E et a11y |
| `load/bench/{trade_setup.sql,overlay.sql,run.sh}` | Bench |

---

### Task 1: Miroir social `0006`, RLS et droits exacts

**Files:**
- Create: `supabase/migrations/0006_mirror_social.sql`
- Modify: `supabase/tests/02_mirror_rls.test.sql` (fixtures, compte, chaîne des droits, cas des quatre tables), `supabase/tests/02_mirror_rls_legacy_grants.test.sh:8-9` (`-f "$d/../migrations/0006_mirror_social.sql"` après `0005`)

**Interfaces:**
- Produces (`0006`, en-tête `-- MIRROR : messages privés, vitrine, signalements, abonnements push (R§3.7, R§4.1, R§4.2, D§6.2, M4b-10, M4b-28). Idempotente.`), sur le modèle de `0005_mirror_trades.sql:4-74` :

  | Objet | Contenu |
  |---|---|
  | `public.report_reason` | enum `('cheating', 'inappropriate_content', 'spam')`, sous garde comme `0005:4-11` |
  | `public.chat_messages` | `id uuid pk default gen_random_uuid()`, `sender_id uuid not null → profiles on delete cascade`, `recipient_id uuid not null → profiles on delete cascade`, `content text not null check (char_length(content) <= 2000)`, `read boolean not null default false`, `created_at timestamptz not null default now()` |
  | `public.showcase` | M4b-7 |
  | `public.reports` | `id uuid pk default gen_random_uuid()`, `reporter_id uuid not null → profiles on delete cascade`, `reported_user_id uuid not null → profiles on delete cascade`, `reason public.report_reason not null`, `details text check (char_length(details) <= 500)`, `created_at timestamptz not null default now()`, `unique (reporter_id, reported_user_id)` |
  | `public.push_subscriptions` | `id uuid pk default gen_random_uuid()`, `user_id uuid not null → profiles on delete cascade`, `endpoint text not null unique`, `p256dh text not null`, `auth text not null`, `created_at timestamptz not null default now()` |

  RLS activée sur les quatre tables. Table rase d'abord (`revoke all … from public, anon, authenticated`), puis `grant all … to service_role`, et M4b-28 pour `authenticated`. Politiques créées si absentes, par la boucle de `0005:63-74`, avec une colonne `cmd` en plus (`select` ou `update`).

- [ ] **Step 1: Tests qui échouent** (`02_mirror_rls.test.sql`)
  - Fixtures, à la suite de celles d'Alice, Bob et Carol :
    - un message Alice → Bob, `'Salut'`, non lu ;
    - un emplacement 0 d'Alice sur sa copie ;
    - un signalement Alice → Bob `'spam'` ;
    - un abonnement d'Alice (`https://fcm.googleapis.com/fcm/send/fixture`, `p256dh` `'k'`, `auth` `'a'`).
  - Tables de `public` : `'{16, 0}'` (16 tables, toutes sous RLS).
  - **Droits exacts** : la chaîne du M4a, avec `authenticated chat_messages SELECT, authenticated chat_messages.read UPDATE` insérés après `authenticated cards SELECT` (ordre `collate "C"`), et rien pour `showcase`, `reports` ni `push_subscriptions`.
  - Lecture :
    - Bob et Alice lisent le message (`count = 1`), Carol 0 (M4-14) ;
    - `anon` : `select` sur `chat_messages` → `insufficient_privilege`.
  - Écriture de `read` :
    - Alice (expéditrice) : `update public.chat_messages set read = true` → `row_count` 0. Puis, en superutilisateur, le message reste `read = false` ;
    - Bob : `update … set read = true where sender_id = <Alice>` → `row_count` 1 ;
    - Bob : `update … set content = 'x'` → `insufficient_privilege` ;
    - Bob : `insert` et `delete` sur `chat_messages` → `insufficient_privilege`.
  - Bob : `select`, `insert`, `update` et `delete` sur `showcase`, `reports` et `push_subscriptions` → `insufficient_privilege`, soit 12 instructions dans la boucle de `02_mirror_rls.test.sql:120-133`.
  - En superutilisateur :
    - `repeat('é', 2001)` en `content` → `check_violation`, `repeat('é', 2000)` passe ;
    - `repeat('x', 501)` en `details` → `check_violation` ;
    - un second signalement Alice → Bob → `unique_violation` ;
    - `reason 'abuse'` → `invalid_text_representation` ;
    - un emplacement en position 4 → `check_violation`, et un second emplacement (Alice, 0) → `unique_violation` ;
    - le même endpoint deux fois → `unique_violation` ;
    - la copie d'Alice supprimée → son emplacement disparaît (cascade).
  - `02_mirror_rls_legacy_grants.test.sh`, qui rejoue `0006`, obtient les mêmes droits exacts.
- [ ] **Step 2: `npm run test:db`** → `FAIL 02_mirror_rls.test.sql` (tables absentes).
- [ ] **Step 3: Implémenter `0006`.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(db): miroir social (chat_messages, showcase, reports, push_subscriptions), lecture du fil par ses deux participants et marquage lu par le destinataire seul, droits exacts`

---

### Task 2: Socle `1800` — config, outbox, préférences, index, avatar, `trade_move` qui vide la vitrine

**Files:**
- Create: `supabase/migrations/1800_wm_social_core.sql`, `supabase/tests/29_social.test.sql`
- Modify: `supabase/tests/helpers.sql:50-66` (B10)

**Interfaces:**
- Consumes : Task 1 ; `wm.trade_move` (`1730_wm_trade_action.sql:8-34`).
- Produces (`1800`, en-tête ADDITIVE et ligne pg-safeupdate de `1600:1-3`) :

  | Objet | Contenu |
  |---|---|
  | Clés `wm.config` (`on conflict do nothing`) | `chat_burst` `{"count": 30, "window_s": 60}` (« Messages privés par fenêtre, par expéditeur (D:595, C17, M4b-3) ») ; `push_origins` `{"origins": ["https://fcm.googleapis.com", "https://updates.push.services.mozilla.com", "https://web.push.apple.com"], "suffixes": [".notify.windows.com"]}` (« Services de push acceptés, contre le SSRF ; le banc y ajoute son origine (M4b-12) ») ; `push_max_subscriptions` `10` (« Abonnements par joueur ; écart à C30 (M4b-20) ») ; `push_types` = les 13 types triés `["auction_outbid","auction_sold","auction_unsold","auction_won","chat_message","friend_accepted","friend_request","trade_accepted","trade_cancelled","trade_countered","trade_declined","trade_received","wishlist_listed"]` (« Types qu'un joueur peut activer en push (M4b-13) ») ; `push_wake_url` `'null'::jsonb` (« URL de /api/cron/push pour pg_net, posée par deploy-m4b.sql (C30, M4b-17) ») ; `list_caps` étendue par B3 |
  | `wm.user_state` | `add column if not exists chat_window_start timestamptz`, `add column if not exists chat_window_count int not null default 0` |
  | `wm.notification_prefs` | M4b-13 |
  | `wm.push_outbox` | `id bigint generated always as identity primary key`, `subscription_id uuid not null`, `notification_id uuid not null`, `created_at timestamptz not null default now()`. Sans clé étrangère : aucun verrou pris, et une ligne orpheline est jetée à la réservation |
  | Index (option A : `CONCURRENTLY` par le runbook) | `chat_messages_pair_idx (sender_id, recipient_id, created_at desc)` ; `chat_messages_recipient_pair_idx (recipient_id, sender_id, created_at desc)` ; `chat_messages_unread_idx (recipient_id) where not read` ; `showcase_user_card_idx (user_card_id)` ; `push_subscriptions_user_idx (user_id)` ; `reports_reported_idx (reported_user_id)` (cascade d'une suppression de compte, M6) |
  | `wm.avatar_url_clear() returns trigger` + `create or replace trigger profiles_avatar_url_clear before update of avatar_user_card_id on public.profiles for each row when (old.avatar_user_card_id is not null and new.avatar_user_card_id is null) execute function wm.avatar_url_clear()` | `new.avatar_url := null` (M4b-6) |
  | `wm.trade_move(p_trade public.trades) returns void` | Même signature et même corps que `1730:8-34`, plus l'instruction (6) `delete from public.showcase where user_card_id = any (v_full)` (M4b-7). L'en-tête ne dit plus « P13 : pas de vitrine au M4a ». |

- [ ] **Step 1: Tests qui échouent** (`29_social.test.sql`)
  - En tête : `pg_temp.err`, `pg_temp.inv`, `pg_temp.player`, `pg_temp.card`, `pg_temp.copy` et `pg_temp.friends`, repris de `28_trades.test.sql` tels quels. Chaque bloc filtre sur ses propres joueurs.
  - Config :
    - le `jsonb_object_agg` de `chat_burst`, `push_origins`, `push_max_subscriptions`, `push_types` et `push_wake_url` = les valeurs exactes ;
    - `list_caps` = `{"conversations": 50, "friend_owners": 3, "friend_search": 20, "messages": 100, "notifications": 50, "trades_closed": 200}` ;
    - aucune note vide ;
    - `\ir ../migrations/1800_wm_social_core.sql` rejoué → mêmes valeurs (idempotence de B3).
  - Index : l'`indexdef` complet des six index, comparé comme `28_trades.test.sql:65-79`.
  - Avatar (M4b-6) :
    - A a l'avatar a1 (count 1) et `avatar_url` `'u1'`. `delete from public.user_cards where id = a1` → `avatar_user_card_id` et `avatar_url` nuls ;
    - avatar a2 et `'u2'`, puis `update public.profiles set avatar_user_card_id = null where id = A` → `avatar_url` nul ;
    - avatar a3 et `'u3'`, puis `update … set bio = 'x'` → `avatar_url` reste `'u3'` ;
    - profil migré : avatar nul et `avatar_url` `'legacy'`, puis `update public.profiles set avatar_user_card_id = null where id = A` → `avatar_url` reste `'legacy'`.
  - Vitrine, sorties autres que l'échange (D:436) :
    - `wm.discard(A, s1)` sur une copie seule en vitrine → l'emplacement disparaît ;
    - `wm.discard(A, s2)` sur une pile de 2 en vitrine → l'emplacement reste (même id, `count` 1) ;
    - `wm.create_auction(A, s3, 10, 60)` d'une copie seule en vitrine et en avatar (A vérifié) → l'emplacement disparaît, et l'avatar et `avatar_url` deviennent nuls.
  - `trade_move` (M4b-7), A et B amis, échange créé par `wm.create_trade` :
    - A montre a1 (seule) en position 0 et a2 (pile de 3, 2 unités échangées) en position 1, avec a1 en avatar ; B montre b1 en position 2 ;
    - B accepte → l'emplacement 0 de A a disparu, l'emplacement 1 reste sur a2, l'emplacement 2 de B a disparu ; l'avatar de A et son `avatar_url` sont nuls ;
    - `tests.trade_snapshot(t) ?& array['showcase', 'push_outbox']`, avec `push_outbox` = 0 (personne n'est abonné) ; `pg_temp.inv`.
  - `28_trades.test.sql` et `17_trades_concurrency.test.sh` restent inchangés et verts (l'égalité des instantanés tient avec les clés en plus).
- [ ] **Step 2: `npm run test:db`** → `FAIL 29_social.test.sql`.
- [ ] **Step 3: Implémenter `1800` et `helpers.sql`** ; fin `revoke`/`grant`.
- [ ] **Step 4: Contrôles complets** → vert, `contract/spec/trades.ts` inchangé.
- [ ] **Step 5: Commit** — `feat(db): socle social (config, outbox push, préférences push, index, avatar_url effacé avec sa copie, trade_move qui vide la vitrine)`

---

### Task 3: Profil et vitrine en SQL, collection d'un profil privé ouverte aux amis

**Files:**
- Create: `supabase/migrations/1810_wm_profile.sql`, `supabase/tests/18_social_concurrency.test.sh`
- Modify: `supabase/tests/29_social.test.sql`

**Interfaces:**
- Consumes : Task 2 ; `wm.are_friends` (`1710_wm_friends.sql:9-13`), `wm.my_collection` (`1700:37-71`).
- Produces :

  | Fonction | Réponse, règles |
  |---|---|
  | `wm.profile_json(p public.profiles, p_full boolean) returns jsonb` | `stable` ; B2 |
  | `wm.profile_get(p_uid uuid, p_username text) returns jsonb` | `stable`. Pseudo cherché par `lower(username)`, sinon 404. `{profile, isOwn, isFriend, friendship}` (M4b-5) : `profile` entier si `isOwn`, `isFriend` ou `is_public`, sinon réduit ; `friendship` = la ligne de la paire en `{id, status, requester_id}`, `null` pour soi ou sans ligne |
  | `wm.profile_update(p_uid uuid, p_username text, p_bio text default null, p_is_public boolean default null, p_avatar_user_card_id uuid default null, p_avatar_set boolean default false, p_idem text default null) returns jsonb` | La réponse de `profile_get(p_uid, p_username)`, par `idem_store`. Ordre : `idem_claim`, `actor`, profil cible (404), cible ≠ `p_uid` → 403 `FORBIDDEN` « Tu ne peux modifier que ton profil », `char_length(p_bio) > 280` → 400, `lock_timeout`, `lock_user(p_uid)`. Puis, si `p_avatar_set` et un id non nul, la copie `where id = … and user_id = p_uid` jointe à sa carte : absente → 403 `42501` ; `image_url` nul ou `hide_image` → 400 « Cette carte n'a pas d'image utilisable en avatar » ; `nsfw_image` → 400 « Une image sensible ne peut pas servir d'avatar ». Enfin un seul `update public.profiles` : `bio` = `nullif(p_bio, '')` si `p_bio` est donnée, `is_public` par `coalesce`, et, si `p_avatar_set`, l'id avec `avatar_url` = l'image validée, ou `null` pour un retrait (explicite : le trigger ne voit pas un profil migré sans copie) |
  | `wm.profile_collection(...)` | Même signature et même corps que `1300:164-186`, sauf la garde : `not p.is_public and p.id is distinct from p_uid and not wm.are_friends(p_uid, p.id)` → 403 (P21 c). Le `shortcut:` de `1300:175` disparaît. |
  | `wm.showcase_json(p_owner uuid) returns jsonb` | `stable` ; `{showcase: [...]}` (B2) |
  | `wm.my_showcase(p_uid uuid) returns jsonb` | `stable` ; `showcase_json(p_uid) || '{"galleries": []}'` |
  | `wm.profile_showcase(p_uid uuid, p_username text) returns jsonb` | `stable` ; 404 ; profil privé, ni soi ni ami → 403 `FORBIDDEN` « Ce profil est privé » ; sinon `showcase_json` du joueur |
  | `wm.showcase_put(p_uid uuid, p_position int, p_user_card_id uuid, p_idem text default null) returns jsonb` | `my_showcase(p_uid)`. Ordre : `idem_claim`, `actor`, position hors de 0..3 → 400, `lock_timeout`, `lock_user(p_uid)`, copie `where id = p_user_card_id and user_id = p_uid` (403 `42501`), la même copie à une autre position → 400 « Cette carte est déjà dans ta vitrine », `insert … on conflict (user_id, position) do update set user_card_id = excluded.user_card_id`, `idem_store` |
  | `wm.showcase_delete(p_uid uuid, p_position int, p_idem text default null) returns jsonb` | `my_showcase(p_uid)`. Ordre : `idem_claim`, `actor`, position (400), `lock_timeout`, `lock_user(p_uid)`, `delete … where user_id = p_uid and position = p_position` (un emplacement vide n'est pas une erreur), `idem_store` |

- [ ] **Step 1: Tests qui échouent** (`29_social.test.sql`)
  - `profile_get` :
    - soi → clés de `profile` exactement `{avatar_url, bio, created_at, id, is_public, username}`, `isOwn` vrai, `isFriend` faux, `friendship` nul ;
    - un inconnu public → `profile` entier, avec la bio ;
    - un inconnu privé → clés exactement `{avatar_url, created_at, id, is_public, username}`, `is_public` faux ;
    - un ami privé → entier, `isFriend` vrai ;
    - après une demande `pending` du lecteur → `friendship` = `{"id": <f>, "status": "pending", "requester_id": <lecteur>}` ;
    - le pseudo en majuscules → le même profil ; un pseudo inconnu → `{"status":404,"error":"Joueur introuvable","message":"Joueur introuvable"}`.
  - `profile_update` (A) :
    - bio de 280 `é` → passe, de 281 → 400 exact ; `''` → `bio` nulle ; `p_is_public false` → `is_public` faux ;
    - avatar sur une copie de `tests.image_card('Avatar A')` → `avatar_url` = son `image_url` ;
    - une copie de B → 403 `42501` exact ;
    - une copie de carte sans image, puis de carte `hide_image` → 400 « Cette carte n'a pas d'image utilisable en avatar » ; de carte `nsfw_image` (image posée) → 400 « Une image sensible ne peut pas servir d'avatar » ;
    - `p_avatar_set true` et un id nul → avatar et `avatar_url` nuls ;
    - profil migré, avatar nul et `avatar_url` `'legacy'` : `profile_update(A, <A>, p_bio => 'x')` garde `'legacy'` (clause `when` du trigger, M4b-6) ;
    - le pseudo de B → 403 `FORBIDDEN` exact ;
    - la réponse = `profile_get(A, <A>)` ; le même `p_idem` deux fois → même réponse ; `maintenance` à `true` → 503 `maintenance`.
  - `profile_collection` (P21 c), A privé : B ami → `{collection, total}` ; Carol → 403 « Ce profil est privé » (`23_collection.test.sql:211` reste vrai).
  - Vitrine :
    - `showcase_put(A, 0, a1)` → exactement `{"showcase":[{"position":0,"user_card_id":a1,"user_card":{…}}],"galleries":[]}` ;
    - les clés de `user_card` = `{card, count, id, is_shiny, snapshot_rarity}`, et celles de `card` = celles du `card` de `wm.my_collection` ;
    - −1 et 4 → 400 « Emplacement de vitrine inconnu (0 à 3) » ;
    - une copie de B → 403 `42501` ;
    - a1 en position 1 → 400 « Cette carte est déjà dans ta vitrine » ; a1 de nouveau en position 0 → passe, sans changement ; a2 en position 0 → remplace a1 ;
    - quatre emplacements → triés 0 à 3 ;
    - `showcase_delete(A, 2)` → l'emplacement 2 retiré ; le même appel de nouveau → même forme, sans erreur ; position 9 → 400 ;
    - même `p_idem` deux fois sur `put`, puis sur `delete` → mêmes réponses.
  - `profile_showcase` : Carol sur A privé → 403 « Ce profil est privé » ; B ami → les emplacements ; pseudo inconnu → 404.
  - Volatilité : `profile_get`, `showcase_json`, `my_showcase` et `profile_showcase` ont `provolatile = 's'`.
  - `lock_timeout` (P5) : le bloc de `28_trades.test.sql:81-96`, recopié dans `29_social.test.sql`, avec les marqueurs `for update`, `for key share`, `wm.lock_users(` et `wm.lock_user(`, sur `profile_update`, `showcase_put` et `showcase_delete` ; chaque tâche suivante y ajoute ses fonctions.
- [ ] **Step 2: Test de concurrence** (`18_social_concurrency.test.sh`)
  - Aides `q`, `bg`, `waitall`, `refusals`, `quiet` et `fail` recopiées de `17_trades_concurrency.test.sh`, `tag="soc_$RANDOM$RANDOM"`, un `cleanup` en `trap`, et en tête la liste des scénarios.
  - **1. Vitrine contre acceptation**, 10 fois : A et B amis, un échange T qui donne a1 (seule) de A à B. Derrière un bloqueur qui tient A et B pendant 1 s, lancés ensemble : `wm.trade_action(B, T, 'accept')` et `wm.showcase_put(A, 0, a1)`. Attendu :
    - aucun `40P01` ni `55P03` ;
    - chaque `showcase_put` réussit ou échoue en « Vous ne possédez pas cette carte » ;
    - `select count(*) from public.showcase s join public.user_cards uc on uc.id = s.user_card_id where uc.user_id <> s.user_id` = 0.
  - Mutation éprouvée rouge : `lock_user` retiré de `showcase_put` → le dernier compte devient non nul en au moins un tour sur 10. Sinon la consigner « non reproduite » dans le rapport de tâche.
- [ ] **Step 3: `npm run test:db`** → `FAIL 29_social.test.sql`.
- [ ] **Step 4: Implémenter `1810`.**
- [ ] **Step 5: Contrôles complets** → vert.
- [ ] **Step 6: Commit** — `feat(db): profil (lecture réduite d'un profil privé, bio, visibilité, avatar d'une copie à image), vitrine de 4 emplacements, collection d'un profil privé ouverte à ses amis`

---

### Task 4: Messages privés en SQL — liste, fil, envoi, débit, notification, synchronisation « lu »

**Files:**
- Create: `supabase/migrations/1820_wm_chat.sql`
- Modify: `supabase/tests/29_social.test.sql`, `supabase/tests/18_social_concurrency.test.sh`

**Interfaces:**
- Consumes : Tasks 1 à 3 ; `wm.lock_users` (`1600:58-64`) ; `wm.notifications_read` (`1740:37-51`).
- Produces :

  | Objet | Réponse, règles |
  |---|---|
  | `wm.chat_conversations(p_uid uuid) returns jsonb` | `stable` ; `{conversations: [...]}` (B2) : une entrée par pair avec qui `p_uid` a échangé, `last_message_at desc, peer_id`, au plus `list_caps.conversations` ; `unread_count` = messages du pair vers `p_uid` non lus. `shortcut:` lit tous les messages du joueur, une table de conversations au M8 si besoin |
  | `wm.chat_thread(p_uid uuid, p_peer_id uuid) returns jsonb` | `stable` ; soi-même → 400 « Tu ne peux pas t'écrire à toi-même » ; pair inconnu → 404 ; `{messages: [...], peer: {id, username, avatar_url}, isFriend}`, les `list_caps.messages` plus récents du couple, en ordre `created_at, id` croissant |
  | `wm.chat_send(p_uid uuid, p_peer_id uuid, p_content text, p_idem text default null) returns jsonb` | `{message}`, dans l'ordre M4b-2. Contenu : `btrim(p_content, E' \t\r\n')` vide → 400 « Le message est vide » ; `char_length(p_content) > 2000` → 400 ; stocké tel quel. Garde : `chat_window_start > now() - window` et `chat_window_count >= count` → 429 (M4b-29), `retry_after = greatest(1, ceil(extract(epoch from chat_window_start + window - now())))::int`. Après l'insertion : notification `chat_message` pour le pair, `{user_id: p_uid, username}`, en une instruction `insert … select … where not exists (une chat_message non lue de p_uid pour p_peer_id)` (M4b-4) ; puis le compteur, comme `market_tick` (`1600:95-119`), sans retirer de vérification humaine ; `idem_store` |
  | `wm.chat_read_sync() returns trigger` + `create or replace trigger chat_messages_read_sync after update on public.chat_messages referencing old table as o new table as n for each statement execute function wm.chat_read_sync()` | Pour chaque couple (destinataire, expéditeur) d'une ligne passée de non lue à lue (`o.read is distinct from n.read and n.read`), `update public.notifications set read = true where type = 'chat_message' and not read and user_id = <destinataire> and data ->> 'user_id' = <expéditeur>::text` |

- [ ] **Step 1: Tests qui échouent** (`29_social.test.sql`)
  - Envoi, A et B amis :
    - `chat_send(A, B, 'Salut')` → `{message}`, dont les clés sont exactement les six du B2, avec `read` faux ;
    - une `chat_message` pour B, dont `data` = exactement `{"user_id": A, "username": <A>}` ;
    - un second envoi → toujours une seule non lue ; B la lit (`wm.notifications_read(B)`), puis un troisième envoi → deux lignes, dont une non lue.
  - Refus exacts :
    - Carol, qui n'est pas amie → `{"status":403,"code":"FORBIDDEN","error":"Vous devez être amis pour vous écrire","message":"Vous devez être amis pour vous écrire"}` ;
    - A vers A → 400 ; un id inconnu → 404 « Joueur introuvable » ;
    - `maintenance` à `true` → 503.
  - ***Review Focus*, contenu** :
    - `E'  \n\t '` → 400 « Le message est vide » ;
    - `repeat('😀', 2000)` → passe ; `repeat('é', 2001)` → 400 « Un message fait au plus 2 000 caractères » ;
    - `'  hé  '` est stocké tel quel.
  - ***Review Focus*, débit** (`chat_burst` posé à `{"count": 3, "window_s": 60}` dans le bloc) :
    - A envoie à B, B, puis C (ami), donc 3 envois → passent ;
    - le 4ᵉ → `{"status":429,"error":"Le site demande de ralentir","message":"Le site demande de ralentir","retry_after":60}` (`now()` figé dans la transaction), et aucune ligne de plus ;
    - un envoi vide ou vers Carol entre-temps ne change pas `chat_window_count` ;
    - la clé du 3ᵉ envoi rejouée → la réponse stockée, sans 429 ni incrément ;
    - `chat_window_start` reculé de 61 s → l'envoi passe, et `chat_window_count` = 1.
  - Fil :
    - 105 messages entre A et B, aux `created_at` distincts → `chat_thread(B, A)` rend exactement les 100 plus récents, en ordre croissant ;
    - `peer` = `{id: A, username: <A>, avatar_url: null}`, `isFriend` vrai ;
    - amitié supprimée → les mêmes messages, `isFriend` faux ;
    - `chat_thread(Carol, A)` → `messages` vide ; A vers A → 400 ; pair inconnu → 404.
  - Conversations :
    - A a écrit à B (dernier `'b3'`) et reçu de C (dernier `'c1'`, non lu) → deux entrées, la plus récente d'abord ;
    - leurs clés sont exactement les six du B2, et `unread_count` vaut 1 pour C et 0 pour B ;
    - D, sans message, absent ; 51 pairs → 50 entrées.
  - Synchronisation :
    - en `tests.login(B)` : `update public.chat_messages set read = true where sender_id = A and recipient_id = B and not read` ;
    - en superutilisateur : la `chat_message` de A pour B est lue, celle de C pour B reste non lue ;
    - le même `update` rejoué ne lève rien.
  - Volatilité : `chat_conversations` et `chat_thread` ont `provolatile = 's'`.
  - `lock_timeout` (P5) : ajouter `chat_send`, et vérifier que `wm.lock_users(` précède `insert into public.chat_messages` dans `prosrc`.
- [ ] **Step 2: Test de concurrence** (`18_social_concurrency.test.sh`, scénario 2)
  - **Messages croisés** : `chat_burst` relevé à `{"count": 1000, "window_s": 60}` puis restauré. A et B amis ; derrière un bloqueur qui tient A et B pendant 1 s, 30 `chat_send(A, B, …)` et 30 `chat_send(B, A, …)` lancés ensemble.
  - Attendu :
    - aucun `40P01` ni `55P03`, aucune erreur ;
    - 60 messages ;
    - exactement une `chat_message` non lue pour A (de B) et une pour B (de A).
  - Mutation éprouvée rouge : `lock_users(array[…])` remplacé par `lock_user(p_uid)` → un `40P01`.
- [ ] **Step 3: `npm run test:db`** → `FAIL 29_social.test.sql`.
- [ ] **Step 4: Implémenter `1820`.**
- [ ] **Step 5: Contrôles complets** → vert.
- [ ] **Step 6: Commit** — `feat(db): messages privés entre amis (liste, fil de 100, envoi sous les deux profils, 30 par minute, notification chat_message dédoublonnée, synchronisée par le marquage lu)`

---

### Task 5: Signalements en SQL

**Files:**
- Create: `supabase/migrations/1830_wm_reports.sql`
- Modify: `supabase/tests/29_social.test.sql`, `supabase/tests/18_social_concurrency.test.sh`

**Interfaces:**
- Consumes : Task 1.
- Produces :

  | Fonction | Réponse, règles |
  |---|---|
  | `wm.report_get(p_uid uuid, p_reported_user_id uuid) returns jsonb` | `stable` ; `{report: {reason, details} \| null}` (R:258), toujours pour `reporter_id = p_uid`. Une cible inconnue rend `null`, sans 404. |
  | `wm.report_upsert(p_uid uuid, p_reported_user_id uuid, p_reason text, p_details text default null, p_idem text default null) returns jsonb` | `{report: {reason, details}}`. Ordre : `idem_claim`, `actor`, soi-même → 400 « Tu ne peux pas te signaler toi-même », `p_reason` hors de `enum_range(null::public.report_reason)` → 400 « Motif de signalement inconnu », `char_length(p_details) > 500` → 400, cible inconnue → 404, `lock_timeout`, `perform from public.profiles where id in (p_uid, p_reported_user_id) order by id for key share` (M4b-31), `insert … on conflict (reporter_id, reported_user_id) do update set reason = excluded.reason, details = excluded.details`, `details` = `nullif(p_details, '')`, `idem_store`. Aucune notification, aucune amitié exigée. |

- [ ] **Step 1: Tests qui échouent** (`29_social.test.sql`)
  - Lecture et écriture :
    - `report_get(A, B)` → `{"report": null}` ;
    - `report_upsert(A, B, 'spam', 'pub')` → `{"report":{"reason":"spam","details":"pub"}}`, puis `report_get` → la même forme ;
    - `report_upsert(A, B, 'cheating', '')` → `{"report":{"reason":"cheating","details":null}}`, et une seule ligne A → B.
  - Refus exacts :
    - A vers A → 400 ;
    - `'abuse'` → 400 « Motif de signalement inconnu » ;
    - 501 caractères → 400 « Les détails font au plus 500 caractères » ;
    - un id inconnu → 404 « Joueur introuvable » ;
    - `maintenance` à `true` → 503.
  - `report_get(Carol, B)` → `null` : Carol ne voit pas le signalement de A. Le même `p_idem` deux fois → même réponse.
  - Aucune notification n'est créée.
  - `lock_timeout` (P5) : ajouter `report_upsert`.
- [ ] **Step 2: Test de concurrence** (`18_social_concurrency.test.sh`, scénario 3, M4b-31)
  - Préparation : R = le plus grand des deux id, L = le plus petit.
  - Deux passes, une par sens : R signale L, puis L signale R. Dans chacune, un bloqueur prend L `for update`, attend 1 s, puis prend R `for update`, dans l'ordre de `lock_users`, et le signalement part pendant son sommeil.
  - Attendu dans les deux passes : aucun `40P01`, et le signalement passe après le bloqueur, entre 0,5 et 2 s.
  - Mutation éprouvée rouge : la ligne `for key share` retirée → `40P01` dans l'une des deux passes, au bloqueur ou au signalement. Les deux sens couvrent l'un et l'autre ordre des triggers de clé étrangère.
- [ ] **Step 3: `npm run test:db`** → `FAIL 29_social.test.sql`.
- [ ] **Step 4: Implémenter `1830`.**
- [ ] **Step 5: Contrôles complets** → vert.
- [ ] **Step 6: Commit** — `feat(db): signalements (un par couple, modifiable, motifs de l'enum, détails de 500 caractères, clés étrangères prises dans l'ordre des profils)`

---

### Task 6: Push en SQL — préférences, abonnements, outbox, réservation, réveil, santé

**Files:**
- Create: `supabase/migrations/1840_wm_push.sql`, `supabase/migrations/9020_wm_push_cron.sql`, `supabase/tests/30_push.test.sql`
- Modify: `supabase/tests/10_wm_core.test.sql:126-130` (`- 'push_lag_s'` et `h -> 'push_lag_s' = 'null'::jsonb`), `supabase/tests/18_social_concurrency.test.sh` (scénario 4), `.github/workflows/health.yml:3-4` et `:24`

**Interfaces:**
- Consumes : Tasks 1 et 2 ; `wm.health` (`1650_wm_market_alerts.sql:80-104`).
- Produces :

  | Objet | Réponse, règles |
  |---|---|
  | `wm.notification_prefs_get(p_uid uuid) returns jsonb` | `stable` ; `{push_types: [...]}`, `[]` sans ligne |
  | `wm.notification_prefs_set(p_uid uuid, p_push_types text[], p_idem text default null) returns jsonb` | `idem_claim`, `actor`, un type hors de `wm.config.push_types` → 400 « Type de notification inconnu », upsert trié et dédoublonné, `idem_store(notification_prefs_get)` |
  | `wm.push_subscribe(p_uid uuid, p_endpoint text, p_p256dh text, p_auth text, p_idem text default null) returns jsonb` | `{ok: true}`. `idem_claim`, `actor`, l'origine selon B9 contre `push_origins` (400 « Service de notifications non pris en charge »), `insert … on conflict (endpoint) do update set user_id, p256dh, auth, created_at = now()`, puis suppression des abonnements de `p_uid` au-delà des `push_max_subscriptions` plus récents (`created_at desc, id desc`) |
  | `wm.push_unsubscribe(p_uid uuid, p_endpoint text, p_idem text default null) returns jsonb` | `{ok: true}` ; `idem_claim`, `actor`, `delete … where user_id = p_uid and endpoint = p_endpoint` |
  | `wm.push_enqueue() returns trigger` + `create or replace trigger notifications_push_enqueue after insert on public.notifications referencing new table as new_n for each statement execute function wm.push_enqueue()` | Une ligne d'outbox par couple (notification, abonnement), pour `new_n` jointe à `push_subscriptions` et à `notification_prefs` sur `type = any (push_types)`, avec la garde `created_at > now() - interval '10 minutes'` (reprise des notifications migrées : jamais de push) |
  | `wm.push_claim(p_limit int default 500) returns jsonb` | `[{subscription_id, endpoint, p256dh, auth, notification_id, type, data}]` : `delete from wm.push_outbox where id in (select id … order by id limit greatest(coalesce(p_limit, 0), 0) for update skip locked) returning …`, joint à l'abonnement et à la notification (les orphelines sont jetées) ; ni `actor` ni `maintenance` (M4b-22) |
  | `wm.push_gone(p_subscription_ids uuid[]) returns int` | `delete from public.push_subscriptions where id = any (p_subscription_ids)` ; le nombre |
  | `wm.push_wake() returns bigint` | `delete from wm.push_outbox where created_at < now() - interval '1 hour'` ; `push_wake_url` nulle ou outbox vide → `null`, sans appel ; secret de `vault.decrypted_secrets where name = 'CRON_SECRET'` absent → `raise warning` et `null` ; sinon `net.http_post(url := …, body := '{}'::jsonb, headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', <secret>), timeout_milliseconds := 10000)`. `net.*` et `vault.*` sont liés tardivement (PL/pgSQL). |
  | `wm.health()` | Même signature, mêmes clés que `1650:80-104`, plus `push_lag_s` = âge en secondes de la plus vieille ligne de l'outbox (`order by id limit 1`), `null` si elle est vide (M4b-18) |
  | `9020_wm_push_cron.sql` | En tête : ADDITIVE, exception aux migrations `wm` comme `9010:1-4`. Un bloc `do` : si `pg_cron` est dans `pg_extension` et que `shared_preload_libraries` contient `pg_net` (regex de `9000:8`), `create extension if not exists pg_net`, puis `perform cron.schedule('wm-push-wake', '15 seconds', 'select wm.push_wake()')` ; `exception when others then raise warning '9020_wm_push_cron : …'` |
  | `health.yml` | `jq -e '.settle_lag_s != null and .settle_lag_s <= 60 and .overdue_s == null and (.push_lag_s // 0) <= 120' health.json` ; l'en-tête cite le retard du push |

- [ ] **Step 1: Tests qui échouent** (`30_push.test.sql` ; en tête, les aides `pg_temp` de `29_social.test.sql`)
  - Préférences :
    - `notification_prefs_get(A)` → `{"push_types": []}` ;
    - `set(A, array['trade_received', 'chat_message', 'chat_message'])` → `{"push_types": ["chat_message", "trade_received"]}` ;
    - `array['nope']` → 400 « Type de notification inconnu » ; même `p_idem` deux fois → même réponse.
  - ***Review Focus*, endpoints** : les six refus et les deux succès de la section, chacun au corps exact. Après les refus, aucune ligne de A.
  - Abonnement :
    - deux appels de A avec E1 → une seule ligne ;
    - 10 abonnements de A posés à la main, aux `created_at = now() - make_interval(mins => n)` pour n de 1 à 10, puis un 11ᵉ par `push_subscribe` → 10 lignes, et celle de n = 10 a disparu ;
    - `push_unsubscribe(A, <inconnu>)` → `{"ok": true}`.
  - ***Review Focus*, navigateur partagé** :
    - A s'abonne avec E, puis B avec E → une ligne, `user_id` = B ;
    - A et B ont `trade_received` ;
    - une notification pour A → 0 ligne d'outbox, une pour B → 1 ;
    - `push_unsubscribe(A, E)` → `{"ok": true}`, et la ligne de B reste.
  - Trigger :
    - A abonné deux fois, `trade_received` activé ; C abonné sans ce type ; D non abonné. Une seule instruction insère 3 notifications `trade_received` (A, C, D) → exactement 2 lignes d'outbox, pour A ;
    - une notification de A au `created_at` vieux de 11 minutes → 0 ligne.
  - Atomicité : dans un bloc `begin … exception`, une notification pour A suivie de `raise exception` → l'outbox ne change pas.
  - Réservation :
    - 7 lignes d'outbox, dont une sur un abonnement supprimé ensuite ;
    - `push_claim(3)` → 3 éléments, aux clés exactement les sept de l'interface, `endpoint` et `data` corrects ;
    - `push_claim()` → les 3 autres ; la ligne orpheline est consommée sans être rendue ; un troisième appel → `[]` ;
    - avec `maintenance` à `true`, `push_claim` passe.
  - `push_gone(array[s1, s2])` → 2, et les lignes ont disparu.
  - Santé :
    - outbox vide → `push_lag_s` nul ;
    - une ligne au `created_at = now() - interval '30 seconds'` → `push_lag_s` = 30 (`now()` figé dans la transaction).
  - Réveil, sans pg_net (faux schémas, modèle `27_market.test.sql:1160-1185`) :
    - `to_regnamespace('net')` est nul, et `\ir ../migrations/9020_wm_push_cron.sql` ne crée ni `net` ni job ;
    - puis `create schema net`, `create table net.calls (url text, body jsonb, headers jsonb, timeout_milliseconds int)`, `create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 2000) returns bigint` qui insère dans `net.calls` et rend 1 ;
    - `create schema vault`, `create view vault.decrypted_secrets as select 'CRON_SECRET'::text name, 'test-cron'::text decrypted_secret` ;
    - `push_wake_url` nulle → `null`, aucun appel ;
    - `push_wake_url` à `"https://exemple.invalid/api/cron/push"`, outbox vide → `null`, aucun appel ;
    - une ligne → `1`, et exactement un appel, à cette URL, avec `headers ->> 'x-cron-secret' = 'test-cron'` et `timeout_milliseconds = 10000` ;
    - une ligne vieille de 2 h → supprimée par l'appel, qui rend `null` s'il n'en reste pas ;
    - vue `vault` sans la ligne → `null`, aucun appel.
  - `10_wm_core.test.sql:126-130` élargi : `push_lag_s` présent et nul.
  - Volatilité : `notification_prefs_get` a `provolatile = 's'`.
- [ ] **Step 2: Test de concurrence** (`18_social_concurrency.test.sh`, scénario 4, `skip locked`)
  - 1 000 lignes d'outbox ;
  - la session 1 lance en arrière-plan `begin; select wm.push_claim(500)::text; select pg_sleep(1); commit;`, et le test attend son `PgSleep` ;
  - la session 2 lance `select wm.push_claim(500)`.
  Attendu : la session 2 rend 500 éléments en moins de 0,5 s ; les deux ensembles sont disjoints, et leur union fait 1 000 `notification_id`.
- [ ] **Step 3: `npm run test:db`** → `FAIL 30_push.test.sql` et `FAIL 10_wm_core.test.sql`.
- [ ] **Step 4: Implémenter `1840` et `9020`**, et modifier `health.yml`. Relire `9020` : aucune fonction `wm`, et `node scripts/check-dml.ts` ne signale rien.
- [ ] **Step 5: Contrôles complets** → vert ; `contract/spec/health.ts` reste vert (`loose`).
- [ ] **Step 6: Commit** — `feat(db): push (préférences opt-in par type, abonnements à liste blanche, outbox remplie dans la transaction de la notification, réservation skip locked, réveil pg_net conditionnel, push_lag_s dans la santé)`

---

### Task 7: `friendOwners` dans l'overlay, pastille « ami possède » en lien

**Files:**
- Create: `supabase/migrations/1850_wm_catalog_friends.sql`
- Modify: `supabase/tests/29_social.test.sql`, `components/card/Card.tsx:139-146`, `components/card/Card.test.tsx:104-110`, `app/(game)/global-collection/global-client.tsx:237` (et son type de page), `contract/spec/catalog.ts`, `e2e/global-collection.spec.ts`

**Interfaces:**
- Consumes : `wm.cards_overlay` (`1520_wm_catalog_pages.sql:76-85`), `wm.are_friends`, `friendships_requester_idx`, `friendships_addressee_idx` et `user_cards_card_user_idx`.
- Produces :
  - `wm.cards_overlay(p_uid uuid, p_card_ids uuid[]) returns jsonb` : même signature et mêmes clés. `friendOwners` = `{<card_id>: [{id, username}]}` : pour chaque carte possédée par au moins un ami accepté, au plus `list_caps.friend_owners` amis, par `lower(username), id`. Profil privé compris, soi exclu ; une carte sans ami possesseur n'a pas de clé. Le `shortcut:` de `1520:83` disparaît.
  - `Card` : la prop `friendOwner?: string` est inchangée. Le `span.rounded-full.bg-sky-300/65` du contrat (R:126) est enveloppé dans un `Link` (`next/link`) vers `` `/profile/${encodeURIComponent(friendOwner)}` ``. Le lien porte la classe `relative z-10`, pour se peindre au-dessus du bouton `absolute inset-0` du `h3` (`Card.tsx:135`), et son `onClick` fait `e.stopPropagation()`, pour ne pas ouvrir la modale de la racine (`Card.tsx:64`). Son nom accessible est « Profil de {pseudo} ». Le `shortcut:` de `Card.tsx:140` disparaît.
  - `global-client.tsx` : `friendOwners: Record<string, { id: string; username: string }[]>` lu dans la page, et `friendOwner={page.friendOwners[c.id]?.[0]?.username}`.

- [ ] **Step 1: Tests qui échouent**
  - `29_social.test.sql` :
    - A est ami de B, C, D et E. X est possédée par B et C ; Y par B, C, D et E ; Z par F, qui n'est pas ami ; W par A seul ;
    - `wm.cards_overlay(A, array[X, Y, Z, W]) -> 'friendOwners'` = exactement `{X: [B, C], Y: [les trois premiers de B, C, D, E par lower(username), id]}`, chaque entrée `{id, username}` ;
    - E au profil privé reste compté ;
    - `wm.cards_overlay(F, array[Z])` → `{"ownedCardIds":[Z],"wishlistCardIds":[],"friendOwners":{}}` ;
    - `24_catalog.test.sql:193` reste vert.
  - `Card.test.tsx` : `friendOwner="Élise Ü"` → un `<a href="/profile/%C3%89lise%20%C3%9C"` qui contient le `span` de classe `rounded-full bg-sky-300/65` et le texte « Élise Ü ».
  - `contract/spec/catalog.ts`, nouveau cas : un joueur et son ami (`befriend` de `friends.ts`). La page 0 de `/api/cards` est lue d'abord, puis l'ami reçoit sa première carte par psql (une ligne `user_cards`). Une nouvelle lecture → `friendOwners[<id>]` = `[{id, username}]` de l'ami, et les autres clés de la page sont inchangées.
  - `e2e/global-collection.spec.ts` : un ami possède la première carte de la page → sa pastille est un lien au `href` exact. Un clic dessus change l'URL en `/profile/<pseudo encodé>`, sans ouvrir la modale de carte (aucun `role="dialog"`). Le h1 de cette page est vérifié à la Task 11.
- [ ] **Step 2: `npm test && npm run test:db`** → échec.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(catalog): friendOwners dans l'overlay par joueur (trois amis au plus par carte), pastille « ami possède » en lien vers le profil`

---

### Task 8: Routes et contrat du profil, de la vitrine et des signalements

**Files:**
- Create: `app/api/profile/[username]/route.ts` (GET, PATCH), `app/api/profile/[username]/showcase/route.ts` (GET), `app/api/showcase/route.ts` (GET, PUT, DELETE), `app/api/reports/route.ts` (GET, POST), `contract/spec/profile.ts`, `contract/spec/reports.ts`
- Modify: `lib/schemas.ts` (`ProfilePatch`, `ShowcaseBody`, `ShowcasePosition`, `ReportBody`), `lib/route.test.ts` (`maskPath`), `contract/spec/collection.ts` (cas « ami »), `contract/spec/index.ts`

**Interfaces:**
- Consumes : `route()` (`lib/route.ts:80-94`) ; les fonctions des Tasks 3 et 5.
- Produces :
  - `lib/schemas.ts` :
    - `ProfilePatch = z.object({ bio: pgText.optional(), is_public: z.boolean().optional(), avatar_user_card_id: z.uuid().nullable().optional() })` ;
    - `ShowcaseBody = z.object({ position: z.int32(), user_card_id: z.uuid() })` et `ShowcasePosition = z.object({ position: z.int32() })` ;
    - `ReportBody = z.object({ reportedUserId: z.uuid(), reason: pgText, details: pgText.optional() })`.
  - Routes (toutes les écritures en `idem: true`, `params: z.object({ username: Username })` pour le profil) :
    - `GET /api/profile/{username}` : `fn: 'profile_get'` ;
    - `PATCH` : `fn: 'profile_update'`, `input: ProfilePatch`, `args` → `{ p_username, p_bio: i.bio ?? null, p_is_public: i.is_public ?? null, p_avatar_user_card_id: i.avatar_user_card_id ?? null, p_avatar_set: i.avatar_user_card_id !== undefined }` ;
    - `GET /api/profile/{username}/showcase` : `fn: 'profile_showcase'` ;
    - `GET /api/showcase` : `fn: 'my_showcase'` ; `PUT` : `fn: 'showcase_put'`, `input: ShowcaseBody` ; `DELETE` : `fn: 'showcase_delete'`, `input: ShowcasePosition`, lu dans le corps JSON (`lib/route.ts:53-55`) ;
    - `GET /api/reports` : `fn: 'report_get'`, `input: z.object({ reportedUserId: z.uuid() })` ; `POST` : `fn: 'report_upsert'`, `input: ReportBody`, `args` → `{ p_reported_user_id, p_reason, p_details: i.details ?? null }`.
  - Contrat :
    - `Profile` = `z.strictObject` de B2, et `ProfileReduced` sans `bio` ;
    - `ProfileResponse` = `z.strictObject({ profile, isOwn, isFriend, friendship: z.strictObject({ id, status, requester_id }).nullable() })` ;
    - `ShowcaseItem` et `Showcase` (`z.strictObject`) ;
    - huit `RouteSpec`, `source: 'R§3.7'`, `confidence: 'prob.'` ;
    - aide `imageCopy(env, uid)` (psql `tests.image_card`, puis une copie), exportée pour `chat.ts` et les specs suivantes.

- [ ] **Step 1: Specs de contrat qui échouent** (chaque erreur au corps entier par `refused`)
  - `GET /api/profile/{u}` :
    - `noSession` ;
    - soi → `ProfileResponse` entier, `isOwn` vrai ;
    - un inconnu privé → `profile` passe `ProfileReduced` (aucune `bio`) ;
    - un ami privé → entier ;
    - pseudo inconnu → 404 exact ;
    - ***Review Focus*, pseudo hérité** : un joueur renommé par psql en `Élise Ü` (puis `a%b`, puis `x?y#z`) → `GET /api/profile/${encodeURIComponent(name)}` rend son id, et `GET …/showcase` répond aussi.
  - `PATCH /api/profile/{u}` :
    - `noSession` ;
    - `{bio: 'Bonjour', is_public: false}` → la forme du `GET`, avec ces valeurs ;
    - `{avatar_user_card_id: <imageCopy>}` → `avatar_url` = l'URL de la carte ; `{avatar_user_card_id: null}` → `null` ;
    - bio de 281 caractères → 400 exact ; la copie d'un autre → 403 `42501` exact ; le pseudo d'un autre → 403 `FORBIDDEN` exact ; `{bio: 'a\u0000'}` → 400 « Caractère invalide » ;
    - même `Idempotency-Key` deux fois → corps identiques.
  - `GET /api/profile/{u}/showcase` : `noSession` ; privé et étranger → 403 « Ce profil est privé » ; ami → `{showcase}` ; inconnu → 404.
  - `GET`, `PUT` et `DELETE /api/showcase` :
    - `noSession` sur chacune ;
    - `PUT {position: 0, user_card_id}` → `{showcase: [1 élément], galleries: []}` ;
    - `DELETE` avec le corps `{position: 0}` → `{showcase: [], galleries: []}` ;
    - `PUT` position 4 → 400 exact ; la copie d'un autre → 403 `42501` ; `DELETE` sans corps → 400 `invalid_request` ;
    - même clé deux fois sur `PUT`, puis sur `DELETE` → corps identiques.
  - `GET /api/reports` : `noSession` ; `?reportedUserId=abc` → 400 ; aucun signalement → `{report: null}`.
  - `POST /api/reports` :
    - `noSession` ;
    - succès → `{report: {reason: 'spam', details: 'x'}}`, puis une modification → une seule ligne (psql) ;
    - soi-même → 400 exact ; `reason: 'abuse'` → 400 exact ; détails de 501 → 400 ; id inconnu → 404 ;
    - même clé deux fois → corps identiques.
  - `contract/spec/collection.ts`, `profileCollection` : un profil privé lu par un ami (`befriend`) → 200 `ProfileCollection`. Le cas « privé d'un autre → 403 » reste.
  - `index.ts` ajoute `...profile, ...reports`.
  - `lib/route.test.ts`, ***Review Focus*** :
    - `maskPath('/api/profile/%C3%89lise%20%C3%9C', { username: 'Élise Ü' })` = `'/api/profile/[username]'` ;
    - `maskPath('/api/profile/x%3Fy%23z/showcase', { username: 'x?y#z' })` = `'/api/profile/[username]/showcase'`.
    Le journal ne porte jamais le pseudo.
- [ ] **Step 2: `npm test && npm run build:test && npm run test:contract`** → les nouveaux cas du contrat échouent. Ceux de `maskPath` peuvent passer déjà : ils fixent un comportement existant.
- [ ] **Step 3: Implémenter** (chaque handler en 1 à 3 lignes).
- [ ] **Step 4: Contrôles complets** → vert ; `coverage:recap` passe de 54 à 62.
- [ ] **Step 5: Commit** — `feat(api): profil (lecture, modification), vitrine (la mienne, celle d'un profil, pose et retrait), signalements, et leur contrat`

---

### Task 9: Routes et contrat des messages, `PATCH rest/v1/chat_messages`

**Files:**
- Create: `app/api/chat/route.ts` (GET), `app/api/chat/[peerId]/route.ts` (GET, POST), `contract/spec/chat.ts`
- Modify: `lib/schemas.ts` (`PeerParams`, `ChatBody`), `contract/spec/rest.ts`, `contract/spec/index.ts`

**Interfaces:**
- Consumes : les fonctions de la Task 4 ; `befriend` (`contract/spec/friends.ts:28`) ; `rest()` et `spec()` (`contract/spec/rest.ts:12-23`, `:51-52`).
- Produces :
  - `PeerParams = z.object({ peerId: z.uuid() })` ; `ChatBody = z.object({ content: pgText })`.
  - Routes :
    - `GET /api/chat` : `route({ fn: 'chat_conversations' })` ;
    - `GET /api/chat/{peerId}` : `fn: 'chat_thread'`, `params: PeerParams` ;
    - `POST /api/chat/{peerId}` : `fn: 'chat_send'`, `params: PeerParams`, `input: ChatBody`, `idem: true`, `status: 201`. `push: true` s'y ajoute à la Task 10.
  - `contract/spec/chat.ts` : `Message`, `Conversation`, `Thread` en `z.strictObject` (B2, M4b-9) ; trois `RouteSpec`, `R§3.7`, `prob.`.
  - `contract/spec/rest.ts` : `rest/v1/chat_messages` en `PATCH` (`R§3.7`, `prob.`), `POST` et `DELETE` (`inc.`, refus).

- [ ] **Step 1: Specs de contrat qui échouent**
  - `GET /api/chat` : `noSession` ; A a écrit à B et reçu de C → deux conversations dans l'ordre, `unread_count` exact ; celles de deux autres joueurs absentes.
  - `GET /api/chat/{peerId}` :
    - `noSession` ; `abc` → 400 ; uuid inconnu → 404 exact ;
    - un ami → `Thread` avec `isFriend` vrai ;
    - un ancien ami (amitié supprimée par psql) → 200 avec l'historique, `isFriend` faux ;
    - le `GET` ne marque rien lu (psql : `read` faux).
  - `POST /api/chat/{peerId}` :
    - `noSession` ;
    - un ami → 201 `{message}` ; une `chat_message` pour le pair (psql), et une seule après deux envois ;
    - non-ami → 403 exact ; `''` → 400 « Le message est vide » ; 2 001 caractères → 400 exact ; `'a\u0000'` → 400 « Caractère invalide » ;
    - même `Idempotency-Key` deux fois → corps identiques, une seule ligne.
    - ***Review Focus*, débit par HTTP** : `chat_burst` posé à `{"count": 2, "window_s": 60}` par psql, et restauré en `finally`. Le 3ᵉ envoi → 429 : `failed(res, 429)` sans `code`, `retry_after` entier entre 1 et 60, et l'en-tête `Retry-After` = `String(retry_after)`.
  - `PATCH rest/v1/chat_messages?sender_id=eq.<A>&recipient_id=eq.<B>&read=eq.false` `{read: true}`, avec `prefer: return=minimal` :
    - par B → 204 ; les messages sont lus et la `chat_message` de A pour B aussi (psql, trigger) ;
    - par A (l'expéditeur), puis par Carol → 204, et rien ne change (psql) ;
    - `{content: 'x'}` par B → 403 `42501`, et `has_column_privilege('authenticated', 'public.chat_messages', 'content', 'update')` est faux (psql, DG:453) ;
    - anon → 401 `42501`.
  - `POST` et `DELETE rest/v1/chat_messages` par un participant → 403 `42501`, et les lignes sont inchangées.
  - `index.ts` ajoute `...chat`.
- [ ] **Step 2: `npm run build:test && npm run test:contract`** → échec.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert ; `coverage:recap` passe de 62 à 66, et plus aucune route du §3.6 ni du §3.7 n'y manque.
- [ ] **Step 5: Commit** — `feat(api): messages privés (conversations, fil, envoi 201, 429 avec Retry-After), marquage lu direct par le destinataire sous RLS, et leur contrat`

---

### Task 10: Push côté serveur — `lib/push.ts`, `after()`, routes, faux service et preuve D§13

**Files:**
- Create: `lib/vapid.ts`, `lib/push.ts`, `lib/push.test.ts`, `lib/cron.ts`, `lib/notification-view.ts`, `app/api/push/subscribe/route.ts` (POST, DELETE), `app/api/settings/notifications/route.ts` (GET, POST), `app/api/cron/push/route.ts`, `app/api/cron/push/route.test.ts`, `contract/push-crypto.ts`, `contract/push-crypto.test.ts`, `contract/spec/push.ts`
- Modify:
  - `package.json` et `package-lock.json` : `web-push` 3.6.7 en dépendance, `@types/web-push` 3.6.4 en dev ;
  - `lib/route.ts:80-94` et `:133-135` (option `push`), `lib/route.test.ts` ;
  - `lib/notifications.ts` : `notificationView` réexporté, `lib/notifications.test.ts` (cas `chat_message`) ;
  - `app/api/cron/revalidate/route.ts` (`cronDenied`) ;
  - les huit routes du B6 (`push: true`) ;
  - `lib/schemas.ts` (`PushSubscriptionBody`, `PushEndpoint`, `PushTypes`), définis ci-dessous ;
  - `contract/harness.ts:83-131` (faux service), `:223-239` (VAPID) ;
  - `contract/spec/index.ts`, `.env.example:24-26`.

**Interfaces:**
- Consumes : `wm.push_claim`, `wm.push_gone`, `wm.push_subscribe`, `wm.push_unsubscribe`, `wm.notification_prefs_get` et `wm.notification_prefs_set` (Task 6) ; `createAdminClient` (`lib/supabase/admin.ts`) ; `brand` (`lib/brand.ts:23`).
- Produces :
  - `lib/notification-view.ts` (B4) :
    - `notificationView` déplacé tel quel, plus `case 'chat_message': return { text: \`${u} t'a écrit\`, href: \`/dms?with=${data.user_id}\` }` ;
    - `PUSH_FAMILIES: readonly { label: 'Messages' | 'Échanges' | 'Amis' | 'Marché'; types: readonly string[] }[]` ;
    - `pushTypes(): string[]`, les 13 types triés.
  - `lib/vapid.ts` : `vapidConfig(): { subject: string; publicKey: string; privateKey: string } | null`. `null` si `VAPID_PRIVATE` ou `VAPID_SUBJECT` manque. `publicKey` est dérivée (M4b-14).
  - `lib/push.ts` (`import 'server-only'`, B7) :
    - `pushPayload(n: { notification_id: string; type: string; data: Record<string, unknown> }): { title: string; body: string; url: string; tag: string }` (B8) ;
    - `drainPush(): Promise<{ sent: number; gone: number; failed: number } | null>`. Sans `vapidConfig()`, c'est `null`, sans aucune RPC. Sinon : `push_claim` avec `p_limit: 500`, puis des vagues de 50 par `Promise.allSettled`, chaque envoi `webpush.generateRequestDetails(…)` puis `fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) })`. Un 2xx compte `sent`, un 404 ou 410 `gone`, le reste et les rejets `failed`. Un seul `push_gone` sur les `subscription_id` dédoublonnés. Une ligne de journal `{"push":{"claimed":n,"sent":n,"gone":n,"failed":n}}`, sans endpoint ni uid. Le `shortcut:` du M4b-19 y figure.
  - `lib/cron.ts` : `cronDenied(req: Request): Response | null`, avec les chaînes et le temps constant de `app/api/cron/revalidate/route.ts:5-16`.
  - `route()` gagne `push?: boolean`. Sur un succès seulement (`out.status === ok`), elle appelle `after(async () => { try { await (await import('@/lib/push')).drainPush() } catch { console.error(JSON.stringify({ push: 'drain_failed' })) } })`.
  - Routes :
    - `POST /api/push/subscribe` : `fn: 'push_subscribe'`, `input: PushSubscriptionBody` = `z.object({ endpoint: z.url().max(2048), keys: z.object({ p256dh: z.string().regex(/^B[A-Za-z0-9_-]{85}[AEIMQUYcgkosw048]$/), auth: z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/) }) })`, chaque refus en « Abonnement push invalide », `idem: true`. Les expressions disent la taille sans `Buffer`, puisque `lib/schemas.ts` part aussi au navigateur. 65 octets font 87 caractères base64url sans remplissage, le premier `B` (0x04) et le dernier porteur de 4 bits ; 16 octets font 22 caractères, le dernier porteur de 2 bits ;
    - `DELETE /api/push/subscribe` : `fn: 'push_unsubscribe'`, `input: PushEndpoint = z.object({ endpoint: z.url().max(2048) })`, `idem: true` ;
    - `GET` et `POST /api/settings/notifications` : `fn: 'notification_prefs_get'` et `'notification_prefs_set'` (`input: PushTypes = z.object({ push_types: z.array(pgText).max(20) })`, `idem: true`), avec `call` qui ajoute `vapid_public: vapidConfig()?.publicKey ?? null` au corps d'un succès ;
    - `POST /api/cron/push` (`export const maxDuration = 60`) : `cronDenied`, puis `drainPush()`. `null` → 503 `push_disabled` « Notifications push non configurées. » ; une exception → 500 `INTERNAL` ; sinon 200 `{sent, gone, failed}`.
  - Harnais :
    - `startNext` pose `VAPID_PRIVATE` et `VAPID_SUBJECT: 'mailto:push@example.invalid'`. La paire vient de `webpush.generateVAPIDKeys()`, une fois au chargement du module : la même pour les deux serveurs du run, jamais écrite ni imprimée ;
    - la passerelle sert `POST /push/<id>`, `POST /push/gone/<id>` et `GET /push/<id>` (M4b-32) ;
    - `export const PUSH_SINK = \`${SUPABASE_URL}/push\``.
  - `contract/push-crypto.ts` :
    - `decryptPush(body: Buffer, ua: ECDH, auth: Buffer): string` : en-tête RFC 8188 §2, puis RFC 8291 §3.3-3.4 ;
    - `verifyVapid(authorization: string, vapidPublic: string): { aud: string; sub: string; exp: number }` : ES256, `dsaEncoding: 'ieee-p1363'` ; lève sur toute signature fausse.
  - `contract/spec/push.ts` : cinq `RouteSpec`, `source: 'D§7.9'`, `confidence: 'ajouté'`.

- [ ] **Step 1: Tests unitaires qui échouent**
  - `contract/push-crypto.test.ts` :
    - `webpush.encrypt(<p256dh>, <auth>, 'é ok', 'aes128gcm')`, puis `decryptPush` → `'é ok'` ; un octet du corps changé → lève ;
    - `verifyVapid` sur les en-têtes de `webpush.getVapidHeaders('http://127.0.0.1:54321', 'mailto:push@example.invalid', pub, priv, 'aes128gcm')` → `aud` = `'http://127.0.0.1:54321'` ; avec une autre clé publique → lève.
  - `lib/push.test.ts` (admin simulé comme `lib/route.test.ts:7-11`, `fetch` par `vi.stubGlobal`, `VAPID_*` posées par `vi.stubEnv`) :
    - sans `VAPID_SUBJECT` → `null`, et `push_claim` n'est pas appelée ;
    - `vapidConfig().publicKey` = le `publicKey` de `generateVAPIDKeys()` pour sa clé privée ;
    - 120 lignes → `fetch` appelé 120 fois, jamais plus de 50 en vol (compteur dans le faux `fetch`) ;
    - statuts 201, 404, 410, 500 et un rejet `AbortError` → `{sent: 1, gone: 2, failed: 2}`, et `push_gone` appelée une fois avec les deux ids ;
    - chaque appel de `fetch` : `method` `POST`, en-têtes `Content-Encoding: aes128gcm`, `TTL: '86400'`, `Authorization` qui commence par `vapid t=`, aucun `Content-Length`, et un `signal` ;
    - `pushPayload` d'une `chat_message` → `{title: brand.name, body: '<u> t\'a écrit', url: '/dms?with=<id>', tag: 'dm:<id>'}` ; d'un `trade_received` → `tag` = l'id de la notification.
  - `lib/route.test.ts` (`vi.mock('next/server', …)` qui capture `after`, et `vi.mock('@/lib/push')`) :
    - `push: true` et un succès → `after` une fois, puis `drainPush` appelé ;
    - un P0001 → `after` jamais ;
    - sans `push` → jamais ;
    - un `drainPush` rejeté ne lève pas.
  - `app/api/cron/push/route.test.ts` : `CRON_SECRET` absent → 503 `cron_disabled` ; mauvais secret → 401 ; `drainPush` → `null` → 503 `{code: 'push_disabled', error: 'Notifications push non configurées.', message: …}` ; `{sent: 1, gone: 0, failed: 0}` → 200, ce corps. `app/api/cron/revalidate/route.test.ts` reste vert.
  - `lib/notifications.test.ts` :
    - `chat_message` → `{text: 'Alice t\'a écrit', href: '/dms?with=<id>'}` ;
    - `PUSH_FAMILIES` aplati et trié = `pushTypes()` = la liste littérale des 13 types, la même que `wm.config.push_types` (Task 2) ;
    - chaque type a un texte autre que « Nouvelle notification ».
- [ ] **Step 2: Specs de contrat qui échouent** (`contract/spec/push.ts`, la preuve de D:1083 ; séquentiel)
  - Préparation :
    - l'origine `http://127.0.0.1:54321` est ajoutée à `push_origins.origins` par psql, si elle manque ;
    - pour chaque abonné : `createECDH('prime256v1').generateKeys()`, et `auth` = `randomBytes(16)` ;
    - les livraisons d'un endpoint s'ajoutent dans l'ordre : chaque cas attend que leur nombre augmente, puis lit la dernière.
  - `POST /api/push/subscribe` :
    - `noSession` ;
    - `{endpoint: \`${PUSH_SINK}/<uuid>\`, keys}` → `{ok: true}` ;
    - `p256dh` de 64 octets → 400 « Abonnement push invalide » ;
    - `https://fcm.googleapis.com@evil.example/x` → 400 « Service de notifications non pris en charge » ;
    - même clé deux fois → corps identiques.
  - `GET /api/settings/notifications` : `noSession` ; → `{push_types: [], vapid_public}`, où `vapid_public` est une chaîne base64url de 87 caractères.
  - `POST /api/settings/notifications` : `{push_types: ['friend_request', 'auction_won']}` → `{push_types: ['auction_won', 'friend_request'], vapid_public}` ; `['nope']` → 400 exact.
  - **Push reçu par `after()`** :
    - Bob fait `POST /api/friends {addressee_id: alice}`, sans aucun appel au cron ;
    - `GET ${PUSH_SINK}/<uuid>` relu toutes les 100 ms, au plus 5 s → exactement une livraison ;
    - en-têtes `content-encoding: aes128gcm`, `ttl: 86400`, `urgency: normal` ;
    - `verifyVapid(authorization, vapid_public)` → `aud` = `'http://127.0.0.1:54321'`, `sub` = `'mailto:push@example.invalid'`, `exp` dans `(now, now + 86 400]` ;
    - `JSON.parse(decryptPush(…))` = `{title: brand.name, body: '<pseudo de Bob> veut devenir ton ami', url: '/friends', tag: <id de la notification>}`.
  - **Type non activé** : Carol fait `POST /api/friends` vers Dave, abonné sans `friend_request` → aucune livraison dans les 2 s, et aucune ligne d'outbox pour Dave (psql).
  - **Push par le cron** :
    - le dernier appel HTTP avant cette étape est `POST /api/settings/notifications` (sans `push`), pour qu'aucun `after()` ne réserve la ligne ;
    - psql insère une `auction_won` pour Alice → une ligne d'outbox ;
    - `POST /api/cron/push` avec `x-cron-secret: CRON_SECRET` → 200 `{sent: 1, gone: 0, failed: 0}`, et la livraison déchiffrée a pour `body` « Tu as remporté … ».
  - **410** : Erin s'abonne à `${PUSH_SINK}/gone/<uuid>` et active `auction_won` ; psql insère une notification ; le cron → `{sent: 0, gone: 1, failed: 0}`, et l'abonnement d'Erin a disparu (psql).
  - `POST /api/cron/push` : sans secret, puis avec un mauvais secret → 401 `cron_unauthorized` ; serveur à porte, sans cookie de porte, bon secret → 200.
  - `DELETE /api/push/subscribe` : `noSession` ; `{endpoint}` d'Alice → `{ok: true}`, et la ligne a disparu ; un endpoint inconnu → `{ok: true}`.
  - Le contenu d'un message n'est jamais dans la charge :
    - la demande de Bob est acceptée par psql (`update public.friendships set status = 'accepted'`), et Alice active `chat_message` ;
    - Bob écrit « secret 42 » à Alice (`POST /api/chat/<alice>`, `push: true`) → une livraison, dont la charge déchiffrée a `body` « <Bob> t'a écrit », `tag` `dm:<bob>`, et ne contient pas « secret ».
  - `index.ts` ajoute `...push`.
- [ ] **Step 3: `npm test && npm run build:test && npm run test:contract`** → échec.
- [ ] **Step 4: Implémenter.** Installer par `npm install --save-exact web-push@3.6.7 && npm install --save-dev --save-exact @types/web-push@3.6.4`, puis vérifier que `package.json` n'a ni `^` ni `~`. `.env.example` :
  - `VAPID_PUBLIC=` devient facultatif, avec le commentaire « dérivée de VAPID_PRIVATE si vide » ;
  - `VAPID_SUBJECT=` s'ajoute, avec « https: ou mailto: ; sans lui, le push est coupé ».
  Si Turbopack ne parvient pas à empaqueter `web-push`, ajouter la ligne `serverExternalPackages: ['web-push']` à `next.config.ts` et la consigner.
- [ ] **Step 5: Contrôles complets** → vert ; `coverage:recap` reste à 66 (routes ajoutées hors du récap).
- [ ] **Step 6: Commit** — `feat(push): envoi Web Push (web-push 3.6.7, generateRequestDetails puis fetch, vagues de 50, 410 qui désabonne), drain par after() et par /api/cron/push, abonnement et préférences ; push reçu, déchiffré et signé vérifié sur le faux service du banc`

---

### Task 11: Page `/profile/[username]` — vue publique, amitié, signalement

**Files:**
- Create: `app/(game)/profile/[username]/page.tsx`, `app/(game)/profile/[username]/profile-view.tsx`, `components/profile/types.ts`, `components/profile/ReportModal.tsx`, `e2e/profile.spec.ts`
- Modify: `lib/format.ts` (+ `formatMonthYear`), `lib/format.test.ts`, `e2e/a11y.spec.ts`, `e2e/fixtures.ts` (`imageCopy`, B11)

**Interfaces:**
- Consumes : `GET /api/profile/{u}`, `GET /api/profile/{u}/showcase`, `GET /api/profile/{u}/collection`, `GET` et `POST /api/reports` (Task 8) ; `POST /api/friends` et `PATCH /api/friends/{id}` (M4a) ; `Card`, `CardModal` en mode catalogue, `Pagination`, `tabKey`, `Modal`, `LoadError`, `Loading`, `PageHeader`, `toast`, `apiOnce`, `userMessage`, `unsure`, `primary`, `ghost` et `link`.
- Produces :
  - `formatMonthYear(iso: string): string` = `Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' })`.
  - `components/profile/types.ts` : `type Profile`, `type ProfileView = { profile: Profile; isOwn: boolean; isFriend: boolean; friendship: { id: string; status: 'pending' | 'accepted'; requester_id: string } | null }`, `type CopyFace`, `type ShowcaseItem`, et `copyFace(c: CopyFace): CardFace`, qui pose `rarity = snapshot_rarity` (un autre nom que le `faceOf` de `CardModal.tsx:48`, qui lit une copie à soi).
  - `page.tsx` : coquille, `metadata.title` « Profil », `<Suspense fallback={<Loading label="Chargement du profil" />}>`. Le client lit `username` par `useParams()` et se monte avec `key={username}`, sur le modèle de `app/(game)/trades/[id]/page.tsx`.
  - `ProfileView` :
    - `PageHeader` avec le pseudo en h1 (icône `User`, `wrap-anywhere`) et les actions à droite ;
    - un bloc d'identité en `card-frame p-6` : avatar de 96 px `alt=""`, sinon l'initiale ; « Membre depuis {mois année} » ; la bio en `whitespace-pre-line wrap-anywhere` ; les six raretés de `rarityCounts` (`?stats=1`) ;
    - actions :
      - soi : un lien « Modifier mon profil » ;
      - ami : « Message » (`/dms?with=<id>`), « Proposer un échange » (`/trades/new?with=<id>`), « Signaler » ;
      - non-ami, selon `friendship` : « Ajouter en ami », « Demande envoyée » (un `p` à `tabIndex={-1}`) ou « Accepter sa demande », plus « Signaler » ;
    - vue permise (`isOwn || isFriend || profile.is_public`) : des onglets `[role=tablist][aria-label="Vues du profil"]` « Vitrine » et « Collection », un seul panneau monté. Sinon un `card-frame` « Ce profil est réservé aux amis. », sans lecture de la vitrine ni de la collection ;
    - « Collection » : une recherche `input type="search"` (« Rechercher dans sa collection »), `Pagination` en base 0, `Card size="grid"` sans `owned`, et `CardModal` en mode catalogue au clic ;
    - une 403 de vitrine ou de collection, arrivée après un profil lisible, montre le texte « réservé aux amis » ;
    - 404 ou 400 → h1 « Joueur introuvable » et « Retour aux amis » ; autre échec → `LoadError` ;
    - écritures : intentions `add:<id>` et `accept:<friendshipId>`, toasts de P19, puis le profil relu ;
    - focus : « Demande envoyée » après l'ajout, « Message » après l'acceptation ; `data-ready` une fois le profil lu, avec la vitrine quand elle est lisible ;
    - aucun polling.
  - `ReportModal({ user, onClose }: { user: { id: string; username: string }; onClose: () => void })` :
    - `Modal` au titre « Signaler {pseudo} » ; `GET /api/reports?reportedUserId=` à l'ouverture, pour préremplir ;
    - un `fieldset` « Motif » à trois radios natives ; « Détails (facultatif) » en `maxLength={500}`, avec le compteur ;
    - « Envoyer le signalement » ou « Modifier le signalement », en `aria-disabled` sans motif ou pendant l'envoi, plus « Annuler » ;
    - intention `JSON.stringify(body)` ; pendant l'envoi, le formulaire est figé, avec une garde dans `onChange` des radios, et Échap est refusé ;
    - succès → toast, fermeture, focus rendu à « Signaler » ; refus → `role="alert"` dans la modale.

- [ ] **Step 1: Tests unitaires qui échouent** : `formatMonthYear('2026-10-15T12:00:00Z')` = `'octobre 2026'`.
- [ ] **Step 2: Tests E2E qui échouent** (`e2e/profile.spec.ts`)
  - Soi : h1 = son pseudo, « Membre depuis » suivi du mois et de l'année, un lien « Modifier mon profil » au `href` `/profile`, et ni « Ajouter en ami » ni « Signaler ».
  - Inconnu public, avec une copie en vitrine (sql) :
    - le panneau « Vitrine » montre sa `Card` ; « Collection » montre la grille et « Page 1 » ;
    - « Ajouter en ami » au clavier → toast « Demande envoyée à <pseudo>. », et `document.activeElement` a le texte « Demande envoyée ».
  - Inconnu privé : « Ce profil est réservé aux amis. », aucun onglet ; aucune requête `/showcase` ni `/collection` observée ; « Ajouter en ami » présent.
  - Demande reçue (sql) : « Accepter sa demande » → toast « <pseudo> fait maintenant partie de tes amis. », puis les onglets apparaissent, et le focus est sur « Message ».
  - Ami : « Message » mène à `/dms?with=<id>`, « Proposer un échange » à `/trades/new?with=<id>`.
  - Signalement, au clavier :
    - « Signaler » → modale « Signaler <pseudo> », Tab jusqu'à « Spam », Espace, détails « pub », « Envoyer le signalement » → toast « Signalement envoyé. », et le focus revient sur « Signaler » ;
    - rouvrir → « Spam » coché, « pub », et le bouton « Modifier le signalement ».
  - ***Review Focus*, pseudo hérité** : un joueur renommé par sql en `Élise Ü` → `page.goto('/profile/' + encodeURIComponent('Élise Ü'))` → h1 « Élise Ü ».
  - `/profile/<pseudo inconnu>` → « Joueur introuvable » et « Retour aux amis ».
  - Erreur : `routeOnce(page, '**/api/profile/*', (r) => r.fulfill({ status: 500 }))` → `LoadError`, puis « Réessayer » → le profil.
  - 360 px, avec un pseudo de 24 caractères et une bio d'un seul mot de 280 caractères : aucun défilement horizontal ; boutons d'au moins 44 px.
  - `e2e/a11y.spec.ts` : `axe /profile/<soi>`, `/profile/<ami>`, `/profile/<privé>`, et la modale de signalement ouverte → 0 violation grave. `READY` : `'main [data-ready]'` pour ces chemins.
- [ ] **Step 3: `npm test && npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/profile.spec.ts e2e/a11y.spec.ts`** → échec.
- [ ] **Step 4: Implémenter.**
- [ ] **Step 5: Contrôles complets** → vert.
- [ ] **Step 6: Commit** — `feat(ui): page /profile/[username] (identité, vitrine, collection, profil réservé aux amis, ajouter ou accepter en ami, message, échange, signalement en modale)`

---

### Task 12: Page `/profile` — éditeur (avatar, bio, visibilité, vitrine)

**Files:**
- Create: `app/(game)/profile/profile-editor.tsx`, `components/profile/CardPicker.tsx`
- Modify: `app/(game)/profile/page.tsx` (une coquille au lieu de `ComingSoon`), `e2e/profile.spec.ts`, `e2e/shell.spec.ts:94` (+ `/profile`), `e2e/a11y.spec.ts`

**Interfaces:**
- Consumes : `PATCH /api/profile/{u}`, `GET`, `PUT` et `DELETE /api/showcase` (Task 8) ; `GET /api/my-collection?page=&q=` ; `createBrowserSupabase` (lecture de sa ligne `profiles`, modèle `settings-client.tsx:46-51`) ; `showsImage` (`Card.tsx:46-48`) ; `Section`, sur le modèle de `settings-client.tsx:173-180`.
- Produces :
  - `page.tsx` : coquille statique, `metadata.title` « Profil » (`navEntry('/profile')`). `ProfileEditor` rend lui-même `PageHeader` « Profil », sur le modèle de `FriendsClient`, et y ajoute le lien « Voir comme les autres » (`/profile/<moi>`) une fois son pseudo lu.
  - `ProfileEditor` : la ligne `profiles` lue en direct (`username, bio, is_public, avatar_url, created_at`), puis `GET /api/showcase`. Quatre sections `card-frame p-6`, chacune avec son chargement, son échec, sa génération et sa garde `inflight` :
    - « Avatar » : l'avatar actuel en 96 px, « Changer l'avatar » (le sélecteur en mode avatar), et « Retirer l'avatar » s'il y en a un (`{avatar_user_card_id: null}`) ; toasts « Avatar changé. » et « Avatar retiré. » ;
    - « À propos » : un `textarea` (label « À propos », `maxLength={280}`) avec le compteur `` `${formatInt(value.length)} / 280` ``, et « Enregistrer » en `aria-disabled` sans changement ou pendant l'envoi (intention `bio:<texte>`, `readOnly` pendant l'envoi) ; statut « Profil enregistré. » en `role="status"` ;
    - « Visibilité » : une case native « Profil public », avec l'aide du B12, enregistrée tout de suite (`public:<bool>`) ; un refus la remet comme avant ;
    - « Vitrine ({n}/4) » : les positions 0 à 3. Un emplacement rempli montre sa `Card` et « Changer » et « Retirer », décrits par le titre. Un vide est un `button` de la taille de la carte, au nom « Ajouter une carte à l'emplacement {n} » (n de 1 à 4), à bordure pointillée `/40`. Intentions `showcase:<position>:<user_card_id>` et `unshowcase:<position>`.
  - `CardPicker({ mode, onPick, onClose }: { mode: 'avatar' | 'showcase'; onPick: (userCardId: string) => Promise<void>; onClose: () => void })` :
    - `Modal` au titre « Choisir ton avatar » ou « Choisir une carte pour la vitrine » ;
    - un filtre « Filtrer mes cartes », envoyé sur Entrée ; des pages de 50, avec « Charger la suite » ;
    - en mode avatar, une copie sans image utilisable (`!showsImage(card, true)`) est visible sans `onClick`, avec la légende « Sans image » ;
    - « Annuler » ; un refus de `onPick` s'affiche en `role="alert"`, et la modale reste ouverte.
  - Focus :
    - après un choix, sur « Changer » du même emplacement (effet après rendu, si `document.activeElement === document.body`) ;
    - après « Retirer », sur « Ajouter une carte à l'emplacement {n} » ;
    - « Réessayer » ramène le focus sur le titre de sa section.
  - `data-ready` quand la ligne et la vitrine sont lues, ou en échec.

- [ ] **Step 1: Tests E2E qui échouent** (`e2e/profile.spec.ts`)
  - h1 « Profil » et titre `^Profil — ` (`shell.spec.ts`) ; `/profile` sort de la liste « Cette section arrive bientôt. ».
  - Bio : saisie, puis « Enregistrer » → « Profil enregistré. ». `sql` → la bio. Le compteur affiche « 7 / 280 » pour « Bonjour ».
  - Visibilité : décocher → `sql` `is_public` faux ; `routeOnce` qui rend 500 au `PATCH` suivant → la case revient comme avant, avec l'alerte.
  - Avatar, au clavier :
    - « Changer l'avatar » → la modale, avec une `imageCopy` et une copie du seed (« Sans image », non cliquable) ;
    - Entrée sur la carte à image → toast « Avatar changé. », et l'`img` d'avatar a pour `src` le `data:` de B10 ;
    - « Retirer l'avatar » → plus d'image.
  - Vitrine, au clavier :
    - « Ajouter une carte à l'emplacement 1 » → choix → toast « Vitrine mise à jour. », « Vitrine (1/4) », et `document.activeElement` est « Changer » de l'emplacement 1 ;
    - « Retirer » → « Carte retirée de la vitrine. », et le focus est sur « Ajouter une carte à l'emplacement 1 » ;
    - la même copie posée par `sql` à l'emplacement 2, puis choisie pour l'emplacement 1 → l'alerte « Cette carte est déjà dans ta vitrine » dans la modale.
  - Copie partie : une copie en vitrine défaussée par `sql` (`wm.discard`), puis un retour sur `/profile` → « Vitrine (0/4) ».
  - 360 px : aucun défilement horizontal ; emplacements et boutons d'au moins 44 px.
  - `e2e/a11y.spec.ts` : `axe /profile`, avec 2 emplacements remplis, puis avec le sélecteur ouvert → 0 violation grave.
- [ ] **Step 2: `npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/profile.spec.ts e2e/shell.spec.ts e2e/a11y.spec.ts`** → échec.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(ui): page /profile (avatar choisi parmi ses copies à image, bio de 280, visibilité, vitrine de 4 emplacements, sélecteur de carte)`

---

### Task 13: Page `/dms` — conversations, fil, poll de 5 s, envoi, marquage lu

**Files:**
- Create: `app/(game)/dms/dms-client.tsx`, `components/dms/types.ts`, `components/dms/Thread.tsx`, `e2e/dms.spec.ts`
- Modify: `app/(game)/dms/page.tsx` (une coquille), `lib/format.ts` (+ `formatTime`, `formatLongDate`), `lib/format.test.ts`, `e2e/shell.spec.ts:94` (+ `/dms`), `e2e/a11y.spec.ts`

**Interfaces:**
- Consumes : `GET /api/chat`, `GET` et `POST /api/chat/{peerId}` (Task 9) ; le `PATCH` direct de `chat_messages` par `createBrowserSupabase()` ; `usePoll` (`lib/poll.ts:47-51`) ; `unreadStore().subscribe`, `getVersion` et `refresh` ; `apiOnce`, `unsure`, `userMessage`, `formatInt` et `formatShortDate`.
- Produces :
  - `formatTime(iso)` = `{ timeStyle: 'short' }` ; `formatLongDate(iso)` = `{ dateStyle: 'long' }`, en `fr-FR`.
  - `components/dms/types.ts` : `type Conversation`, `type Message`, `type Thread = { messages: Message[]; peer: { id: string; username: string; avatar_url: string | null }; isFriend: boolean }`.
  - `page.tsx` : `PageHeader` « Messages », `Suspense` autour de `DmsClient` (`useSearchParams`).
  - `DmsClient` :
    - la liste `GET /api/chat`, relue à chaque affichage, après chaque envoi, et à chaque version de `unreadStore()` (mécanisme de `/friends`) ;
    - `ul[aria-label="Conversations"]` de `Link` d'au moins 44 px vers `/dms?with=<peer_id>`, avec `aria-current="page"` sur le fil ouvert ; avatar de 40 px `alt=""`, pseudo, `last_message` en `line-clamp-1`, `formatShortDate`, une pastille `formatInt(unread_count)` et le texte `sr-only` « {n} message non lu » ou « {n} messages non lus » ; les non-lues en gras ;
    - deux colonnes dès `md` ; sous `md`, la liste sans `with`, le fil avec `with`, précédé de « ← Conversations » ;
    - `<Thread key={peerId} peerId={peerId} me={uid} />`.
  - `Thread` :
    - `usePoll(read, 5_000)` ; un `h2` focalisable, le pseudo en lien vers `/profile/<encodeURIComponent(pseudo)>` ;
    - `ol[role="log"][aria-label="Messages avec {pseudo}"]`, avec des séparateurs de jour (`formatLongDate`) ; des bulles en `whitespace-pre-wrap wrap-anywhere`, le préfixe `sr-only` « Toi : » ou « {pseudo} : », et un `time` (`formatTime`) ;
    - défilement vers le dernier message, sans `smooth` sous `prefers-reduced-motion` ;
    - marquage lu : quand une lecture appliquée contient des messages non lus du pair, `update({ read: true }).eq('sender_id', peer).eq('recipient_id', me).eq('read', false)`, puis `unreadStore().refresh()` ; un échec ne fait rien, le poll suivant réessaie ;
    - envoi :
      - un `textarea` « Ton message », `maxLength={2000}`, avec le compteur `` `${formatInt(value.length)} / ${formatInt(2000)}` `` ;
      - Entrée envoie, sauf avec Maj ou pendant une composition IME (`e.nativeEvent.isComposing`) ; l'aide du B12 ;
      - « Envoyer » en `aria-disabled` si `value.trim()` est vide ou pendant l'envoi ;
      - `apiOnce(keys, \`send:${peer}:${content}\`, …)` ; `readOnly` pendant l'envoi ; `hold = performance.now()` ;
      - succès → le message ajouté, le champ vidé, le focus dans le champ ;
      - refus → `role="alert"`, et le texte reste ; issue incertaine → le texte du B12, effacé par le premier message nouveau lu ;
    - `isFriend` faux → à la place de la saisie, « Vous devez être amis pour vous écrire » et un lien vers son profil ;
    - 404 ou 400 → « Joueur introuvable » et « Retour aux messages ».
  - États : ceux de B12 et `LoadError`. `data-ready` quand la liste est lue, avec le fil quand `with` est présent, ou en échec.

- [ ] **Step 1: Tests unitaires qui échouent** : `formatLongDate('2026-10-21T12:00:00Z')` = `'21 octobre 2026'` ; `formatTime(…)` correspond à `/^\d{2}:\d{2}$/`.
- [ ] **Step 2: Tests E2E qui échouent** (`e2e/dms.spec.ts` ; amitiés et messages préparés par `sql`)
  - `/dms` sans conversation : h1 « Messages », « Aucune conversation. » et le lien « Amis ». `/dms` sort de la liste « bientôt ».
  - Fil, au clavier :
    - `/dms?with=<ami>` → « Aucun message pour l'instant. » ;
    - saisie de « Salut », puis Entrée → la bulle « Salut » ; le champ est vide et focalisé ; le `POST` observé porte une `Idempotency-Key` ;
    - Maj+Entrée insère un saut de ligne sans envoyer.
  - **Poll** : `page.clock.install()` avant `goto` ; `sql` insère un message de l'ami ; `page.clock.runFor(5_000)` → la bulle apparaît. Le `PATCH /rest/v1/chat_messages` est observé, puis `sql` : le message est lu.
  - Liste : deux conversations, l'une avec 2 non lus → la pastille « 2 » et « 2 messages non lus » ; l'ouverture de ce fil, puis le retour → la pastille a disparu.
  - Ancien ami (amitié supprimée par `sql`) : le fil reste lisible, et la saisie est remplacée par « Vous devez être amis pour vous écrire ».
  - Refus 429 : `routeOnce` rend 429 `{error: 'Le site demande de ralentir', message: …, retry_after: 30}` au `POST` → l'alerte « Le site demande de ralentir », et le texte reste dans le champ.
  - Issue incertaine : `routeOnce` rend 503 après `r.fetch()` → l'alerte d'incertitude ; « Envoyer » de nouveau → la même `Idempotency-Key`, et une seule bulle.
  - ***Review Focus*, contenu** :
    - « 😀 » × 2 000 collé → le champ en garde 1 000, puisque `maxLength` compte les unités UTF-16 ;
    - le compteur affiche `` `${formatInt(2000)} / ${formatInt(2000)}` ``, et l'envoi passe : l'UI est plus stricte que le serveur, jamais plus large ;
    - des espaces seuls → « Envoyer » reste en `aria-disabled`.
  - Téléphone (390 px) : la liste seule sans `with` ; un lien, puis le fil seul, avec « ← Conversations », et le focus sur le `h2` du fil.
  - 360 px, avec un message d'un seul mot de 300 caractères : aucun défilement horizontal.
  - `e2e/a11y.spec.ts` : `axe /dms` (deux conversations) et `axe /dms?with=<ami>` (dix messages) → 0 violation grave, sans `scrollable-region-focusable`.
- [ ] **Step 3: `npm test && npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/dms.spec.ts e2e/shell.spec.ts e2e/a11y.spec.ts`** → échec.
- [ ] **Step 4: Implémenter.**
- [ ] **Step 5: Contrôles complets** → vert.
- [ ] **Step 6: Commit** — `feat(ui): page /dms (conversations et non-lus, fil interrogé toutes les 5 s, envoi à l'Entrée, marquage lu direct, ancien ami en lecture seule)`

---

### Task 14: Raccords — push dans `/settings`, `sw.js`, boutons « Message », cloche

**Files:**
- Create: `public/sw.js`, `app/(game)/settings/push-section.tsx`, `lib/push-browser.ts`, `lib/push-browser.test.ts`, `e2e/push-stub.ts`
- Modify :
  - `app/(game)/settings/settings-client.tsx` (section entre « Préférences » et « Compte », aide de `:20`) ;
  - `lib/gate.ts:4` (`'/sw.js'` dans `EXEMPT`), `lib/gate.test.ts:6`, `contract/spec/gate.ts` ;
  - `app/(game)/friends/friends-client.tsx:285-287` (« Message »), `e2e/friends.spec.ts:316-329` ;
  - `app/(game)/trades/[id]/trade-client.tsx:147` (« Message à <pseudo> »), `e2e/trades.spec.ts` ;
  - `e2e/notifications.spec.ts`, `e2e/settings.spec.ts`, `e2e/a11y.spec.ts:35` (`READY` de `/settings`).

**Interfaces:**
- Consumes : `GET` et `POST /api/settings/notifications`, `POST` et `DELETE /api/push/subscribe` (Task 10) ; `PUSH_FAMILIES` et `pushTypes` (B4).
- Produces :
  - `public/sw.js`, neutre et sans gestionnaire `fetch` :
    - `push` → `event.waitUntil(self.registration.showNotification(d.title, { body: d.body, tag: d.tag, icon: '/icon', data: { url: d.url } }))` ;
    - `notificationclick` → fermer la notification, puis focaliser un onglet de même origine déjà sur cette URL, sinon `clients.openWindow`. L'URL est résolue sur `self.location.origin` et ramenée à `/` si son origine diffère.
  - `lib/push-browser.ts` :
    - `fromBase64Url(s: string): Uint8Array` ;
    - `pushState(): Promise<'unsupported' | 'denied' | 'off' | 'on'>`, d'après `serviceWorker`, `PushManager`, `Notification.permission` et `getRegistration()?.pushManager.getSubscription()` ;
    - `subscribePush(vapidPublic: string): Promise<PushSubscriptionJSON>`, qui fait `requestPermission` (dans le geste), `register('/sw.js', { scope: '/', updateViaCache: 'none' })`, puis `subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(vapidPublic) })` ;
    - `unsubscribePush(): Promise<string | null>`, qui rend l'endpoint.
  - `PushSection` :
    - `section` « Notifications » (id `settings-notifications`), avec `data-ready` après `GET /api/settings/notifications` ;
    - `vapid_public` nul → « Les notifications push ne sont pas disponibles pour l'instant. » ;
    - selon `pushState()` : les textes du B12. « Activer sur cet appareil » fait `subscribePush`, `POST /api/push/subscribe` (intention `subscribe:<endpoint>`), puis, si `push_types` est vide, `POST {push_types: pushTypes()}`. « Désactiver sur cet appareil » fait `DELETE {endpoint}` (intention `unsubscribe:<endpoint>`), puis `unsubscribe()`. Tous passent par `apiOnce` (C6, D:131) ;
    - une case native par famille (`PUSH_FAMILIES`) : cochée si tous ses types sont actifs ; chaque bascule `POST` la liste entière (intention `JSON.stringify(liste triée)`) ; un refus la remet comme avant ;
    - l'aide « Ces choix valent pour tous tes appareils. » ;
    - erreurs en `role="alert"` ; « Réessayer » ramène le focus sur le titre.
  - `settings-client.tsx:20` : l'aide de « Profil public » devient celle du B12, « Décochée, seuls tes amis voient ta bio, ta vitrine et ta collection. » (U8).
  - `/friends` : un `Link` « Message » (`ghost`) vers `/dms?with=<id>`, avant « Échanger », avec `aria-describedby={desc}`.
  - `/trades/[id]` : un `Link` « Message à {pseudo de l'autre} » (icône `MessageCircle`, classe `link`) vers `/dms?with=<id de l'autre>`, sous « De {pseudo} à {pseudo} », pour les deux participants (l'identité vient de la session, P16).
  - `e2e/push-stub.ts` : `stubPush(page, { permission?: NotificationPermission })` par `addInitScript`. Il remplace `Notification.requestPermission` et `Notification.permission`, `navigator.serviceWorker.register` et `getRegistration`, et `pushManager.subscribe` et `getSubscription`. L'abonnement simulé a `toJSON()` → `{endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-<uuid>', keys: {p256dh, auth}}` (clés valides au regard de `PushSubscriptionBody`) et `unsubscribe()`.

- [ ] **Step 1: Tests qui échouent**
  - `lib/gate.test.ts` : `['/sw.js', 'pass']` dans la liste, et `'/sw.jsx'` → `redirect`.
  - `contract/spec/gate.ts` : serveur à porte, sans cookie : `GET /sw.js` → 200, `content-type` qui contient `javascript`, le corps contient `addEventListener('push'` et pas `addEventListener('fetch'`.
  - `lib/push-browser.test.ts` : `fromBase64Url('BAEC')` = `Uint8Array [4, 1, 2]` ; `-` et `_` sont décodés comme `+` et `/`.
  - `e2e/settings.spec.ts`, sous `stubPush(page)` :
    - la section « Notifications » et « Activer sur cet appareil » ;
    - le clic → un `POST /api/push/subscribe` observé avec l'`endpoint` du stub, puis un `POST /api/settings/notifications` avec les 13 types ; les quatre cases cochées, et « Notifications activées sur cet appareil. » ;
    - décocher « Marché » → un `POST` avec 8 types ; `sql` → `push_types` sans `auction_*` ni `wishlist_listed` ;
    - « Désactiver sur cet appareil » → un `DELETE` avec l'endpoint ; `sql` → plus de ligne ;
    - `stubPush(page, { permission: 'denied' })` → le texte « bloquées » et aucun bouton d'activation ;
    - le focus n'est jamais sur `body`.
  - `e2e/friends.spec.ts:316` devient : une ligne d'ami a « Message » (`href` `/dms?with=<id>`), « Échanger » et « Retirer ».
  - `e2e/trades.spec.ts` : au détail, le destinataire voit « Message à <initiateur> », et l'initiateur « Message à <destinataire> », chacun au `href` exact.
  - `e2e/notifications.spec.ts` : une `chat_message` (`username` « Alice ») → « Alice t'a écrit », au `href` `/dms?with=<user_id>`.
  - `e2e/a11y.spec.ts` : `READY['/settings']` = `'main:has(#settings-username):has(input[name="sounds"]) section[data-ready]'` ; `axe /settings` sous `stubPush`, section active → 0 violation grave.
- [ ] **Step 2: `npm test && npm run build:test && npm run test:contract && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/settings.spec.ts e2e/friends.spec.ts e2e/trades.spec.ts e2e/notifications.spec.ts e2e/a11y.spec.ts`** → échec.
- [ ] **Step 3: Implémenter.** `components/trades/TradeCard.test.tsx:40-45` (aucun « Message » dans la carte de liste) reste vrai.
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(ui): notifications push dans /settings (activer sur cet appareil, familles en opt-in), service worker exempté de la porte, boutons Message et Message à, lien de la cloche vers le fil`

---

### Task 15: Parcours du jalon au clavier — profil, amitié, messages, vitrine

**Files:**
- Create: `e2e/social-journey.spec.ts`

**Interfaces:**
- Consumes : les pages des Tasks 11 à 14 ; `makePlayer`, `sql`, `cookieFor`, `giveCopies` et `imageCopy` (`e2e/fixtures.ts`) ; le modèle de `e2e/trade-journey.spec.ts` (un contexte par joueur).

- [ ] **Step 1: Test qui échoue** (un seul `test`, tout au clavier ; chaque étape d'un joueur commence par un `page.goto`)
  0. `test.setTimeout(120_000)` ; un `browser.newContext()` par joueur, fermé en fin de test, puis les `auth.users` des deux joueurs supprimés.
  1. Seules écritures SQL : A et B par `makePlayer()` ; `imageCopy(A)` (I) et `giveCopies(A, 'C', 1)` (Z).
  2. A : `/profile/<B>` → « Ajouter en ami » → toast « Demande envoyée à <B>. », et le focus sur « Demande envoyée ».
  3. B : `/friends` → « Accepter » → toast.
  4. B : `/profile/<A>` → « Message » → `/dms?with=<A>` ; « Salut A », puis Entrée → la bulle.
  5. A : `/pulls` → badge « 2 » (`friend_accepted` et `chat_message`). La cloche, Entrée → « <B> t'a écrit », Entrée sur le lien → `/dms?with=<B>`, avec la bulle « Salut A ». Le `PATCH /rest/v1/chat_messages` est observé ; « Salut B », puis Entrée.
  6. B : `/dms` → la conversation avec A a la pastille « 1 » → l'ouvrir → « Salut B ». `sql` : les deux messages sont lus. `/pulls` → badge « 1 » : il reste la `friend_request` de l'étape 2, et la `chat_message` de A a été lue par le trigger.
  7. A : `/profile` → « Changer l'avatar » → I → « Avatar changé. » ; « Ajouter une carte à l'emplacement 1 » → Z → « Vitrine mise à jour. ».
  8. B : `/profile/<A>` → l'`img` d'avatar au `src` de I ; « Vitrine » montre Z ; « Message », « Proposer un échange » et « Signaler » présents.
- [ ] **Step 2: `npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/social-journey.spec.ts`** → vert du premier coup si les Tasks 11 à 14 sont justes ; sinon le défaut se corrige dans le code, jamais dans le parcours.
- [ ] **Step 3: Contrôles complets** → vert.
- [ ] **Step 4: Commit** — `test(e2e): parcours social au clavier, du profil à l'amitié, au message, à la réponse lue et à la vitrine vue par l'ami`

---

### Task 16: Bench refait — vitrine et abonnements dans l'acceptation, mesure de l'overlay

**Files:**
- Create: `load/bench/overlay.sql`
- Modify: `load/bench/trade_setup.sql:88-99` (vitrine et abonnements), `load/bench/run.sh`, `docs/verifications.md` (section « M4b — Task 16 : acceptation avec vitrine et push, overlay des amis »)

**Interfaces:**
- Consumes : toutes les migrations du M4b ; `run.sh` du M4a (`PG_FSYNC=on`, `deadlocks()`, invariants, p95).
- Produces :
  - `trade_setup.sql` :
    - chaque joueur des 10 paires reçoit un abonnement (`https://fcm.googleapis.com/fcm/send/bench-<n>`) et `push_types` = les 5 types `trade_*`. Ils sont posés à la fin du fichier, après la création des échanges, si bien que l'outbox est vide au départ ;
    - `bench.accept_next` pose, avant chaque acceptation, en plus de l'avatar, les 4 emplacements de vitrine de chaque joueur sur 4 copies seules de l'échange du tour, par `insert … on conflict (user_id, position) do update`, puis vérifie qu'il en a posé 8, sinon `raise exception`.
  - `run.sh`, après chaque taille :
    - les emplacements des 20 joueurs = 0 (tous pointaient vers des copies déplacées) ;
    - `select count(*) from wm.push_outbox` = 100 de plus (une `trade_accepted` par acceptation, un abonnement par initiateur) ;
    - p95 < 500 000 µs, comme au M4a ;
    - puis `delete from wm.push_outbox where true`.
  - `overlay.sql`, sur `wm_test` seulement :
    - un joueur O à 1 000 amis acceptés, chacun possédant les 50 premières cartes du seed, puis `analyze` (DG:467 : sans statistiques, des boucles imbriquées sur toute `user_cards`) ;
    - `load 'auto_explain'`, `set auto_explain.log_min_duration = 0`, `set auto_explain.log_nested_statements = on`, `set auto_explain.log_analyze = on`, `set client_min_messages = log`, puis `select wm.cards_overlay(O, <50 ids>)` ;
    - `run.sh` exige `user_cards_card_user_idx` et aucun `Seq Scan on user_cards` dans la sortie ;
    - puis `pgbench -n -c 1 -t 200` du même appel → p95 < 50 ms (B14).
- [ ] **Step 1: `bash -n load/bench/run.sh`**, puis `bash load/bench/run.sh` → échec tant que les scripts manquent.
- [ ] **Step 2: Implémenter**, puis `bash load/bench/run.sh` → le résumé ; p95 100 ↔ 100 < 500 ms ; 0 interblocage ; invariants vides ; plan et p95 de l'overlay dans les bornes.
- [ ] **Step 3: Consigner** dans `docs/verifications.md` :
  - la méthode du M4a, plus la vitrine, l'avatar et un abonnement par joueur ;
  - les p95 à côté de ceux du M4a ;
  - le plan de l'overlay et son p95 ;
  - « chiffres indicatifs (A5) ; le M8 mesure S5 sur Pro ».
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `perf(db): bench d'acceptation 100 ↔ 100 avec vitrine pleine et abonnements push des deux côtés, plan et p95 de l'overlay des amis (1 000 amis)`

---

### Task 17 (contrôleur): Livraison — migrations sur la démo, réveil sondé, variables VAPID, passation

**Files:**
- Modify: `docs/superpowers/HANDOFF.md`, `docs/suivi.md`, `docs/verifications.md`, `docs/decisions-graphify.md`, `docs/DESIGN.md` (une section « Profil, messages et notifications push », et « Pas de bouton "Message" avant le M4b » retiré de la section « Amis et échanges »)
- Create (non versionnés) : `.superpowers/sdd/2026-10-23-m4b-profil-messages-push/make-deploy-m4b.sh` et `deploy-m4b.sql`

> Ordre (R32, M4b-27) : variables, puis migrations, puis fusion. `develop` est la branche de production de Vercel, et ses pages appellent `wm.profile_get`, `wm.chat_*` et `wm.push_*`.

- [ ] **Step 1: Contrôles complets, revue de branche, PG17.**
  - Tout vert, `coverage:recap` à 66/90. Puis la revue finale de la branche (R31) et ses corrections.
  - Pousser la branche et lancer `ci.yml` sur sa tête (`workflow_dispatch`, MCP GitHub) : `checks` et `integration` verts sur `postgres:17`.
  - Une correction SQL arrivée après le Step 4 est une nouvelle migration `1860+`.
- [ ] **Step 2 (contrôleur): Relevé de la démo, en lecture seule** (MCP `execute_sql`) :
  - `current_setting('shared_preload_libraries')` contient `pg_net` ;
  - `pg_available_extensions` : `pg_net` 0.20.4, `installed_version` nul ; `to_regnamespace('net')` nul ;
  - `select name from vault.secrets where name = 'CRON_SECRET'` → une ligne (la valeur n'est jamais lue) ;
  - `max_worker_processes` = 6 ; `cron.job` liste quatre jobs du M3 et `wm-trade-expire`.
  Un écart se consigne, puis on décide avant d'aller plus loin.
- [ ] **Step 3 (contrôleur): Préparer `deploy-m4b.sql`** par `make-deploy-m4b.sh`, sur le modèle de `make-deploy-m4a.sh` :
  - `begin`, `set local lock_timeout = '5s'` ;
  - `cat` de `0006`, `1800`, `1810`, `1820`, `1830`, `1840`, `1850` et `9020` ;
  - `update wm.config set value = to_jsonb('https://wmr-ivm.vercel.app/api/cron/push'::text) where key = 'push_wake_url'` ;
  - les lignes d'historique, celle de `9020` conditionnée à `exists (select from pg_extension where extname = 'pg_net')` ;
  - `notify pgrst, 'reload schema'`, `commit`.
  **Répétition** comme au M4a (P4a:970-978) :
  - `db-test.sh --stop`, un worktree de `develop`, `--setup-only` ;
  - deux passes de `psql -v ON_ERROR_STOP=1 -f deploy-m4b.sql` → `COMMIT` ;
  - `helpers.sql` de la branche, puis `29_social.test.sql` et `30_push.test.sql` entre `begin` et `rollback` → verts ;
  - `md5` des définitions `wm` = celui de la branche ;
  - `wm.check_invariants()` = `[]`.
- [ ] **Step 4 (humain, demandé maintenant): Variables Vercel, puis le SQL.**
  - L'utilisateur génère la paire VAPID hors du dépôt (`npx web-push@3.6.7 generate-vapid-keys`), sans la coller dans la conversation. Il pose `VAPID_PRIVATE` et `VAPID_SUBJECT` = `https://wmr-ivm.vercel.app` en Production.
  - Puis il lance `deploy-m4b.sql` dans le SQL Editor du projet `iggurckxmoagsajzrnwd` (« Run without RLS »), sans rien sélectionner. En cas d'erreur, rien n'est appliqué, et l'historique est relu avant toute relance.
  - Si `net` est absent après coup, il relance `9020` seul, qui est idempotent.
- [ ] **Step 5 (contrôleur): Contrôles par le MCP**, consignés :
  - `cron.job` : `wm-push-wake`, `15 seconds`, `select wm.push_wake()`, actif ; une minute plus tard, des runs `succeeded` dans `cron.job_run_details` ; `net._http_response` sans ligne neuve tant que l'outbox est vide (C19) ;
  - droits : `role_table_grants` sur les quatre tables pour `anon` et `authenticated` → seulement `authenticated SELECT` sur `chat_messages`, plus la colonne `read` en `UPDATE` (`column_privileges`) ;
  - sondes avec la clé publiable : `GET /rest/v1/reports` → 401 `42501` ; `POST /rest/v1/rpc/push_claim` avec `Content-Profile: wm` → 401 `42501` ;
  - `wm.check_invariants()` = `[]` ; `get_advisors` `security` → aucune nouvelle alerte à nous ; `performance` → au plus des INFO « unused index » sur les index du M4b ;
  - taille de la base et du WAL, avant et après.
- [ ] **Step 6 (contrôleur): Fusion `--no-ff` dans `develop`** de la tête validée au Step 1, push, déploiement READY.
  - `/api/health` → 200 avec `push_lag_s` nul ; `health.yml` en `workflow_dispatch` → vert.
  - **Sonde du réveil** (M4b-17) : un abonnement d'essai pour un compte de démo choisi par l'utilisateur (`https://fcm.googleapis.com/fcm/send/probe-<uuid>`, clés valides générées hors du dépôt), `push_types` `['auction_won']`, et une notification d'essai insérée par le MCP. Attendu : dans les 15 s, une ligne de `net._http_response` au `status_code` 200 ; la réponse `{sent, gone, failed}` est consignée, avec l'abonnement factice compté `gone` ou `failed`. Un 401 signale une valeur du Vault différente de celle de Vercel.
  - Facultatif : l'utilisateur active le push sur son navigateur, et une action d'un autre compte (demande d'ami) le fait recevoir, ce qui est consigné.
- [ ] **Step 7: Passation**
  - `HANDOFF.md` :
    - l'état du M4b ;
    - chaque critère du D§13 pour le M4 entier, et sa preuve : 100 ↔ 100 (Task 16 et M4a), atomicité et rejeu (M4a), push en CI (Task 10), §3.6 et §3.7 (66/90) ;
    - une section « Exploitation du push » : arrêt d'urgence `select cron.alter_job(jobid, active := false) from cron.job where jobname = 'wm-push-wake'`, et son effet (`after()` continue, la cloche reste juste) ; rotation des clés VAPID (tous les abonnements tombent) ;
    - l'étape suivante : le M5.
  - `docs/suivi.md` : la section M4b soldée ; S:40-44 rayés. Reportés :
    - au M6 : la file staff des signalements, la suppression des messages par le staff, l'effacement des abonnements à la suppression de compte ;
    - au M7 : la seconde cloche et `selectors.spec.ts` ;
    - au M8 : une table de conversations si `chat_conversations` pèse, `profile_collection` qui calcule `pendingTradeCardIds` pour rien, l'image de catalogue changée qui reste en avatar (M4b-6).
  - `docs/decisions-graphify.md` : M4b-1 à M4b-33, les écarts, B1 à B14.
  - `docs/verifications.md` : la répétition, PG17, les contrôles MCP, la sonde, le renvoi au bench de la Task 16.
- [ ] **Step 8: Commit** — `docs: M4b livré — profil, vitrine, messages, signalements et Web Push sur la démo, réveil pg_net sondé, passation`
- [ ] **Step 9 (contrôleur): Push et CI.** Pousser, lancer `ci.yml` → vert, fusion `--no-ff` dans `develop`, push.

---

## Auto-revue

- **Couverture du spec.**
  - D§7.9 :
    - profil (Tasks 3, 8, 11, 12) ; vitrine de 4 emplacements, `DELETE` à corps JSON (Tasks 1, 3, 8, 12) ;
    - messages entre amis, 2 000 caractères, 30 par minute, `PATCH` direct, poll de 5 s (Tasks 1, 4, 9, 13) ;
    - signalements un par couple (Tasks 1, 5, 8, 11) ;
    - Web Push :
      - abonnement (Tasks 6, 10) ;
      - `public/sw.js` (Task 14) ;
      - trigger *statement-level* filtré par type (Task 6) ;
      - `after()` et réveil de 15 s conditionnel (Tasks 6, 10) ;
      - 500 lignes et vagues de 50, 404/410 (Tasks 6, 10) ;
      - notification dans la transaction (Tasks 4, 6).
  - D§7.0 : `actor`, verrous C4, idempotence, erreurs, C17 (Tasks 3 à 6, et scénarios de `18_social_concurrency`).
  - D§7.12 : signalements stockés, file staff au M6.
  - D§8 : 12 routes du §3.7 (Tasks 8, 9) et routes ajoutées (Task 10) ; 429 du D§8.2 (Tasks 4, 9) ; axe par route, clavier, 44 px, `alt=""` (Tasks 11 à 15).
  - D§9 : index du D:811 et deux de plus (Task 2) ; poll de 5 s (Task 13) ; bench 100 ↔ 100 avec vitrine et push (Task 16).
  - D§12.3 : retard de l'outbox dans `/api/health` (Task 6).
  - D§13 (D:1083) : push en CI (Task 10), §3.7 vert (Task 9), §3.6 inchangé (Tasks 2 et 9).
  - Héritages S:40-44 : Tasks 1, 2, 3, 6, 7 et 14.
- **Scan des étapes.** Chaque étape de test donne ses valeurs, et chaque étape de code sa signature, son fichier et ses valeurs. Corrigé pendant la relecture :
  - l'E2E des émojis de la Task 13 : `maxLength` garde 1 000 émojis, pas 2 000 ;
  - le badge de B à l'étape 6 du parcours : il reste la `friend_request`, donc « 1 » ;
  - le trigger d'avatar gagne une clause `when`, qui protège un `avatar_url` migré sans copie, avec ses deux tests (Tasks 2 et 3) ;
  - le scénario 3 du signalement se joue dans les deux sens, faute de connaître l'ordre des triggers de clé étrangère ;
  - l'expression de `p256dh` : le dernier caractère porte 4 bits, donc `[AEIMQUYcgkosw048]`, et non 2 bits ;
  - la pastille passe en `relative z-10` au-dessus du bouton du `h3` ;
  - les abonnements du bench sont posés après les échanges ;
  - `maskPath` est éprouvé par un test unitaire, et non par la lecture d'un journal ;
  - les lignes citées de `1600`, `1740` et `28_trades` sont recalées sur le code.
  Les corps de code n'apparaissent que pour l'ordre des refus, les expressions de `p256dh` et `auth`, et le rappel d'`after()`, que les tests ne fixent pas seuls.
- **Cohérence des noms.**
  - Les fonctions consommées par les routes (Tasks 8 à 10) sont définies aux Tasks 3 à 6, avec les mêmes paramètres :
    - `profile_update(p_uid, p_username, p_bio, p_is_public, p_avatar_user_card_id, p_avatar_set, p_idem)` ;
    - `showcase_put(p_uid, p_position, p_user_card_id, p_idem)` et `showcase_delete(p_uid, p_position, p_idem)` ;
    - `chat_send(p_uid, p_peer_id, p_content, p_idem)`, `chat_thread(p_uid, p_peer_id)` ;
    - `report_get(p_uid, p_reported_user_id)` et `report_upsert(p_uid, p_reported_user_id, p_reason, p_details, p_idem)` ;
    - `push_subscribe(p_uid, p_endpoint, p_p256dh, p_auth, p_idem)`, `push_unsubscribe(p_uid, p_endpoint, p_idem)`, `notification_prefs_set(p_uid, p_push_types, p_idem)`, `push_claim(p_limit)`, `push_gone(p_subscription_ids)`.
  - `tests.image_card` (Task 2) sert aux Tasks 3, 8 et 11, et `imageCopy` porte le même nom dans le contrat et dans les E2E, en deux modules distincts.
  - `PUSH_FAMILIES` et `pushTypes` (Task 10) servent à la Task 14 et répondent à `wm.config.push_types` (Task 2), ce que vérifie un test.
  - `friendOwner` reste une chaîne dans `Card` (Task 7).
- **Review Focus.** Chaque ligne a son test dans la tâche qui possède le code :
  - endpoints et navigateur partagé : Task 6 ;
  - débit et contenu : Tasks 4, 9 et 13 ;
  - pseudo hérité : Tasks 8 et 11.
- **Proportion.** Dix-sept tâches, pour douze routes du §3.7, cinq routes ajoutées, trois pages, la section push et le bench. Les tableaux d'interface tiennent lieu de code. Le plan fait environ 1,2 fois le design (1 119 lignes), un peu plus que le M4a (1 032 lignes), pour une tâche de plus et le push. Aucune tâche ne transcrit un corps de fonction.
