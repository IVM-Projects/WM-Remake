# M5b — Guildes, succès, classements : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ouvrir les guildes, les succès et les classements, et finir la ligne M5 de D:1084. Un joueur crée une guilde (gratuite, 200 membres au plus) ou en rejoint une sur l'invitation d'un ami membre ; le chef exclut et transmet son rôle, le dernier membre qui part la dissout. Les membres discutent (chat de 1 000 caractères, poll de 5 s, seau de rafale partagé avec les messages privés), demandent une carte chacun, et se donnent des copies (1 don reçu par jour UTC, +1 karma au donneur). Chaque semaine (lundi 00:00 UTC), une guilde marque 500 points par bataille gagnée par un membre et 1 point par wikibidou de ses ventes ; le classement change de clé sans aucun job. Les 51 succès (12 connus, 39 inférés) se débloquent par `check` (1 par 5 min) et se réclament une fois. Le classement des joueurs (victoires, collection, légendaires ; semaine ou depuis toujours) ouvre `GET /api/leaderboard`. Critères du jalon pris ici (D:1084, M5a-1) : test de la borne hebdomadaire, réclamation rejouée qui ne crédite qu'une fois, contrat §3.8 et §3.10 vert, soit `coverage:recap` 70 → **90 sur 90**, rendu bloquant.

**Architecture:**
- Miroir `0008` : huit tables (`guilds`, `guild_members`, `guild_wishlists`, `guild_donations`, `guild_chat_messages`, `guild_weekly_scores`, `achievements`, `user_achievements`). Seules les deux tables de succès sont lisibles par PostgREST (R:267) ; tout le reste passe par des routes minces et des fonctions `wm.*`.
- Les écritures de guilde suivent M5b-1 : les profils d'abord, puis la ligne `guilds` en `for no key update` (compatible avec le `for key share` d'une clé étrangère) ; `leave` et `kick` ne prennent aucun profil en exclusif. Le score s'écrit par une seule aide, `wm.guild_score_add`, appelée en dernier par `wm.battle_finish` (+500) et `wm.settle_auction` (prix final), qui ne lève jamais faute de guilde.
- Le don déplace une unité par `wm.move_copies`, aide extraite de `wm.trade_move` (D-C19), qui la rappelle sans changer de signature.
- `wm.week_start` est la seule horloge hebdomadaire (D-C12) ; les métriques de succès se calculent au `check` depuis les tables sources (D-C16) ; les deux classements passent par `'use cache: remote'` (30 s et 60 s), la part du lecteur (`me`, `user_guild_id`, `reset_in_ms`) hors cache (D-C14, D-C15).
- Pages `/guild` (sans guilde, puis onglets Chat, Entraide, Membres, Classement), `/achievements`, `/leaderboard` ; `ComingSoon` disparaît.

**Tech Stack:** celle du M5a (next 16.4.2, react 19.3.1, @supabase/supabase-js 2.118.0, zod 4.6.7, vitest 5.0.5, @playwright/test 1.64.1, @axe-core/playwright 4.14.0, PostgREST v12.2.3, GoTrue v2.197.0, PostgreSQL 17.11 sur la démo, `pgbench` 16 au banc). **Aucune dépendance npm ajoutée**, aucun job pg_cron (D:575), aucun LLM.

**Spec:** `docs/superpowers/specs/2026-10-18-*-rebuild-design.md` (un seul fichier y répond ; le nom n'est pas recopié ici, dépôt public), cité D§x ou D:ligne : surtout D§6.2 (D:266-268), §7.8 (D:568-591), §7.10 (D:606-614), §8.2 (D:668-689), §9.4 (D:812), §9.5 (D:822, D:833), §12.1, la ligne M5 du §13 (D:1084). Le récap `docs/rea-recap.md` est cité R§x ou R:ligne : surtout R§3.8 (R:261-268), §3.10 (R:281-297), §4.1 (R:342), §5.8 (R:624-630). Le plan du M5a est cité P5a:ligne, `docs/decisions-graphify.md` DG:ligne, `docs/suivi.md` S:ligne. Les rulings du contrôleur (`4-rulings.md`) et les trois rapports de repérage du M5b ne sont pas versionnés : ce plan recopie chaque valeur dont une tâche a besoin.

## Global Constraints

- **Toutes les contraintes globales des plans M0 à M5a restent en vigueur** (P5a:20-75) :
  - versions exactes ; lire le guide de `node_modules/next/dist/docs/` avant de toucher une API Next (`AGENTS.md`), et en plus pour le M5b :
    - `01-app/03-api-reference/03-file-conventions/route.md` et `dynamic-routes.md` (seize fichiers de route, dont `invites/[guildId]`) ;
    - `01-app/03-api-reference/01-directives/use-cache-remote.md`, `04-functions/cacheLife.md` et `cacheTag.md` (deux classements en cache partagé, Task 12) ;
    - `01-app/02-guides/preserving-ui-state.md` (Activity : relecture à chaque affichage, modales fermées) ;
  - fonctions `wm.*` en `security definer` et `set search_path = ''`, sans autre entrée dans `proconfig`, `EXECUTE` à `service_role` seul ; chaque migration `wm` finit par les cinq lignes `revoke`/`grant` de `1900_wm_battle_core.sql:141-145`, et `10_wm_core.test.sql:144-160` le vérifie. Aucune exception au M5b (aucun `9xxx`) ;
  - migrations idempotentes, expand-only, PG16 et PG17 ; toutes les tables avant toute fonction `language sql` (C1 du M5a) : elles naissent en `0008` et en tête de `2000` ;
  - une fonction redéfinie garde sa signature et sa réponse, et reprend **le corps entier** de sa dernière définition, plus ses ajouts (en-tête « même signature, même corps et même réponse qu'en XXXX (déployée, non retouchée), plus … », modèle `1860:1-3`). Redéfinies au M5b : `wm.check_invariants` (dernière en `1900:71-139`, gagne `ach_money`, Task 2), `wm.trade_move` (`1800:66-93`, Task 5), `wm.battle_finish` (`1930:24-50`) et `wm.settle_auction` (`1630:5-38`, Task 7). Leçon de `1960` (M5b-17) : aucune des quatre ne porte de réglage dans `proconfig` ; une redéfinition qui en rencontrerait un le redit ;
  - tout `DELETE`/`UPDATE` garde un `WHERE` (`scripts/check-dml.ts`) ;
  - chaînes d'erreur exactes, `error` = `message`, levées par `wm.raise_err(p_status, p_code, p_message, p_extra)` (`1000_wm_core.sql:58`) et recopiées par `route()` ;
  - aucune PII dans les logs ; « tu » dans le jeu, apostrophe ASCII dans les chaînes ; thème sombre ; ports du banc du M1 ; aucun chemin de code réservé aux tests ;
  - formes JSON : clés en plus permises, jamais de clé retirée ; les contrats existants ne changent pas, sauf l'ajout de `guild_points_win` dans `rules` (Task 2), qui est une clé en plus.
- **Dépôt public** (M2-R1, DG:150) : aucun nouveau fichier ne nomme la marque du jeu d'origine, son domaine ni son exploitant, données d'amorce des succès comprises ; aucun nom de joueur, de carte ni de guilde de la démo dans `docs/` ni dans un journal d'Actions (les preuves consignent des comptes et des ids) ; aucun secret.
- **La CI reste verte après chaque tâche.** Contrôles rapides (job `checks`) : `npm run typecheck && npm run lint && npm test && npm run coverage:recap`. Contrôles complets (`checks` + `integration`) : les rapides, puis `npm run test:db && npm run build:test && npm run test:contract && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e`. Une tâche qui touche une migration, `supabase/tests/`, l'app ou le contrat lance les contrôles complets.
- **Verrous (C4, M5b-1)** :
  - opération de guilde qui écrit une ligne référençant un profil (`guild_create`, `guild_join`, `guild_invite`, `guild_transfer`, `guild_wish_set`, `guild_donate`, `guild_chat_send`) : d'abord les profils (`wm.lock_user` ou `wm.lock_users`, ordre des id), puis la guilde ;
  - la ligne `guilds` se prend en `for no key update` quand l'opération change la guilde ou ses membres (`join`, `invite`, `transfer`, `leave`, `kick`), en `for key share` quand elle n'y insère qu'une ligne qui la référence (`guild_chat_send`, `guild_wish_set`, `wm.guild_score_add`) ; `for update` seulement pour la supprimer (`guild_leave` du dernier membre) ;
  - `guild_leave` ne prend aucun profil ; `guild_kick` prend seulement le profil de l'exclu `for key share`, **avant** la guilde (G2) ;
  - le souhait est une ligne métier : `guild_donate` et `guild_wish_set` le prennent `for update` **avant** tout profil (D:574, G3) ; la copie du donneur vient après les profils ;
  - `perform set_config('lock_timeout', '2s', true)` précède le premier verrou de chaque fonction d'écriture ; contrôle `tests.lock_timeout_violations` (`supabase/tests/helpers.sql:86-95`). `wm.guild_score_add` et `wm.move_copies`, appelées sous les verrous de leur appelant, n'en posent pas ;
  - `wm.actor` ne verrouille rien et passe après `idem_claim` ; une insertion de notifications est une seule instruction `order by user_id` (P28).
- **Argent** (P4a:36-39) : seul `wm.wallet_apply` écrit un solde. Raison `achievement`, référence `ach:<achievement_id>`, une ligne par réclamation (D:611, D-C16). Un don et un score ne déplacent aucun wikibidou. Un test de chaque fonction monétaire ou qui déplace une copie finit par `wm.check_invariants()` = `'[]'` (filtré sur ses joueurs dans un E2E, P5a:71).
- **Notifications** (M5b-11, D-C17) : `guild_invite` (à l'invité), `guild_kicked` (à l'exclu), `guild_donation` (au receveur), cloche seulement. `data` en snake_case, sans texte libre hors le nom de guilde = `{guild_id, guild_name, user_id, username}` de l'acteur. `wm.config.push_types` reste à 13 ; ni `PushTypes` (`lib/schemas.ts:88`), ni `PUSH_FAMILIES`, ni `e2e/settings.spec.ts` ne changent ; aucune route de guilde ne prend `push: true` (commentaire d'une ligne, modèle `app/api/battles/[battleId]/route.ts:6`).
- **DOM** : aucun sélecteur du R§6.8 ne vise ces pages (R:736). Règles de la maison (P5a:60-67) : aucun `id` fixe ; jamais `placeholder="Rechercher par titre ou catégorie..."` ni `aria-label="Fermer"` ; `Card` pour toute carte ; cibles de 44 px (mesurées à 0,01 près, `e2e/battle.spec.ts:8-9`) ; nombres par `formatInt` ; `aria-disabled` et une garde, jamais `disabled` ; 360 px sans défilement horizontal ; texte libre (nom de guilde, description, pseudo, message) en `wrap-anywhere`, description et chat en `whitespace-pre-wrap` ; focus jamais sur `body` (effet après rendu, seulement si `document.activeElement === document.body`, et un `toBeFocused()` par cible listée dans la tâche) ; pseudo encodé par `encodeURIComponent` dans tout lien ; `alt=""` pour un avatar à côté du pseudo.
- **Motifs imposés à chaque page** (P5a:68) : lectures ordonnées (génération ou `hold`) ; un 2xx illisible est une lecture en échec, avec sa boucle E2E `for (const [label, reply] of [['500', { status: 500 }], ['200 illisible', { status: 200, body: 'x' }]] as const)` par `routeOnce` ; une issue incertaine dite (`UNSURE`, `lib/api.ts:40`), prise au départ et effacée quand l'état affiché change ; `data-ready` ; clés `apiOnce` oubliées après une relecture qui refuse la relance ; relecture à chaque affichage (Activity).
- **E2E** (P5a:69-73) : chaque test crée ses joueurs, copies, amitiés et guildes (`makeGuild`, Task 15), puis supprime ses `auth.users` (cascade) ; toujours `routeOnce` ; deux joueurs = deux `browser.newContext()` avec `addCookies` ; une valeur de `wm.config` changée l'est dans `try`/`finally` avec la garde de `e2e/pulls.spec.ts:22-31`. Les classements sont en cache partagé (30 s, 60 s) et globaux : un E2E n'affirme le contenu d'une table de classement que sur un corps posé par `routeOnce` (`fulfill`), ou par `expect(…).toPass({ timeout: 40_000 })` avec relecture ; `me` (« Ton rang ») est par requête, donc exact.

### Catalogue des erreurs (toutes « inféré », D:689, sauf mention)

Corps `{status, code?, error, message, …extra}` levé par `wm.raise_err`.

| Statut | `code` | Message |
|---|---|---|
| 400 | `invalid_request` | « Le nom de la guilde est vide » · « Un nom de guilde fait au plus 40 caractères » · « Une description fait au plus 280 caractères » · « Tu ne peux pas t'inviter toi-même » · « Tu ne peux pas t'exclure toi-même » · « Tu es déjà le chef de la guilde » · « Tu ne peux pas te donner une carte » · « Cette carte n'est pas celle demandée » · « Le message est vide » (repris de `1860:27`) · « Un message fait au plus 1 000 caractères » · « Classement inconnu » · « Période inconnue » · « Événement inconnu » · messages zod |
| 403 | `FORBIDDEN` | « Vous devez être amis pour inviter ce joueur » (forme de D:684) · « Aucune invitation de cette guilde » (`join`) · « Seul le chef de la guilde peut faire cela » · « Ce souhait n'est pas dans ta guilde » |
| 403 | `42501` | « Vous ne possédez pas cette carte » (D:675) |
| 404 | — | « Joueur introuvable » (existant) · « Guilde introuvable » · « Tu n'es dans aucune guilde » (M5b-9, pour toute lecture ou écriture d'un joueur sans guilde) · « Ce joueur ne fait pas partie de ta guilde » · « Aucune invitation de cette guilde » (refus d'une invitation absente) · « Carte introuvable » (D:682) · « Tu ne demandes aucune carte » · « Ce souhait n'existe plus » · « Succès introuvable » |
| 409 | — | « Tu fais déjà partie d'une guilde » · « Ce joueur fait déjà partie d'une guilde » · « Cette guilde est pleine » · « Transmets d'abord ton rôle de chef à un autre membre » (M5b-10) · « Ce membre a déjà reçu un don aujourd'hui » · « Cette carte est déjà engagée dans un échange en attente » (D:676) · « Ce succès n'est pas encore débloqué » · « Ce succès a déjà été réclamé » (D-C16) |
| 429 | — | « Le site demande de ralentir » + `retry_after` en secondes (D:685, M4b-29) : chat de guilde (seau `chat_burst` partagé, entre 1 et `window_s`) et `achievements_check` (entre 1 et `check_interval_s`) |

Textes des notifications (inférés, `lib/notification-view.ts`, Task 14) : `guild_invite` « {username} t'invite dans la guilde {guild_name} », `guild_kicked` « Tu ne fais plus partie de la guilde {guild_name} », `guild_donation` « {username} t'a donné la carte que tu demandais », tous vers `/guild`. Tous les textes d'interface de `/guild`, `/achievements` et `/leaderboard` sont inférés (aucune capture, R:131, R:135, R:136), sauf « Entraide de la semaine » (R:627), les cinq catégories et les titres connus de succès (R:630) ; ils sont donnés mot pour mot dans leur tâche.

## Décisions (contrôleur, à consigner dans `docs/decisions-graphify.md`, Task 20)

Règles de conduite inchangées (DG:339). Format : décision — pourquoi — coût si faux. M5b-1 à M5b-18 recopient les rulings R1 à R18 du contrôleur (2026-10-30), dans leur ordre ; ils complètent D-C9 à D-C20 (DG:871-892).

- **M5b-1. Verrous des guildes** : toute écriture de guilde qui touche des profils les prend d'abord, puis la ligne `guilds` en `for no key update` ; seule la suppression d'une guilde prend `for update` ; `leave` et `kick` ne verrouillent aucun profil (D-C9) — ferme le cycle avec `battle_finish` que D-C9 laissait ouvert pour `create`, `join`, `invite`, `transfer` — un scénario de concurrence par opération (Task 10).
- **M5b-2. Crochet de score** : `wm.guild_score_add(p_user_id uuid, p_kind text, p_amount int, p_at timestamptz)` trouve la guilde par `guild_members` ; sans guilde, ou guilde disparue, no-op, jamais une erreur ; appelé en dernier (après `wallet_apply` et les notifications) ; `p_at` = `now()` partout ; les tests passent des instants explicites autour du lundi 00:00 UTC : c'est le test de la borne de D:1084, sans horloge truquée — un paramètre de plus.
- **M5b-3. +500 points** au gagnant de toute bataille finie avec un gagnant (victoire, abandon, inactivité : les trois passent par `battle_finish`), même contre un membre de sa guilde, sans plafond ; collusion chiffrée au suivi (M7) ; `rules.guild_points_win` (500) dans `GET /api/battles` et sur l'écran de fin ; `BattleRules` gagne la ligne — D ne pose aucune garde — un abus visible au classement.
- **M5b-4. Souhait** : un ouvert au plus par membre ; `PUT` remplace l'ouvert ; un don le clôt (`fulfilled_at`), la ligne reste ; le donneur choisit sa copie (`{wishlist_id, user_card_id}`), le serveur vérifie qu'elle est du `card_id` demandé et libre ; pas de `donor_user_card_id` ; un départ supprime le souhait ouvert du membre — une colonne.
- **M5b-5. `check`** : instant du dernier `check` réussi dans `wm.user_state.achievements_checked_at` ; fenêtre fixe de 5 min ; un `check` sans déblocage compte ; refus 429 au corps M4b-29 ; `check` crée les lignes `user_achievements`, jamais `claim` ; `claim` d'un succès non débloqué → 409, rejeu sans clé → 409 « Ce succès a déjà été réclamé », même clé → la réponse stockée — une colonne.
- **M5b-6. Listes** : `members` en `limit` + `offset` avec `hasMore` ; chat = les 100 derniers (`list_caps.guild_messages`), du plus ancien au plus récent, relus en entier toutes les 5 s, page visible ; classements top 100 ; égalités au rang partagé (`rank()`), départage d'affichage par nom ; `week_end` exclusif (`week_start + 7 jours`).
- **M5b-7. Karma** : `weekly_karma_donors` = les 10 membres de la guilde du lecteur aux plus de dons depuis `week_start` (égalités par nom) ; le karma total n'est affiché nulle part.
- **M5b-8. Invitations** : sans durée de vie ; `invite` exige l'amitié et réécrit une invitation existante ; effacées quand le joueur rejoint une guilde et en cascade avec la guilde ; listées dans `GET /api/guilds` sous `invites: [{guild_id, guild_name, inviter_username, created_at}]`, la plus récente d'abord — une clé en plus.
- **M5b-9. Sans guilde** : `/home`, `/members`, `/chat` → 404 « Tu n'es dans aucune guilde » ; `GET /api/guilds/leaderboard` rend `user_guild_id: null`.
- **M5b-10. Départs** : les messages restent ; le chef ne peut pas s'exclure ; un chef qui part alors que d'autres membres restent → 409 ; un chef seul qui part supprime la guilde (D-C20) ; transfert vers soi → 400.
- **M5b-11. Notifications** : cloche seulement ; `guild_invite`, `guild_kicked`, `guild_donation` ; `data` = ids et pseudos, nom de guilde permis ; textes dans `lib/notification-view.ts`.
- **M5b-12. Succès** : 12 connus (R:630) + 39 inventés (`inferred = true`, +10 à +100) ; `first_rarity` = au moins une copie de la rareté dans `user_rarity_counts` au `check` ; un succès débloqué le reste après une défausse ou une vente.
- **M5b-13. Classement des joueurs** : `battles` (victoires), `collection` (Σ des copies possédées), `legendary` (Σ des copies L) ; `period=week` : batailles `completed` dont `updated_at >= week_start`, copies dont `obtained_at >= week_start` ; un joueur à 0 est absent ; `me` = rang réel parmi tous (coût en `shortcut:`, M8) ou `null` à 0 ; défaut `battles`/`week` (D:614).
- **M5b-14. Saison** : `season` = `'S' || to_char(week_start, 'IW')` dans le classement des guildes, calculée en SQL ; le client décompte `reset_in_ms` et relit à zéro.
- **M5b-15. Pages** : `/guild` sans guilde (créer, invitations reçues), avec guilde (onglets Chat par défaut, Entraide, Membres, Classement) ; `/achievements` par catégorie ; `/leaderboard` (Joueurs, Guildes) ; aucun raccord au profil ; « Demander une carte » = une `Modal` de recherche du catalogue (2 caractères, route existante) ; le chat reprend `Thread` paramétré ; la modale « Donner » dit en une ligne que la copie quitte la vitrine ou l'avatar ; `ComingSoon` supprimé à la dernière page.
- **M5b-16. Dette Wikimédia** : compteur `fallback` dans le résumé de `generate.ts`, et pas de `quiz_fail('short_text')` sur un texte de repli (la carte reste en file).
- **M5b-17. Numéros et livraison** : miroir `0008`, fonctions `2000`+, aucun cron ; `deploy-m5b.sql` au SQL Editor sur le modèle de la Task 16 du M5a ; tout `create or replace` d'une fonction à réglage le redit.
- **M5b-18. Rejeux dans les tests** : un test qui rejoue une ancienne migration (`29_social.test.sql:75`, `31_battles.test.sql:70`) la fait suivre de toutes celles qui redéfinissent ses fonctions.

**Écarts au spec (les décisions l'emportent, à consigner) :**
- D:349 range les dons parmi les bornes de jour du fuseau ; D:588 et D-C13 prennent le jour UTC du receveur.
- D:572 : l'invitation est une notification **et** une ligne `wm.guild_invites` (D-C10).
- D:583 : création gratuite, sans clé `guild_create_cost` (rien ne la lirait, G9).
- D:609 écrit `achievement_rules(metric, threshold)` : la table porte `achievement_id`, `metric`, `threshold`, `rarity` et `inferred` (D:266, D-C16) ; D:610 nomme `user_stats`, `user_rarity_counts` et la vitrine, les métriques lisent aussi batailles, échanges, ventes et dons (D-C16).
- D:612 marque les 39 inférés dans `docs/parity.md`, qui n'existe pas encore : la colonne `inferred` tient lieu de marqueur jusqu'au M7.
- D:613 lit `user_stats` et `user_rarity_counts` : `period=week` se calcule depuis `public.battles` et `public.user_cards` (D-C14).
- R:297 : clé en plus `season` ; R:285 : clé en plus `invites` ; R:289 : clé en plus `my_copies` dans `Wish` (G6) ; R:276 : clé en plus `guildPoints` dans `game_state` (G5).

## Décisions ajoutées par ce plan (à consigner avec les précédentes)

Numérotées Gn, pour ne pas se confondre avec les Cn du M5a.

- **G1. Fichiers.**
  - Migrations : `0008_mirror_progress.sql` ; `2000_wm_progress_core.sql` (config, tables `wm`, colonne de `user_state`, index, `week_start`, `guild_score_add`, `notify_guild`, `check_invariants`) ; `2010_wm_guilds.sql` (lecture, création, invitations, adhésion, départ, exclusion, transfert, membres) ; `2020_wm_guild_help.sql` (`move_copies`, `trade_move`, souhait, don, entraide) ; `2030_wm_guild_chat.sql` ; `2040_wm_score_hooks.sql` (`battle_finish`, `settle_auction`) ; `2050_wm_achievements.sql` (amorce, règles, valeurs, `check`, `claim`) ; `2060_wm_leaderboards.sql`.
  - Tests : `supabase/tests/34_guilds.test.sql`, `35_achievements.test.sql`, `36_leaderboard.test.sql`, `20_guilds_concurrency.test.sh` ; `contract/spec/guilds.ts`, `achievements.ts`, `leaderboard.ts` ; `e2e/guild.spec.ts`, `achievements.spec.ts`, `leaderboard.spec.ts`, `guild-journey.spec.ts`.
- **G2. `kick` prend l'exclu `for key share` avant la guilde.** Sa notification `guild_kicked` prend ce verrou de toute façon, mais après la guilde : un `invite` de l'exclu (son profil en exclusif, puis la guilde en `no key update`) ferait alors un cycle. Le prendre d'abord est la règle M4b-31 (P5a:44) : face à un `battle_finish` qui tient ce profil, `kick` attend sans rien tenir encore, donc sans cycle — précision de M5b-1, qui dit « aucun profil » pour le verrou exclusif — coût : un `perform` de plus.
- **G3. Le souhait avant le profil**, aussi dans `guild_wish_set` (remplacer l'ouvert) et `guild_wish_clear` : `guild_donate` tient le souhait puis les profils (D:574) ; prendre le profil d'abord ferait un cycle. `leave` et `kick` suppriment le souhait ouvert après la guilde, sans profil : ils attendent un don en cours, sans cycle — aucun coût.
- **G4. Lots et lignes de score.** `settle_due_auctions` et `expire_battles` tiennent chacun plusieurs lignes `guild_weekly_scores` jusqu'à la fin de leur lot, dans l'ordre de leurs enchères ou batailles : deux lots qui touchent deux mêmes guildes en ordre inverse s'interbloquent. Accepté : PostgreSQL annule la sous-transaction d'un des deux, que le lot avale (`raise warning`), et l'enchère ou la bataille est reprise au passage suivant (10 s ou 15 min), sans perte. `-- shortcut: lots non triés par guilde (G4) ; trier les lignes de score avant la boucle si les avertissements apparaissent.` dans `wm.guild_score_add`. Un `battle_finish` unique peut attendre un lot plus de 2 s et rendre 503 `BUSY` (accepté par D-C9) — coût : un avertissement et un délai, jamais un score perdu.
- **G5. Les points de guilde d'une bataille finie** vont dans `game_state.guildPoints` (500, ou 0 sans guilde), écrit par `battle_finish` après `guild_score_add` sur la ligne déjà tenue ; l'écran de fin les lit là. `reward` reste l'entier du grand livre (sa forme ne peut pas changer) — précision de M5b-3 (« dans le `reward` de fin du détail ») — coût : une clé en plus dans `game_state`.
- **G6. `Wish.my_copies`** : les copies du lecteur du `card_id` souhaité, `[{id, count, is_shiny}]`, triées par id, vides si `wm.card_locked` ; la modale « Donner » y choisit la copie quand il y en a plusieurs — M5b-4 demande que le donneur choisisse sans que le serveur désigne une copie, et `/api/my-collection` n'a pas de filtre par `card_id` — coût : une clé en plus.
- **G7. Repli Wikimédia** = la lecture de TextExtracts en échec (la branche `catch` de `textOf`, `scripts/quiz/generate.ts:130-131`). Une page sans extrait est une réponse définitive de Wikipédia et garde son `quiz_fail('short_text')` — sinon une carte sans extrait resterait en tête de file à vie — coût : aucun.
- **G8. Les 39 succès inférés** (tableau de la Task 8) : métriques, seuils et récompenses fixés ici ; titres rédigés par l'implémenteur (D:1097), descriptions par modèle fixe. Ids = `md5('wm-ach:' || code)::uuid`, stables d'un rejeu à l'autre et d'une base à l'autre (D:612 : remplacés à la migration) — coût : des titres à revoir avec l'utilisateur.
- **G9. Config.** `guild` = `{"max_members": 200, "donations_per_day": 1}` ; `achievements` = `{"check_interval_s": 300}` ; `list_caps` gagne `{"guild_messages": 100, "guild_members": 50, "leaderboard": 100, "karma_donors": 10}` ; `battle` gagne `{"guild_points_win": 500}` (donc `rules`, M5a-16). Pas de clé pour le coût de création (0, D:583) ni pour les longueurs de texte (contraintes `check` et messages en SQL).
- **G10. Chat de guilde** : la fenêtre `chat_window_*` des messages privés, recopiée dans `wm.guild_chat_send` (deux instructions, commentaire « même fenêtre que `wm.chat_send` (D-C18) ») plutôt qu'extraite : extraire redéfinirait `wm.chat_send` (`1860`) et l'ajouterait au déploiement — coût : deux instructions en double.
- **G11. Cache des classements** : `lib/leaderboard-cache.ts` reprend `sharedRpc` et `busy` de `lib/market-cache.ts`, qui les exporte (aucune autre ligne n'y change) ; profils `guilds: { stale: 30, revalidate: 30, expire: 60 }` et `players: { stale: 30, revalidate: 60, expire: 120 }` ; `board` et `period` validés par zod **avant** la clé du cache (une valeur libre remplirait le cache). `reset_in_ms` = `max(0, week_end − Date.now())` en TypeScript.
- **G12. `coverage:recap` bloquant dès 90/90** (Task 12) : `process.exitCode = missing.length ? 1 : 0`, au lieu d'attendre le M7 (`contract/recap-coverage.ts:12`) — le critère du jalon devient un garde-fou de la CI — coût : aucun, il n'y a plus de route manquante.
- **G13. `Thread` paramétré** par `channel: { kind: 'dm'; peerId: string } | { kind: 'guild' }` (M5b-15) ; le DOM des messages privés ne change pas (`e2e/dms.spec.ts` reste vert tel quel).
- **G14. Bouton `danger`** sorti de `app/(game)/battle/[id]/arena-client.tsx:26` vers `components/ui/button.ts` (Quitter, Exclure) — aucun changement de DOM dans l'arène.
- **G15. Résidus de la revue finale du M5a** (S:70 : alerte de l'arène après « introuvable », `since` du profil, attentes fixes et commentaires de tests) : reportés au M7 (qualité), hors des rulings du M5b — coût : ils restent ouverts.
- **G16. Sauté, dit ici** : annuaire et page publique d'une guilde (aucune route, R§3.10) ; invitations envoyées et leur retrait ; rôle d'officier (D:587) ; historique des saisons (R:481) ; barres de progression des succès (aucune donnée lisible par le client) ; « Tout réclamer » ; notification de déblocage (D-C16) ; raccord au profil (M5b-15) ; bench (D§9 ne fixe aucune cible propre au M5b ; le mélange S6 les prendra au M8).

## Review Focus

- **Un membre qui disparaît pendant une action.** Départ, exclusion ou dissolution pendant une fin de bataille, un règlement de vente, un don, un message ou une adhésion → aucune réponse 500, aucun interblocage ; le score part à la guilde du moment ou nulle part ; un souhait ouvert disparaît avec son auteur. → Task 7 (`guild_score_add` sur guilde supprimée), Task 4, Task 10 (scénarios 1 à 6).
- **La semaine qui bascule.** Un score à dimanche 23:59:59 et un à lundi 00:00:00 UTC tombent dans deux lignes ; la saison passe de `S53` à `S01` au 4 janvier 2027 ; `TimeZone` de session sans effet ; `reset_in_ms` jamais négatif ; le karma de la semaine repart à 0. → Task 2, Task 9, Task 12.
- **Rejeu, double clic, deux onglets.** `claim` deux fois (sans clé, même clé, dix sessions) → un seul crédit ; deux donneurs pour un souhait → un seul don ; deux souhaits du même receveur le même jour → un seul ; adhésions concurrentes au plafond → jamais plus de `max_members`. → Tasks 5, 8, 10, 12, 17.
- **Ce que voit un autre joueur.** Un non-membre ne lit ni le chat, ni l'entraide, ni les membres d'une guilde (il n'en a aucune : 404) ; le cache partagé ne porte ni `me`, ni `user_guild_id`, ni une donnée d'un lecteur ; un joueur ne lit que ses `user_achievements`. → Task 1 (RLS), Task 12 (contrat).
- **La copie donnée.** Une copie étoilée, étiquetée, en vitrine, en avatar, en pile de 3, en échange en attente, ou d'une autre carte que celle demandée → l'unité part sans étoile ni étiquette, la vitrine et l'avatar se vident seulement si la ligne part entière, le refus est exact, et `rarity_counts` reste juste. → Task 5.

## Fichiers

| Fichier | Rôle |
|---|---|
| `supabase/migrations/0008_mirror_progress.sql` | Miroir : `guild_role`, six tables de guilde, `achievements`, `user_achievements`, RLS |
| `supabase/migrations/2000_wm_progress_core.sql` | Config, `wm.guild_invites`, `wm.achievement_rules`, `achievements_checked_at`, index, `week_start`, `guild_score_add`, `notify_guild`, `check_invariants` |
| `supabase/migrations/2010_wm_guilds.sql` | `guild_get`, `guild_create`, `guild_invite`, `guild_join`, `guild_invite_decline`, `guild_leave`, `guild_kick`, `guild_transfer`, `guild_members` |
| `supabase/migrations/2020_wm_guild_help.sql` | `move_copies`, `trade_move`, `guild_wish_set`, `guild_wish_clear`, `guild_donate`, `guild_home` |
| `supabase/migrations/2030_wm_guild_chat.sql` | `guild_chat_list`, `guild_chat_send` |
| `supabase/migrations/2040_wm_score_hooks.sql` | `battle_finish`, `settle_auction` |
| `supabase/migrations/2050_wm_achievements.sql` | 51 succès et règles, `achievement_value`, `achievements_check`, `achievements_claim` |
| `supabase/migrations/2060_wm_leaderboards.sql` | `guild_leaderboard`, `guild_of`, `leaderboard_top`, `leaderboard_me` |
| `supabase/tests/34_guilds.test.sql`, `35_achievements.test.sql`, `36_leaderboard.test.sql`, `20_guilds_concurrency.test.sh` ; recalés : `02_mirror_rls.test.sql`, `02_mirror_rls_legacy_grants.test.sh`, `27_market.test.sql`, `28_trades.test.sql`, `29_social.test.sql`, `31_battles.test.sql` | Tests SQL et concurrence |
| `app/api/guilds/**` (13 fichiers), `app/api/achievements/{check,claim}/route.ts`, `app/api/leaderboard/route.ts`, `lib/schemas.ts`, `lib/leaderboard-cache.ts`, `lib/market-cache.ts` (exports), `next.config.ts` (profils) | Routes |
| `contract/spec/{guilds,achievements,leaderboard}.ts`, `contract/spec/rest.ts`, `contract/spec/index.ts`, `contract/spec/battles.ts` (rien : `rules` est un `record`), `contract/recap-coverage.ts` | Contrat |
| `scripts/quiz/generate.ts`, `scripts/quiz/generate.test.ts` | Dette Wikimédia |
| `app/(game)/{guild,achievements,leaderboard}/**`, `components/guild/*`, `components/dms/Thread.tsx`, `components/ui/button.ts`, `components/battle/{BattleRules.tsx,types.ts}`, `app/(game)/battle/[id]/arena-client.tsx`, `lib/notification-view.ts`, `components/shell/PageHeader.tsx` (`ComingSoon` retiré) | Pages et raccords |
| `e2e/{guild,achievements,leaderboard,guild-journey}.spec.ts`, `e2e/fixtures.ts` ; recalés : `e2e/shell.spec.ts`, `e2e/a11y.spec.ts`, `e2e/battle.spec.ts`, `e2e/notifications.spec.ts`, `lib/notifications.test.ts` | E2E, a11y, unitaires |
| `docs/superpowers/HANDOFF.md`, `docs/suivi.md`, `docs/verifications.md`, `docs/decisions-graphify.md`, `docs/DESIGN.md` | Passation (Task 20) |

---

### Task 1: Miroir `0008` — guildes et succès, deux tables lisibles

**Files:**
- Create: `supabase/migrations/0008_mirror_progress.sql`
- Modify: `supabase/tests/02_mirror_rls.test.sql` (en-tête `:1-2`, fixtures `:7-34`, compte `:38-40`, droits exacts `:59-67`, boucle des refus `:157-166`, bloc superutilisateur), `supabase/tests/02_mirror_rls_legacy_grants.test.sh:3-11` (`-f "$d/../migrations/0008_mirror_progress.sql"` après `0007`, et sa mention au commentaire de `:2`)

**Interfaces:**
- Produces (`0008`, en-tête `-- MIRROR : guildes et succès (R§3.8, R§3.10, R§4.2, D§6.2, D-C10, D-C20, M5b-4). Idempotente.`, modèle `0007_mirror_battles.sql`) :

  | Objet | Contenu |
  |---|---|
  | `public.guild_role` | enum `('leader', 'member')` (R:340), sous garde comme `0007:4-8` |
  | `public.guilds` | `id uuid pk default gen_random_uuid()`, `name text not null check (char_length(name) between 1 and 40)`, `description text check (char_length(description) <= 280)`, `leader_id uuid references public.profiles on delete set null` (D-C20), `created_at timestamptz not null default now()` ; aucune unicité du nom |
  | `public.guild_members` | `guild_id uuid not null → guilds on delete cascade`, `user_id uuid not null → profiles on delete cascade`, `role public.guild_role not null default 'member'`, `joined_at timestamptz not null default now()`, `primary key (guild_id, user_id)` |
  | `public.guild_wishlists` | `id uuid pk default gen_random_uuid()`, `guild_id → guilds cascade`, `user_id → profiles cascade`, `card_id uuid not null → public.cards on delete cascade`, `created_at timestamptz not null default now()`, `fulfilled_at timestamptz` (M5b-4) ; tous `not null` sauf `fulfilled_at` |
  | `public.guild_donations` | `id uuid pk default gen_random_uuid()`, `guild_id → guilds cascade`, `wishlist_id → guild_wishlists cascade`, `donor_id → profiles cascade`, `recipient_id → profiles cascade`, `user_card_id uuid not null` (copie source, sans clé : elle peut partir entière ou disparaître), `created_at timestamptz not null default now()` |
  | `public.guild_chat_messages` | `id uuid pk default gen_random_uuid()`, `guild_id → guilds cascade`, `user_id → profiles cascade`, `content text not null check (char_length(content) between 1 and 1000)`, `created_at timestamptz not null default now()` |
  | `public.guild_weekly_scores` | `week_start timestamptz not null`, `guild_id uuid not null → guilds cascade`, `score_battles bigint not null default 0`, `score_wb bigint not null default 0`, `total_score bigint generated always as (score_battles + score_wb) stored`, `primary key (week_start, guild_id)` (D:268, R:297) |
  | `public.achievements` | `id uuid pk`, `title text not null`, `description text not null`, `wikibidous_reward int not null check (wikibidous_reward > 0)`, `sort_order int not null`, `category text not null`, `threshold int not null` (R:267, R:478) |
  | `public.user_achievements` | `user_id → profiles cascade`, `achievement_id → achievements cascade`, `unlocked_at timestamptz not null default now()`, `claimed_at timestamptz`, `primary key (user_id, achievement_id)` |

  RLS activée sur les huit, table rase d'abord (`revoke all … from public, anon, authenticated`), `grant all … to service_role`. **Seules** `achievements` et `user_achievements` reçoivent `grant select … to authenticated` et une politique `select`, créées dans la boucle `do $$` qui saute un nom déjà présent (`0006:58-68`) : `achievements_select_all` (`using (true)`) et `user_achievements_select_own` (`using (user_id = (select auth.uid()))`, modèle `wishlist_items_select_own`, `0002:39`). Aucun droit d'écriture client nulle part (`claimed_at` est sacré, R:515).

- [ ] **Step 1: Tests qui échouent** (`02_mirror_rls.test.sql`)
  - Fixtures, après la bataille (`:33-34`) : une guilde d'Alice (chef) avec Bob membre, un souhait de Bob, un message d'Alice, une ligne de score ; un succès `X` et deux `user_achievements` (Alice et Bob sur `X`). En-tête : la phrase des fixtures de guilde et de succès.
  - Tables de `public` : `'{26, 0}'`, message « tables de public : 26 attendues, toutes sous RLS ».
  - Droits exacts : la chaîne de `:59-67` gagne `authenticated achievements SELECT` et `authenticated user_achievements SELECT` à leur rang dans le tri `collate "C"` ; rien d'autre.
  - Bob (`authenticated`) : `select` sur `achievements` → 1 ligne ; sur `user_achievements` → sa seule ligne (pas celle d'Alice) ; `insert`, `update` et `delete` sur les deux → `insufficient_privilege` ; `select`, `insert`, `update`, `delete` sur les six tables de guilde → `insufficient_privilege` (30 instructions de plus dans la boucle de `:157-166`).
  - En superutilisateur, dernier bloc : un nom de 41 caractères → `check_violation` ; un nom vide → `check_violation` ; une description de 281 → `check_violation` ; un message de 1 001 → `check_violation` ; un second membre (même guilde, Bob) → `unique_violation` ; `role 'x'` → `invalid_text_representation` ; `total_score` = `score_battles + score_wb` après un `update` ; `wikibidous_reward` 0 → `check_violation` ; le profil d'Alice supprimé → la guilde reste avec `leader_id` nul, son message disparaît ; la guilde supprimée → membres, souhaits, dons, messages et scores disparaissent (cascade).
  - `02_mirror_rls_legacy_grants.test.sh`, qui rejoue `0008`, obtient les mêmes droits exacts.
- [ ] **Step 2: `npm run test:db`** → `FAIL 02_mirror_rls.test.sql` (tables absentes).
- [ ] **Step 3: Implémenter `0008`.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(db): miroir des guildes et des succès (guild_role, six tables de guilde sans droit client, achievements et user_achievements lisibles sous RLS)`

---

### Task 2: Socle `2000` — config, tables `wm`, index, borne hebdomadaire, crochet de score, invariant `ach_money`

**Files:**
- Create: `supabase/migrations/2000_wm_progress_core.sql`, `supabase/tests/34_guilds.test.sql`
- Modify: `supabase/tests/28_trades.test.sql:60` et `supabase/tests/29_social.test.sql:66-67` (littéral de `list_caps`) ; `supabase/tests/31_battles.test.sql:60-61` et `:201-202` (littéraux de `battle` et de `rules`), `:70` (le rejeu de `1900` suivi de `\ir ../migrations/2000_wm_progress_core.sql`, M5b-18)

**Interfaces:**
- Consumes : Task 1 ; `wm.check_invariants` (`1900:71-139`, corps entier repris) ; `wm.lock_user` (`1100:37-49`).
- Produces (`2000`, en-tête ADDITIVE et ligne pg-safeupdate de `1900:1-3`) :

  | Objet | Contenu |
  |---|---|
  | Clés `wm.config` (`on conflict do nothing`) | `guild` et `achievements` de G9, notes « Guildes (D§7.8, R§5.8) : 200 membres (D:582, R:628 inconnu), 1 don reçu par jour UTC du receveur (D:584, D-C13) ; création gratuite (D:583), sans clé » et « Succès (D§7.10) : un check par 5 min et par joueur (D:610, M5b-5) » |
  | `list_caps`, `battle` | `update wm.config set value = '<G9>'::jsonb \|\| value where key = …` (les valeurs posées gagnent) |
  | `wm.user_state` | `add column if not exists achievements_checked_at timestamptz` (M5b-5) |
  | `wm.guild_invites` | `guild_id uuid not null → public.guilds on delete cascade`, `user_id uuid not null → public.profiles on delete cascade`, `inviter_id uuid not null → public.profiles on delete cascade`, `created_at timestamptz not null default now()`, `primary key (guild_id, user_id)` (D-C10) |
  | `wm.achievement_rules` | `achievement_id uuid pk → public.achievements on delete cascade`, `metric text not null check (metric in ('cards_total', 'first_rarity', 'shiny_copies', 'distinct_cards', 'showcase_full', 'battles_won', 'battles_played', 'trades_done', 'guild_donations', 'auctions_sold', 'auctions_won'))`, `threshold int not null check (threshold > 0)`, `rarity public.rarity` (`not null` si et seulement si `metric = 'first_rarity'`, par `check`), `inferred boolean not null` (D-C16) |
  | Index (option A : `CONCURRENTLY` par le runbook ; M16, D-C14) | `guild_members_user_key` **unique** `(user_id)` ; `guild_members_leader_key` **unique** `(guild_id) where role = 'leader'` ; `guilds_leader_idx (leader_id)` ; `guild_wishlists_open_key` **unique** `(user_id) where fulfilled_at is null` ; `guild_wishlists_guild_idx (guild_id, created_at) where fulfilled_at is null` ; `guild_wishlists_card_idx (card_id)` ; `guild_donations_recipient_idx (recipient_id, created_at desc)` ; `guild_donations_donor_idx (donor_id, created_at desc)` ; `guild_donations_guild_idx (guild_id, created_at desc)` ; `guild_donations_wishlist_idx (wishlist_id)` ; `guild_chat_messages_guild_idx (guild_id, created_at desc)` ; `guild_chat_messages_user_idx (user_id)` ; `guild_weekly_scores_rank_idx (week_start, total_score desc)` ; `guild_weekly_scores_guild_idx (guild_id)` ; `guild_invites_user_idx on wm.guild_invites (user_id, created_at desc)` ; `guild_invites_inviter_idx on wm.guild_invites (inviter_id)` ; `user_stats_battles_won_idx on wm.user_stats (battles_won desc) where battles_won > 0` (D:812) ; `battles_completed_idx on public.battles (updated_at) where status = 'completed'` ; `user_cards_obtained_idx on public.user_cards (obtained_at)` (D-C14) |
  | `wm.week_start(p_at timestamptz) returns timestamptz` | `immutable` ; le lundi 00:00 UTC de la semaine de `p_at` : `date_trunc('week', p_at at time zone 'UTC') at time zone 'UTC'` (D-C12) |
  | `wm.notify_guild(p_users uuid[], p_type text, p_guild_id uuid, p_actor uuid) returns int` | modèle `wm.notify_battle` (`1920:7-20`) ; `data` = `{guild_id, guild_name, user_id: p_actor, username}` ; une instruction `order by u` |
  | `wm.guild_score_add(p_user_id uuid, p_kind text, p_amount int, p_at timestamptz) returns int` | `p_kind` hors (`battles`, `wb`) → `raise exception … using errcode = 'XX000'` (erreur de programmation) ; `p_amount <= 0` ou nul → 0. Sinon la guilde de `p_user_id` lue dans `guild_members` (aucune → 0), prise `for key share` (disparue → 0 : un `delete` concurrent est attendu, puis la ligne n'est plus là ; sans ce verrou, l'insertion lèverait `23503`) ; puis `insert into public.guild_weekly_scores … values (wm.week_start(p_at), g, …) on conflict (week_start, guild_id) do update` qui ajoute `p_amount` à `score_battles` ou à `score_wb` ; rend `p_amount`. Aucun `lock_timeout` (l'appelant l'a posé), aucun `actor` (le cron l'appelle en maintenance). `shortcut:` de G4 |
  | `wm.check_invariants()` | les 8 contrôles de `1900:71-139`, plus `ach_money` : (a) une ligne `reason = 'achievement'` dont la `ref` n'est pas `'ach:' \|\| achievement_id` d'un `user_achievements` réclamé (`claimed_at` non nul) de son auteur → `{check: 'ach_money', ref, user_id}`, jointe sur le texte ; (b) un `user_achievements` réclamé sans sa ligne `ach:<id>` → `{check: 'ach_money', achievement_id, user_id}` ; `-- shortcut:` de `battle_money` recopié (suppression de compte, M6) |

- [ ] **Step 1: Tests qui échouent**
  - `28_trades.test.sql:60` et `29_social.test.sql:67` : `list_caps` = `{"battles_closed":50,"conversations":50,"friend_owners":3,"friend_search":20,"guild_members":50,"guild_messages":100,"karma_donors":10,"leaderboard":100,"messages":100,"notifications":50,"trades_closed":200}`.
  - `31_battles.test.sql:60-61` : `battle` = `{"questions":3,"pool":6,"quota_free":3,"quota_pro":10,"invite_ttl_h":24,"idle_loss_h":48,"reward_win":50,"reward_loss":10,"guild_points_win":500}` ; `:201-202` : la même valeur pour `rules` ; `:70` suivi de `\ir ../migrations/2000_wm_progress_core.sql`, et le bloc `:71-74` reste vert (la valeur posée `quota_free` 5 survit aux deux rejeux).
  - `34_guilds.test.sql`, en tête : `pg_temp.err`, `pg_temp.inv`, `pg_temp.card`, `pg_temp.player`, `pg_temp.copy` et `pg_temp.friends`, repris de `29_social.test.sql:6-46` tels quels ; la règle du fichier écrite en tête (`check_invariants` global, sous-transaction `WMT00` pour toute violation voulue, P5a:47).
  - Config : `guild` = `{"max_members":200,"donations_per_day":1}`, `achievements` = `{"check_interval_s":300}`, notes non vides ; rejeu de `2000` (`\ir`) → mêmes valeurs, une valeur posée (`max_members` 5) survit.
  - `wm.user_state` d'un joueur neuf (`wm.lock_user`) → `achievements_checked_at` nul.
  - Index : l'`indexdef` complet des dix-neuf, comparé comme `28_trades.test.sql:65-79` (`CREATE UNIQUE INDEX` pour les trois uniques).
  - ***Review Focus*, la borne hebdomadaire (D:1084, D-C12)** :
    - `wm.week_start('2026-11-01 23:59:59+00')` = `'2026-10-26 00:00:00+00'` ; `'2026-11-01 23:59:59.999999+00'` → la même ; `'2026-11-02 00:00:00+00'` → `'2026-11-02 00:00:00+00'` ; `'2026-11-02 00:59:59+01'` (soit dimanche 23:59:59 UTC) → `'2026-10-26 00:00:00+00'` ;
    - sous `set local timezone = 'Pacific/Kiritimati'`, puis `'America/Los_Angeles'` : les mêmes quatre valeurs ;
    - `'2027-01-03 23:59:59+00'` → `'2026-12-28 00:00:00+00'`, `to_char(…, 'IW')` = `'53'` ; `'2027-01-04 00:00:00+00'` → lui-même, `'01'` ;
    - `provolatile = 'i'`.
  - `guild_score_add` (guilde et membres posés par `insert` en superutilisateur, Alice membre de G, Bob sans guilde) :
    - `(Alice, 'battles', 500, '2026-11-01 23:59:59+00')` → 500 ; `(Alice, 'wb', 120, '2026-11-02 00:00:00+00')` → 120 : exactement deux lignes de G, `(2026-10-26, 500, 0, 500)` et `(2026-11-02, 0, 120, 120)` ;
    - `(Alice, 'battles', 500, '2026-11-02 12:00:00+00')` → la ligne du 2026-11-02 à `(500, 120, 620)` ;
    - Bob → 0, aucune ligne ; `p_amount` 0 et nul → 0 ; `'x'` → XX000 ;
    - G supprimée avant l'appel (dans une sous-transaction annulée) → 0, sans erreur.
  - `notify_guild(array[Bob, Alice], 'guild_invite', G, Alice)` → 2 lignes, `data` exactement `{"guild_id": G, "guild_name": <nom>, "user_id": Alice, "username": <Alice>}`.
  - `ach_money` (sous-transaction `WMT00`, modèle `27_market.test.sql:278-285`, avec un succès inséré en superutilisateur) : `wallet_apply(A, 10, 'achievement', 'ach:' ‖ X)` sans `user_achievements` → une violation de `ref` ; la ligne `user_achievements` posée non réclamée → toujours une ; réclamée → aucune ; une `user_achievements` réclamée de Carol sans ligne → `{check: 'ach_money', achievement_id: X, user_id: Carol}` ; une `ref` `ach:x` → une violation, pas une erreur ; après la sous-transaction, `pg_temp.inv` vide.
- [ ] **Step 2: `npm run test:db`** → `FAIL 28_trades.test.sql` (premier fichier en échec dans l'ordre lexical).
- [ ] **Step 3: Implémenter `2000`** ; fin `revoke`/`grant`.
- [ ] **Step 4: Contrôles complets** → vert (`contract/spec/battles.ts` reste vert : `rules` y est un `record`).
- [ ] **Step 5: Commit** — `feat(db): socle du M5b (config guild, achievements et list_caps, invitations et règles de succès, index, week_start, guild_score_add, notify_guild, invariant ach_money)`

---

### Task 3: Guildes en SQL — lecture, création, invitations, adhésion, refus

**Files:**
- Create: `supabase/migrations/2010_wm_guilds.sql`
- Modify: `supabase/tests/34_guilds.test.sql`

**Interfaces:**
- Consumes : Task 2 ; `wm.actor` (`1000:67-96`) ; `wm.lock_user`, `wm.lock_users` (`1600:58-64`) ; `wm.are_friends` (`1710:9-13`) ; `wm.idem_claim`, `wm.idem_store`.
- Produces (le chemin de chaque écriture : `idem_claim`, `actor`, refus sans verrou, `lock_timeout`, verrous, refus sous verrou, écritures, `idem_store` ; un refus n'écrit rien) :

  | Fonction | Réponse, règles |
  |---|---|
  | `wm.guild_get(p_uid uuid) returns jsonb` | `stable`, sans `actor` ; `{guild: {id, name, description, leader_id, created_at} \| null, membership: {guild_id, user_id, role, joined_at} \| null, member_count, invites}` ; sans guilde `guild` et `membership` nuls, `member_count` 0 ; `invites` = M5b-8, toujours un tableau |
  | `wm.guild_create(p_uid uuid, p_name text, p_description text default null, p_idem text default null) returns jsonb` | 201 (route), corps = `guild_get(p_uid)`. Nom `btrim` vide → 400 « Le nom de la guilde est vide » ; plus de 40 caractères après `btrim` → 400 « Un nom de guilde fait au plus 40 caractères » ; description de plus de 280 → 400 « Une description fait au plus 280 caractères » ; nom stocké rogné, description vide ou blanche stockée nulle. `lock_user(p_uid)` ; déjà membre → 409 « Tu fais déjà partie d'une guilde ». Insère la guilde (`leader_id` = p_uid), le membre `leader`, efface les invitations de `p_uid` (M5b-8). Aucun débit (D:583) |
  | `wm.guild_invite(p_uid uuid, p_user_id uuid, p_idem text default null) returns jsonb` | `{ok: true}`. Soi → 400 « Tu ne peux pas t'inviter toi-même » ; cible inconnue → 404 « Joueur introuvable ». `lock_users(array[p_uid, p_user_id])`, puis la guilde de l'appelant `for no key update` (aucune → 404 « Tu n'es dans aucune guilde ») ; pas amis → 403 `FORBIDDEN` « Vous devez être amis pour inviter ce joueur » ; cible membre d'une guilde → 409 « Ce joueur fait déjà partie d'une guilde ». `insert … on conflict (guild_id, user_id) do update set inviter_id = excluded.inviter_id, created_at = clock_timestamp()`, puis `notify_guild(array[p_user_id], 'guild_invite', g, p_uid)` à chaque invitation, réécrite comprise |
  | `wm.guild_join(p_uid uuid, p_guild_id uuid, p_idem text default null) returns jsonb` | 200, corps = `guild_get(p_uid)`. `lock_user(p_uid)`, puis la guilde `for no key update` (absente → 404 « Guilde introuvable ») ; déjà membre d'une guilde → 409 « Tu fais déjà partie d'une guilde » ; aucune invitation `(p_guild_id, p_uid)` → 403 `FORBIDDEN` « Aucune invitation de cette guilde » ; membres ≥ `guild.max_members` → 409 « Cette guilde est pleine ». Insère le membre, efface **toutes** les invitations de `p_uid` |
  | `wm.guild_invite_decline(p_uid uuid, p_guild_id uuid, p_idem text default null) returns jsonb` | `{ok: true}` ; `delete … returning` de l'invitation `(p_guild_id, p_uid)`, absente → 404 « Aucune invitation de cette guilde » ; aucun verrou de profil |

- [ ] **Step 1: Tests qui échouent** (`34_guilds.test.sql` ; une aide `pg_temp.guild(p_leader uuid, p_members uuid[] default '{}') returns uuid` crée la guilde par `wm.guild_create`, puis pour chaque membre `pg_temp.friends`, `wm.guild_invite` et `wm.guild_join`)
  - Création : `guild_create(A, '  Les Archivistes ', 'Une guilde.')` → `guild.name` = `'Les Archivistes'`, `membership.role` = `leader`, `member_count` 1, `invites` `[]`, `leader_id` = A ; `guild_get` rend la même chose ; même `p_idem` deux fois → même corps, une seule guilde.
  - Refus exacts de la création : `'   '` → 400 « Le nom de la guilde est vide » ; 41 caractères → 400 « Un nom de guilde fait au plus 40 caractères » ; exactement 40 → passe ; description de 281 → 400 ; A de nouveau → 409 « Tu fais déjà partie d'une guilde » ; `maintenance` à `true` → 503.
  - Invitations : A et B amis, C ami de personne. `guild_invite(A, B)` → `{ok: true}`, une `guild_invite` pour B au `data` exact ; `guild_get(B) -> 'invites'` = `[{"guild_id": G, "guild_name": "Les Archivistes", "inviter_username": <A>, "created_at": …}]` ; réinvité par un autre membre M → une seule ligne, `inviter_username` = M, deux notifications ; A → A → 400 ; un uuid inconnu → 404 « Joueur introuvable » ; C → 403 exact `{"status":403,"code":"FORBIDDEN","error":"Vous devez être amis pour inviter ce joueur","message":…}` ; un joueur D sans guilde qui invite → 404 « Tu n'es dans aucune guilde » ; un membre d'une autre guilde → 409 « Ce joueur fait déjà partie d'une guilde ».
  - Deux invitations pour B (G et H) : `invites` triées de la plus récente ; B rejoint G → `guild_get(B)` membre de G, `invites` `[]` (celle de H effacée aussi) ; `guild_join(B, H)` → 409 « Tu fais déjà partie d'une guilde ».
  - Adhésion : sans invitation → 403 « Aucune invitation de cette guilde » ; guilde inconnue → 404 « Guilde introuvable » ; `guild.max_members` posé à 2 (restauré en fin de bloc) avec A et B déjà membres, E invité → 409 « Cette guilde est pleine », l'invitation de E reste.
  - Refus d'une invitation : → `{ok: true}`, la ligne disparaît ; de nouveau → 404 « Aucune invitation de cette guilde ».
  - Création efface les invitations : F invité dans G, puis `guild_create(F, …)` → `guild_get(F) -> 'invites'` = `[]`.
  - Volatilité : `guild_get` `provolatile = 's'`.
  - `lock_timeout` : `tests.lock_timeout_violations(array['guild_create', 'guild_invite', 'guild_join', 'guild_invite_decline'], array['for update', 'for no key update', 'for key share', 'wm.lock_users(', 'wm.lock_user(', 'delete from wm.guild_invites'])` nul ; dans le `prosrc` de `guild_invite` et `guild_join`, `wm.lock_user` précède `for no key update`.
  - `pg_temp.inv` vide à la fin de chaque bloc.
- [ ] **Step 2: `npm run test:db`** → `FAIL 34_guilds.test.sql`.
- [ ] **Step 3: Implémenter `2010` (cette partie).**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(db): guildes (lecture avec invitations reçues, création gratuite, invitation entre amis, adhésion sous les profils puis la guilde, refus)`

---

### Task 4: Guildes en SQL — départ, exclusion, transfert, membres

**Files:**
- Modify: `supabase/migrations/2010_wm_guilds.sql`, `supabase/tests/34_guilds.test.sql`

**Interfaces:**
- Consumes : Task 3.
- Produces :

  | Fonction | Réponse, règles |
  |---|---|
  | `wm.guild_leave(p_uid uuid, p_idem text default null) returns jsonb` | `{ok: true}`. Aucun profil (M5b-1). `lock_timeout`, guilde de l'appelant (aucune → 404 « Tu n'es dans aucune guilde »), prise `for no key update`, puis l'adhésion relue sous ce verrou ; chef et d'autres membres → 409 « Transmets d'abord ton rôle de chef à un autre membre » ; seul membre → la guilde reprise `for update`, puis `delete from public.guilds where id = g` (cascade : membres, souhaits, dons, messages, scores, invitations, D-C20) ; sinon `delete` de l'adhésion et du souhait ouvert de `p_uid` (M5b-4). Ses messages restent (M5b-10) |
  | `wm.guild_kick(p_uid uuid, p_user_id uuid, p_idem text default null) returns jsonb` | `{ok: true}`. `p_user_id = p_uid` → 400 « Tu ne peux pas t'exclure toi-même ». `lock_timeout`, `perform from public.profiles where id = p_user_id for key share` (G2), puis la guilde de l'appelant `for no key update` (aucune → 404) ; appelant non chef → 403 `FORBIDDEN` « Seul le chef de la guilde peut faire cela » ; cible hors de cette guilde → 404 « Ce joueur ne fait pas partie de ta guilde ». `delete` de l'adhésion et du souhait ouvert de la cible, puis `notify_guild(array[p_user_id], 'guild_kicked', g, p_uid)` |
  | `wm.guild_transfer(p_uid uuid, p_user_id uuid, p_idem text default null) returns jsonb` | `{ok: true}`. `p_user_id = p_uid` → 400 « Tu es déjà le chef de la guilde ». `lock_users(array[p_uid, p_user_id])`, puis la guilde `for no key update` ; non chef → 403 ; cible hors de la guilde → 404 « Ce joueur ne fait pas partie de ta guilde ». L'ancien chef passe `member` **avant** que la cible passe `leader` (index `guild_members_leader_key`), puis `guilds.leader_id` = la cible. Aucune notification (M5b-11) |
  | `wm.guild_members(p_uid uuid, p_limit int default null, p_offset int default 0) returns jsonb` | `stable` ; `{members: [{user_id, id, username, profile: {username}, user: {username}, role, joined_at}], hasMore}` (union des variantes de R:292, `id` = `user_id`) ; le chef d'abord, puis `joined_at`, puis `user_id` ; `limit` = `p_limit` borné à `1..list_caps.guild_members`, nul → la borne ; `offset` borné à `0..` ; `hasMore` = il reste au moins une ligne après la page ; sans guilde → 404 « Tu n'es dans aucune guilde » |

- [ ] **Step 1: Tests qui échouent**
  - Départ : membre B → `{ok: true}`, plus d'adhésion, son souhait ouvert supprimé (posé par `insert`), son souhait clos et ses messages restent ; chef A avec B → 409 exact ; A seul → la guilde n'existe plus, ni ses scores, ni ses invitations ; sans guilde → 404.
  - Exclusion : A exclut B → `{ok: true}`, une `guild_kicked` pour B au `data` exact (acteur A) ; B exclut A (B simple membre) → 403 exact ; A s'exclut → 400 ; A exclut un joueur hors de la guilde → 404 « Ce joueur ne fait pas partie de ta guilde ».
  - Transfert : A → B → B `leader`, A `member`, `leader_id` = B, une seule ligne `leader` ; A (devenu membre) → 403 ; B → B → 400 « Tu es déjà le chef de la guilde » ; vers un non-membre → 404 ; puis A peut partir (`{ok: true}`).
  - Membres : 3 membres → les clés exactes de chaque élément, chef d'abord, `hasMore` faux ; `p_limit` 2 → 2 éléments, `hasMore` vrai ; `p_offset` 2 → 1 élément, `hasMore` faux ; `p_limit` 500 → borné à 50 (55 membres posés par `insert`, `guild.max_members` relevé dans le bloc) ; sans guilde → 404.
  - Volatilité : `guild_members` `'s'`.
  - `lock_timeout` : l'appel de la Task 3 gagne `guild_leave`, `guild_kick`, `guild_transfer` ; dans le `prosrc` de `guild_kick`, `for key share` précède `for no key update` ; `guild_leave` ne contient ni `wm.lock_user` ni `from public.profiles`.
- [ ] **Step 2: `npm run test:db`** → `FAIL 34_guilds.test.sql`.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(db): départ (dissolution au dernier membre), exclusion notifiée, transfert du rôle de chef, liste des membres paginée`

---

### Task 5: Entraide en SQL — `move_copies` extrait de `trade_move`, souhait, don, karma

**Files:**
- Create: `supabase/migrations/2020_wm_guild_help.sql`
- Modify: `supabase/tests/34_guilds.test.sql` ; `supabase/tests/29_social.test.sql:75` (le rejeu de `1800` suivi de `\ir ../migrations/2020_wm_guild_help.sql`, M5b-18 : `trade_move` est la seule fonction de `1800` redéfinie depuis, comme `check_invariants` pour `1900`)

**Interfaces:**
- Consumes : Tasks 2 et 3 ; `wm.trade_move` (`1800:66-93`, corps entier repris) ; `wm.card_locked(uid, card_id)` (`1700:22-26`) ; `wm.notify_guild`.
- Produces :

  | Fonction | Réponse, règles |
  |---|---|
  | `wm.move_copies(p_a uuid, p_b uuid, p_ids uuid[], p_k int[]) returns void` | Les six instructions de `1800:73-92`, où l'échange cède la place à la paire : chaque copie de `p_ids` passe de son propriétaire (`p_a` ou `p_b`) à l'autre, `p_k[i]` unités ; `k = count` déplace la ligne (même id), `k < count` crée une ligne de `k` chez l'autre (snapshots et `obtained_at` recopiés, sans fusion) et décrémente la source ; ce qui arrive est sans étoile ni étiquette ; avatar et vitrine vidés pour une ligne partie entière (`and id in (p_a, p_b)` pour l'avatar). La première instruction reste textuellement `update public.user_cards set user_id = case user_id when p_a then p_b else p_a end, starred = false where id = any (v_full)` (`17_trades_concurrency.test.sh:176-179` lit `update public.user_cards set user_id` dans la trace). Commentaire de `1800:60-64` déplacé ici (M4-3 : seul `update … set user_id` hors défausse et enchères). Copies verrouillées et vérifiées par l'appelant |
  | `wm.trade_move(p_trade public.trades) returns void` | Même signature ; calcule ids et `k` depuis `trade_items` comme `1800:73-77`, puis `perform wm.move_copies(p_trade.initiator_id, p_trade.recipient_id, …)` |
  | `wm.guild_wish_set(p_uid uuid, p_card_id uuid, p_idem text default null) returns jsonb` | `{wishlist: {id, user_id, card_id, created_at}}`. Carte inconnue → 404 « Carte introuvable ». `lock_timeout`, le souhait ouvert de `p_uid` `for update` (G3), puis `lock_user(p_uid)`, la guilde `for key share` (aucune → 404 « Tu n'es dans aucune guilde ») ; `delete` de l'ancien ouvert, `insert` du nouveau (M5b-4) |
  | `wm.guild_wish_clear(p_uid uuid, p_idem text default null) returns jsonb` | `{ok: true}` ; `lock_timeout`, `delete … returning` du souhait ouvert, absent → 404 « Tu ne demandes aucune carte » |
  | `wm.guild_donate(p_uid uuid, p_wishlist_id uuid, p_user_card_id uuid, p_idem text default null) returns jsonb` | `{ok: true, wishlist_id}`. `lock_timeout`, le souhait `for update` (absent ou clos → 404 « Ce souhait n'existe plus ») ; son auteur = `p_uid` → 400 « Tu ne peux pas te donner une carte » ; `lock_users(array[p_uid, w.user_id])` ; `p_uid` hors de `w.guild_id` → 403 `FORBIDDEN` « Ce souhait n'est pas dans ta guilde » ; dons reçus par `w.user_id` depuis `date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'` ≥ `guild.donations_per_day` → 409 « Ce membre a déjà reçu un don aujourd'hui » (jour UTC du receveur, D-C13) ; la copie `select … from public.user_cards where id = p_user_card_id and user_id = p_uid for update` (absente → 403 `42501` « Vous ne possédez pas cette carte ») ; autre `card_id` → 400 « Cette carte n'est pas celle demandée » ; `wm.card_locked(p_uid, card_id)` → 409 « Cette carte est déjà engagée dans un échange en attente ». Puis `move_copies(p_uid, w.user_id, array[copie], array[1])`, `fulfilled_at = now()`, une ligne `guild_donations`, `notify_guild(array[w.user_id], 'guild_donation', w.guild_id, p_uid)` |
  | `wm.guild_home(p_uid uuid) returns jsonb` | `stable` ; sans guilde → 404. `{my_wishlist: Wish \| null, wishlists: Wish[], weekly_karma_donors, received_donation_today}`. `Wish` = `{id, user_id, card, created_at, can_donate, recipient_received_today, user: {id, username}, recipient: {id, username}, my_copies}` : `card` = l'objet `card` de `wm.my_collection` (`1300:149-151`, douze clés) ; `user` et `recipient` = l'auteur du souhait ; `my_copies` = G6 ; `can_donate` = lecteur ≠ auteur, `my_copies` non vide et `recipient_received_today` faux. `wishlists` = les souhaits ouverts des autres membres, `created_at` puis `id`. `weekly_karma_donors` = M5b-7, `[{user_id, username, karma, karma_this_week, donations_this_week}]` : `karma` = tous ses dons, les deux autres = ses dons dans cette guilde depuis `wm.week_start(now())`, membres à 0 absents, `list_caps.karma_donors` au plus, tri par dons de la semaine puis `username`. `received_donation_today` = le lecteur a atteint `donations_per_day` aujourd'hui (UTC) |

- [ ] **Step 1: Tests qui échouent** (`34_guilds.test.sql` ; G avec A chef, B et C ; carte X)
  - Souhait : `guild_wish_set(B, X)` → exactement les quatre clés ; `guild_wish_set(B, Y)` → un seul souhait ouvert, sur Y, d'un autre id ; même `p_idem` → même corps ; carte inconnue → 404 « Carte introuvable » ; sans guilde → 404 « Tu n'es dans aucune guilde » ; `guild_wish_clear(B)` → `{ok: true}`, puis → 404 « Tu ne demandes aucune carte ».
  - ***Review Focus*, la copie donnée** : B souhaite X ; A a une copie X de `count` 1, étoilée, étiquetée, en vitrine et en avatar. `guild_donate(A, W, copie)` → `{ok: true, wishlist_id: W}` ; la copie (même id) est à B, `starred` faux, sans étiquette ; la vitrine de A ne la montre plus, `avatar_user_card_id` et `avatar_url` de A sont nuls ; W a `fulfilled_at` ; une ligne `guild_donations` (G, W, A, B, la copie) ; une `guild_donation` pour B, `data` exact ; `pg_temp.inv` vide. Une pile X de `count` 3 en vitrine et en avatar : B reçoit une ligne neuve de `count` 1 (même `obtained_at`), la pile de A passe à 2 et garde vitrine et avatar.
  - Refus exacts : A donne au souhait de A → 400 « Tu ne peux pas te donner une carte » ; une copie d'une autre carte → 400 « Cette carte n'est pas celle demandée » ; la copie de C → 403 `42501` ; une copie X promise dans un échange `pending` de A → 409 D:676 ; W déjà clos → 404 « Ce souhait n'existe plus » ; D, d'une autre guilde → 403 « Ce souhait n'est pas dans ta guilde » ; B, ayant reçu aujourd'hui, souhaite Z, C donne → 409 « Ce membre a déjà reçu un don aujourd'hui » ; le premier don reculé à `date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' - interval '1 second'` → le don de C passe ; `maintenance` → 503. Après chaque refus, rien n'a bougé (copie, souhait, aucune ligne de don).
  - Entraide : `guild_home(A)` → clés exactes ; le souhait ouvert de B dans `wishlists` avec `can_donate` vrai, `my_copies` `[{id, count, is_shiny}]` exacts, `recipient_received_today` faux ; après un don à B, `recipient_received_today` vrai et `can_donate` faux ; A sans copie de Y → `my_copies` `[]`, `can_donate` faux ; `guild_home(B) -> 'received_donation_today'` vrai ; `my_wishlist` de B = son souhait ouvert ou nul.
  - Karma : A 2 dons cette semaine, C 1, un don de E reculé à la semaine précédente (`wm.week_start(now()) - interval '1 second'`) → `weekly_karma_donors` = A (2), C (1), E absent ; E compte dans `karma` s'il donne de nouveau ; 12 donneurs → 10 entrées ; égalité → par `username`.
  - Régression (D-C19) : `28_trades.test.sql` et `17_trades_concurrency.test.sh` restent verts **tels quels** ; `29_social.test.sql:130-144` vert après le rejeu suivi de `2020`.
  - `lock_timeout` : `guild_wish_set`, `guild_wish_clear` et `guild_donate` ajoutées à l'appel de la Task 3 (marqueurs de la Task 3, plus `delete from public.guild_wishlists`) ; dans le `prosrc` de `guild_donate`, `from public.guild_wishlists` … `for update` précède `wm.lock_users(`, qui précède `from public.user_cards` ; dans celui de `guild_wish_set`, `for update` précède `wm.lock_user(` ; `move_copies` et `guild_score_add` ne contiennent pas `lock_timeout`.
- [ ] **Step 2: `npm run test:db`** → `FAIL 34_guilds.test.sql`.
- [ ] **Step 3: Implémenter `2020`.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(db): entraide de guilde (souhait unique remplacé, don d'une unité par move_copies extrait de trade_move, un don reçu par jour UTC, karma de la semaine)`

---

### Task 6: Chat de guilde en SQL

**Files:**
- Create: `supabase/migrations/2030_wm_guild_chat.sql`
- Modify: `supabase/tests/34_guilds.test.sql`

**Interfaces:**
- Consumes : Task 3 ; la fenêtre de `wm.chat_send` (`1860:39-52`) et `wm.config.chat_burst`.
- Produces :

  | Fonction | Réponse, règles |
  |---|---|
  | `wm.guild_chat_list(p_uid uuid) returns jsonb` | `stable` ; sans guilde → 404. `{messages: [{id, user_id, content, created_at, username, user: {username}, profile: {username}}]}` (union de R:295) : les `list_caps.guild_messages` derniers par `created_at desc, id desc`, rendus du plus ancien au plus récent (M5b-6) |
  | `wm.guild_chat_send(p_uid uuid, p_content text, p_idem text default null) returns jsonb` | 201 (route), `{message: <l'élément de la liste>}`. Vide ou blancs seuls (`btrim(p_content, E' \t\r\n')`) → 400 « Le message est vide » ; plus de 1 000 caractères → 400 « Un message fait au plus 1 000 caractères » ; contenu stocké tel quel. `lock_timeout`, `lock_user(p_uid)`, guilde `for key share` (aucune → 404) ; fenêtre pleine → 429 au corps M4b-29, `retry_after` = `least(window_s, greatest(1, ceil(fin de fenêtre − now())))` ; `insert`, puis la mise à jour de `chat_window_*` de `1860:50-52` (G10) |

- [ ] **Step 1: Tests qui échouent**
  - `guild_chat_send(A, 'Bonjour')` → `{message}` aux sept clés exactes, `username` de A ; même `p_idem` → même corps, une ligne ; `guild_chat_list(B)` → ce message.
  - Refus : `'  \n '` → 400 « Le message est vide » ; 1 001 caractères → 400 exact ; 1 000 → passe ; sans guilde (liste et envoi) → 404 « Tu n'es dans aucune guilde » ; `maintenance` → 503.
  - 101 messages posés par `insert` → 100, du plus ancien au plus récent, le premier posé absent.
  - Le message d'un membre parti reste, avec son pseudo.
  - ***Seau partagé*** (D-C18) : `chat_burst.count` posé à 3 dans le bloc ; A envoie 3 messages privés à un ami par `wm.chat_send`, puis `guild_chat_send(A, …)` → 429 exact, `retry_after` entre 1 et 60 ; à l'inverse, 3 messages de guilde puis `wm.chat_send` → 429 ; `chat_window_start` reculé de 61 s → passe.
  - `lock_timeout` : `guild_chat_send` ajoutée à l'appel de la Task 3.
- [ ] **Step 2: `npm run test:db`** → `FAIL 34_guilds.test.sql`.
- [ ] **Step 3: Implémenter `2030`.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(db): chat de guilde (100 derniers, 1 000 caractères, seau de rafale partagé avec les messages privés)`

---

### Task 7: Crochets de score — +500 à la fin d'une bataille, prix final au règlement d'une vente

**Files:**
- Create: `supabase/migrations/2040_wm_score_hooks.sql`
- Modify: `supabase/tests/31_battles.test.sql`, `supabase/tests/27_market.test.sql`

**Interfaces:**
- Consumes : `wm.guild_score_add` (Task 2) ; `wm.battle_finish` (`1930:24-50`) et `wm.settle_auction` (`1630:5-38`), corps entiers repris.
- Produces (en-tête « même signature, même corps et même réponse qu'en 1930 et 1630 (déployées, non retouchées), plus le score de guilde (M5b-2, M5b-3, D:472, D:535, D:576) ») :
  - `wm.battle_finish(p_battle_id uuid, p_winner uuid) returns void` : le `shortcut:` de `1930:40` retiré ; après les deux `notify_battle`, `v_gp := wm.guild_score_add(p_winner, 'battles', (c ->> 'guild_points_win')::int, now())`, puis `update public.battles set game_state = game_state || jsonb_build_object('guildPoints', v_gp) where id = b.id` (G5, ligne déjà tenue). Ni `for update` ni `lock_timeout` dans le source (contrôle P5 de `31_battles.test.sql:1144-1156`, inchangé).
  - `wm.settle_auction(p_auction_id uuid) returns jsonb` : le `shortcut:` de `1630:23` remplacé par `-- Score de guilde du vendeur au règlement (M5b-2) ; les statistiques du marché sont calculées au check des succès (D-C16).` ; dans la branche vendue, après l'`update public.auctions`, `perform wm.guild_score_add(a.seller_id, 'wb', a.final_price, now())`. La branche invendue ne change pas.

- [ ] **Step 1: Tests qui échouent**
  - `31_battles.test.sql`, nouveau bloc (guilde G par `wm.guild_create` et `wm.guild_join` après une invitation ; `pg_temp.active` de la Task 5 du M5a) :
    - A (membre de G) gagne contre B (sans guilde) par l'abandon de B → la ligne `(wm.week_start(now()), G)` a `score_battles` 500, `game_state -> 'guildPoints'` = 500 ; B gagne une autre bataille → `guildPoints` 0, aucune ligne pour une guilde de B ;
    - A et un autre membre de G se battent → G gagne 500 (M5b-3) ;
    - fin par inactivité (`updated_at` reculé de 49 h, `wm.expire_battles(5000)`) avec A gagnant → +500 ;
    - G dissoute (départ du dernier membre) avant la fin → `guildPoints` 0, aucune erreur ;
    - `pg_temp.inv` vide ; le contrôle P5 reste vert.
  - `27_market.test.sql`, nouveau bloc : une vente réglée (`wm.settle_auction` d'une enchère échue avec mise) d'un vendeur membre de G → `score_wb` de G = `final_price` ; une invendue → aucune ligne ; un vendeur sans guilde → aucune ligne ; la guilde de l'acheteur ne gagne rien ; deux ventes de membres de G réglées par `wm.settle_due_auctions(500)` → la somme ; la réponse de `settle_auction` reste exacte (`{id, status, settled}`) ; `pg_temp.inv` vide.
- [ ] **Step 2: `npm run test:db`** → `FAIL 27_market.test.sql`.
- [ ] **Step 3: Implémenter `2040`.** `grep -n 'shortcut: +500\|shortcut: ni score' supabase/migrations/20*.sql` ne rend rien.
- [ ] **Step 4: Contrôles complets** → vert (`e2e/battle.spec.ts` et `contract/spec/battles.ts` restent verts : `GameState` est `.loose()`).
- [ ] **Step 5: Commit** — `feat(db): score de guilde hebdomadaire branché (+500 au gagnant de toute bataille finie, prix final au vendeur d'une vente réglée), guildPoints dans game_state`

---

### Task 8: Succès en SQL — amorce de 51, `check` limité, `claim` qui ne crédite qu'une fois

**Files:**
- Create: `supabase/migrations/2050_wm_achievements.sql`, `supabase/tests/35_achievements.test.sql`

**Interfaces:**
- Consumes : Tasks 1 et 2 ; `wm.wallet_apply` (`1300:190-221`) ; `wm.user_rarity_counts` (`1300:12-19`).
- Produces :
  - **Amorce** (`insert … on conflict (id) do nothing` dans `public.achievements` puis `wm.achievement_rules`, les valeurs posées gagnent ; id = `md5('wm-ach:' || code)::uuid`, G8 ; `public.achievements.threshold` = celui de la règle ; `sort_order` = 10, 20, 30… dans l'ordre d'écriture ci-dessous). Format : `code` métrique seuil [rareté] → récompense ; « * » = inféré (`inferred = true`) ; titre entre guillemets quand il est connu (R:630) :
    - **Cartes et rareté** : `first_c`* first_rarity 1 C → 10 ; `first_pc`* first_rarity 1 PC → 10 ; `first_r`* first_rarity 1 R → 10 ; `first_sr` first_rarity 1 SR → 10 (titre inféré « Super rare ») ; `first_ur` first_rarity 1 UR → 25 (titre inféré « Ultra rare ») ; `first_l` « Légendaire ! » first_rarity 1 L → 75 ; `shiny_1`* shiny_copies 1 → 25 ; `shiny_5`* 5 → 50 ; `shiny_25`* 25 → 75 ; `shiny_100`* 100 → 100.
    - **Collection** : `cards_50` « Débutant » cards_total 50 → 10 ; `cards_100` « Amateur » 100 → 15 ; `cards_250` « Collectionneur » 250 → 25 ; `cards_500`* 500 → 30 ; `cards_1000`* 1 000 → 40 ; `cards_2000`* 2 000 → 50 ; `cards_5000`* 5 000 → 75 ; `cards_10000`* 10 000 → 100 ; `distinct_25`* distinct_cards 25 → 15 ; `distinct_100`* 100 → 30 ; `distinct_500`* 500 → 60 ; `showcase` « Exposition » showcase_full 4 → 25.
    - **Combat** : `wins_1`* battles_won 1 → 10 ; `wins_3`* 3 → 20 ; `wins_5` « Combattant » 5 → 50 ; `wins_10` « Stratège » 10 → 100 ; `wins_25` « Vétéran » 25 → 200 ; `wins_50` « Champion » 50 → 500 ; `wins_100` « Invincible » 100 → 750 ; `wins_200`* 200 → 100 ; `played_1`* battles_played 1 → 10 ; `played_10`* 10 → 20 ; `played_50`* 50 → 40 ; `played_100`* 100 → 60 ; `played_250`* 250 → 100.
    - **Échanges** : `trades_1`* trades_done 1 → 10 ; `trades_5`* 5 → 20 ; `trades_25`* 25 → 50 ; `trades_50`* 50 → 75 ; `trades_100`* 100 → 100 ; `donations_1`* guild_donations 1 → 15 ; `donations_10`* 10 → 40 ; `donations_50`* 50 → 80.
    - **Enchères** : `sold_1`* auctions_sold 1 → 10 ; `sold_5`* 5 → 20 ; `sold_10`* 10 → 30 ; `sold_25`* 25 → 50 ; `sold_50`* 50 → 75 ; `sold_100`* 100 → 100 ; `won_1`* auctions_won 1 → 10 ; `won_10`* 10 → 40.
    - Titres des inférés : rédigés par l'implémenteur, en français, 40 caractères au plus, tous distincts, aucun nom du jeu d'origine. Descriptions, par métrique (n en chiffres, espace simple des milliers ; à 1, la forme entre parenthèses) : `first_rarity` « Obtiens ta première carte {rareté} » (le libellé de `lib/rarity.ts:3-8` en minuscules, point final) ; `cards_total` « Possède {n} cartes. » ; `shiny_copies` « Possède {n} cartes brillantes. » (« Possède une carte brillante. ») ; `distinct_cards` « Possède {n} cartes différentes. » ; `showcase_full` « Remplis les 4 emplacements de ta vitrine. » ; `battles_won` « Gagne {n} batailles. » (« Gagne ta première bataille. ») ; `battles_played` « Termine {n} batailles. » (« Termine ta première bataille. ») ; `trades_done` « Conclus {n} échanges. » (« Conclus ton premier échange. ») ; `guild_donations` « Fais {n} dons à ta guilde. » (« Fais ton premier don à ta guilde. ») ; `auctions_sold` « Vends {n} cartes aux enchères. » (« Vends ta première carte aux enchères. ») ; `auctions_won` « Remporte {n} enchères. » (« Remporte ta première enchère. »).
  - `wm.achievement_value(p_uid uuid, p_metric text, p_rarity public.rarity default null) returns bigint` : `stable`, 0 si rien. `cards_total` Σ `copies` de `wm.user_rarity_counts` ; `first_rarity` la même somme sur `snapshot_rarity = p_rarity` ; `shiny_copies` sur `is_shiny` ; `distinct_cards` `count(distinct card_id)` de `public.user_cards` ; `showcase_full` lignes de `public.showcase` ; `battles_won` `wm.user_stats.battles_won` ; `battles_played` batailles `completed` dont il est l'un des deux joueurs ; `trades_done` échanges `accepted` dont il est initiateur ou destinataire ; `guild_donations` dons dont il est le donneur ; `auctions_sold` enchères `settled_sold` dont il est le vendeur ; `auctions_won` `settled_sold` dont il est `winner_id`. Métrique inconnue → XX000.
  - `wm.achievements_check(p_uid uuid, p_idem text default null) returns jsonb` : `{ok: true, unlocked: n}`. `idem_claim`, `actor`, `lock_timeout`, `lock_user(p_uid)` ; `achievements_checked_at > now() - check_interval_s` → 429 au corps M4b-29, `retry_after` = `least(check_interval_s, greatest(1, ceil(secondes restantes)))` ; `insert into public.user_achievements (user_id, achievement_id) select … from wm.achievement_rules r where wm.achievement_value(p_uid, r.metric, r.rarity) >= r.threshold on conflict do nothing`, `n` = lignes insérées ; `achievements_checked_at = now()` même si `n` = 0 (M5b-5) ; aucune notification.
  - `wm.achievements_claim(p_uid uuid, p_achievement_id uuid, p_idem text default null) returns jsonb` : `{ok: true}`. `idem_claim` (même clé → la réponse stockée, D-C16), `actor`, succès inconnu → 404 « Succès introuvable », `lock_timeout`, `lock_user(p_uid)`, puis la ligne `user_achievements` relue sous ce verrou : absente → 409 « Ce succès n'est pas encore débloqué » ; `claimed_at` posé → 409 « Ce succès a déjà été réclamé » ; `update … set claimed_at = now() where … and claimed_at is null` (D:611), `wm.wallet_apply(p_uid, wikibidous_reward, 'achievement', 'ach:' || id)`, `idem_store`.

- [ ] **Step 1: Tests qui échouent** (`35_achievements.test.sql` ; aides `pg_temp` de `34_guilds.test.sql`)
  - Amorce : 51 succès et 51 règles ; les 12 connus exacts (dix titres connus et les deux titres inférés de `first_sr` et `first_ur`, récompense, catégorie, métrique, seuil, rareté, `inferred` faux) ; 39 inférés, récompenses entre 10 et 100 ; par catégorie 10, 12, 13, 8 et 8 ; `sort_order` distincts et croissants dans l'ordre des catégories ; titres distincts de 40 caractères au plus ; `id` de « Légendaire ! » = `md5('wm-ach:first_l')::uuid` ; rejeu de `2050` → rien ne change, une récompense modifiée survit ; chaque métrique de la contrainte de `wm.achievement_rules` sert au moins une fois.
  - `achievement_value` : un cas par métrique, sur un joueur construit pour (copies de trois raretés dont une brillante, deux copies de la même carte, vitrine pleine, une bataille gagnée et une perdue par `pg_temp.active` et `forfeit`, un échange accepté, une vente réglée, une enchère gagnée, un don) → la valeur exacte attendue ; métrique `'x'` → XX000.
  - `check` : 50 copies C → `{ok: true, unlocked: n}` avec `n` = le nombre exact de règles atteintes (dont `cards_50` et `first_c`), lignes à `claimed_at` nul ; un second appel → 429 exact `{"status":429,"error":"Le site demande de ralentir","message":…,"retry_after":300}` (au plus 300, au moins 1) ; `achievements_checked_at` reculé de 301 s → `unlocked` 0, l'instant avancé ; les 50 copies défaussées, puis un `check` → les lignes débloquées restent (M5b-12) ; `maintenance` → 503 ; même `p_idem` → la réponse stockée.
  - ***Review Focus*, la réclamation rejouée (D:1084)** : `claim` de `cards_50` → `{ok: true}`, solde + 10, une ligne `achievement`/`ach:<id>` de `delta` 10 ; rejoué sans clé → 409 exact « Ce succès a déjà été réclamé », solde inchangé, une seule ligne ; rejoué avec la clé du premier → `{ok: true}`, solde inchangé, une seule ligne ; un succès verrouillé → 409 « Ce succès n'est pas encore débloqué » ; un uuid inconnu → 404 « Succès introuvable » ; `pg_temp.inv` vide.
  - Volatilité : `achievement_value` `'s'`. `lock_timeout` : `tests.lock_timeout_violations(array['achievements_check', 'achievements_claim'])` nul.
- [ ] **Step 2: `npm run test:db`** → `FAIL 35_achievements.test.sql`.
- [ ] **Step 3: Implémenter `2050`.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(db): succès (12 connus et 39 inférés, métriques calculées au check limité à 5 min, réclamation créditée une fois par ach:<id>)`

---

### Task 9: Classements en SQL — guildes de la semaine, joueurs, rang du lecteur

**Files:**
- Create: `supabase/migrations/2060_wm_leaderboards.sql`, `supabase/tests/36_leaderboard.test.sql`

**Interfaces:**
- Consumes : Tasks 2 et 7.
- Produces (lectures `stable`, sans `actor`) :

  | Fonction | Réponse, règles |
  |---|---|
  | `wm.guild_leaderboard() returns jsonb` | `{entries: [{rank, guild_id, guild_name, member_count, score_battles, score_wb, total_score}], week_start, week_end, season}` sur `ws := wm.week_start(now())` : `week_end` = `ws + interval '7 days'` (exclusif), `season` = `'S' \|\| to_char(ws, 'IW')` (M5b-14) ; les lignes de score de `ws` seules (les autres semaines ne sont jamais lues : aucune remise à zéro, D:575), `rank() over (order by total_score desc)`, affichage par `total_score desc, guild_name, guild_id`, `list_caps.leaderboard` au plus |
  | `wm.guild_of(p_uid uuid) returns uuid` | la guilde du joueur, sinon nul |
  | `wm.leaderboard_top(p_board text, p_period text) returns jsonb` | `{board, period, week_start, entries: [{rank, user_id, username, avatar_url, value}]}`. `p_board` hors (`battles`, `collection`, `legendary`) → 400 « Classement inconnu » ; `p_period` hors (`week`, `all`) → 400 « Période inconnue ». Valeurs (M5b-13) : `battles`/`all` `wm.user_stats.battles_won` ; `battles`/`week` batailles `completed` gagnées dont `updated_at >= ws` ; `collection`/`all` Σ `copies` de `wm.user_rarity_counts` ; `collection`/`week` Σ `count` des `user_cards` dont `obtained_at >= ws` ; `legendary` les mêmes sur la rareté `L` (`snapshot_rarity`). Valeur 0 absente ; `rank()` sur `value desc`, affichage par `value desc, username, user_id` ; `list_caps.leaderboard` au plus ; `week_start` = `ws` en `week`, nul en `all`. `-- shortcut: agrégat complet à chaque lecture partagée (60 s) ; une table de totaux au M8 si le bench le montre (D-C14).` |
  | `wm.leaderboard_me(p_uid uuid, p_board text, p_period text) returns jsonb` | mêmes refus ; `{rank, value}` du joueur sur le même agrégat, rang réel parmi tous ; nul si sa valeur est 0 |

- [ ] **Step 1: Tests qui échouent** (`36_leaderboard.test.sql` ; le fichier commence par `assert (select count(*) from public.profiles) = 0` : chaque fichier tourne seul dans `begin … rollback` sur une base sans joueur, `scripts/db-test.sh:78-80`, donc les rangs y sont exacts)
  - Guildes : trois guildes aux scores 900, 500 et 500 cette semaine et une ligne de 9 999 la semaine précédente → `entries` = trois éléments, rangs 1, 2, 2, les deux à 500 par nom, `member_count` exact, la ligne précédente absente ; `week_start` = `wm.week_start(now())`, `week_end` = + 7 jours, `season` = `'S' || to_char(wm.week_start(now()), 'IW')` ; clés exactes ; 101 guildes → 100 entrées.
  - `guild_of` : membre → sa guilde ; sans guilde → nul.
  - Joueurs, chaque couple tableau × période : trois joueurs aux valeurs construites (victoires de cette semaine et d'avant par `pg_temp.active`, `forfeit` puis `updated_at` reculé ; copies d'avant et de cette semaine par `obtained_at` ; copies L) → valeurs et rangs exacts, égalités au rang partagé et triées par `username`, un joueur à 0 absent, `week_start` nul en `all` ; `'x'` → 400 « Classement inconnu », période `'y'` → 400 « Période inconnue ».
  - Copie reçue par un échange cette semaine (son `obtained_at` d'origine, `trade_move`) → absente du `collection`/`week` du receveur (M5b-13, `1800:84`) ; présente en `all`.
  - `me` : le deuxième joueur → `{rank: 2, value}` ; un joueur à 0 → nul.
  - Volatilité : les quatre fonctions `'s'`.
- [ ] **Step 2: `npm run test:db`** → `FAIL 36_leaderboard.test.sql`.
- [ ] **Step 3: Implémenter `2060`.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(db): classements (guildes de la semaine avec saison ISO, joueurs par victoires, collection et légendaires, semaine ou depuis toujours, rang du lecteur)`

---

### Task 10: Concurrence des guildes et des succès

**Files:**
- Create: `supabase/tests/20_guilds_concurrency.test.sh`

**Interfaces:**
- Consumes : Tasks 3 à 8 ; les aides `q`, `fail`, `bg`, `waitall`, `refusals`, `quiet`, `sleeping`, `hold`, `released` et `ms` de `19_battles_concurrency.test.sh`, recopiées telles quelles, le préfixe des messages devenant `20_guilds_concurrency :` ; `tag="gld_$RANDOM$RANDOM"`, cartes et `cleanup` en `trap` comme la Task 6 du M5a (P5a:518), plus la restauration de `guild` dans `wm.config`.
- Produces : la liste des scénarios en tête du fichier. « Derrière un bloqueur » = `hold <nom> "<verrous>" <n>`, puis les n appels par `bg`, puis `released <nom> <n/2>` et `waitall`. « La fin » = une bataille A (gagnant, membre de G) contre B, à la dernière réponse d'un KO, défenseur B, jouée par `bg` ; elle prend les deux profils puis la guilde en `key share`. Chaque scénario attend : aucun `40P01` ni `55P03` (`refusals`, `quiet`), `check_invariants()` = `[]`, et l'appel servi.
- [ ] **Step 1: Scénarios** (M5b-1 : un par opération ; M4, M15 ; chaque mutation éprouvée rouge une fois, puis remise)
  - **1. `join` contre la fin** : B invité dans G. Derrière `hold s1 "perform from public.profiles where id in ('$a', '$b') order by id for update" 2`, la fin et `wm.guild_join(B, G)`. Attendu : les deux servis, B membre, G à +500. Mutation : `guild_join` qui prend la guilde `for update` **avant** `lock_user` → un `40P01`.
  - **2. `invite` contre la fin** : M (membre de G, ami de B) invite B pendant la fin. Mutation : la guilde `for update` avant `lock_users` → un `40P01`.
  - **3. `transfer` contre la fin** : le chef L transfère à A pendant la fin. Mutation : idem.
  - **4. `create` contre la fin** : B crée une guilde pendant la fin → les deux servis.
  - **5. `leave` contre la fin** (M4) : A quitte G pendant la fin → les deux servis ; G à +500 ou rien, jamais une erreur ; A seul membre (dissolution) → la fin rend 200, `guildPoints` 0 ou 500, aucune ligne de score orpheline. Mutation : `guild_leave` qui prend la guilde `for update` (au lieu de `for no key update`), puis le profil de A `for update` → un `40P01` (le cycle de M4).
  - **6. `kick` contre la fin et contre `invite`** : le chef exclut A pendant la fin ; puis le chef exclut M pendant que M invite C (M tient son profil, puis attend la guilde). Attendu : servis, sans cycle. Mutation : le `for key share` de G2 retiré → un `40P01` dans la seconde moitié, sinon « non reproduite » dans le rapport de tâche (le contrôle `prosrc` de la Task 4 tient l'ordre).
  - **7. Dons croisés** (M15), 20 tours : A souhaite X, B souhaite Y ; `guild_donate(A, W_B, …)` et `guild_donate(B, W_A, …)` lancés ensemble → les deux servis ; deux donneurs pour le même souhait → un seul don, l'autre 404 « Ce souhait n'existe plus » ; exactement une ligne `guild_donations` par souhait clos.
  - **8. Fin pendant un lot de règlement** (M15) : une vente due d'un vendeur de G ; une session lance `begin; select wm.settle_due_auctions(500); select pg_sleep(1); commit;` en arrière-plan, puis la fin (A de G) → servie après 0,5 s au moins et avant 2 s ; G a `score_wb` = le prix et `score_battles` 500.
  - **9. Double `claim`** (D:1084, M15) : 10 `wm.achievements_claim(A, X)` sans clé derrière `hold s9` sur le profil de A → exactement 1 `{ok: true}` et 9 refus « Ce succès a déjà été réclamé » ; une seule ligne `ach:<X>` ; solde + la récompense une fois. Puis même clé, deux sessions (gabarit du scénario 4 de `19_battles_concurrency.test.sh`) : la seconde servie après 500 ms au moins, au même corps. Mutation : la garde `claimed_at is null` relue **avant** `lock_user` → deux `{ok: true}`, une seule ligne de grand livre (le rejeu de `wallet_apply` masque le crédit, D-C16), et le test échoue sur le nombre de succès.
  - **10. Adhésions au plafond** : `guild.max_members` à 3, G à 2 membres, 5 invités ; derrière `hold s10 "perform from public.guilds where id = '$g' for no key update" 1`, 5 `guild_join` → exactement 1 servi, 4 refus « Cette guilde est pleine », 3 membres. Mutation : la guilde lue sans verrou → 4 ou 5 membres.
  - **11. Deux `check` simultanés** : exactement un `{ok: true, …}` et un 429.
- [ ] **Step 2: `npm run test:db`** → vert ; chaque mutation éprouvée rouge une fois, puis remise, et notée dans le rapport de tâche.
- [ ] **Step 3: Contrôles complets** → vert.
- [ ] **Step 4: Commit** — `test(db): concurrence du M5b (adhésion, invitation, transfert, création, départ et exclusion contre la fin d'une bataille, dons croisés, fin pendant un lot de règlement, double réclamation, adhésions au plafond, check doublé)`

---

### Task 11: Routes et contrat du §3.10 — quinze routes de guilde

**Files:**
- Create: `app/api/guilds/route.ts` (GET, POST), `app/api/guilds/join/route.ts`, `app/api/guilds/invites/[guildId]/route.ts` (DELETE), `app/api/guilds/home/route.ts`, `app/api/guilds/wishlist/route.ts` (PUT, DELETE), `app/api/guilds/wishlist/donate/route.ts`, `app/api/guilds/members/route.ts`, `app/api/guilds/invite/route.ts`, `app/api/guilds/kick/route.ts`, `app/api/guilds/transfer-leadership/route.ts`, `app/api/guilds/leave/route.ts`, `app/api/guilds/chat/route.ts` (GET, POST), `contract/spec/guilds.ts`
- Modify: `lib/schemas.ts` (`intParam` exporté, `:7` ; schémas ci-dessous), `contract/spec/index.ts` (`...guilds`)

**Interfaces:**
- Consumes : `route()` (`lib/route.ts:80-118`) ; les fonctions des Tasks 3 à 6 ; `makeUser`, `giveCards`, `send`, `idem`, `failed`, `refused`, `ok`, `created`, `noSession`, `psql`, `Iso` (`contract/users.ts`) ; `befriend` (`contract/spec/friends.ts:28`) ; `ChatBody` (`lib/schemas.ts:72`) ; les guides Next des Global Constraints.
- Produces :
  - `lib/schemas.ts` : `export const intParam` ; `GuildParams = z.object({ guildId: z.uuid() })` ; `GuildCreate = z.object({ name: pgText, description: pgText.nullish() })` ; `GuildJoin = z.object({ guild_id: z.uuid() })` ; `GuildTarget = z.object({ user_id: z.uuid() })` ; `GuildWish = z.object({ card_id: z.uuid() })` ; `GuildDonate = z.object({ wishlist_id: z.uuid(), user_card_id: z.uuid() })` ; `GuildMembersQuery = z.object({ limit: intParam.optional(), offset: intParam.default(0) })` (longueurs et bornes en SQL, P11).
  - Routes (chaque handler en 1 à 3 lignes ; toutes les écritures `idem: true`, aucune `push`, commentaire « Types guild_* dans la cloche seulement (D-C17) : aucun push à drainer. » dans `app/api/guilds/route.ts`) :

    | Route | `fn` | Entrée, `args`, statut |
    |---|---|---|
    | `GET /api/guilds` | `guild_get` | — |
    | `POST /api/guilds` | `guild_create` | `GuildCreate` → `{ p_name, p_description }`, `status: 201` |
    | `POST /api/guilds/join` | `guild_join` | `GuildJoin` → `{ p_guild_id }` |
    | `DELETE /api/guilds/invites/{guildId}` | `guild_invite_decline` | `params: GuildParams` → `{ p_guild_id }` |
    | `GET /api/guilds/home` | `guild_home` | — |
    | `PUT /api/guilds/wishlist` | `guild_wish_set` | `GuildWish` → `{ p_card_id }` |
    | `DELETE /api/guilds/wishlist` | `guild_wish_clear` | — |
    | `POST /api/guilds/wishlist/donate` | `guild_donate` | `GuildDonate` → `{ p_wishlist_id, p_user_card_id }` |
    | `GET /api/guilds/members` | `guild_members` | `GuildMembersQuery` → `{ p_limit, p_offset }` |
    | `POST /api/guilds/invite`, `/kick`, `/transfer-leadership` | `guild_invite`, `guild_kick`, `guild_transfer` | `GuildTarget` → `{ p_user_id }` |
    | `POST /api/guilds/leave` | `guild_leave` | — |
    | `GET /api/guilds/chat` | `guild_chat_list` | — |
    | `POST /api/guilds/chat` | `guild_chat_send` | `ChatBody` → `{ p_content }`, `status: 201` |

  - `contract/spec/guilds.ts` (modèle `contract/spec/battles.ts:9-38`) : `Who = z.strictObject({ id: z.uuid(), username: z.string() })` ; `Guild = z.strictObject({ id: z.uuid(), name: z.string(), description: z.string().nullable(), leader_id: z.uuid().nullable(), created_at: Iso })` ; `Membership = z.strictObject({ guild_id: z.uuid(), user_id: z.uuid(), role: z.enum(['leader', 'member']), joined_at: Iso })` ; `Invite = z.strictObject({ guild_id: z.uuid(), guild_name: z.string(), inviter_username: z.string(), created_at: Iso })` ; `State = z.strictObject({ guild: Guild.nullable(), membership: Membership.nullable(), member_count: z.int().min(0), invites: z.array(Invite) })` ; `Ok = z.strictObject({ ok: z.literal(true) })` ; `Member = z.strictObject({ user_id: z.uuid(), id: z.uuid(), username: z.string(), profile: z.strictObject({ username: z.string() }), user: z.strictObject({ username: z.string() }), role: z.enum(['leader', 'member']), joined_at: Iso })` ; `Members = z.strictObject({ members: z.array(Member), hasMore: z.boolean() })` ; `Message = z.strictObject({ id: z.uuid(), user_id: z.uuid(), content: z.string(), created_at: Iso, username: z.string(), user: z.strictObject({ username: z.string() }), profile: z.strictObject({ username: z.string() }) })` ; `Wish = z.strictObject({ id: z.uuid(), user_id: z.uuid(), card: z.object({ id: z.uuid(), wikipedia_title: z.string() }).loose(), created_at: Iso, can_donate: z.boolean(), recipient_received_today: z.boolean(), user: Who, recipient: Who, my_copies: z.array(z.strictObject({ id: z.uuid(), count: z.int().min(1), is_shiny: z.boolean() })) })` ; `Home = z.strictObject({ my_wishlist: Wish.nullable(), wishlists: z.array(Wish), weekly_karma_donors: z.array(z.strictObject({ user_id: z.uuid(), username: z.string(), karma: z.int(), karma_this_week: z.int(), donations_this_week: z.int() })), received_donation_today: z.boolean() })` ; quinze `RouteSpec`, `source: 'R§3.10'`, `confidence: 'prob.'` ; aide exportée `guildWith(env: ContractEnv, leader: string, members?: string[]): string` (amitiés par `befriend`, puis `wm.guild_create`, `wm.guild_invite` et `wm.guild_join` par psql ; rend l'id de la guilde).

- [ ] **Step 1: Specs de contrat qui échouent** (chaque erreur au corps entier par `refused` ; le 429 par `failed`)
  - `noSession` sur les quinze.
  - `GET /api/guilds` : sans guilde → `State` à `guild` nul, `member_count` 0, `invites` `[]` ; invité → `invites` d'un élément.
  - `POST /api/guilds` : 201 `State` (chef, 1 membre) ; nom de 41 caractères → 400 exact ; `{name: 'a\u0000'}` → 400 « Caractère invalide » ; déjà membre → 409 exact ; même clé deux fois → corps identiques, une seule guilde (psql).
  - `join` : invité → 200 `State` ; sans invitation → 403 exact ; plein (`guild.max_members` posé par psql, restauré en `finally`) → 409 exact. `DELETE invites/{guildId}` : → `Ok` ; `abc` → 400 `invalid_request` ; de nouveau → 404 exact.
  - `invite` : ami → `Ok` et une `guild_invite` (psql) ; non-ami → 403 exact ; `kick` : chef → `Ok` ; membre → 403 exact ; `transfer-leadership` : → `Ok`, `leader_id` changé (psql) ; vers soi → 400 exact ; `leave` : chef avec membres → 409 exact ; dernier membre → `Ok`, la guilde absente (psql).
  - `members` : `Members` ; `?limit=1` → 1 élément, `hasMore` vrai ; `?limit=-1` → 400 `invalid_request`.
  - `chat` : `POST` 201 `{message: Message}` ; 1 001 caractères → 400 exact ; `GET` → `{messages}` passé par `z.strictObject({ messages: z.array(Message) })`, du plus ancien au plus récent ; ***Review Focus*, seau partagé par HTTP** : `chat_burst.count` posé à 2 par psql (restauré en `finally`) ; deux messages privés par `POST /api/chat/{peerId}` puis un message de guilde → `failed(res, 429)` sans `code`, `retry_after` entier, `Retry-After` entre 1 et 60.
  - `wishlist` : `PUT` → `{wishlist}` strict à quatre clés ; carte inconnue → 404 exact ; `DELETE` → `Ok`, puis 404 exact. `home` → `Home`. `donate` : → `z.strictObject({ ok: z.literal(true), wishlist_id: z.uuid() })`, la copie au receveur (psql) ; second don le même jour → 409 exact ; copie d'un autre → 403 `42501` exact ; même clé deux fois → corps identiques, un seul don ; `check_invariants()` = `[]`.
  - ***Review Focus*, ce que voit un autre joueur** : un joueur sans guilde sur `home`, `members` et `chat` → 404 « Tu n'es dans aucune guilde » ; un membre d'une guilde H ne voit dans aucune de ses réponses l'id d'un message, d'un souhait ni d'un membre de G (recherche des ids de G, lus par psql, dans le texte des corps).
  - `index.ts` ajoute `...guilds`.
- [ ] **Step 2: `npm run build:test && npm run test:contract`** → échec.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert ; `coverage:recap` passe de 70 à 85.
- [ ] **Step 5: Commit** — `feat(api): guildes (lecture, création, adhésion, refus, entraide, membres, invitation, exclusion, transfert, départ, chat) et leur contrat`

---

### Task 12: Routes et contrat du §3.8 et des classements — cache partagé, 90/90 bloquant

**Files:**
- Create: `app/api/achievements/check/route.ts`, `app/api/achievements/claim/route.ts`, `app/api/guilds/leaderboard/route.ts`, `app/api/leaderboard/route.ts`, `lib/leaderboard-cache.ts`, `contract/spec/achievements.ts`, `contract/spec/leaderboard.ts`
- Modify: `lib/market-cache.ts` (`export` devant `sharedRpc`, `:11`, et `busy`, `:22` ; rien d'autre), `next.config.ts:11-15` (profils `guilds` et `players`, G11), `lib/schemas.ts`, `contract/spec/rest.ts` (deux `spec(…)`), `contract/spec/index.ts` (`...achievements`, `...leaderboards`), `contract/recap-coverage.ts:12` (G12)

**Interfaces:**
- Consumes : Tasks 8 et 9 ; le modèle `lib/market-cache.ts:24-56` ; `rest()` et `spec()` de `contract/spec/rest.ts:13-54` ; les guides `use-cache-remote.md`, `cacheLife.md`, `cacheTag.md`.
- Produces :
  - `lib/schemas.ts` : `AchievementCheck = z.object({ event: z.literal('achievements_sync', { error: 'Événement inconnu' }) })` ; `AchievementClaim = z.object({ achievement_id: z.uuid() })` ; `LeaderboardQuery = z.object({ board: z.enum(['battles', 'collection', 'legendary'], { error: 'Classement inconnu' }).default('battles'), period: z.enum(['week', 'all'], { error: 'Période inconnue' }).default('week') })`.
  - `lib/leaderboard-cache.ts` : `sharedGuildBoard(): Promise<RpcResult>` et `sharedPlayerBoard(board: string, period: string): Promise<RpcResult>`, chacune `'use cache: remote'`, `cacheTag('leaderboard')`, un seul `cacheLife` par branche (`busy` → `'auction'`, sinon `'guilds'` ou `'players'`), par `sharedRpc('guild_leaderboard', {})` et `sharedRpc('leaderboard_top', { p_board, p_period })` ; `guildBoardCall(args: Record<string, unknown>): Promise<RpcResult>` = le partagé, plus `user_guild_id` (`wm.guild_of(p_uid)`, hors cache) et `reset_in_ms` (G11) ; `playerBoardCall(args)` = le partagé, plus `me` (`wm.leaderboard_me(p_uid, p_board, p_period)`, hors cache). Une erreur du partagé ou de l'appel du lecteur est rendue telle quelle.
  - Routes : `GET /api/guilds/leaderboard` = `route({ fn: 'guild_leaderboard', call: guildBoardCall })` ; `GET /api/leaderboard` = `route({ fn: 'leaderboard_top', input: LeaderboardQuery, args: (i) => ({ p_board: i.board, p_period: i.period }), call: playerBoardCall })` ; `POST /api/achievements/check` = `route({ fn: 'achievements_check', input: AchievementCheck, idem: true })` (l'événement ne part pas en SQL) ; `POST /api/achievements/claim` = `route({ fn: 'achievements_claim', input: AchievementClaim, idem: true, args: (i) => ({ p_achievement_id: i.achievement_id }) })`.
  - Contrat (`contract/spec/achievements.ts` exporte `achievements`, deux `RouteSpec` ; `contract/spec/leaderboard.ts` exporte `leaderboards`, deux `RouteSpec`) : `GuildBoard = z.strictObject({ entries: z.array(z.strictObject({ rank: z.int().min(1), guild_id: z.uuid(), guild_name: z.string(), member_count: z.int().min(0), score_battles: z.int().min(0), score_wb: z.int().min(0), total_score: z.int().min(1) })), week_start: Iso, week_end: Iso, season: z.string().regex(/^S\d{2}$/), reset_in_ms: z.int().min(0), user_guild_id: z.uuid().nullable() })` (`source: 'R§3.10'`, `prob.`) ; `PlayerBoard = z.strictObject({ board: z.enum(['battles', 'collection', 'legendary']), period: z.enum(['week', 'all']), week_start: Iso.nullable(), entries: z.array(z.strictObject({ rank: z.int().min(1), user_id: z.uuid(), username: z.string(), avatar_url: z.string().nullable(), value: z.int().min(1) })), me: z.strictObject({ rank: z.int().min(1), value: z.int().min(1) }).nullable() })` (`source: 'D:613'`, `confidence: 'ajouté'`) ; `Achievement = z.strictObject({ id: z.uuid(), title: z.string(), description: z.string(), wikibidous_reward: z.int().min(1), sort_order: z.int(), category: z.string(), threshold: z.int().min(1) })` ; `source: 'R§3.8'`, `prob.` pour `check`, `claim` et les deux lectures REST.

- [ ] **Step 1: Specs de contrat qui échouent**
  - `noSession` sur les quatre routes `/api/…`.
  - `check` : `{}` → 400 `invalid_request` « Événement inconnu » ; `{event: 'achievements_sync'}` → `z.strictObject({ ok: z.literal(true), unlocked: z.int().min(0) })` ; aussitôt de nouveau (autre clé) → `failed(res, 429)`, corps exactement `{error, message, retry_after}`, `Retry-After` entre 1 et 300.
  - ***Review Focus*, la réclamation rejouée par HTTP (D:1084)** : un succès débloqué par `check` (le joueur a 50 copies C par `giveCards`) ; `claim` → `{ok: true}` ; même clé → corps identique ; autre clé → 409 exact « Ce succès a déjà été réclamé » ; psql : une seule ligne `ach:<id>`, solde = solde d'avant + la récompense ; un succès verrouillé → 409 exact ; un uuid inconnu → 404 exact ; `check_invariants()` = `[]`.
  - `GET rest/v1/achievements?select=*` (JWT du joueur) → 51 éléments, chacun `Achievement` ; `POST` de la même table → le refus `42501` que `rest.ts` attend déjà d'une table sans droit d'écriture. `GET rest/v1/user_achievements?select=achievement_id,claimed_at&user_id=eq.<moi>` → ses lignes seules, `[{achievement_id, claimed_at}]` ; `user_id=eq.<autre>` → `[]` ; `PATCH` de `claimed_at` → `42501`.
  - `GET /api/leaderboard` : sans paramètre → `board` `battles`, `period` `week` ; `?board=x` → 400 exact « Classement inconnu » ; `?period=y` → 400 « Période inconnue » ; un joueur à deux victoires cette semaine (batailles jouées par psql, fins par `forfeit`) → `me` = `wm.leaderboard_me(<lui>, 'battles', 'week')` lu par psql ; deux joueurs sur la même combinaison → même `entries`, `me` différents (`me` hors cache, M8) ; **premier appel du contrat** à `board=legendary&period=all` → `entries` = `wm.leaderboard_top('legendary', 'all') -> 'entries'` lu par psql juste avant ; `week_start` nul en `all`.
  - `GET /api/guilds/leaderboard` (seul cas du contrat qui la lit ; il pose d'abord un score de G par `wm.guild_score_add`) : `GuildBoard` ; `entries` = `wm.guild_leaderboard() -> 'entries'` ; `season` et `week_end` = ceux de psql ; `user_guild_id` = G pour un membre, nul pour un joueur sans guilde, lus l'un après l'autre (hors cache, M8) ; `reset_in_ms` à 5 s près de `week_end − maintenant`.
  - `index.ts` ajoute les deux fichiers ; `rest.ts` ses deux `spec`.
- [ ] **Step 2: `npm run build:test && npm run test:contract`** → échec.
- [ ] **Step 3: Implémenter** ; puis `contract/recap-coverage.ts:12` : `process.exitCode = missing.length ? 1 : 0`, le `shortcut:` retiré.
- [ ] **Step 4: Contrôles complets** → vert ; `npm run -s coverage:recap` affiche `Recap : 90 routes · couvertes : 90 · manquantes :` et sort 0 ; une spec retirée à la main (essai local, non commité) → sortie 1.
- [ ] **Step 5: Commit** — `feat(api): succès (check limité, réclamation rejouable), classements des guildes et des joueurs en cache partagé, part du lecteur hors cache ; coverage:recap à 90/90 et bloquant`

---

### Task 13: Dette Wikimédia — repli compté, carte gardée en file

**Files:**
- Modify: `scripts/quiz/generate.ts:17` (`Summary`), `:122-135` (`textOf`), `:163-168` (texte court), `scripts/quiz/generate.test.ts`, `docs/superpowers/HANDOFF.md` (« Exploitation des batailles », lignes « Lire un run » et « Wikimédia en échec »)

**Interfaces:**
- Produces : `textOf(card: QueueCard): Promise<{ text: string; fallback: boolean } | null>` — `fallback` vrai seulement dans la branche `catch` (G7) ; `Summary` gagne `fallback: number` (cartes passées sur leur résumé faute de Wikimédia). Un texte de repli de moins de 200 caractères : `summary.skipped++`, sa ligne JSON, **aucun** `quiz_fail` (la carte reste en file, M5b-16) ; un texte de repli assez long suit le chemin normal. Rien d'autre ne change (`.github/workflows/quiz-bank.yml` et `scripts/quiz/workflow.test.ts` non plus).
- [ ] **Step 1: Tests qui échouent** (`scripts/quiz/generate.test.ts`)
  - le test de `:197` (« client Wikimedia en échec … ») attend en plus `summary.fallback` = le nombre de cartes ;
  - nouveau : « Wikimédia en échec et résumé de 150 caractères → skipped 1, fallback 1, aucun quiz_fail, aucun appel amont » ;
  - `:168` (texte de 150 caractères hors repli → `quiz_fail(short_text)`) et `:190` (page sans extrait → le résumé, `fallback` 0) restent tels quels ;
  - chaque assertion d'un résumé entier gagne `fallback: 0` (ou sa valeur) ; le test des journaux (`:310`) reste vert.
- [ ] **Step 2: `npm test`** → échec.
- [ ] **Step 3: Implémenter** ; `HANDOFF.md` : le résumé se lit `{cards, stored, failed, skipped, fallback, rejected, stopped}` ; « Wikimédia en échec » devient « la carte passe sur son résumé, comptée dans `fallback` ; un résumé trop court la laisse en file, sans `quiz_fail` (M5b-16) ».
- [ ] **Step 4: Contrôles rapides** → vert.
- [ ] **Step 5: Commit** — `fix(quiz): repli Wikimédia compté dans le résumé, une carte au résumé court gardée en file au lieu de quiz_fail(short_text)`

---

### Task 14: Raccords — types `guild_*` dans la cloche, +500 dans les règles et à la fin d'une bataille

**Files:**
- Modify: `lib/notification-view.ts:16-39`, `lib/notifications.test.ts:110-139`, `components/battle/BattleRules.tsx:4-15`, `components/battle/types.ts:74-84` (et le type de `game_state`), `app/(game)/battle/[id]/arena-client.tsx` (écran de fin), `e2e/battle.spec.ts:390-400` et sa partie fin de partie, `e2e/notifications.spec.ts`, `e2e/fixtures.ts`

**Interfaces:**
- Consumes : `wm.notify_guild` et ses `data` (Task 2) ; `rules.guild_points_win` (Task 2) ; `game_state.guildPoints` (Task 7) ; `wm.guild_create`, `wm.guild_invite`, `wm.guild_join` (Task 3).
- Produces :
  - `notificationView` : les trois cas du catalogue (Global Constraints), `href` `/guild` ; `PUSH_FAMILIES` et `pushTypes()` inchangés.
  - `Rules` gagne `guild_points_win: number` ; le type de `game_state` gagne `guildPoints?: number`.
  - `BattleRules` : dernière ligne `Gagnant : +${formatInt(r.guild_points_win)} points pour sa guilde, s'il en a une.` ; le commentaire de `:4` dit « chaque valeur lue dans wm.config (M5a-16), +500 de guilde compris (M5b-3) ».
  - Arène, `completed` : sous « +{reward} {wikibidous(reward)} », si le lecteur est `winner_id` et `game_state.guildPoints > 0`, une ligne « +{formatInt(guildPoints)} points pour ta guilde » ; rien sinon, ni chez le perdant.
  - `e2e/fixtures.ts` : `makeGuild(leader: User, members: User[] = [], name?: string): string` — `befriend(leader, m)` pour chaque membre, puis `wm.guild_create`, `wm.guild_invite`, `wm.guild_join` par `sql` ; rend l'id ; le nom par défaut `` `Guilde ${randomUUID().slice(0, 8)}` `` (un pseudo peut dépasser 40 caractères).
- [ ] **Step 1: Tests qui échouent**
  - `lib/notifications.test.ts` : le type inconnu de `:119` devient `'inconnu_x'` (attendu `:135` inchangé), le titre du test garde son compte ; nouveau cas : les trois types avec `{guild_id: 'g-1', guild_name: 'Les Archivistes', user_id: 'u-1', username: 'Alice'}` → `{text: 'Alice t\'invite dans la guilde Les Archivistes', href: '/guild'}`, `{text: 'Tu ne fais plus partie de la guilde Les Archivistes', href: '/guild'}`, `{text: 'Alice t\'a donné la carte que tu demandais', href: '/guild'}`. Le test de `:159-165` reste vert.
  - `e2e/notifications.spec.ts` : une `guild_invite` posée par `sql` (`wm.guild_invite`) → « <pseudo> t'invite dans la guilde <nom> », au `href` `/guild`.
  - `e2e/battle.spec.ts:390-400` : `not.toContainText(/guilde/i)` devient `toContainText("Gagnant : +500 points pour sa guilde, s'il en a une.")` ; le titre du test dit « +500 points de guilde » au lieu de « aucun point de guilde ».
  - `e2e/battle.spec.ts`, fin de partie (bataille close par `forfeit` par `sql`) : gagnant membre d'une guilde (`makeGuild`) → « +500 points pour ta guilde » ; gagnant sans guilde → aucune ligne « points pour ta guilde » ; perdant membre → aucune.
- [ ] **Step 2: `npm test && npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/battle.spec.ts e2e/notifications.spec.ts`** → échec.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(ui): notifications de guilde dans la cloche, +500 points de guilde annoncés dans les règles et à la fin d'une bataille gagnée`

---

### Task 15: Page `/guild` (1/2) — sans guilde, en-tête, membres, invitation, départ

**Files:**
- Create: `app/(game)/guild/guild-client.tsx`, `components/guild/types.ts`, `components/guild/NoGuild.tsx`, `components/guild/GuildMembers.tsx`, `e2e/guild.spec.ts`
- Modify: `app/(game)/guild/page.tsx` (une coquille au lieu de `ComingSoon`), `components/ui/button.ts` (`danger`, G14), `app/(game)/battle/[id]/arena-client.tsx:26` (importe `danger`), `e2e/shell.spec.ts:94` (+ `'/guild'`), `e2e/a11y.spec.ts` (`READY['/guild']` = `'main [data-ready]'`, et `/guild` dans les deux tableaux de `:58-61`)

**Interfaces:**
- Consumes : les routes de la Task 11 ; `GET /api/friends` (`{friendships}`, lu comme `app/(game)/battle/battle-client.tsx:112`) ; le joueur de la session (`createBrowserSupabase().auth.getSession()`, P16) ; `unreadStore` (`lib/notifications.ts:58`, lu comme `app/(game)/dms/dms-client.tsx:63`) ; `PageHeader`, `Section`, `ReadError`, `LoadError`, `Loading`, `Modal`, `tabKey`, `toast`, `primary`, `ghost`, `link` ; `api`, `apiOnce`, `unsure`, `UNSURE`, `userMessage` ; `formatInt`, `formatShortDate` ; `makeGuild` (Task 14).
- Produces :
  - `components/guild/types.ts` : `type Guild`, `type Membership`, `type GuildInvite`, `type GuildState = { guild: Guild | null; membership: Membership | null; member_count: number; invites: GuildInvite[] }`, `type Member`, `type MemberPage = { members: Member[]; hasMore: boolean }`, `type Wish`, `type GuildHome`, `type ChatMessage`, `type GuildBoardData` (formes des Tasks 11 et 12) ; `membersLabel(n: number): string` → « 1 membre » ou « {formatInt(n)} membres ».
  - `page.tsx` : coquille `div.flex-1.p-4.md:p-6.space-y-6`, `metadata.title` = `navEntry('/guild').title`.
  - `GuildClient` : `PageHeader` « Guilde » ; `GET /api/guilds` lisible si `r && 'guild' in r && Array.isArray(r.invites)`, relu à chaque affichage et à chaque version de `unreadStore()` (une invitation ou une exclusion arrive par la cloche) ; `data-ready` quand cette lecture et la session ont abouti ou échoué ; « Chargement de la guilde » ; `LoadError` et « Réessayer » → le h1. Toute réponse 404 « Tu n'es dans aucune guilde » d'une lecture ou d'une écriture d'onglet relit `GET /api/guilds` ; si la vue passe alors sans guilde, toast « Tu ne fais plus partie de cette guilde. ».
  - `NoGuild` (vue sans guilde) :
    - `card-frame` : « Tu n'as pas encore de guilde. » et « Pour en rejoindre une, demande à un ami membre de t'inviter. » ;
    - `Section` « Invitations » : une ligne par invitation, nom de la guilde (`wrap-anywhere`), « Invitation de {inviter_username} » et la date courte dans un `time` ; « Rejoindre » (`primary`) et « Refuser » (`ghost`), chacun décrit par le nom (`aria-describedby`) ; vide : « Aucune invitation. » (`tabIndex -1`) ; refus → `role="alert"` sur la ligne, texte du serveur ; incertain → `UNSURE` sur la ligne, clé gardée, relecture ;
    - `Section` « Créer une guilde » : « Nom de la guilde » (`maxLength` 40, compteur « {n} / 40 »), « Description (facultatif) » (`textarea`, `maxLength` 280, « {n} / 280 »), « Créer la guilde » (`primary`, `aria-disabled` sans nom non blanc) ; champs `readOnly` pendant l'envoi ; refus → `role="alert"` sous le formulaire ; incertain → `UNSURE`, relecture.
  - Vue membre :
    - `card-frame` d'en-tête : h2 focalisable (`tabIndex -1`) au nom, description en `whitespace-pre-wrap`, `membersLabel(member_count)`, pastille « Chef » si `role` = `leader`, « Quitter la guilde » (`ghost`) ;
    - onglets `[role=tablist][aria-label="Vues de la guilde"]` sur le modèle de `battle-client.tsx:275-296` (soulignés, `tabKey`, 44 px, un seul panneau monté) : ici le seul onglet « Membres » ; la Task 16 ajoute Chat (par défaut), Entraide et Classement ;
    - `GuildMembers` : `GET /api/guilds/members?limit=50&offset=<n>` lisible si `Array.isArray(r?.members) && typeof r.hasMore === 'boolean'` ; une ligne par membre : pseudo en lien vers `/profile/{encodeURIComponent(username)}`, pastille « Chef », « Membre depuis le {formatShortDate(joined_at)} » ; « Charger la suite » (bordé) si `hasMore` ; « Chargement des membres », échec « Les membres n'ont pas pu être chargés. » (`ReadError`) ;
    - chez le chef, sur chaque autre membre : « Nommer chef » et « Exclure » (`ghost`, décrits par le pseudo), confirmés en `Modal` : « Nommer {pseudo} chef de la guilde ? », « Tu deviendras simple membre. », « Nommer chef » (`primary`) et « Annuler » ; « Exclure {pseudo} de la guilde ? », « Il ne pourra revenir que sur une nouvelle invitation. », « Exclure » (`danger`) et « Annuler » ; toasts « {pseudo} est maintenant chef de la guilde. » et « {pseudo} a été exclu de la guilde. » ;
    - chez tout membre : « Inviter un ami » (`primary`) → `Modal` « Inviter un ami » : les amis acceptés de `GET /api/friends` hors des membres déjà lus, chacun avec « Inviter » ; vide « Aucun ami à inviter. » ; succès → toast « Invitation envoyée à {pseudo}. » et la ligne montre « Invité » ; refus → `role="alert"` dans la modale ;
    - « Quitter la guilde » → `Modal` « Quitter {nom} ? » : chef avec d'autres membres → « Transmets d'abord ton rôle de chef à un membre. » et « Quitter » en `aria-disabled` décrit par cette phrase ; seul membre → « Tu es le dernier membre : la guilde sera dissoute. » ; sinon « Tu pourras revenir sur une nouvelle invitation. » ; « Quitter » (`danger`) et « Annuler » ; succès → vue sans guilde, toast « Tu as quitté la guilde. ».
  - Focus (Global Constraints) : « Rejoindre » ou « Créer la guilde » réussis → le h2 du nom ; « Refuser » → « Rejoindre » de l'invitation suivante, sinon « Aucune invitation. » ; « Quitter » réussi → le h1 ; « Exclure » → « Exclure » du membre suivant, sinon le h2 ; « Nommer chef » → le h2 ; « Réessayer » d'un onglet → l'onglet sélectionné ; modale fermée → son ouvreur (`Modal`).
- [ ] **Step 1: Tests E2E qui échouent** (`e2e/guild.spec.ts` ; guildes, amitiés et invitations posées par `sql`, par les fonctions `wm.guild_*`)
  - h1 « Guilde », titre `^Guilde — ` ; `/guild` sort de la liste « Cette section arrive bientôt. » (`e2e/shell.spec.ts:94`).
  - Sans guilde ni invitation : les deux phrases, « Aucune invitation. » ; créer au clavier (« Nom de la guilde », Tab, Tab, Entrée sur « Créer la guilde ») → le h2 au nom focalisé, « 1 membre », « Chef » ; `sql` compte une guilde. Nom blanc → « Créer la guilde » en `aria-disabled`, aucun `POST`.
  - Deux invitations (G puis H) : H en premier ; « Refuser » sur H → « Rejoindre » de G `toBeFocused()` ; « Rejoindre » G → la vue membre, h2 « <G> » focalisé.
  - Refus forcé à « Rejoindre » (`guild.max_members` posé à 1, `try`/`finally`) → l'alerte « Cette guilde est pleine » sur la ligne.
  - Issue incertaine sur « Créer la guilde » (`routeOnce` sur `POST`, `r.fetch()` puis `fulfill({ status: 500 })`) → `UNSURE` ; la relecture montre la vue membre, l'alerte tombe, `sql` compte une seule guilde.
  - Membres, chez le chef de trois membres : les trois lignes, « Chef » sur lui ; « Exclure » → la modale → « Exclure » → la ligne disparaît, toast, « Exclure » du membre suivant focalisé ; « Nommer chef » → la pastille passe, plus aucun « Exclure ».
  - « Inviter un ami » : deux amis dont un membre → un seul « Inviter » ; « Inviter » → toast, « Invité », `sql` voit la ligne de `wm.guild_invites`.
  - Quitter : chef avec membres → « Quitter » de la modale en `aria-disabled` avec sa phrase ; membre → vue sans guilde, toast, h1 focalisé ; chef seul → la phrase de dissolution, puis `sql` ne voit plus la guilde.
  - Exclu pendant la visite : la guilde ouverte, le chef exclut le joueur par `sql`, puis la cloche (`unreadStore`) change → vue sans guilde et le toast « Tu ne fais plus partie de cette guilde. ».
  - Lectures en échec, même boucle (`500`, `200 illisible`) : `**/api/guilds` → `LoadError`, `main [data-ready]` ; « Réessayer » → la vue, le h1 focalisé ; `**/api/guilds/members*` → « Les membres n'ont pas pu être chargés. » ; « Réessayer » → les lignes, l'onglet focalisé.
  - 360 px avec un nom de 40 caractères sans espace et un pseudo de 24 : aucun défilement horizontal ; boutons et liens de 44 px.
  - `e2e/a11y.spec.ts` : `axe /guild` sans guilde (une invitation), membre (onglet Membres, chef) et la modale « Quitter » ouverte → 0 violation grave.
- [ ] **Step 2: `npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/guild.spec.ts e2e/shell.spec.ts e2e/a11y.spec.ts e2e/battle.spec.ts`** → échec (`battle.spec.ts` garde le bouton `danger` de l'arène au même rendu).
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(ui): /guild sans guilde (création, invitations reçues) et membre (en-tête, membres, exclusion, transfert, invitation d'un ami, départ)`

---

### Task 16: Page `/guild` (2/2) — chat, entraide, classement de la guilde

**Files:**
- Create: `components/guild/GuildHelp.tsx`, `components/guild/CatalogPicker.tsx`, `components/guild/GuildBoard.tsx`
- Modify: `components/dms/Thread.tsx` (G13), `app/(game)/dms/dms-client.tsx:125` (`channel={{ kind: 'dm', peerId }}`), `app/(game)/guild/guild-client.tsx`, `e2e/guild.spec.ts`, `e2e/a11y.spec.ts`

**Interfaces:**
- Consumes : Task 15 ; `GET`/`POST /api/guilds/chat`, `GET /api/guilds/home`, `PUT`/`DELETE /api/guilds/wishlist`, `POST /api/guilds/wishlist/donate` (Task 11), `GET /api/guilds/leaderboard` (Task 12), `GET /api/cards?q=` (`app/api/cards/route.ts`, lu comme `app/(game)/global-collection/global-client.tsx:72`) ; `Card`, `usePoll` (`lib/poll.ts:47`), `formatDateTime`.
- Produces :
  - `Thread({ channel, me, onSent, onSettled, onGone }: { channel: { kind: 'dm'; peerId: string } | { kind: 'guild' }; me: string; onSent: () => void; onSettled: () => void; onGone?: () => void })`. En `dm`, rien ne change (DOM, requêtes, textes). En `guild` : lecture et envoi sur `/api/guilds/chat` ; `MAX` 1 000 ; journal `div[role="log"][aria-label="Chat de la guilde"]` ; un message est au lecteur si `user_id === me` ; au-dessus de chaque bulle d'un autre, son pseudo en lien vers son profil, et « {pseudo} : » pour les lecteurs d'écran ; ni en-tête de pair, ni marquage lu, ni « Joueur introuvable », ni branche non-ami ; une réponse 404 appelle `onGone` ; texte d'incertitude « Le message n'a pas été confirmé : il a peut-être été envoyé. Le chat se met à jour. » ; vide « Aucun message pour l'instant. » ; poll de 5 s visible (D:589), comme le fil privé.
  - Onglets complets : « Chat » (par défaut, `Thread` en `guild`, `onGone` = la relecture de `GET /api/guilds`), « Entraide », « Membres », « Classement ».
  - `GuildHelp` : `GET /api/guilds/home` lisible si `r && 'my_wishlist' in r && Array.isArray(r.wishlists) && Array.isArray(r.weekly_karma_donors)` ; « Chargement de l'entraide », échec « L'entraide n'a pas pu être chargée. ».
    - `Section` « Ma demande » : sans demande, « Tu ne demandes aucune carte. » et « Demander une carte » (`primary`) ; avec, `Card` de la carte et « Retirer ma demande » (`ghost`) ; « Tu as reçu un don aujourd'hui. » si `received_donation_today`.
    - `CatalogPicker({ onPick, onClose }: { onPick: (cardId: string, title: string) => Promise<void>; onClose: () => void })` : `Modal` « Choisir une carte à demander » ; champ « Rechercher une carte » (`type="search"`, sans `placeholder`), envoyé sur Entrée ; moins de 2 caractères → « Tape au moins 2 caractères. », aucune requête ; résultats en grille de `Card` cliquables (la première page de `/api/cards?q=…`), « Aucune carte trouvée. », « Annuler » ; `onPick` lève le texte d'un refus ou d'une incertitude, que la modale montre (modèle `CardPicker`, `components/profile/CardPicker.tsx:16-18`). Succès → `PUT /api/guilds/wishlist`, toast « Demande enregistrée : {titre}. », focus « Retirer ma demande ».
    - `Section` « Demandes de la guilde » : par souhait, `Card`, « Demandée par {pseudo} », « Donner » (`primary`) ; `aria-disabled` décrit par « Tu n'as pas de copie libre de cette carte. » (`my_copies` vide) ou « {pseudo} a déjà reçu un don aujourd'hui. » ; vide « Aucune demande dans la guilde. » (`tabIndex -1`).
    - « Donner » → `Modal` « Donner {titre} à {pseudo} ? » : plus d'une copie → un groupe de radios « Copie ×{count} » (« , brillante » si `is_shiny`), la première cochée ; la ligne « Si cette copie est dans ta vitrine ou ton avatar, elle en sort. » (M5b-15) ; « Donner » (`primary`) et « Annuler » ; succès → toast « Don envoyé à {pseudo} : +1 point de karma. », relecture, focus « Donner » du souhait suivant, sinon « Aucune demande dans la guilde. » ; refus → `role="alert"` dans la modale ; incertain → `UNSURE` dans la modale, clé gardée, relecture.
    - `Section` « Entraide de la semaine » (R:627) : `ol`, « {pseudo} — {n} don » ou « … {n} dons » (`donations_this_week`) ; vide « Aucun don cette semaine. ».
  - `GuildBoard()` (partagé avec `/leaderboard`, Task 18) : `GET /api/guilds/leaderboard` lisible si `Array.isArray(r?.entries) && typeof r.week_end === 'string' && typeof r.season === 'string'` ; « Saison {season} » et « Jusqu'au {formatDateTime(week_end)} » ; relecture quand `reset_in_ms` s'écoule (un `setTimeout` borné à 2 147 483 647 ms, annulé au démontage) ; `table` dans un `card-frame` : `caption` sr-only « Classement des guildes, saison {season} », `th scope="col"` « Rang », « Guilde », « Membres », « Batailles », « Enchères », « Total » (les trois du milieu masquées sous `sm`) ; la ligne `user_guild_id` sur la surface claire, `aria-current="true"` et « (ta guilde) » sr-only ; nombres par `formatInt` ; vide « Aucune guilde classée cette semaine. » ; « Chargement du classement », échec « Le classement n'a pas pu être chargé. ».
  - Focus : « Retirer ma demande » → « Demander une carte » ; modale fermée → son ouvreur ; « Réessayer » d'un onglet → l'onglet.
- [ ] **Step 1: Tests E2E qui échouent** (`e2e/guild.spec.ts`)
  - Chat à deux (deux contextes) : A envoie au clavier → sa bulle ; `page.clock.install()` chez B avant `goto`, `runFor(5_000)` → le message de A sous son pseudo ; 1 001 caractères impossibles (`maxLength`) ; 429 forcé par `routeOnce` → « Le site demande de ralentir », le texte reste dans le champ ; issue incertaine (`abort` du `POST`) → le texte d'incertitude, puis la même `Idempotency-Key` au renvoi ; un exclu (par `sql`) qui envoie → la vue sans guilde et le toast.
  - `e2e/dms.spec.ts` reste vert tel quel.
  - Entraide : sans demande → « Demander une carte » → la modale, « a » → « Tape au moins 2 caractères. » sans requête ; un titre de carte du seed → la carte → toast, `Card` de « Ma demande », « Retirer ma demande » focalisé ; « Retirer ma demande » → « Demander une carte » focalisé.
  - Don : B demande X ; A a deux copies X (une brillante) → « Donner » → la modale avec deux radios et la ligne vitrine-avatar → « Donner » → toast, la demande disparaît, « Aucune demande dans la guilde. » focalisé ; `sql` : la copie choisie chez B, une ligne `guild_donations`, `check_invariants()` filtré sur A et B = `[]` ; « Entraide de la semaine » de A : « <A> — 1 don ». Chez B : « Tu as reçu un don aujourd'hui. ». Un second souhait de B → « Donner » en `aria-disabled` avec « <B> a déjà reçu un don aujourd'hui. ». Un souhait d'une carte que A n'a pas → `aria-disabled` « Tu n'as pas de copie libre de cette carte. ». 409 D:676 forcé par `routeOnce` → l'alerte dans la modale.
  - Classement : corps posé par `routeOnce` (`fulfill`, deux guildes dont celle du joueur, `season` `S53`, `reset_in_ms` 2 000, horloge installée) → « Saison S53 », la ligne de sa guilde en `aria-current`, puis `runFor(2_000)` → une nouvelle requête `GET /api/guilds/leaderboard` ; vide → « Aucune guilde classée cette semaine. ».
  - Lectures en échec, même boucle, pour `**/api/guilds/home` et `**/api/guilds/leaderboard` : le texte d'échec, « Réessayer », l'onglet focalisé ; le chat garde l'état affiché sur un poll en échec.
  - 360 px : chat avec un message de 1 000 caractères sans espace, entraide avec trois souhaits, classement → aucun défilement horizontal.
  - `e2e/a11y.spec.ts` : `axe /guild` onglets Chat (deux messages), Entraide (un souhait, la modale « Donner » ouverte, puis `CatalogPicker` ouvert) et Classement → 0 violation grave.
- [ ] **Step 2: `npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/guild.spec.ts e2e/dms.spec.ts e2e/a11y.spec.ts`** → échec.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(ui): chat de guilde par Thread paramétré, entraide (demande depuis le catalogue, don d'une copie choisie, entraide de la semaine), classement de la saison`

---

### Task 17: Page `/achievements`

**Files:**
- Create: `app/(game)/achievements/achievements-client.tsx`, `e2e/achievements.spec.ts`
- Modify: `app/(game)/achievements/page.tsx`, `e2e/shell.spec.ts:94` (+ `'/achievements'`), `e2e/a11y.spec.ts` (`READY` et les deux tableaux)

**Interfaces:**
- Consumes : `rest/v1/achievements` et `rest/v1/user_achievements` par `createBrowserSupabase()` (`lib/supabase/browser.ts`, sous RLS, R:267) ; `POST /api/achievements/check` et `/claim` (Task 12) ; `WCoin`, `wikibidous`, `formatShortDate`, `toast`, `apiOnce`, `unsure`, `UNSURE`.
- Produces :
  - `page.tsx` : coquille, `metadata.title` = `navEntry('/achievements').title`.
  - `AchievementsClient` :
    - lectures : `from('achievements').select('*').order('sort_order')` et `from('user_achievements').select('achievement_id,claimed_at').eq('user_id', me)` ; un `data` qui n'est pas un tableau, ou une erreur, est une lecture en échec ; puis, une fois par 5 min au plus par onglet (un instant gardé au niveau du module : Activity le garde, un rechargement repart sans danger), `api('/api/achievements/check', { method: 'POST', body: { event: 'achievements_sync' } })` : un échec, 429 compris, n'affiche rien (D-C16) ; `unlocked > 0` → relecture de `user_achievements` ; relecture à chaque affichage ; « Chargement des succès » ; `LoadError` ; `data-ready` après les deux lectures, abouties ou en échec ;
    - synthèse : « {n} / {N} succès débloqués » et, si k > 0, « {k} à réclamer » ;
    - un h2 par catégorie, dans l'ordre « Cartes et rareté », « Collection », « Combat », « Échanges », « Enchères » (R:630), chaque succès dans l'ordre de `sort_order` : `card-frame`, titre (h3), description, `WCoin` et « +{formatInt(n)} {wikibidous(n)} », puis l'état en texte : « Verrouillé » (`/70`), « Réclamer » (`primary`, décrit par le titre) ou « Réclamé le {formatShortDate(claimed_at)} » (`tabIndex -1`) ;
    - « Réclamer » : `apiOnce(keys, \`claim:${id}\`, '/api/achievements/claim', { method: 'POST', body: { achievement_id: id } })` ; une réclamation à la fois (garde `inflight`, tous les « Réclamer » en `aria-disabled` pendant l'envoi) ; succès → toast « {titre} : +{n} {wikibidous(n)} » et relecture ; refus → `role="alert"` sur la ligne (texte du serveur), relecture, l'alerte tombe quand la ligne change ; incertain → `UNSURE` sur la ligne, clé gardée, relecture ; clé oubliée quand la ligne relue est réclamée.
  - Focus : « Réclamer » remplacé → « Réclamé le … » de la même ligne ; « Réessayer » → le h1.
- [ ] **Step 1: Tests E2E qui échouent** (`e2e/achievements.spec.ts`)
  - h1 « Succès », titre `^Succès — ` ; cinq h2 dans l'ordre ; 51 succès ; « Légendaire ! » en « Verrouillé ».
  - Le `check` part une fois (`page.waitForRequest`) ; un second affichage dans les 5 min (navigation client puis retour) → aucun nouveau `check` ; un `check` en 429 posé par `routeOnce` → aucun texte d'erreur.
  - ***Review Focus*, réclamation (D:1084)** : 50 copies C par `giveCopies` → après le `check`, « Débutant » montre « Réclamer » ; au clavier → toast « Débutant : +10 wikibidous », « Réclamé le … » focalisé ; `sql` : solde + 10 et une seule ligne `ach:<id>`. Issue incertaine (`routeOnce`, `r.fetch()` puis `fulfill({ status: 500 })`) → `UNSURE`, puis la relecture montre « Réclamé le … » ; un nouvel essai par la même clé (`routeOnce` qui laisse passer) → `{ok: true}` rejoué, toujours une seule ligne. 409 forcé → l'alerte sur la ligne.
  - Lectures en échec, même boucle, pour `**/rest/v1/achievements*` et `**/rest/v1/user_achievements*` → `LoadError`, `main [data-ready]` ; « Réessayer » → la liste, h1 focalisé.
  - 360 px : aucun défilement horizontal ; « Réclamer » de 44 px.
  - `e2e/a11y.spec.ts` : `axe /achievements` avec un succès de chaque état → 0 violation grave.
- [ ] **Step 2: `npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/achievements.spec.ts e2e/shell.spec.ts e2e/a11y.spec.ts`** → échec.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(ui): /achievements (succès par catégorie, check discret toutes les 5 min, réclamation une fois)`

---

### Task 18: Page `/leaderboard` — joueurs et guildes ; `ComingSoon` retiré

**Files:**
- Create: `app/(game)/leaderboard/leaderboard-client.tsx`, `e2e/leaderboard.spec.ts`
- Modify: `app/(game)/leaderboard/page.tsx`, `components/shell/PageHeader.tsx:21-29` (`ComingSoon` supprimé, plus aucun appelant), `e2e/shell.spec.ts:94` (la ligne supprimée : les treize entrées ont une page), `e2e/a11y.spec.ts`

**Interfaces:**
- Consumes : `GET /api/leaderboard` (Task 12) ; `GuildBoard` (Task 16) ; `Avatar` (`components/ui/Avatar.tsx`), `tabKey`.
- Produces :
  - `page.tsx` : coquille, `metadata.title` = `navEntry('/leaderboard').title`.
  - `LeaderboardClient` : `PageHeader` « Classement » ; onglets `[role=tablist][aria-label="Vues du classement"]` « Joueurs » (par défaut) et « Guildes » (`GuildBoard`), un seul panneau monté ; aucun poll, relecture à chaque affichage et à chaque critère (génération : la réponse d'un critère quitté est jetée).
  - Joueurs : deux groupes de boutons à bascule (`role="group"`, `aria-label` « Classer par » et « Période », `aria-pressed`, 44 px, le focus reste sur le bouton pressé) : « Victoires », « Collection », « Légendaires » ; « Cette semaine », « Depuis toujours » ; `GET /api/leaderboard?board=…&period=…` lisible si `Array.isArray(r?.entries) && 'me' in r` ; « Ton rang : {formatInt(rank)} ({formatInt(value)}) » ou « Tu n'es pas encore classé. » ; `table` : `caption` sr-only « Classement des joueurs : {critère}, {période} » (`tabIndex -1`), « Rang », « Joueur » (`Avatar` `alt=""`, masqué sous `sm`, et le pseudo en lien vers son profil), puis « Victoires », « Cartes » ou « Légendaires » ; la ligne du lecteur sur la surface claire, `aria-current="true"` ; vide « Personne n'est encore classé. » ; « Chargement du classement », échec « Le classement n'a pas pu être chargé. ».
  - Focus : « Réessayer » → la `caption`, sinon le h1.
- [ ] **Step 1: Tests E2E qui échouent** (`e2e/leaderboard.spec.ts`)
  - h1 « Classement », titre `^Classement — ` ; « Joueurs » sélectionné, « Victoires » et « Cette semaine » pressés.
  - Corps posé par `routeOnce` (`fulfill`, trois entrées dont le joueur à égalité de rang, `me` `{rank: 2, value: 3}`) → trois lignes, « Ton rang : 2 (3) », la ligne du joueur en `aria-current` ; « Collection » → une requête `board=collection&period=week`, le focus reste sur « Collection », la colonne devient « Cartes » ; une réponse lente du critère quitté (retenue par `routeOnce`, puis relâchée) n'écrase pas l'affichage.
  - Lecture réelle : un joueur à deux victoires de la semaine (batailles closes par `forfeit` par `sql`) → « Ton rang : <n> (2) » (`me` est par requête, exact) ; sans victoire → « Tu n'es pas encore classé. ».
  - « Guildes » → `GuildBoard` (corps posé par `routeOnce`).
  - Lectures en échec, même boucle, pour `**/api/leaderboard*` → l'échec, « Réessayer », la `caption` focalisée.
  - 360 px avec des pseudos de 24 caractères : aucun défilement horizontal.
  - `e2e/shell.spec.ts` : plus aucune page ne montre « Cette section arrive bientôt. » (la condition de `:94` supprimée, les h1 et titres de `:87-93` gardés) ; `grep -rn ComingSoon app components` ne rend rien.
  - `e2e/a11y.spec.ts` : `axe /leaderboard` sur les deux onglets → 0 violation grave.
- [ ] **Step 2: `npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/leaderboard.spec.ts e2e/shell.spec.ts e2e/a11y.spec.ts`** → échec.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(ui): /leaderboard (joueurs par victoires, collection et légendaires, semaine ou depuis toujours, ton rang ; guildes de la saison), ComingSoon retiré`

---

### Task 19: Parcours de guilde à deux joueurs

**Files:**
- Create: `e2e/guild-journey.spec.ts`

**Interfaces:**
- Consumes : les pages des Tasks 14 à 18 ; `makePlayer`, `sql`, `cookieFor`, `giveCopies`, `befriend` (`e2e/fixtures.ts`) ; le modèle de `e2e/battle-journey.spec.ts` (un contexte par joueur, `POLL = { timeout: 10_000 }`).
- [ ] **Step 1: Test qui échoue** (un seul `test`, `test.setTimeout(240_000)` ; chaque joueur commence par `page.goto` ; contextes fermés puis `auth.users` des deux supprimés en `finally`)
  1. Seules écritures SQL : A et B par `makePlayer()`, `befriend(A, B)`, `giveCopies(A, 'C', 50)`, `giveCopies(A, 'R', 1)` (la carte X, dont `sql` lit le titre), `giveCopies(B, 'C', 3)`, puis, à l'étape 6, une bataille A contre B posée par les fonctions (`wm.battle_create`, `accept`, deux `submit_deck` sur trois copies distinctes de chacun) et close par `wm.battle_action(B, id, 'forfeit')`, A gagnant (P5a:70).
  2. A : `/guild` → crée « Les Archivistes » au clavier → « Inviter un ami » → « Inviter » sur B.
  3. B : la cloche → « <A> t'invite dans la guilde Les Archivistes » → `/guild` → « Rejoindre » → h2 « Les Archivistes ».
  4. Chat : B écrit « Bonjour » ; A le voit sous le pseudo de B (`POLL`).
  5. B : « Entraide » → « Demander une carte » → le titre de X → la demande. A : « Entraide » → « Donner » → « Donner » ; B : « Tu as reçu un don aujourd'hui. » ; `sql` : la copie chez B.
  6. La bataille close (étape 1) : A gagnant. A : « Classement » de `/guild` montre « Les Archivistes » à 500 (`expect(…).toPass({ timeout: 40_000 })` avec relecture de l'onglet, cache de 30 s) ; `sql` : `guild_weekly_scores` de la semaine à 500.
  7. A : `/achievements` → « Réclamer » sur « Débutant » → toast ; `sql` : une ligne `ach:<id>`, solde + 10.
  8. B : « Quitter la guilde » → « Quitter » → vue sans guilde ; A : « Membres » ne liste plus B.
  9. `check_invariants()` filtré sur A, B et leur bataille (P5a:905) = `[]`.
- [ ] **Step 2: `npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/guild-journey.spec.ts --repeat-each 3`** → vert du premier coup si les Tasks 14 à 18 sont justes ; sinon le défaut se corrige dans le code, jamais dans le parcours.
- [ ] **Step 3: Contrôles complets** → vert.
- [ ] **Step 4: Commit** — `test(e2e): parcours de guilde à deux joueurs (création, invitation, adhésion, chat, demande et don, +500 au classement, succès réclamé, départ)`

---

### Task 20 (contrôleur): Livraison — migrations sur la démo, essai en deux navigateurs, passation

**Files:**
- Modify: `docs/superpowers/HANDOFF.md`, `docs/suivi.md`, `docs/verifications.md`, `docs/decisions-graphify.md`, `docs/DESIGN.md` (sections « Guilde », « Succès » et « Classement » après « Batailles »)
- Create (non versionnés, `.superpowers/sdd/` ignoré par git) : `.superpowers/sdd/2026-10-30-m5b-guildes-succes-classements/make-deploy-m5b.sh` et `deploy-m5b.sql`

> Ordre (R32) : base, puis fusion. `develop` est la branche de production de Vercel : ses pages appelleraient `wm.guild_get` absente.

- [ ] **Step 1: Contrôles complets, revue de branche, PG17.** Tout vert, `coverage:recap` à 90/90 et bloquant. Revue finale de la branche (R31) et ses corrections. `ci.yml` lancé sur la tête (`workflow_dispatch`, MCP GitHub) → `checks` et `integration` verts sur `postgres:17`. Une correction SQL arrivée après le Step 4 est une nouvelle migration `2070+`. Un `integration` annulé par le délai de 30 min (C24 du M5a) est relancé une fois (`rerun_failed_jobs`) avant toute recherche dans le code. Les durées de `test:db`, `test:contract`, de l'installation de Chromium et de `test:e2e` sont consignées dans `docs/verifications.md` (ligne « CI sur postgres:17 »).
- [ ] **Step 2 (contrôleur): Relevé de la démo en lecture seule** (MCP `execute_sql`) : `to_regclass('public.guilds')` nul ; `wm.config` sans clé `guild` ni `achievements`, `list_caps` à sept clés, `battle` sans `guild_points_win` ; dernière ligne de `supabase_migrations.schema_migrations` = `20261030100000` (`1960`) ; sept jobs `cron.job` actifs (inchangés après) ; `md5(prosrc)` de `wm.battle_finish`, `wm.settle_auction`, `wm.trade_move` et `wm.check_invariants` = celui d'une base du banc montée depuis `develop` (les versions de `1930`, `1630`, `1800`, `1900` que `2040`, `2020` et `2000` reprennent) ; taille de la base et du WAL. Un écart se consigne avant d'aller plus loin.
- [ ] **Step 3 (contrôleur): `deploy-m5b.sql`** par `make-deploy-m5b.sh`, sur le modèle de `make-deploy-m5a.sh` (gardé hors dépôt : `/tmp/claude-0/-home-user/920aa50c-9781-594e-8242-046811805fd6/scratchpad/m5a-archive/make-deploy-m5a.sh` ; à défaut, sa description dans `docs/verifications.md`, M5a — livraison) : liste explicite des fichiers, refus si une migration diffère de `HEAD`, en-tête « généré depuis <tête> ; tout ou rien, relançable tel quel », `begin`, `set local lock_timeout = '5s'`, `cat` de `0008`, `2000`, `2010`, `2020`, `2030`, `2040`, `2050` et `2060` entre `-- ===== nom.sql =====`, les huit lignes d'historique (`AAAAMMJJHHMMnn`, `created_by = 'sql-editor'`, `on conflict (version) do nothing`), `notify pgrst, 'reload schema'`, `commit`. L'`alter table wm.user_state add column` de `2000` prend un verrou exclusif bref : une expiration de 5 s annule tout le fichier, relancé tel quel.
  - Leçons de `1860` et `1960` (M5a-18, M5b-17) : `grep` confirme qu'aucune migration du dépôt postérieure à `2060` ne redéfinit `check_invariants`, `trade_move`, `battle_finish` ni `settle_auction`, et qu'aucune de `20xx` ne touche `wm.quiz_next` (son `statement_timeout` de `1960` reste). À rebours, les `deploy-*.sql` antérieurs qui ramènent une ancienne version sont listés pour la passation : `deploy-m5a.sql` (`battle_finish`, `check_invariants`), `deploy-m4b.sql` (`trade_move`), `deploy-m3.sql` (`settle_auction`, `check_invariants`), `deploy-m1-reste.sql` et `deploy-m4a.sql` (`check_invariants`).
  - **Répétition**, comme au M5a (`docs/verifications.md`, M5a — livraison) : `db-test.sh --stop` ; worktree de `origin/develop` et lien `.cache/gotrue` ; base montée sans `supabase/seed.sql` (`36_leaderboard` exige une base sans joueur, `32_quiz` un pool vide) ; schéma de remplacement `supabase_migrations.schema_migrations` ; deux passes de `psql -X -v ON_ERROR_STOP=1 -f deploy-m5b.sql` → `COMMIT` ; historique `0008`…`2060` inscrit ; `helpers.sql` de la branche, puis `02_mirror_rls`, `10_wm_core`, `27_market`, `28_trades`, `29_social`, `31_battles`, `34_guilds`, `35_achievements` et `36_leaderboard` de la branche, chacun entre `begin` et `rollback` → verts tels quels ; `md5` des fonctions `wm` = celui d'une base de la tête ; `check_invariants()` = `[]` ; fichier livré régénéré depuis la tête finale, son `md5` consigné ; worktree retiré.
- [ ] **Step 4 (humain, demandé maintenant).** L'utilisateur lance `deploy-m5b.sql` dans le SQL Editor du projet `iggurckxmoagsajzrnwd` (« Run without RLS »), sans rien sélectionner : les fonctions contiennent `delete`, que le MCP ferait confirmer sans réponse (M5a-18). En cas d'erreur, rien n'est appliqué ; l'historique est relu avant une relance, toujours du fichier entier. Aucun secret nouveau.
- [ ] **Step 5 (contrôleur): Contrôles par le MCP**, consignés :
  - droits : `role_table_grants` des six tables de guilde pour `anon` et `authenticated` → aucune ligne ; `achievements` et `user_achievements` → `SELECT` pour `authenticated` seulement ; `select not has_schema_privilege('anon', 'wm', 'usage') and not has_schema_privilege('authenticated', 'wm', 'usage')` → vrai ; le compte des ACL de `wm` pour `anon`, `authenticated` et `PUBLIC` (requête de P5a:939) → 0 ;
  - sondes avec la clé publiable, sans JWT : `GET /rest/v1/guilds` → 401 `42501` ; `GET /rest/v1/achievements` → 401 `42501` (aucun droit `anon`) ; `POST /rest/v1/rpc/guild_get` avec `Content-Profile: wm` → 401 `42501` ;
  - `wm.check_invariants()` = `[]` ; `count(*)` de `public.achievements` et de `wm.achievement_rules` = 51 ; `wm.config` `guild`, `achievements`, `list_caps` et `battle` = G9 ; `wm.guild_leaderboard()` → `entries` `[]` et `season` de la semaine ;
  - conseillers : `security` → au plus six INFO « RLS Enabled No Policy » sur les tables de guilde, voulues ; `performance` → au plus des INFO « unused index » sur les index du M5b ;
  - `cron.job` inchangé (sept jobs actifs) ; taille de la base et du WAL, après.
- [ ] **Step 6 (contrôleur): Fusion `--no-ff` dans `develop`** de la tête validée, push, déploiement READY ; `/api/health` 200 ; `health.yml` en `workflow_dispatch` → vert.
- [ ] **Step 7: Critères sur la démo, en deux navigateurs** (forux et forux2, déjà amis ; journaux Vercel lus pendant l'essai, rétention d'une heure ; seuls des comptes et des ids sont consignés, jamais un nom de guilde ni un message) :
  - forux crée une guilde et invite forux2, qui la rejoint depuis la cloche ; un message de chaque côté, vu par l'autre en moins de 10 s ;
  - forux2 demande une carte que forux possède, forux la donne ; MCP : une ligne `guild_donations`, la copie chez forux2, `check_invariants()` = `[]` ;
  - une bataille forux contre forux2 jusqu'à la fin ; MCP : la ligne `guild_weekly_scores` de la semaine à `score_battles` 500, `game_state -> 'guildPoints'` = 500 ; l'onglet « Classement » de `/guild` et `/leaderboard` (« Guildes ») la montrent en moins de 40 s ; `/leaderboard` « Joueurs » montre « Ton rang » au gagnant ;
  - `/achievements` : un succès débloqué réclamé ; MCP : une seule ligne `ach:<id>`, le solde + la récompense ;
  - si une vente d'un membre se règle pendant l'essai : `score_wb` = son prix (sinon noté « prouvé au banc, Task 7 ») ;
  - forux2 quitte la guilde ; forux la quitte en dernier : la guilde et ses lignes disparaissent (MCP).
- [ ] **Step 8: Passation.**
  - `HANDOFF.md` :
    - l'état du M5b ; chaque critère de D:1084 pris par le M5b et sa preuve : borne hebdomadaire (Task 2, et Task 9 pour la clé qui change sans job), réclamation rejouée (Tasks 8, 10, 12, 17 et Step 7), contrat §3.8 et §3.10 et 90/90 bloquant (Tasks 11, 12) ; la ligne M5 de D:1084 est close ; l'étape suivante est le plan M6 ;
    - une section « Exploitation des guildes et des succès » : dissoudre une guilde ou retirer un message (SQL Editor : `delete from public.guilds where id = '<id>'`, `delete from public.guild_chat_messages where id = '<id>'`), jusqu'à l'outil staff du M6 (D:640) ; rouvrir le `check` d'un joueur (`update wm.user_state set achievements_checked_at = null where user_id = '<id>'`) ; lire le classement (`select wm.guild_leaderboard()`) ; remplacer les succès à la migration (D:612) : les `user_achievements` partent en cascade avec un succès supprimé, donc mise à jour en place plutôt que suppression ; lire un run de `quiz-bank.yml` avec `fallback` (Task 13) ;
    - la règle de relance des `deploy-*.sql` : « … jusqu'à `deploy-m5a.sql`, puis `1960`, puis `deploy-m5b.sql` » ; les fichiers du Step 3 qui ramènent une ancienne `battle_finish`, `settle_auction`, `trade_move` ou `check_invariants` retirent les crochets tant que `deploy-m5b.sql` ne les suit pas.
  - `docs/suivi.md` :
    - « Réglés au M5b » ; S:65 à S:69 soldés (Wikimédia, Task 13 ; score du vendeur et +500, Task 7 ; statistiques du marché, calculées au `check`, D-C16 ; types `guild_*`, Task 14) ; S:70 déplacé au M7 (G15) ;
    - au M6 : modération du chat de guilde (D:640) ; suppression de compte et guildes (un chef supprimé laisse `leader_id` nul : désigner un nouveau chef) ; invitations sans durée de vie (purge à décider) ;
    - au M7, dans « Écarts permis à consigner dans `allowed-diffs.yaml` » : la collusion des points de guilde (deux amis gratuits d'une même guilde, 12 victoires par 24 h, 6 000 points ; 40 en Pro, 20 000) ; le jour UTC du don (D-C13 contre D:349) ; le karma dérivé (D-C11) ; les 39 succès inférés et leurs titres ; les clés en plus `invites`, `season`, `my_copies`, `guildPoints`, `unlocked`, `unlocked_at` ; les réponses inférées des écritures de guilde (`{ok: true}`, l'état de `GET /api/guilds`) ; le 404 « Tu n'es dans aucune guilde » ; `GET /api/leaderboard` ajoutée ; les tris et égalités (M5b-6) ;
    - au M8 : le rang `me` sur l'agrégat complet (D-C14) ; les lots non triés par guilde (G4) ; les lectures de guilde et de classement dans le mélange S6.
  - `docs/decisions-graphify.md` : M5b-1 à M5b-18, les écarts au spec, G1 à G16, et les rulings d'exécution.
  - `docs/verifications.md` : la répétition, PG17, les contrôles MCP, l'essai en deux navigateurs (comptes et ids).
  - `docs/DESIGN.md` : sections « Guilde » (vue sans guilde, en-tête, quatre onglets, modales), « Succès » (catégories, états en texte) et « Classement » (bascules, table, ligne du lecteur), au format de « Batailles » (`docs/DESIGN.md:355`).
- [ ] **Step 9: Commit** — `docs: M5b livré — guildes, succès et classements sur la démo, 90/90, passation`
- [ ] **Step 10 (contrôleur): Push et CI.** Pousser, `ci.yml` → vert, fusion `--no-ff` dans `develop`, push.

---

## Auto-revue

- **Couverture du spec (part M5b de D:1084, R§3.8, R§3.10).**
  - D§7.8 : une guilde par joueur, invitation d'un membre ami, refus, gouvernance, dissolution (Tasks 3, 4) ; entraide, ordre de verrouillage souhait → profils → copie, copie non verrouillée, 1 don par jour UTC, karma (Task 5) ; scores hebdomadaires sans job, saison ISO, cache de 30 s (Tasks 2, 7, 9, 12) ; constantes 40/280/1 000, 200, 0, 1 (Tasks 1 à 6, G9) ; chat de 5 s (Task 16).
  - D§7.10 : tables lues par PostgREST (Tasks 1, 12), règles `(achievement_id, metric, threshold)`, `check` limité, `claim` à `ach:<id>` (Task 8), 12 + 39 succès (Task 8), classement des joueurs top 100, rang, cache 60 s, défaut victoires de la semaine (Tasks 9, 12, 18).
  - R§3.8 et R§3.10 : les vingt routes manquantes et `GET /api/leaderboard` (Tasks 11, 12), 90/90 (Task 12).
  - D:1084 : borne hebdomadaire (Task 2) ; réclamation rejouée (Tasks 8, 10, 12, 17) ; contrat (Tasks 11, 12).
  - D§12.1 : une fonction `wm.*` = un test SQL (`34`, `35`, `36`, `27`, `31`) ; fonctions monétaires ou de copie avec invariant (`achievements_claim`, `guild_donate`, crochets) ; concurrence en `.sh` (D:325, Task 10).
  - D§8.6 : axe par route et 44 px (Tasks 15 à 18) ; le parcours clavier n'est exigé que pour la bataille (D:747), le parcours de guilde (Task 19) le complète.
  - Crochets et dette du M5a : +500 et score du vendeur (Task 7), statistiques du marché (D-C16, Task 8), types `guild_*` (Task 14), Wikimédia (Task 13), coquilles (Tasks 15, 17, 18) ; M4 (Task 10, scénarios 5 et 6), M8 (Task 12), M15 (Task 10, scénarios 7 à 9), M16 (Task 2).
- **Scan des étapes.** Chaque test donne ses valeurs, chaque fonction sa signature, son fichier et ses règles ; aucun corps n'est écrit. Les seules requêtes recopiées sont des assertions, des formules que les tests ne fixent pas seuls (`week_start`, le jour UTC) ou des consignes d'exploitation. Les titres des 39 succès inférés restent à l'implémenteur, par décision (G8, D:1097), avec leurs contraintes.
- **Cohérence des noms.**
  - Les routes (Tasks 11, 12) appellent `guild_get(p_uid)`, `guild_create(p_uid, p_name, p_description, p_idem)`, `guild_join(p_uid, p_guild_id, p_idem)`, `guild_invite_decline(p_uid, p_guild_id, p_idem)`, `guild_home(p_uid)`, `guild_wish_set(p_uid, p_card_id, p_idem)`, `guild_wish_clear(p_uid, p_idem)`, `guild_donate(p_uid, p_wishlist_id, p_user_card_id, p_idem)`, `guild_members(p_uid, p_limit, p_offset)`, `guild_invite`/`guild_kick`/`guild_transfer(p_uid, p_user_id, p_idem)`, `guild_leave(p_uid, p_idem)`, `guild_chat_list(p_uid)`, `guild_chat_send(p_uid, p_content, p_idem)`, `achievements_check(p_uid, p_idem)`, `achievements_claim(p_uid, p_achievement_id, p_idem)`, `guild_leaderboard()`, `guild_of(p_uid)`, `leaderboard_top(p_board, p_period)`, `leaderboard_me(p_uid, p_board, p_period)`, définies aux Tasks 3 à 9 avec ces paramètres.
  - `guild_score_add(p_user_id, p_kind, p_amount, p_at)` et `notify_guild(p_users, p_type, p_guild_id, p_actor)` (Task 2) servent aux Tasks 3 à 7 ; `move_copies(p_a, p_b, p_ids, p_k)` (Task 5) à `trade_move` et `guild_donate` ; `achievement_value(p_uid, p_metric, p_rarity)` (Task 8) à `achievements_check`.
  - `game_state.guildPoints` (Task 7) est lu par l'arène (Task 14) ; `rules.guild_points_win` (Task 2) par `BattleRules` (Task 14) ; `season`, `reset_in_ms` et `user_guild_id` (Task 12) par `GuildBoard` (Task 16), partagé par `/leaderboard` (Task 18) ; `my_copies` (Task 5) par la modale « Donner » (Task 16) ; `invites` (Task 3) par `NoGuild` (Task 15) ; `makeGuild` (Task 14) par les Tasks 15 à 19 ; `guildWith` (Task 11) par le contrat de la Task 12 ; `danger` (Task 15) par l'arène et `/guild` ; `Thread` à `channel` (Task 16) par `/dms` et `/guild`.
  - Messages : « Tu n'es dans aucune guilde » pour toute action d'un joueur sans guilde (Tasks 3 à 6, 11, 15) ; « Aucune invitation de cette guilde » en 403 à `join`, en 404 au refus (catalogue).
- **Tests existants touchés, vérifiés sur le dépôt.** `02_mirror_rls.test.sql:38-40`, `:59-67`, `:157-166` et le rejeu legacy (Task 1) ; `list_caps` : `28_trades.test.sql:60`, `29_social.test.sql:67` (Task 2) ; `battle` et `rules` : `31_battles.test.sql:60-61`, `:201-202` (Task 2) ; rejeux M5b-18 : `31_battles.test.sql:70` (Task 2), `29_social.test.sql:75` (Task 5) — les deux seules fonctions de `1800` et `1900` redéfinies depuis sont `trade_move` et `check_invariants` (vérifié par `grep`) ; `lib/notifications.test.ts:119` (Task 14) ; `e2e/battle.spec.ts:390-400` (Task 14) ; `e2e/shell.spec.ts:94` (Tasks 15, 17, 18) ; `e2e/a11y.spec.ts:32-61` (Tasks 15 à 18) ; `scripts/quiz/generate.test.ts:197` et les résumés entiers (Task 13). Restent vrais sans changement : `17_trades_concurrency.test.sh:176-179` (première instruction de `move_copies`), le contrôle P5 de `31_battles.test.sql:1144-1156`, `contract/spec/battles.ts` (`rules` en `record`, `GameState` `.loose()`), `e2e/dms.spec.ts` (`Thread` en `dm`), `e2e/settings.spec.ts` et `29_social.test.sql:59-64` (`push_types` à 13), `10_wm_core.test.sql:127-133` (`wm.health` intouchée), `contract/recap-coverage.test.ts:26-30`. `19_battles_concurrency.test.sh` n'est pas rejoué avec des joueurs en guilde (piste de `2-code` §14.2) : la fin d'une bataille face aux opérations de guilde est le gabarit « la fin » de `20_guilds_concurrency.test.sh` (Task 10), qui couvre M4.
- **Review Focus.** Chaque ligne a son test dans la tâche qui possède le code : membre qui disparaît (Tasks 2, 4, 7, 10), semaine qui bascule (Tasks 2, 9, 12, 16), rejeu et double clic (Tasks 5, 8, 10, 12, 17), ce que voit un autre joueur (Tasks 1, 11, 12), la copie donnée (Task 5).
- **Proportion.** Vingt tâches pour vingt et une routes, trois pages, un miroir de huit tables et sept migrations `wm`, soit la taille du M5a (seize tâches, quatre routes, deux pages, un workflow). Les tableaux d'interface tiennent lieu de code ; les Tasks 5, 8 et 11 sont les plus lourdes : leur revue peut se faire en deux moitiés du diff (`move_copies` et souhait, puis don et entraide ; amorce, puis `check` et `claim` ; routes, puis contrat).
