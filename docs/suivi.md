# Suivi des points différés

Relevés par les revues des tâches et des branches du M0 et du M1, triés par jalon : chaque point est à traiter au plus tard au jalon indiqué. Les points du M0 gardent leur libellé d'origine (anglais) ; ceux du M1 sont résumés en français. « Dette » regroupe ce qui n'a pas de jalon naturel : à prendre quand on retouche le fichier concerné.

## Réglés au M1

- Du M0 : POST à corps vide lu comme `{}` dans `route()` (Task 2) ; paramètres de chemin validés (Task 2) ; clés de requête répétées lues avec `getAll` (Task 2) ; `retry_after` daté en ISO (Task 2) ; fuseau accepté par `Intl` mais inconnu de Postgres → `Europe/Paris` côté SQL (R9, R10) ; index `wishlist_items(card_id)` (`1300`) ; la fixture E2E réutilise `tests.make_user` via `makeUser` (Task 1) ; prérequis du README (PG16/`PGBIN`, `psql`, `get-tools.sh`, `build:test` avant contrat et E2E, `PW_CHROMIUM_PATH`, les deux variables de porte) ; tests de la modale sur `[aria-label="Fermer"]` exact (Task 12).

## M2 — Catalogue réel

- **Cache partagé de `/api/cards`** (D§9.5, `'use cache: remote'`) : absent au M1 (`shortcut:` dans le code, décision 4 du plan M1).
- **Retirer les 2 000 cartes d'essai** (`supabase/seed.sql`, « Article d'essai n° NNNN ») au chargement du vrai catalogue, sur le projet de démo comme sur le banc.
- **Pool de tirage par *swap-with-last*** (C8) : au M1, `wm.draw_pool` est rempli une fois depuis le seed.
- **`wm.set_prefs` met à jour 0 ligne** quand le profil n'a pas de ligne `user_prefs` : la migration du M2 doit créer ces lignes, ou `set_prefs` doit faire un upsert.
- Tirage : aucun test de la branche « pool manqué », des cartes `hide_image`/`nsfw_image` tirables ni des comptes du seed ; `catalog_empty` est aussi levé quand la configuration ne rend rien tirable.
- « Comment ça marche ? » (`/pulls`) écrit en dur les seuils, les périodes et le stock : risque de dérive avec `wm.config`.
- Les cas de tri du contrat lisent les champs vivants de la carte au lieu des `snapshot_*` : ils divergeront dès qu'un chargement modifie une carte possédée.
- Recherche : la garde « aucune lettre ni chiffre » teste `q` brut, pas le motif sans accents.
- Le contrôle `img.complete` de la carte n'est vérifié que dans Chromium (vraies images au M2).
- Hérités du M0, prévus au M1 et non traités : /login redirect drops Supabase cache headers from setAll (proxy.ts); Server Actions must check auth themselves and /gate's tree must stay action-free (or re-check gateEnv in actions); log e.name in route() catch; wm.sanctions(user_id) index; brand NFKD normalisation; pageTitle test env dependence; db-test.sh key=value DATABASE_URL guard, LC_ALL=C, keep pg_ctl log on failed start, logout() sets role anon claims; harness env '' instead of undefined, check .next came from build:test, timeouts on waitReady/execFileSync, serve.ts watches child exits, gate valid-session case asserts 200; onClose focus guard, skip link, « Plus » active state, focus-trap leak after click on blank sheet space; OFL.txt garbled copyright lines, remap --font-sans; checkout persist-credentials: false; Task 14 doc wording; NAV ↔ GAME_PREFIXES test; one helper for the cookie-name option; after the gate redirects to a game route without session, the address bar shows /pulls while the page is /login and `next` is lost (server-side redirect follow) — still true, pinned by `e2e/gate.spec.ts`.
- Hérités du M0 (avant le premier appelant) : idem_store null response → store 'null'::jsonb, idempotency key scoped by operation; wallet_apply edge cases (reserve ('opening','opening'), delta 0, overflow, nulls); C7 lock_timeout on money paths; maintenance flag reading '"true"'; FOR UPDATE vs FOR NO KEY UPDATE; missing route() tests; hover:scale-105 and reduced motion; 4 preloaded fonts; exact-grants test over every public table vs an allowlist (new tables get Supabase default privileges).

## M3 — Marché

- Décision 2 du plan M1 à revoir : un helper `wm` sans HTTP pour les pages publiques mises en cache.
- Hérités du M0 : decide on Next cacheComponents/Activity hidden pages duplicating ids/selectors (top A3 risk for #marketplace-auction-*); ledger history sorted by id; hourly idempotency purge (9000_wm_cron); pg_cron detection via shared_preload_libraries; PGRST003/PGRST000 → 503 BUSY.

## M4 — Échanges et social

- **Verrou d'échange de la défausse** (C13) : une copie engagée dans un échange ne doit pas pouvoir être défaussée, unitairement ou en masse.
- **Amitié pour `wishlisted_by` et `owned_by`** : au M1, ces filtres ne servent que pour soi-même ou un profil public (`shortcut:`).
- Hérités du M0 : owner change must clear avatar_user_card_id and the old owner's tag links; discard term in check_invariants.

## M6 — Pro, modération, paramètres

- VIP traité comme Pro (`is_pro or is_vip`) pour la période de régénération et le paquet Pro du jour : à confirmer avec D§7.2.
- Paquets Pro, spéciaux et de grâce comptés dans `packs_opened` et `cards_obtained` (accepté au M1 : ce sont des paquets) : à confirmer avec les succès.
- Solde dans tout le shell avec la boutique (R23 : au M1, en-tête de `/collection` seulement) ; bandeau d'achat de paquets quand le stock est à 0.
- `/api/human-check` et `/api/username-available` sans limite de débit (C17).
- `/reset-password` utilisable par n'importe quelle session connectée.

## M7 — Parité et qualité

- **Écarts permis à consigner dans `allowed-diffs.yaml`** :
  - couleurs de la modale de carte (R20) : ATK/DEF en `red-400`/`blue-400`, extrait en `neutral-900/90`, méta en `/60`, pour le contraste ;
  - axe `nested-interactive` toléré sur `[role=listbox] li[role=option] button` (R21, exception `TAG_OPTION` de `e2e/a11y.spec.ts`) ;
  - RarityChips non sélectionnées en `opacity-80` au lieu de 50 (R24) ;
  - « Trier les cartes » est un `select` natif, pas un bouton (R28).
- zod dans le bundle client de `/collection` (R26) : à revoir si un budget de bundle est fixé.
- État de `/global-collection` dans React, pas dans l'URL (R27, `shortcut:`).
- Accessibilité et interface : nom accessible du `h3` doublé par le bouton de titre vide ; échec de lecture des étiquettes mis en cache comme `[]` ; préférences relues sans délai croissant ; la zone `::after` du favori de la grille couvre ~10 px des badges `xN`/✨ ; `toggleStar` libère son verrou sans `try/finally` et ne vide pas son erreur après un succès ; deux modales réagiraient toutes deux à Échap (une seule existe) ; `turnstile.render` qui lève ne montre pas d'erreur en français ; un échec transitoire d'`api.js` reste en cache jusqu'au rechargement ; une adresse déjà confirmée reçoit l'étape du code sans e-mail (anti-énumération de GoTrue) ; table `KNOWN` d'`authErrorMessage` inatteignable depuis le navigateur ; `onToken` dans les dépendances d'effet (latent) ; bulles natives `required`/`minLength` dans la langue du navigateur ; aucun voile visible pendant une relecture (seulement `aria-busy`) ; `focusIdle` après « Réessayer » déplace le focus même si le joueur a tabulé ailleurs ; un refocus en attente pendant une relecture peut sauter sur une tuile après un clic dans le vide ; littéral `text-[rgb(13,17,23)]`.

## M8 — Charge et démo

- **`p_missing` sur le catalogue complet** (mode « manquantes » du catalogue) : à mesurer avec les 300 k cartes.
- La recherche en collection lit toutes les copies (~100 ms à 20 k copies) : à revoir pour les baleines.
- Les préfixes larges de 2 caractères trient toutes les correspondances.

## Ops et bascule (option A)

- `create or replace trigger` sur `user_cards` sans `lock_timeout` : ligne du runbook.
- Rejouer `1000` seul rétablit l'ancien corps de `wm.wallet_apply` tant que `1300` n'est pas rejoué (même règle que « never replay 0002 alone »).
- Prérequis de `1400` sur le projet de l'exploitant : `pg_trgm` et `unaccent` dans `extensions`, schéma `wm_index` avant l'index, `CONCURRENTLY` depuis le runbook (commentaire d'en-tête présent).
- Revérifier qu'aucun trigger étranger n'existe sur `auth.users` avant d'ajouter `wm_on_auth_user_created` (aucun sur la démo, Task 3).
- Index hérités `user_cards_user_id_idx` et `user_cards_card_id_idx` devenus redondants.
- Un nouveau compte démarre son horloge de régénération à la première synchronisation, pas à l'inscription (R8).
- Hérités du M0 : `supabase migration repair` before any CLI db push (MCP stored timestamp versions); never replay 0002 alone (header comment added to 0002; add a runbook line); check_invariants at scale; confirm 40 waiters in the concurrency test; npm audit when eslint-config-next is patched; DUMP-S confirmations; main not a direct child of div.flex.h-dvh (restore or list in parity/allowed-diffs.yaml); classList[1] icon assertion; @theme regex and missing contrast pairs; contract type import layering; .test.sql COMMIT convention; redundant tags_user_id_idx; dispatch health.yml twice after merge to exercise the issue path; robots.txt Disallow vs noindex (consider allowing crawl + noindex).

## Dette (tests et code)

- Banc (Task 1) : `latestMail` ne lit que le plus récent (pas de filtre `since`) ; prêt = tout statut autre que 503 ; littéral 54324 deux fois ; secret JWT de 39 caractères ; `get-tools.sh` en mode 100644 ; `get-tools.sh` masque le stderr de `auth version` ; aucun test commité du stub Turnstile, de l'exigence d'`apikey` ni du 404 de gabarit ; l'assertion de `verify` ne lit pas le corps.
- `route()` (Task 2) : cast `as RouteCtx & {params: P}` (préférer `Omit<RouteCtx,'params'>`) ; `getAll` appelé deux fois ; assertion `/UUID/` non propre au français ; cas manquants (`pre` non appelé sur entrée invalide, `pre` qui lève → 500, `p_idem` écrasé, `retry_after` illisible → 1).
- Comptes et régénération (Tasks 3–4) : test du délai de 30 jours dépendant de l'heure d'été (comparer à `username_changed_at + 30 days`) ; `set_prefs` écrit toujours `profiles` ; `username_available` lève puis rattrape ; une ligne de config absente désactive en silence délai et TTL ; message 401 dupliqué dans `1100` ; ancienne surcharge `username_problem(text)` à supprimer (`drop if exists`) si une base l'a reçue (aucune) ; un renommage vers le même nom renvoie un `next_change_at` parfois passé ; commentaire de `pg_temp.err` inexact ; assertion anon calée sur le texte anglais de l'erreur (`lc_messages`) ; note de `pack_period_s` non mise à jour sur une base qui a déjà la ligne (aucune).
- Paquets (Tasks 5, 9, 13) : `v_resp` réutilisé dans `pro_daily_claim` ; branche `or null` morte gardée (R7) ; en-têtes `CET`/`EET`/`MET`/`WET` lus comme abréviations fixes (1 h d'écart en été) ; chaînes de fuseau POSIX en cache par backend (service_role seul) ; délai de 5 s de Turnstile non épinglé par un test ; le cas du fuseau peut échouer une fois si minuit à Paris tombe entre la préparation psql et la requête ; chemins non testés (403 stock vide depuis l'ouverture, second refus Turnstile, affichage du `retry_after` d'un 429) ; commentaire de l'horloge trop affirmatif ; commentaires sur plusieurs lignes.
- Collection et défausse (Tasks 6, 7, 10, 12, 14) : aucun test pour `p_rarity '{}'`, page négative, `p_limit 0`, recherche sur `snapshot_category` contre la catégorie du catalogue ; `p_uid` nul ferait correspondre `p_untagged` et le mode « manquantes » à tout (inatteignable) ; verrou des copies sans `order by id` (40P01 rare → 500 avec un PATCH `starred` multi-lignes, sans effet sur l'argent) ; `wallet_apply(0)` et la mise à jour `discarded` tournent quand rien n'est retiré ; `balance_after` d'ouverture = solde réel ≠ Σ delta pour qui a défaussé (à commenter) ; l'attente active `PgSleep` compte tout le serveur ; aucun cas de contrat pour `tag_id`, `untagged`, `wishlisted_by`, `owned_by` et `missing` ; refus `snapshot_*`, insertion `user_cards` et solde de `profiles` non épinglés sur `rest/v1` ; `strictObject` sur les éléments de `cards` ; helpers de contrat dupliqués (`KEY`, `post`, `sql`) ; la collection d'un profil exige une session (R§3.3 muet) ; un `q` fait d'espaces masque `search` ; `rarityOf` retombe sur C ; le test de contraste épingle l'hexadécimal et non la classe ; gardes des cases de tuile et `tagsGen` non testées ; aucun test d'une relecture en cours qui contient encore la copie ouverte ; `createTag` exporté depuis un fichier de composant ; tests de `Pagination` dans `RarityChips.test.tsx`.
- Auth (Task 11) : pause fixe de 1,1 s dans le test de renvoi du code (la CI ne relance pas) ; codes GoTrue supplémentaires traduits dans `lib/auth.ts` (gain accepté).

## En attente d'étapes humaines

- **Graphify** : indexation du dépôt et notes de `docs/decisions-graphify.md`, en attente de l'étape humaine de `docs/superpowers/HANDOFF.md`.
- **Démo** : script Turnstile réel avec la clé de site de test, changement de mot de passe et déconnexion sur le Supabase hébergé, en-tête `alg` d'une vraie session : après les réglages Auth de `docs/superpowers/HANDOFF.md`.
