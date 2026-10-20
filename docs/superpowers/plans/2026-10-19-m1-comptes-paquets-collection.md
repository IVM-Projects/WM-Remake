# M1 — Comptes, paquets, collection : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un joueur s'inscrit (pseudo, 18+, code par e-mail), passe la vérification anti-bot, ouvre ses paquets de 5 cartes qui se régénèrent, retrouve ses copies dans sa collection (étiquettes, favoris, liste de souhaits, défausse unitaire et en masse), parcourt le catalogue et règle ses paramètres de base. Le tout tourne sur la démo Vercel avec un catalogue d'essai de 2 000 cartes.

**Architecture:** Même découpe qu'au M0. Les règles et les réponses JSON vivent dans des fonctions `wm.*`, et des route handlers d'une à trois lignes les appellent via `route()`. Les étiquettes, les liaisons, la liste de souhaits et `starred` passent en direct par PostgREST sous RLS, comme dans l'original. Les pages de jeu sont des composants client qui appellent ces mêmes routes : le trafic réseau reste celui de l'original, et les extensions tierces continuent de fonctionner. Le banc de test gagne un vrai GoTrue (binaire épinglé), qui signe avec la clé ES256 du banc, et Mailpit, qui reçoit les codes par e-mail.

**Tech Stack:** celle du M0 (next 16.4.2, react 19.3.1, @supabase/ssr 0.12.7, @supabase/supabase-js 2.118.0, zod 4.6.7, vitest 5.0.5, @playwright/test 1.64.1, @axe-core/playwright 4.14.0, lucide-react 1.59.0, PostgREST v12.2.3), plus les binaires de banc **GoTrue v2.197.0** (`supabase/auth`, publié le 2026-09-09) et **Mailpit v1.31.0**. Aucune dépendance npm ajoutée.

**Spec:** `docs/superpowers/specs/2026-10-18-wikimasters-rebuild-design.md` (le « design », cité D§x) et `docs/rea-recap.md` (le « recap », cité R§x). Jalon : D§13 ligne M1.

## Global Constraints

- Toutes les contraintes globales du plan M0 (`docs/superpowers/plans/2026-10-19-m0-fondations.md`) restent en vigueur. Rappel des plus citées :
  - versions exactes ;
  - lire le guide de `node_modules/next/dist/docs/` avant de toucher une API Next (`AGENTS.md`) ;
  - fonctions `wm.*` en `security definer` avec `set search_path = ''`, `EXECUTE` à `service_role` seul, et chaque migration `wm` finit par le couple `revoke`/`grant` vérifié par le scan de `10_wm_core.test.sql` ;
  - migrations idempotentes, expand-only, compatibles PG16 et PG17 ;
  - chaînes d'erreur exactes du D§8.2, `error` = `message` ;
  - aucune PII dans les logs ;
  - « tu » dans le jeu, « vous » dans les pages légales ;
  - thème sombre seulement.
- **Binaires de banc épinglés** (SHA-256 de l'archive vérifié à chaque appel, comme PostgREST) :
  - **GoTrue** : `https://github.com/supabase/auth/releases/download/v2.197.0/auth-v2.197.0-x86.tar.gz`, `9daff5d1939c3142a1586e435e6e2a7a2f71534ec40ff1b196b59b83ad5678f3`, 26 096 776 octets. L'archive contient `auth` (lien `gotrue`) et `migrations/`.
  - **Mailpit** : `https://github.com/axllent/mailpit/releases/download/v1.31.0/mailpit-linux-amd64.tar.gz`, `076b5ded9a2182842b93e761b9586a1a251445bffe2666f9f22a6dc14470237d`, 10 634 648 octets.
- **Ports du banc** :

  | Service | Port |
  |---|---|
  | Passerelle | 54321 |
  | PostgREST | 54322 |
  | GoTrue | 54323 |
  | Mailpit HTTP | 54324 |
  | Mailpit SMTP | 54325 |
  | PG local | 54329 |
  | Next sans porte / avec porte | 3100 / 3101 |
- **Aucun chemin de code réservé aux tests** dans l'app. La seule différence est la configuration (variables d'environnement). Le banc n'a pas de clé Turnstile de site, et le serveur rejette alors toute vérification que le vérificateur configuré refuse.
- **Contrat DOM** : les classes et attributs exacts du R§6.3 à §6.5 et les sélecteurs du R§6.8 sont reproduits tels quels. Une passe Impeccable ne les retire jamais.
- **Formes JSON** : on renvoie l'union des champs du R§3.1 à §3.4. Les clés en plus sont permises, il est interdit d'en retirer. Pagination en base 0, 50 par page, `limit` plafonné à 50.
- **Paramètres de requête répétables** (`rarity=L&rarity=UR`) lus avec `getAll`.
- **Variables d'environnement nouvelles** :
  - `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (publique) ;
  - `TURNSTILE_SECRET_KEY` (serveur) ;
  - `TURNSTILE_VERIFY_URL` (serveur, défaut `https://challenges.cloudflare.com/turnstile/v0/siteverify`).

  Elles remplacent `TURNSTILE_SITEKEY` et `TURNSTILE_SECRET` dans `.env.example`.
- **Jetons et marque** : ceux de `app/globals.css` et `docs/DESIGN.md`. Sans image, une carte affiche le logo texte de **notre** marque. Le visuel du paquet est le nôtre. Aucun asset d'origine.

## Décisions de ce plan (à consigner dans `docs/decisions-graphify.md`, Task 16)

1. **Banc d'auth : vrai GoTrue en binaire**, pas `supabase start`. Il n'y a pas de démon Docker dans le bac à sable, et C3 demande « même chemin en prod, en CI et dans le bac à sable ». GoTrue migre lui-même le schéma `auth` du banc : le stub `auth.users` de `bootstrap_local.sql` disparaît, et les tests SQL tournent sur la vraie table.
2. **Pas de helper `wm` sans HTTP pour les Server Components au M1.** Les pages de jeu sont des composants client qui appellent les routes du contrat. C'est ce que fait l'original, et c'est ce qu'observent les extensions (R§3.0). À reconsidérer au M3 pour les pages publiques mises en cache.
3. **Défausses hors grand livre (C5)** : `wallet_apply` crédite `p_reason = 'discard'` sans écrire de ligne et le compte dans `wm.user_stats.discard_wb`. L'invariant devient Σ ledger + `discard_wb` = solde, et l'écriture d'ouverture vaut `solde − discard_wb`.
4. **Catalogue d'essai synthétique** (`supabase/seed.sql`, 2 000 cartes « Article d'essai n° NNNN »). Le bac à sable n'atteint pas Wikimedia, et le M2 charge le vrai catalogue (échantillon). Pas de cache partagé sur `/api/cards` au M1 (`shortcut:`, cache du D§9.5 au M2).
5. **Vérification humaine avant le tout premier paquet** : un nouveau joueur n'a pas encore de `human_verified_until`, donc son premier « Ouvrir » renvoie 403. Ce comportement est voulu par D§7.0 (« sans elle, 403 »).

## Review Focus

- **Double ouverture concurrente** (deux onglets, double clic, 50 appels parallèles sur un stock de 3) : exactement 3 paquets et 15 copies, stock jamais négatif, aucune erreur autre que « Plus de paquets disponibles ». → `12_packs_concurrency.test.sh`, Task 5.
- **Retour après une longue absence** (stock 0, dernier `packs_last_regen_at` il y a 3 jours, passage Pro entre deux visites) : stock plafonné à `pack_cap`, `packs_last_regen_at` à `null` quand il est plein, `next_regen_at` juste après une consommation depuis un stock plein. → tests de `wm.apply_regen`, Task 4.
- **Pseudos piégés** (`Admin`, `ALICE` si `alice` existe, `é`, 2 et 25 caractères, espace, cyrillique `аlice`, deux inscriptions simultanées du même pseudo) : refus avec le message français exact, une seule inscription réussit. → tests du trigger, Task 3, et cas GoTrue, Task 10.
- **Défausse abusive** (copie d'un autre, copie déjà défaussée, ids en double, 51 ids, la même copie défaussée 2 × 25 fois en parallèle) : 403 `42501`, entrée dans `failed` ou 400, solde crédité d'exactement une unité par copie réellement retirée. → Task 7.
- **Fuseau aux bornes** (plafond quotidien et paquet Pro du jour à 23 h 59 puis 00 h 01 dans `x-wiki-calendar-tz`, changement de fuseau pour réclamer deux fois, fuseau invalide) : le jour suit le fuseau validé (défaut `Europe/Paris`), et l'écart de 20 h empêche le saut de fuseau. → tests de `wm.pro_daily_claim` et du plafond quotidien, Task 5.

---

### Task 1: Banc d'auth — GoTrue et Mailpit (SQL, contrat, E2E, CI)

**Files:**
- Create: `scripts/get-tools.sh` (remplace `scripts/get-postgrest.sh`, supprimé) ; `contract/mail.ts` ; `contract/users.ts` ; `supabase/templates/confirmation.html`, `supabase/templates/recovery.html` ; `contract/spec/auth.ts`
- Modify: `supabase/tests/bootstrap_local.sql`, `supabase/tests/helpers.sql` (`tests.make_user`), `supabase/tests/00_bootstrap.test.sql`, `scripts/db-test.sh`, `contract/jwt.ts`, `contract/harness.ts`, `contract/spec/index.ts`, `e2e/fixtures.ts`, `.github/workflows/ci.yml`, `README.md` (prérequis)

**Interfaces:**
- Produces :
  - `get-tools.sh` place `.cache/postgrest/postgrest`, `.cache/gotrue/auth` (avec `.cache/gotrue/migrations/`) et `.cache/mailpit/mailpit` ;
  - `Backend` gagne `mailpitUrl: 'http://127.0.0.1:54324'` ;
  - `contract/mail.ts` : `latestMail(email: string): Promise<{ subject: string; text: string; html: string }>` (attend jusqu'à 10 s), `latestOtp(email): Promise<string>` (`/\b(\d{6})\b/`) et `latestLink(email): Promise<string>` (premier `href` du HTML) ;
  - `contract/users.ts` : `makeUser(databaseUrl: string, opts?: { username?: string; balance?: number; pro?: boolean }): { uid: string; username: string }` (psql synchrone ; l'option `humanVerified` arrive à la Task 9) et `authCookie(backend, uid): { name: string; value: string }` (JWT ES256 du banc + `sessionCookie`) ;
  - `tests.make_user(p_username text, p_balance int default 0) returns uuid` garde sa signature.

- [ ] **Step 1: `scripts/get-tools.sh`**
  - Une fonction `fetch <nom> <url> <sha256>` reprend la logique de `get-postgrest.sh` : télécharger si la somme ne correspond pas, vérifier, réextraire.
  - Les trois outils sont appelés avec les valeurs du Global Constraints, plus PostgREST v12.2.3 (somme actuelle).
  - Terminer par `postgrest --version`, `auth --version` (ou `auth -h`) et `mailpit version`, sortie jetée.

  Remplacer `get-postgrest.sh` par `get-tools.sh` partout : CI, README, messages d'erreur du harness. Commande de contrôle : `bash scripts/get-tools.sh && ls .cache/gotrue/auth .cache/mailpit/mailpit` (les deux chemins existent).

- [ ] **Step 2: Bootstrap sans stub `auth.users`** — `bootstrap_local.sql`
  - Garder sous garde les rôles `anon`, `authenticated`, `service_role` et `authenticator`, ainsi que les extensions `pgcrypto` et `pg_trgm`, et ajouter `unaccent` dans `extensions`.
  - Ajouter `supabase_auth_admin` : `login createrole noinherit password 'auth'`, mot de passe de test.
  - Ajouter `create schema if not exists auth authorization supabase_auth_admin`, `grant create on database <base courante> to supabase_auth_admin` (en SQL dynamique sur `current_database()`), `alter role supabase_auth_admin set search_path = auth`, et `grant usage on schema public, extensions, auth to anon, authenticated, service_role`.
  - **Supprimer** la table `auth.users` et les fonctions `auth.jwt()`, `auth.uid()` et `auth.role()` : c'est GoTrue qui les crée.
  - Nouvelle garde : sauter le fichier si `to_regclass('auth.users')` n'est pas nul.

- [ ] **Step 3: `db-test.sh` lance la migration GoTrue**
  - Juste après `bootstrap_local.sql` :

    ```bash
    GOTRUE_DB_DRIVER=postgres DATABASE_URL="<url wm_test avec user supabase_auth_admin:auth>" \
    GOTRUE_JWT_SECRET=banc-de-test-secret-hs256-inutilise-32c API_EXTERNAL_URL=http://127.0.0.1:54321/auth/v1 \
    GOTRUE_SITE_URL=http://127.0.0.1:3100 "$root/.cache/gotrue/auth" migrate >/dev/null
    ```

    L'URL se dérive de `$url` en remplaçant les identifiants. Lancer depuis `.cache/gotrue` : le binaire lit `./migrations`.
  - Si le binaire manque : `echo "db-test : lancer bash scripts/get-tools.sh" >&2; exit 1`.
  - En mode `--setup-only` seulement, appliquer aussi `supabase/seed.sql` s'il existe (Task 5).

- [ ] **Step 4: `tests.make_user` passe par le vrai `auth.users`**
  - Insérer `(id, email, raw_user_meta_data)` avec `{"username": p_username, "age_confirmed": true, "terms_version": "test"}`.
  - Puis `insert into public.profiles (id, username, wikibidous_balance) … on conflict (id) do update set wikibidous_balance = excluded.wikibidous_balance`. Le trigger de la Task 3 crée le profil ; avant lui, l'insertion directe le fait.
  - `00_bootstrap.test.sql` : garder l'assertion des quatre rôles et de `auth.uid()` via `request.jwt.claims`, et ajouter `assert to_regclass('auth.schema_migrations') is not null`.
  - Commande : `npm run test:db`. Attendu : les six fichiers actuels restent `ok`.

- [ ] **Step 5: Clés compatibles GoTrue** — `contract/jwt.ts`
  - `privateJwk` reçoit `key_ops: ['sign', 'verify']` et `publicJwk` reçoit `key_ops: ['verify']`. Le `kid` ne change pas.
  - Test (dans un `contract/jwt.test.ts` vitest) : `signJwt` puis vérification avec `crypto.verify` sur `publicJwk` → `true` ; `publicJwk.d` est indéfini.

- [ ] **Step 6: Harness — Mailpit, GoTrue, passerelle `/auth/v1`**
  - Dans `startBackend`, après PostgREST :
    1. Lancer `mailpit --smtp 127.0.0.1:54325 --listen 127.0.0.1:54324` (prêt quand `GET /api/v1/info` répond 200).
    2. Lancer `auth serve` (cwd `.cache/gotrue`), prêt quand `GET http://127.0.0.1:54323/health` répond 200. Environnement :

       | Variable | Valeur |
       |---|---|
       | `GOTRUE_DB_DRIVER` | `postgres` |
       | `DATABASE_URL` | URL `supabase_auth_admin:auth` |
       | `GOTRUE_API_HOST` | `127.0.0.1` |
       | `PORT` | `54323` |
       | `API_EXTERNAL_URL` | `http://127.0.0.1:54321/auth/v1` |
       | `GOTRUE_SITE_URL` | `http://127.0.0.1:3100` |
       | `GOTRUE_URI_ALLOW_LIST` | `http://127.0.0.1:3100/**,http://127.0.0.1:3101/**` |
       | `GOTRUE_JWT_SECRET` | une chaîne de 32 caractères, inutilisée |
       | `GOTRUE_JWT_KEYS` | `JSON.stringify([privateJwk])` |
       | `GOTRUE_JWT_EXP` | `3600` |
       | `GOTRUE_JWT_AUD` | `authenticated` |
       | `GOTRUE_JWT_DEFAULT_GROUP_NAME` | `authenticated` |
       | `GOTRUE_JWT_ADMIN_ROLES` | `service_role` |
       | `GOTRUE_EXTERNAL_EMAIL_ENABLED` | `true` |
       | `GOTRUE_MAILER_AUTOCONFIRM` | `false` |
       | `GOTRUE_MAILER_OTP_LENGTH` | `6` |
       | `GOTRUE_SMTP_HOST` / `GOTRUE_SMTP_PORT` | `127.0.0.1` / `54325` |
       | `GOTRUE_SMTP_ADMIN_EMAIL` | `noreply@wikicartes.test` |
       | `GOTRUE_SMTP_SENDER_NAME` | `WikiCartes` |
       | `GOTRUE_MAILER_TEMPLATES_CONFIRMATION` | `http://127.0.0.1:54321/templates/confirmation.html` |
       | `GOTRUE_MAILER_TEMPLATES_RECOVERY` | `…/recovery.html` |
       | `GOTRUE_MAILER_SUBJECTS_CONFIRMATION` | `Ton code de confirmation` |
       | `GOTRUE_MAILER_SUBJECTS_RECOVERY` | `Choisis un nouveau mot de passe` |
       | `GOTRUE_SECURITY_CAPTCHA_ENABLED` | `false` |
       | `GOTRUE_LOG_LEVEL` | `warn` |

       Ajouter les limites `GOTRUE_RATE_LIMIT_*` d'envoi d'e-mail, de vérification, de rafraîchissement et d'OTP à `10000`. Les noms exacts se vérifient avec `strings auth | grep GOTRUE_RATE_LIMIT`, et les noms retenus sont consignés en commentaire.
  - Passerelle :
    - `/auth/v1/*` part vers GoTrue avec le préfixe retiré, la même vérification d'`apikey` et le même échange clé → JWT de rôle que `/rest/v1`.
    - `GET /templates/<nom>.html` sert `supabase/templates/<nom>.html` (404 sinon, aucun `..`).
    - `POST /turnstile/siteverify` (formulaire `secret`, `response`) répond `{"success": true}` si `secret === 'test-turnstile'` et `response === 'dev-bypass'`, sinon `{"success": false, "error-codes": ["invalid-input-response"]}`.
    - Le JWKS n'est plus servi par la passerelle : GoTrue sert le même via `/auth/v1/.well-known/jwks.json`.
  - PostgREST reçoit `PGRST_DB_MAX_ROWS=1000` (D§8.1 n° 3).
  - `startNext` ajoute `TURNSTILE_SECRET_KEY=test-turnstile` et `TURNSTILE_VERIFY_URL=http://127.0.0.1:54321/turnstile/siteverify`.
  - Ordre d'arrêt inverse du démarrage.

- [ ] **Step 7: Modèles d'e-mail FR** (`supabase/templates/`), courts, sans nom de marque (les modèles ne lisent pas l'environnement), ton « tu » :
  - `confirmation.html` : « Ton code de confirmation : `<strong>{{ .Token }}</strong>` » et « Il expire dans une heure. Si tu n'as rien demandé, ignore ce message. » ;
  - `recovery.html` : « Pour choisir un nouveau mot de passe, ouvre ce lien : `<a href="{{ .ConfirmationURL }}">Choisir un nouveau mot de passe</a>` ».

- [ ] **Step 8: `contract/users.ts`, `contract/mail.ts`, fixture E2E**
  - `makeUser` : insère dans `auth.users` (`id`, `email` `<uid>@test.local`, `raw_user_meta_data` complet), puis fait l'upsert de `public.profiles` (`username`, `wikibidous_balance`, `is_pro`), comme `tests.make_user`.
  - `e2e/fixtures.ts` réutilise `makeUser` et `authCookie`, ce qui règle le point « e2e fixture should reuse … » de `docs/suivi.md`.

- [ ] **Step 9: Spec de contrat `contract/spec/auth.ts`** (`source: 'R§3.11'`, `confidence: 'conf.'`), cas :
  - `GET /auth/v1/health via la passerelle → 200 et version v2.197.0`.
  - `inscription → code à 6 chiffres reçu dans Mailpit → verify → JWT ES256 du kid du banc` : `POST /auth/v1/signup` avec la clé publiable et `data: {username, age_confirmed: true, terms_version: 'test'}`, puis `latestOtp`, `POST /auth/v1/verify {type:'signup', email, token}` → 200, `access_token` d'en-tête `{alg:'ES256', kid:'wm-test-es256'}`, et `GET /rest/v1/profiles?select=username` avec ce jeton renvoie le pseudo.
  - `connexion par mot de passe → session` : `POST /auth/v1/token?grant_type=password` → 200.

  Commande : `npm run build:test && npm run test:contract`. Attendu : `health`, `gate` et `auth` verts.

- [ ] **Step 10: CI** — `integration` : `bash scripts/get-tools.sh` remplace `get-postgrest.sh`, avant `npm run test:db`. Rien d'autre ne change.

- [ ] **Step 11: Commit** — `test: banc d'auth GoTrue v2.197.0 + Mailpit (SQL, contrat, E2E)`

---

### Task 2: `route()` — corps vide, paramètres de chemin, requêtes répétées, idempotence, `retry_after` daté, pré-contrôle

**Files:**
- Modify: `lib/route.ts`, `lib/route.test.ts`

**Interfaces:**
- Produces :
  - `route<I = undefined, P = Record<string, string>>(opts: { fn: string; auth?: boolean; input?: z.ZodType<I>; params?: z.ZodType<P>; idem?: boolean; pre?: (input: I, req: NextRequest) => Promise<HttpError | void>; args?: (input: I, ctx: RouteCtx & { params: P }) => Record<string, unknown> })` ;
  - `HttpError` est exporté ;
  - `idem: true` ajoute `p_idem: ctx.idem` aux arguments RPC ;
  - `toHttpError` lit un `retry_after` ISO comme une date.

- [ ] **Step 1: Tests qui échouent** (`lib/route.test.ts`, avec les mocks Supabase existants) :
  - `POST à corps vide → input {} (pas de 400)` : avec `input: z.looseObject({})`, `req.text()` vide donne `{}` et la RPC est appelée.
  - `GET a=1&rarity=L&rarity=UR → { a: '1', rarity: ['L', 'UR'] }` : une clé répétée devient un tableau, une clé unique reste une chaîne.
  - `params invalide → 400 français, aucune RPC` : `params: z.object({ userCardId: z.uuid() })` avec `userCardId: 'abc'` → 400, `code: 'invalid_request'`, `rpc` jamais appelé.
  - `idem: true → p_idem transmis` : avec l'en-tête `Idempotency-Key: k1`, les arguments contiennent `p_idem: 'k1'` ; sans l'en-tête, `p_idem: null` ; sans `idem`, aucune clé `p_idem`.
  - `retry_after ISO → Retry-After en secondes` : un détail `{status: 429, retry_after: <maintenant + 30 s en ISO>}` donne l'en-tête `Retry-After` entre 29 et 31 ; une date passée donne `1`.
  - `pre renvoie une HttpError → réponse telle quelle, aucune RPC` ; `pre` ne renvoie rien → la RPC est appelée.

- [ ] **Step 2: `npm test -- lib/route.test.ts`** → les nouveaux cas échouent.

- [ ] **Step 3: Implémenter**
  - `readInput` : POST, PUT ou PATCH à texte vide → `{}`, et GET → objet `getAll`.
  - `params` : `safeParse` des paramètres de chemin, avant la lecture du corps.
  - `pre` : après l'authentification et la validation, avant la RPC.
  - `toHttpError` : `retry_after` numérique → `ceil` ; chaîne parsable par `Date.parse` → `max(1, ceil((date − now) / 1000))` ; sinon 1.

- [ ] **Step 4: `npm test`** → tout est vert (98 + nouveaux).

- [ ] **Step 5: Commit** — `feat(route): corps vide, paramètres de chemin validés, requêtes répétées, Idempotency-Key, retry_after daté, pré-contrôle`

---

### Task 3: Comptes en SQL — état joueur, trigger d'inscription, pseudos, préférences, vérification humaine

**Files:**
- Create: `supabase/migrations/1100_wm_accounts.sql`, `supabase/tests/20_accounts.test.sql`

**Interfaces:**
- Produces (toutes dans `wm`, en `security definer` avec `set search_path = ''`) :

  | Objet | Contenu |
  |---|---|
  | Table `wm.user_state` | `user_id uuid pk → profiles on delete cascade`, `human_verified_until timestamptz`, `last_open_at timestamptz`, `opens_day date`, `opens_day_count int not null default 0`, `open_window_start timestamptz`, `open_window_count int not null default 0`, `username_changed_at timestamptz` |
  | Table `wm.user_stats` | `user_id uuid pk → profiles cascade`, `packs_opened int not null default 0`, `cards_obtained int not null default 0`, `discarded int not null default 0`, `discard_wb int not null default 0` |
  | Table `wm.user_prefs` | `user_id uuid pk → profiles cascade`, `sounds boolean not null default true`, `hide_sensitive boolean not null default true` |

  | Fonction | Rôle |
  |---|---|
  | `wm.lock_user(p_uid uuid) returns public.profiles` | Verrouille `profiles` `for update`, fait l'upsert des trois lignes `wm`, puis verrouille `user_state` `for update` (ordre C4) ; 401 `unauthorized` si le profil manque |
  | `wm.username_problem(p_username text) returns text` | `null` si le pseudo est libre, sinon `'invalid' \| 'reserved' \| 'taken'` |
  | `wm.username_available(p_username text) returns jsonb` | `{available: true}` ou `{available: false, reason, error}` |
  | `wm.handle_new_user() returns trigger` | Trigger `wm_on_auth_user_created after insert on auth.users for each row` |
  | `wm.change_username(p_uid uuid, p_username text) returns jsonb` | Réponse `{username, next_change_at}` |
  | `wm.get_prefs(p_uid uuid) returns jsonb` | Réponse `{sounds, hide_sensitive, is_public}` |
  | `wm.set_prefs(p_uid uuid, p_sounds boolean, p_hide_sensitive boolean, p_is_public boolean) returns jsonb` | `null` = inchangé ; même réponse que `get_prefs` |
  | `wm.set_human_verified(p_uid uuid) returns jsonb` | Réponse `{ok: true}` |

  Clés `wm.config` (avec leur `note`) :
  - `reserved_usernames` : `["admin","administrateur","administrator","staff","moderateur","moderator","modo","support","wikimasters","wikicartes","system","systeme"]` (C28) ;
  - `username_change_days` : `30` (D§7.1) ;
  - `human_check_ttl_h` : `12` (D§7.0, R§5.1).

- [ ] **Step 1: Test qui échoue** (`20_accounts.test.sql`, transaction annulée, `pg_temp.err` repris de `10_wm_core.test.sql`). Messages exacts :

  | Erreur | Statut et code | Message |
  |---|---|---|
  | Pseudo invalide | 400 `username_invalid` | « Pseudo invalide (3 à 24 caractères) » |
  | Pseudo réservé | 400 `username_reserved` | « Ce pseudo est réservé » |
  | Pseudo pris | 409 `username_taken` | « Ce pseudo est déjà pris » |
  | Consentement manquant | 400 `consent_required` | « Confirme avoir au moins 18 ans et accepte les conditions. » |
  | Renommage trop tôt | 409 `username_change_too_soon` | « Un seul changement de pseudo tous les 30 jours. » + `next_change_at` |

  Cas à couvrir :
  - Validité, réservation et unicité :
    - `wm.username_problem` vaut `'invalid'` pour `ab`, une chaîne de 25 caractères, `a b`, `é`, `аlice` (а cyrillique) et `''` ;
    - il vaut `'reserved'` pour `Admin` et `MODO` ;
    - il vaut `'taken'` pour `ALICE` quand `alice` existe ;
    - il vaut `null` pour `bob.le-2_x`.
  - Trigger :
    - insérer `auth.users` avec `{"username":"alice","age_confirmed":true,"terms_version":"t"}` crée `profiles(username='alice', packs_remaining=1, wikibidous_balance=0)` et une ligne dans chacune des tables `user_state`, `user_stats` et `user_prefs` (`hide_sensitive = true`) ;
    - sans `age_confirmed`, ou avec `terms_version` vide, l'insertion lève P0001 `consent_required` ;
    - un pseudo pris lève `username_taken` ;
    - le pseudo est stocké tel que saisi (casse gardée).
  - `change_username` : refusé à moins de 30 jours de `username_changed_at`, accepté sinon, `next_change_at` = `username_changed_at + 30 jours`, mêmes refus que le trigger.
  - `set_prefs(uid, null, false, null)` ne change que `hide_sensitive`, et `is_public` va dans `profiles`.
  - `set_human_verified` : `human_verified_until` entre `now() + 11 h 59` et `now() + 12 h 01`, et `open_window_count` remis à 0.
  - `lock_user` crée les lignes manquantes d'un profil migré (cas d'un profil inséré sans trigger).
  - Les privilèges suivent le scan de `10_wm_core` : relancer ce test le couvre.

- [ ] **Step 2: `npm run test:db`** → `FAIL 20_accounts.test.sql`.

- [ ] **Step 3: Implémenter `1100_wm_accounts.sql`**
  - Validité : `^[A-Za-z0-9_.-]{3,24}$`, réservés comparés sur `lower()`, unicité sur `lower(username)`.
  - Le trigger traduit aussi une `unique_violation` concurrente en `username_taken`.
  - Les erreurs passent par `wm.raise_err`.
  - Le trigger appartient au propriétaire de la migration, qui l'applique sur Supabase via le MCP.
  - Fin du fichier : le couple `revoke`/`grant` du M0.

- [ ] **Step 4: `npm run test:db`** → tout est `ok`, `11_wallet_concurrency` compris (`make_user` passe par le trigger).

- [ ] **Step 5: Commit** — `feat(db): comptes — état joueur, trigger d'inscription, pseudos, préférences, vérification humaine`

---

### Task 4: Régénération paresseuse et RPC du miroir

**Files:**
- Create: `supabase/migrations/0003_mirror_rpc.sql`, `supabase/tests/21_regen.test.sql`
- Modify: `supabase/migrations/1100_wm_accounts.sql` (ajout de `wm.apply_regen` et de la clé de config)

**Interfaces:**
- Produces :
  - `wm.apply_regen(p_uid uuid) returns public.profiles`. L'appelant tient déjà le verrou du profil. La fonction applique la formule du D§7.2 et met à jour seulement si quelque chose change.
  - `wm.next_regen_at(p public.profiles) returns timestamptz`.
  - Clé `wm.config` `pack_period_s` = `{"free":600,"pro":180}` (R§5.1). `is_pro or is_vip` donne la période Pro.
  - `public.sync_profile_packs(user_id uuid) returns table (username text, avatar_url text, is_pro boolean, is_vip boolean, pack_cap int, packs_remaining int, packs_last_regen_at timestamptz, wikibidous_balance int, next_regen_at timestamptz)`. Le paramètre s'appelle `user_id`, comme dans l'original (R§3.1).
  - `public.get_my_profile() returns setof public.profiles`.
  - Les deux fonctions sont en `security definer` avec `set search_path = ''`. `EXECUTE` est révoqué à `public` et `anon`, et accordé à `authenticated`.
  - `0003` accorde aussi `select on public.cards` à `anon`, avec la politique `cards_select_anon for select to anon using (true)` (R§3.4, D§7.4).

- [ ] **Step 1: Test qui échoue** (`21_regen.test.sql`), horloge simulée en écrivant `packs_last_regen_at` dans le passé :
  - Gratuit, stock 0, dernier passage il y a 25 min → stock 2, `last` = ancien + 1 200 s, `next_regen_at` = `last` + 600 s.
  - Gratuit, stock 0, dernier passage il y a 3 jours → stock 10 (`pack_cap`), `last` = `null`, `next_regen_at` = `null`.
  - Pro (`is_pro`), stock 0, il y a 9 min → stock 3. Avec `is_vip` seul, même résultat.
  - Stock plein et `last` = `null` → rien ne change.
  - Stock 3 sur 10 et `last` = `null` (donnée migrée) → rien ne change.
  - `sync_profile_packs` :
    - avec `tests.login(alice)`, l'appel sur l'uid d'alice renvoie une ligne régénérée ;
    - sur l'uid de bob, il lève `42501` ;
    - en `anon`, l'appel est refusé (permission).
  - `get_my_profile` renvoie le profil d'alice régénéré.
  - `anon` lit `cards` et ne lit pas `user_cards` (0 ligne ou refus).

- [ ] **Step 2: `npm run test:db`** → `FAIL 21_regen.test.sql`.

- [ ] **Step 3: Implémenter**
  - `sync_profile_packs` : comparer `auth.uid()` à `user_id`, verrouiller le profil, appeler `wm.apply_regen`, puis renvoyer.
  - Les deux RPC sont en `plpgsql` : `0003` s'applique avant `1100`, et un corps `language sql` serait validé à la création alors que `wm.apply_regen` n'existe pas encore.
  - `0003` est MIRROR (en-tête du M0 : jamais en option A) ; `wm.apply_regen` est ADDITIVE.

- [ ] **Step 4: `npm run test:db`** → `ok`.

- [ ] **Step 5: Commit** — `feat(db): régénération paresseuse, sync_profile_packs et get_my_profile, lecture anon du catalogue`

---

### Task 5: Tirage et paquets en SQL, catalogue d'essai

**Files:**
- Create: `supabase/migrations/1200_wm_packs.sql`, `supabase/seed.sql`, `supabase/tests/22_packs.test.sql`, `supabase/tests/12_packs_concurrency.test.sh`

**Interfaces:**
- Consumes : `wm.lock_user`, `wm.apply_regen` et `wm.next_regen_at` (Tasks 3 et 4) ; `wm.actor`, `wm.idem_claim` et `wm.idem_store` (M0).
- Produces :

  | Objet | Contenu |
  |---|---|
  | Table `wm.catalog_stats` | `rarity public.rarity pk`, `n int not null` |
  | Table `wm.draw_pool` | `rarity public.rarity`, `seq int`, `card_id uuid not null → cards`, `primary key (rarity, seq)`, unique `(card_id)` |
  | Table `wm.pro_daily_claims` | `user_id`, `day date`, `claimed_at timestamptz default now()`, pk `(user_id, day)` |
  | Table `wm.special_packs` | `id uuid pk default gen_random_uuid()`, `name text not null`, `description text`, `size int not null default 5`, `exclude public.rarity[] not null default '{}'`, `starts_at timestamptz`, `ends_at timestamptz` |
  | Table `wm.special_pack_claims` | pk `(pack_id, user_id)`, `claimed_at` |
  | Table `wm.grace_grants` | `id bigint identity pk`, `user_id`, `size int not null default 5`, `reason text`, `created_by uuid`, `created_at`, `claimed_at` |

  | Fonction | Rôle |
  |---|---|
  | `wm.rebuild_draw_pool() returns int` | Vide le pool, numérote chaque rareté par `id`, recalcule `catalog_stats`, renvoie le nombre de cartes. `shortcut:` reconstruction complète ; le M2 apporte le *swap-with-last* incrémental |
  | `wm.grant_copy(p_uid uuid, p_card_id uuid, p_shiny boolean) returns public.user_cards` | Une ligne `count = 1`, snapshots copiés de `cards` (C10) |
  | `wm.draw_cards(p_uid uuid, p_n int, p_exclude public.rarity[] default '{}') returns jsonb` | Tableau de `CardInPack`, la meilleure carte en dernier |
  | `wm.pack_guard(p_uid uuid) returns void` | Contrôles communs aux paquets, sans écriture : vérification humaine (validité et rafale) |
  | `wm.open_pack(p_uid uuid, p_tz text, p_idem text default null) returns jsonb` | Ouverture d'un paquet |
  | `wm.pro_daily_status(p_uid uuid, p_tz text) returns jsonb` | Réponse `{eligible, claimed_today, size, is_pro, next_claim_at}` |
  | `wm.pro_daily_claim(p_uid uuid, p_tz text, p_idem text default null) returns jsonb` | Réponse `{cards}` |
  | `wm.special_packs(p_uid uuid) returns jsonb` | Réponse `{packs: [{id, name, title, description, size}], available}` |
  | `wm.claim_special(p_uid uuid, p_pack_id uuid, p_idem text default null) returns jsonb` | Réponse `{cards, packs_remaining}` |
  | `wm.claim_grace(p_uid uuid, p_idem text default null) returns jsonb` | Réponse `{cards}` |

  **`CardInPack`** (union R§3.1) : `{id: card_id, card_id, user_card_id, card: {id, wikipedia_title, rarity, is_shiny}, wikipedia_title, rarity, snapshot_rarity, is_shiny, image_url, wikipedia_url, category, summary, description: category, atk, def, hide_image, nsfw_image, is_new}`. `rarity` et `snapshot_rarity` = rareté au tirage. `is_new` = aucune copie `(card_id, is_shiny)` n'existait juste avant cette carte. Tri : `snapshot_rarity` croissante, puis la brillante après la normale.

  **Réponse de `open_pack`** : `{cards, packs_remaining, packs_last_regen_at, next_regen_at, owned_copies: [{card_id, is_shiny, count}]}`. `count` = unités possédées après le paquet, une entrée par couple distinct du paquet.

  **Clés `wm.config`** (avec `note`) :

  | Clé | Valeur |
  |---|---|
  | `pack_size` | `5` |
  | `pro_daily` | `{"size":15,"exclude":["C"],"min_gap_h":20}` |
  | `shiny` | `{"rate":0.01,"scope":["L"]}` |
  | `draw_weights` | `{"free":null,"pro":null}` |
  | `open_min_interval_s` | `1` |
  | `open_daily_cap` | `600` |
  | `open_burst` | `{"count":30,"window_s":600}` |

- [ ] **Step 1: `supabase/seed.sql`** (idempotent, `on conflict (lang, wikipedia_title) do nothing`)
  - 2 000 cartes : L 6, UR 24, SR 90, R 280, PC 600 et C 1 000.
  - `wikipedia_title` = `Article d'essai n° NNNN` (sur 4 chiffres) ; `category` = `Carte d'essai — <libellé de rareté>` ; `summary` = « Carte d'essai du catalogue de développement, remplacée par le vrai catalogue au M2. » ; `wikipedia_url` = `https://fr.wikipedia.org/wiki/` + titre encodé ; `image_url` = `null`.
  - `pageviews` dans la bande de sa rareté (R§5.2 : C < 50 · PC ≥ 50 · R ≥ 250 · SR ≥ 1 000 · UR ≥ 5 000 · L ≥ 20 000).
  - `atk` et `def` entre 1 000 et 10 000, croissants avec la rareté et déterministes (fonction de n) ; `q_score` à 2 décimales.
  - Toutes les 50 cartes, `hide_image = true`, et toutes les 97 cartes, `nsfw_image = true`.
  - Termine par `select wm.rebuild_draw_pool()`.

- [ ] **Step 2: Test qui échoue** (`22_packs.test.sql`, qui crée son propre mini-catalogue). Erreurs exactes :

  | Situation | Statut | Corps |
  |---|---|---|
  | Vérification humaine | 403 | `{code: 'human_verification_required', human_verification_required: true, error: 'Vérification anti-bot requise pour continuer à ouvrir des paquets.'}` |
  | Intervalle trop court | 429 | `{rate_limited: true, retry_after: <ISO>, error: 'Le site demande de ralentir'}` |
  | Plafond quotidien | 429 | `{rate_limit_daily: true, retry_after: <ISO minuit suivant dans le fuseau>, error: 'Limite quotidienne de paquets atteinte'}` |
  | Stock vide | 403 | `{error: 'Plus de paquets disponibles', packs_remaining: 0, next_regen_at}` |
  | Catalogue vide | 503 | `{code: 'catalog_empty', error: 'Catalogue indisponible, réessaie dans un instant.'}` |
  | Fonction Pro | 403 | `{code: 'pro_required', error: 'Fonction réservée aux membres Pro'}` |
  | Paquet Pro déjà pris | 409 | `{code: 'already_claimed', error: 'Paquet Pro du jour déjà récupéré', next_claim_at}` |
  | Paquet spécial introuvable | 404 | `{error: 'Paquet introuvable'}` |
  | Paquet spécial déjà pris | 409 | `{code: 'already_claimed', error: 'Paquet déjà récupéré'}` |
  | Pas de paquet de grâce | 404 | `{code: 'no_grace', error: 'Aucun paquet de grâce disponible'}` |

  Cas à couvrir :
  - `rebuild_draw_pool` sur 3 C, 2 R et 1 L → `catalog_stats` = `{C:3, R:2, L:1}`, et les `seq` de chaque rareté sont `1..n` sans trou.
  - `open_pack`, joueur vérifié, stock 1 → 5 cartes (`jsonb_array_length = 5`), 5 lignes `user_cards` avec les snapshots égaux à la carte, `packs_remaining` = 0, `user_stats.packs_opened` = 1 et `cards_obtained` = 5, cartes triées par rareté croissante, `owned_copies` cohérent.
  - Consommation depuis un stock plein → `packs_last_regen_at` = `now()`.
  - Sans vérification humaine → 403 attendu.
  - Rafale : 30 ouvertures dans la fenêtre de 600 s (états écrits à la main) → la 31e reçoit le même 403 ; après `set_human_verified`, elle passe.
  - Intervalle (`last_open_at` = `now()`) → 429 attendu.
  - Plafond (`opens_day` = jour du fuseau, `opens_day_count` = 600) → 429 attendu ; le même état avec la veille dans le fuseau passe.
  - Stock vide → 403 attendu.
  - Catalogue vide → 503 attendu.
  - Restriction (`activity_blocked_until` ou `packs_blocked_until` futur) → la 403 de `wm.actor`.
  - `p_idem` rejoué → même réponse et aucune nouvelle copie.
  - Brillante : avec `shiny.rate` = 1, une L tirée a `is_shiny = true` et une C non.
  - `pro_daily_claim` :
    - non-Pro → 403 attendu ;
    - Pro → 15 cartes sans C ;
    - même jour → 409 attendu ;
    - autre fuseau où c'est déjà le lendemain, moins de 20 h après → 409 ;
    - 21 h après, jour suivant dans le fuseau → succès.
  - `pro_daily_status` reflète ces états.
  - `special_packs` sans paquet actif → `{packs: [], available: false}`. Avec un paquet actif, la réclamation donne `size` cartes sans les raretés exclues, puis 409 à la deuxième ; un id inconnu donne 404.
  - `claim_grace` sans dotation → 404. Avec deux dotations, l'appel prend la plus ancienne et pose `claimed_at`.

- [ ] **Step 3: Test de concurrence** (`12_packs_concurrency.test.sh`, même gabarit que `11_wallet_concurrency.test.sh`)
  - Préparation : le script crée son mini-catalogue (10 cartes, `rebuild_draw_pool`) et le supprime à la sortie avec le joueur ; `open_min_interval_s` mis à 0 et restauré à la sortie ; joueur vérifié, stock 3 sur 10, profil bloqué 2 s, puis 50 appels `wm.open_pack` en parallèle.
  - Attendu :
    - 3 succès et 47 échecs contenant tous « Plus de paquets disponibles » ;
    - 15 lignes `user_cards` et `packs_remaining` = 0 ;
    - `check_invariants()` vaut `[]`.

- [ ] **Step 4: `npm run test:db`** → `FAIL` sur les deux nouveaux fichiers.

- [ ] **Step 5: Implémenter `1200_wm_packs.sql`**
  - Ordre dans `open_pack` :
    1. `idem_claim` ;
    2. `actor(p_uid, 'packs')` ;
    3. `lock_user` puis `apply_regen` ;
    4. `pack_guard` ;
    5. intervalle ;
    6. plafond (jour = `(now() at time zone p_tz)::date`) ;
    7. stock ;
    8. décrément (et `last = now()` si le stock était plein) ;
    9. mise à jour de `user_state` (intervalle, jour, fenêtre de rafale) ;
    10. `draw_cards`, compteurs, réponse ;
    11. `idem_store`.
  - Les autres paquets suivent les étapes 1 à 4, puis leurs propres gardes.
  - Les contrôles de rafale, d'intervalle et de plafond **n'écrivent rien** : une exception annulerait l'écriture.
  - Rareté : la probabilité est `n_r / N` sur les raretés non exclues ayant `n_r > 0`, ou les poids de `draw_weights` s'ils ne sont pas nuls. Le numéro vaut `1 + floor(random() * n_r)`, lu par PK dans `draw_pool` (C8).

- [ ] **Step 6: `npm run test:db`** → tout est `ok`.

- [ ] **Step 7: Commit** — `feat(db): tirage par pool, ouverture de paquet, Pro du jour, spéciaux, grâce, catalogue d'essai`

---

### Task 6: Collection — lectures en SQL

**Files:**
- Create: `supabase/migrations/1300_wm_collection.sql`, `supabase/tests/23_collection.test.sql`

**Interfaces:**
- Produces :
  - Table `wm.user_rarity_counts` : `user_id`, `snapshot_rarity`, `is_shiny`, `rows int`, `copies int`, pk `(user_id, snapshot_rarity, is_shiny)`. Elle est maintenue par des triggers *statement-level* à tables de transition sur `public.user_cards` (insert, delete, update de `user_id`, `snapshot_rarity`, `is_shiny` et `count`), avec un upsert par instruction. Le remplissage initial se fait dans la migration. `check_invariants()` gagne `rarity_counts` (écart avec un `group by` réel).
  - Index du D§9.4 sur `user_cards` : `(user_id, obtained_at desc, id)`, `(user_id, snapshot_rarity desc, obtained_at desc, id)`, `(card_id, user_id)` et l'index partiel `(user_id) where starred`. S'y ajoute `wishlist_items (card_id)`.
  - `wm.my_collection(p_uid uuid, p_page int default 0, p_limit int default 50, p_sort text default 'rarity', p_q text default null, p_rarity public.rarity[] default null, p_tag_id uuid default null, p_untagged boolean default false, p_wishlisted_by uuid default null, p_owned_by uuid default null) returns jsonb`. Réponse `{collection: Item[], total, pendingTradeCardIds: []}`.
  - **`Item`** : `{id, user_id, card_id, card: {id, wikipedia_title, rarity, category, atk, def, image_url, hide_image, nsfw_image, wikipedia_url, description: category, summary}, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def, is_shiny, starred, count, tags: [{id, name, color}], obtained_at}`.
  - `wm.my_collection_stats(p_uid uuid, …mêmes filtres sans page, limit ni sort) returns jsonb`. Réponse `{total, rarities: [{rarity, key, name, count, total, value}]}` : `key` = `rarity`, `name` = libellé français, `count` = `total` = `value` = nombre de lignes, ordre L, UR, SR, R, PC, C.
  - `wm.profile_collection(p_uid uuid, p_username text, p_page int default 0, p_q text default null, p_stats boolean default false) returns jsonb`. Réponse `{collection: [{id, card, count, is_shiny, snapshot_rarity}], total, rarityCounts?: {C, PC, R, SR, UR, L}}` (cartes uniques par rareté si `p_stats`).

- [ ] **Step 1: Test qui échoue** (`23_collection.test.sql`, joueur avec 120 copies variées) :
  - Pagination :
    - page 0 → 50 éléments, page 2 → 20 ;
    - `p_limit` 500 → 50 ;
    - `total` = 120 sans filtre, et cette valeur vient de `user_rarity_counts` (le test compare les deux).
  - Ordre stable : la concaténation des pages 0, 1 et 2 contient chaque id une seule fois. Pour `rarity`, l'ordre est `snapshot_rarity desc, obtained_at desc, id`.
  - Tris : `name` sur `snapshot_title`, `atk` et `def` décroissants, `starred` d'abord, `obtained_at` et `added` équivalents. Un tri inconnu donne 400 `invalid_request` « Tri inconnu ».
  - Filtres :
    - `p_q` filtre sur titre et catégorie, sans tenir compte des accents ni de la casse ;
    - `p_rarity '{L,UR}'` ;
    - `p_tag_id` ;
    - `p_untagged` ;
    - `p_wishlisted_by` = soi → seulement les cartes de ma liste ; = un autre → 403 `{code: 'FORBIDDEN', error: 'Vous devez être amis pour voir sa liste de souhaits'}`.
  - `p_owned_by` :
    - un autre joueur avec `is_public` → sa collection ;
    - un profil privé → 403 `{code: 'FORBIDDEN', error: 'Cette collection est privée'}`.
  - `tags` liste les étiquettes de la copie, et `count` reprend la colonne.
  - Stats : `total` et les comptes par rareté sont égaux à des `count(*)` filtrés.
  - `profile_collection` :
    - un pseudo inconnu donne 404 `{error: 'Joueur introuvable'}` ;
    - un profil privé d'un autre donne 403 `{code: 'FORBIDDEN', error: 'Ce profil est privé'}` ;
    - `p_stats` donne `rarityCounts` en cartes uniques.
  - Triggers : après insertion, suppression, changement de `count` et changement de `user_id`, `check_invariants()` vaut `[]`.

- [ ] **Step 2: `npm run test:db`** → `FAIL 23_collection.test.sql`.

- [ ] **Step 3: Implémenter**
  - Jointure différée : sous-requête d'ids `order by … limit … offset` sur l'index, puis jointure des lignes et agrégation des étiquettes (D§7.3).
  - Recherche par `wm.search_text(t text, c text) returns text`, créée ici en `immutable parallel safe` : `extensions.unaccent('extensions.unaccent', lower(t || ' ' || coalesce(c, '')))`. L'extension `unaccent` est créée `if not exists` dans `extensions`. La Task 8 la réutilise.

- [ ] **Step 4: `npm run test:db`** → `ok`.

- [ ] **Step 5: Commit** — `feat(db): collection — pages stables, filtres, stats en O(1), collection d'un profil`

---

### Task 7: Défausse, défausse en masse et solde

**Files:**
- Modify: `supabase/migrations/1300_wm_collection.sql`, `supabase/tests/23_collection.test.sql`
- Create: `supabase/tests/13_discard_concurrency.test.sh`

**Interfaces:**
- Produces :
  - `wm.wallet_apply` est redéfini (`create or replace`, même signature). Avec `p_reason = 'discard'`, il n'écrit pas de ligne de grand livre, ajoute `p_delta` à `user_stats.discard_wb` et met à jour le solde. Partout ailleurs, l'écriture d'ouverture vaut `solde − discard_wb`.
  - `wm.check_invariants()` est redéfini : `ledger_balance` compare `Σ delta + discard_wb` au solde, pour les joueurs qui ont un grand livre. Le contrôle `rarity_counts` de la Task 6 est gardé.
  - `wm.discard(p_uid uuid, p_user_card_id uuid, p_idem text default null) returns jsonb` → `{balance}`.
  - `wm.bulk_discard(p_uid uuid, p_ids uuid[], p_idem text default null) returns jsonb` → `{discarded_count, failed: [{id, reason}]}`.
  - `wm.wallet_balance(p_uid uuid) returns jsonb` → `{balance}`.

- [ ] **Step 1: Tests qui échouent** (ajoutés à `23_collection.test.sql`) :
  - `discard` :
    - une copie à `count = 1` disparaît, le solde gagne 1, `discard_wb` = 1, `discarded` = 1, aucune ligne de grand livre ;
    - `count = 3` passe à 2, avec le même +1 ;
    - la copie d'un autre ou un id inconnu donne 403 `{code: '42501', error: 'Vous ne possédez pas cette carte'}` ;
    - la copie qui sert d'avatar remet `avatar_user_card_id` à null (FK `set null`).
  - `bulk_discard` :
    - 3 ids possédés, 1 à un autre et 1 inconnu donnent `discarded_count` = 3, `failed` = deux entrées `{id, reason: 'Vous ne possédez pas cette carte'}`, et un solde + 3 ;
    - 0 id ou 51 ids donnent 400 `invalid_request` « Entre 1 et 50 cartes par défausse » ;
    - des ids en double donnent 400 « Cartes en double dans la défausse ».
  - Grand livre :
    - `wallet_apply(uid, 5, 'test', 'r1')` après deux défausses écrit une ouverture `solde − 2` ;
    - `check_invariants()` vaut `[]` ;
    - les cas `wallet_apply` de `10_wm_core.test.sql` restent verts.

- [ ] **Step 2: Test de concurrence** (`13_discard_concurrency.test.sh`)
  - Préparation : une copie à `count = 1`, plus une à `count = 25`. Profil bloqué 2 s, puis 25 `discard` sur la première et 25 sur la seconde en parallèle.
  - Attendu :
    - 1 succès sur la première (24 refus `42501`) et 25 succès sur la seconde (ligne supprimée au dernier) ;
    - solde + 26, `discard_wb` = 26 ;
    - `check_invariants()` vaut `[]`.

- [ ] **Step 3: `npm run test:db`** → `FAIL`.

- [ ] **Step 4: Implémenter**
  - Ordre : `idem_claim`, `actor` (sans portée `packs` : la défausse reste permise sans vérification humaine, D§7.0), `lock_user`, verrou des copies `where id = any(…) and user_id = p_uid for update`, décrément ou suppression, `wallet_apply(…, 'discard', 'discard')`, compteurs, `idem_store`.
  - La défausse en masse est ensembliste (pas de boucle de requêtes).
  - `shortcut:` aucun verrou d'échange au M1 ; le 409 « Cette carte est déjà engagée dans un échange en attente » arrive au M4 avec `trades`.

- [ ] **Step 5: `npm run test:db`** → `ok`.

- [ ] **Step 6: Commit** — `feat(db): défausse unitaire et en masse hors grand livre, solde`

---

### Task 8: Catalogue en SQL

**Files:**
- Create: `supabase/migrations/1400_wm_catalog.sql`, `supabase/tests/24_catalog.test.sql`

**Interfaces:**
- Produces :
  - Index `cards_title_prefix_idx` sur `lower(wikipedia_title) text_pattern_ops`, et `cards_search_trgm_idx` en GIN sur `wm.search_text(wikipedia_title, category) extensions.gin_trgm_ops` (D§9.4), avec `wm.search_text` de la Task 6.
  - `wm.cards_page(p_uid uuid, p_page int default 0, p_q text default null, p_rarity public.rarity[] default null, p_wishlist boolean default false, p_missing boolean default false) returns jsonb`. Réponse `{cards: Card[], total: int|null, rarityCounts?: {C..L}, searchHasMore?: bool, ownedCardIds: uuid[], wishlistCardIds: uuid[], friendOwners: {}}`.
  - **`Card`** reprend les colonnes de `rest/v1/cards` du R§3.4 : `id, atk, def, lang, rarity, q_score, category, image_url, pageviews, hide_image, nsfw_image, wikipedia_url, wikipedia_title, summary, pageviews_refreshed_at, qscore_refreshed_at`.

- [ ] **Step 1: Test qui échoue** (`24_catalog.test.sql`, sur un catalogue créé par le test, avec `rebuild_draw_pool`) :
  - Sans recherche, page 0 → au plus 50 cartes dans l'ordre L, UR, SR, R, PC, C, puis `seq` dans chaque rareté. `total` = N et `rarityCounts` = `catalog_stats`.
  - La page qui chevauche deux raretés enchaîne les deux sans trou ni doublon : la concaténation de toutes les pages donne exactement N ids distincts.
  - `p_rarity '{UR,C}'` → seulement ces raretés, `total` = leur somme.
  - Recherche :
    - `p_q` d'un caractère donne 400 `invalid_request` « La recherche demande au moins 2 caractères » ;
    - deux caractères font une recherche par préfixe du titre ;
    - trois caractères ou plus cherchent dans le titre et la catégorie, sans accents ni casse ;
    - pendant une recherche, `total` vaut `null`, `rarityCounts` est absent, et `searchHasMore` vaut `true` quand il reste plus de 50 résultats.
  - `p_wishlist` : seulement ma liste ; `total` = sa taille.
  - `p_missing` : seulement les cartes que je ne possède pas ; `total` = `null`, `searchHasMore` présent.
  - `ownedCardIds` et `wishlistCardIds` ne contiennent que des cartes de la page renvoyée.

- [ ] **Step 2: `npm run test:db`** → `FAIL 24_catalog.test.sql`.

- [ ] **Step 3: Implémenter**
  - Pages arithmétiques : on cumule `catalog_stats` dans l'ordre L…C pour trouver la rareté et le `seq` de départ de l'offset `p_page * 50`, puis on parcourt des intervalles de la PK `(rarity, seq)` de `draw_pool` (D§7.4).
  - `shortcut:` `p_missing` fait un anti-jointure avec offset ; à revoir au M8 sur le catalogue complet.

- [ ] **Step 4: `npm run test:db`** → `ok`.

- [ ] **Step 5: Commit** — `feat(db): page du catalogue en O(1), recherche préfixe et trigramme, overlay joueur`

---

### Task 9: Routes et contrat — paquets, vérification humaine, portefeuille

**Files:**
- Create:
  - `lib/turnstile.ts`, `lib/turnstile.test.ts`
  - Routes : `app/api/packs/open/route.ts`, `app/api/packs/pro-daily/route.ts`, `app/api/packs/special/route.ts`, `app/api/packs/grace/route.ts`, `app/api/human-check/route.ts`, `app/api/wikibidous/route.ts`
  - Specs : `contract/spec/packs.ts`, `contract/spec/wallet.ts`
- Modify: `contract/spec/index.ts`, `.env.example`

**Interfaces:**
- Consumes : `route()` (Task 2), `makeUser` et `authCookie` (Task 1), fonctions de la Task 5.
- Produces :
  - `verifyTurnstile(token: string, ip: string | null): Promise<boolean>`. Un `POST` formulaire (`secret`, `response`, `remoteip`) part vers `TURNSTILE_VERIFY_URL`, délai 5 s. Sans `TURNSTILE_SECRET_KEY`, la fonction renvoie `false` (fail-closed) ; une erreur réseau aussi.
  - Routes :

    | Route | Fonction et options |
    |---|---|
    | `POST /api/packs/open` | `open_pack`, `input: z.looseObject({})` |
    | `GET /api/packs/pro-daily` | `pro_daily_status` |
    | `POST /api/packs/pro-daily` | `pro_daily_claim` |
    | `GET /api/packs/special` | `special_packs` |
    | `POST /api/packs/special` | `claim_special`, `{packId: z.uuid()}` |
    | `POST /api/packs/grace` | `claim_grace` |
    | `POST /api/human-check` | `{token: z.string().min(1).max(2048)}`, `pre` = `verifyTurnstile` (échec → 400 `{ok: false, code: 'human_check_failed', error: 'Vérification anti-bot échouée, réessaie.'}`), fonction `set_human_verified` |
    | `GET /api/wikibidous` | `wallet_balance` |

    Tous les `POST` de paquets passent `idem: true`. `open_pack`, `pro_daily_status` et `pro_daily_claim` reçoivent aussi `p_tz: ctx.tz`.
  - `makeUser` gagne l'option `humanVerified?: boolean` (upsert `wm.user_state.human_verified_until = now() + interval '12 hours'`), et `e2e/fixtures.ts` l'expose aussi.

- [ ] **Step 1: Test unitaire qui échoue** (`lib/turnstile.test.ts`, `fetch` simulé) :
  - pas de secret → `false` sans appel ;
  - `success: true` → `true` ;
  - `success: false`, statut 500 ou exception → `false` ;
  - le corps envoyé contient `secret`, `response` et `remoteip`.

- [ ] **Step 2: Specs de contrat qui échouent** (`contract/spec/packs.ts` et `wallet.ts`), une `RouteSpec` par route du R§3.1 et du R§3.2, avec `source` et `confidence` du recap. Joueurs créés par `makeUser`, état préparé par psql. Cas :
  - `POST /api/packs/open` :
    - 401 sans session (corps D§8.2) ;
    - 403 `human_verification_required` pour un nouveau joueur ;
    - après `POST /api/human-check {token: 'dev-bypass'}` → 200 `{ok: true}`, puis 200 avec `cards.length === 5` ;
    - chaque carte porte les clés de l'union, et les cartes sont triées par rareté croissante ;
    - `owned_copies` est un tableau ;
    - stock vide → 403 avec `next_regen_at` ISO ;
    - deuxième ouverture immédiate → 429 avec un en-tête `Retry-After` ≥ 1 ;
    - `Idempotency-Key` rejouée → même corps et une seule série de copies en base ;
    - `x-wiki-calendar-tz: ../../etc/passwd` → traité comme `Europe/Paris`.
  - `POST /api/human-check` : `{token: 'mauvais'}` → 400 `human_check_failed`, et `{}` → 400 `invalid_request`.
  - `GET` puis `POST /api/packs/pro-daily` :
    - non-Pro → `{eligible: false}`, puis 403 `pro_required` ;
    - Pro vérifié → 15 cartes sans C, puis 409.
  - `GET /api/packs/special` → `{packs: [], available: false}`. `POST` avec un uuid inconnu → 404, et `packId: 'x'` → 400.
  - `POST /api/packs/grace` sans dotation → 404 `no_grace` ; avec une dotation insérée par psql → 200 `{cards}`.
  - `GET /api/wikibidous` → `{balance}` égal à la base.

- [ ] **Step 3: `npm run build:test && npm run test:contract`** → les nouveaux cas échouent (404 de route).

- [ ] **Step 4: Implémenter les handlers** (1 à 3 lignes chacun) **et `lib/turnstile.ts`**. Dans `.env.example`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` et `TURNSTILE_VERIFY_URL` remplacent les anciennes clés, avec un commentaire qui rappelle les clés de test Cloudflare (site `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`, toujours valides).

- [ ] **Step 5: `npm test && npm run build:test && npm run test:contract && npm run coverage:recap`** → tout est vert. Le rapport compte les routes du R§3.1 et du R§3.2 couvertes.

- [ ] **Step 6: Commit** — `feat(api): paquets, vérification humaine Turnstile, portefeuille (contrat R§3.1–3.2)`

---

### Task 10: Routes et contrat — collection, catalogue, pseudos, paramètres, surface `rest/v1`

**Files:**
- Create:
  - Routes : `app/api/my-collection/route.ts`, `app/api/my-collection/stats/route.ts`, `app/api/profile/[username]/collection/route.ts`, `app/api/user-cards/[userCardId]/discard/route.ts`, `app/api/user-cards/bulk-discard/route.ts`, `app/api/cards/route.ts`, `app/api/username-available/route.ts`, `app/api/settings/username/route.ts`, `app/api/settings/preferences/route.ts`
  - Schémas : `lib/schemas.ts`
  - Specs : `contract/spec/collection.ts`, `contract/spec/catalog.ts`, `contract/spec/accounts.ts`, `contract/spec/rest.ts`
- Modify: `contract/spec/index.ts`

**Interfaces:**
- Produces (`lib/schemas.ts`, partagé par les routes et l'UI) :
  - `Rarity = z.enum(['C','PC','R','SR','UR','L'])` ;
  - `rarityList` (chaîne ou tableau → tableau) ;
  - `pageParam` (entier ≥ 0, défaut 0) ;
  - `CollectionSort = z.enum(['rarity','obtained_at','added','name','atk','def','starred'])` ;
  - `boolParam` (`'1'`, `'true'` → `true` ; `'0'`, `'false'`, absent → `false`) ;
  - `Username` (chaîne de 1 à 64 caractères, la règle fine est en SQL).
- Routes :

  | Route | Paramètres | Fonction |
  |---|---|---|
  | `GET /api/my-collection` | `page`, `limit`, `sort`, `q` ou `search`, `rarity`, `tag_id`, `untagged`, `wishlisted_by`, `owned_by`, `pending` (accepté, ignoré), `stats` (accepté) | `my_collection` |
  | `GET /api/my-collection/stats` | mêmes filtres | `my_collection_stats` |
  | `GET /api/profile/{username}/collection` | `page`, `stats`, `q` | `profile_collection` |
  | `POST /api/user-cards/{userCardId}/discard` | `params` uuid, `idem` | `discard` |
  | `POST /api/user-cards/bulk-discard` | `{card_ids: z.array(z.uuid()).min(1).max(50)}`, `idem` | `bulk_discard` |
  | `GET /api/cards` | `page`, `sort` (`'rarity'` seul), `q`, `rarity`, `wishlist`, `missing` | `cards_page` |
  | `GET /api/username-available?u=` | `auth: false` | `username_available` |
  | `POST /api/settings/username` | `{username}` | `change_username` |
  | `GET /api/settings/preferences` | — | `get_prefs` |
  | `POST /api/settings/preferences` | `{sounds?, hide_sensitive?, is_public?: boolean}` | `set_prefs` |

- [ ] **Step 1: Specs qui échouent.** Une `RouteSpec` par route du R§3.3 et du R§3.4, ainsi que des routes ajoutées (`confidence: 'ajouté'`). Cas principaux, en plus du 401 sans session partout où c'est authentifié :
  - Collection :
    - enveloppe `{collection, total, pendingTradeCardIds}` ;
    - pages de 50 en base 0, `limit=500` → 50 ;
    - `rarity=L&rarity=UR` filtre bien ;
    - `sort=xyz` → 400 ;
    - stats → `{total, rarities}`.
  - Profil : pseudo inconnu → 404, profil privé → 403, `stats=1` → `rarityCounts`.
  - Défausse :
    - 200 `{balance}` +1 ;
    - copie d'un autre → 403 `42501` ;
    - `userCardId=abc` → 400 (jamais 500).
  - Défausse en masse : 51 ids → 400, mélange de copies → `failed`.
  - Catalogue :
    - `/api/cards` → les clés du R§3.4 ;
    - `q=a` → 400 ;
    - recherche → `total: null` ;
    - `ownedCardIds` reflète une copie possédée.
  - `username-available` : libre → `{available: true}` ; `Admin` → `{available: false, reason: 'reserved'}` ; `u` absent → 400.
  - Paramètres : changement de pseudo puis 409 au second ; préférences lues et écrites.
  - **Surface `rest/v1` sous RLS** (`contract/spec/rest.ts`, appels directs à la passerelle avec la clé publiable et le JWT du joueur, comme l'original) :
    - `rest/v1/cards` en anon → 200 ;
    - `rest/v1/user_cards?select=id,card_id,count,starred,is_shiny,obtained_at,snapshot_title,snapshot_rarity,snapshot_category,user_card_tags(tag_id),card:cards(id,wikipedia_title,rarity)&user_id=eq.<moi>` → seulement mes lignes ;
    - `PATCH user_cards?id=in.(…) {starred: true}` → 204, et rien ne change sur la ligne d'un autre ;
    - `PATCH {count: 9}` → refusé ;
    - `POST tags {user_id, name, color: '#fb7185'}` → 201, et un doublon de nom → 409 `23505` ;
    - `POST user_card_tags` (tableau de 100) → 201, et un doublon sans `ignore-duplicates` → 409 `23505` ;
    - `DELETE tags?id=eq.` → les liaisons disparaissent en cascade ;
    - `wishlist_items` : POST, GET ordonné par `created_at.desc`, DELETE ;
    - `rpc/sync_profile_packs {user_id: <moi>}` → 200 `[ligne]`, et `{user_id: <autre>}` → 403 ;
    - `rpc/get_my_profile` → 200 ;
    - une étiquette `[LOCKED]` est conservée telle quelle.
  - Trigger d'inscription via GoTrue (dans `contract/spec/auth.ts`) : `POST /auth/v1/signup` avec un pseudo pris → statut ≥ 400, et le corps contient « Ce pseudo est déjà pris » ; deux inscriptions simultanées du même pseudo → une seule réussit.

- [ ] **Step 2: `npm run build:test && npm run test:contract`** → les nouveaux cas échouent.

- [ ] **Step 3: Implémenter** les handlers et `lib/schemas.ts`.

- [ ] **Step 4: `npm test && npm run build:test && npm run test:contract && npm run coverage:recap`** → vert. Toutes les routes du R§3.1 au R§3.4 sont couvertes.

- [ ] **Step 5: Commit** — `feat(api): collection, défausse, catalogue, pseudos, paramètres, contrat rest/v1 (R§3.3–3.4)`

---

### Task 11: Pages d'authentification

**Files:**
- Create:
  - Composants : `components/auth/Turnstile.tsx`, `components/auth/OtpForm.tsx`
  - Pages : `app/(public)/signup/page.tsx` (remplace la page d'attente), `app/(public)/signup/signup-form.tsx`, `app/(public)/login/login-form.tsx`, `app/(public)/forgot-password/page.tsx`, `app/(public)/reset-password/page.tsx`, `app/(public)/verify-email/page.tsx`, `app/(public)/terms/page.tsx`, `app/(public)/rules/page.tsx` (pages d'attente, « vous »)
  - Callback : `app/callback/route.ts`
  - Lib : `lib/auth.ts`
  - E2E : `e2e/auth.spec.ts`
- Modify: `app/(public)/login/page.tsx`, `e2e/a11y.spec.ts`

**Interfaces:**
- Produces :
  - `TERMS_VERSION = '2026-10-19'` ;
  - `authErrorMessage(err: { message?: string; code?: string } | null): string` : un message français connu passe tel quel ; `email_not_confirmed` → « Confirme d'abord ton adresse : saisis le code reçu par courriel. » ; `invalid_credentials` → « Adresse courriel ou mot de passe incorrect. » ; sinon « Une erreur est survenue, réessaie. » ;
  - `<Turnstile onToken={(t: string) => void} />` : avec `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, il charge `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit` et rend le widget en `theme: 'dark'` ; sans clé, il ne rend rien et appelle `onToken('dev-bypass')` une fois ;
  - `<OtpForm email onVerified />` : `input#signup-otp-code[name=otp][inputmode=numeric][autocomplete=one-time-code]`, motif `\d{6,12}`, puis `verifyOtp({ email, token, type: 'signup' })`, avec un bouton « Renvoyer le code » (`resend`).

- [ ] **Step 1: E2E qui échouent** (`e2e/auth.spec.ts`, serveur 3100, e-mails lus par `contract/mail.ts`) :
  - `inscription → code par courriel → /pulls` :
    1. `form#signup-form` contient `#username`, `#email` et `#password`, avec les deux cases aux textes exacts du R§2.1 : « Je confirme avoir au moins 18 ans et je comprends que les cartes proviennent de Wikipédia et peuvent inclure du contenu sensible. » et « J'accepte les Conditions d'utilisation et les Règles de la communauté. ». Les liens pointent vers `/terms` et `/rules`.
    2. Remplir et envoyer ; `#signup-otp-code` apparaît.
    3. Saisir `latestOtp` ; l'URL devient `/pulls`.
  - `pseudo déjà pris → message avant envoi` : quitter `#username` (`blur`) avec un pseudo existant affiche « Ce pseudo est déjà pris » et désactive l'envoi. `Admin` affiche « Ce pseudo est réservé ».
  - `cases non cochées → envoi impossible` : les deux cases sont `required`.
  - `connexion → next restauré` : `/collection` sans session redirige vers `/login?next=%2Fcollection`. Remplir `#email` (libellé « Adresse courriel ») et `#password` envoie vers `/collection`. Sans `next`, on arrive sur `/pulls`. Un mauvais mot de passe affiche « Adresse courriel ou mot de passe incorrect. ».
  - `mot de passe oublié → lien → nouveau mot de passe → connexion` :
    1. Le lien « Mot de passe oublié ? » mène à `/forgot-password`, avec le texte « Nous vous enverrons un lien pour choisir un nouveau mot de passe. ».
    2. Ouvrir `latestLink` mène à `/reset-password` (titre « Nouveau mot de passe — <marque> »).
    3. Saisir le nouveau mot de passe, puis se connecter avec.
  - `lien de réinitialisation invalide → « Lien invalide ou expiré »` : `/callback?code=faux&next=/reset-password`.
  - `compte non confirmé → /verify-email` : se connecter avant la saisie du code mène à `/verify-email?email=…`, avec « Vérifier l'e-mail » et le formulaire de code.

- [ ] **Step 2: `npm run build:test && npx playwright test e2e/auth.spec.ts`** → échec.

- [ ] **Step 3: Implémenter**
  - Formulaires en composants client, avec le client navigateur `@supabase/ssr` (PKCE par défaut).
  - Inscription :
    - `signUp({ email, password, options: { data: { username, age_confirmed: true, terms_version: TERMS_VERSION }, captchaToken, emailRedirectTo: <origine>/callback?next=/pulls } })` ;
    - la vérification préalable du pseudo passe par `GET /api/username-available` au `blur`, avec un délai de 300 ms ;
    - `autocomplete=username` sur le pseudo, `new-password` sur le mot de passe.
  - Connexion : `signInWithPassword` avec `captchaToken`, puis `router.replace(safeNext(next))`.
  - Mot de passe oublié : `resetPasswordForEmail(email, { redirectTo: <origine>/callback?next=/reset-password, captchaToken })`.
  - `/callback` : `exchangeCodeForSession(code)`, puis redirection vers `safeNext(next)`. En cas d'échec, `/reset-password?error=invalid` si `next` vaut `/reset-password`, sinon `/login?error=invalid`.
  - `/reset-password` : `updateUser({ password })`, puis `/pulls`. Sans session ou avec `?error`, la page affiche « Lien invalide ou expiré ».
  - Titres : « Inscription », « Connexion », « Mot de passe oublié », « Nouveau mot de passe » et « Vérifier l'e-mail », via le gabarit `pageTitle`.
  - Ajouter `/signup`, `/login`, `/forgot-password`, `/reset-password` et `/verify-email` à la boucle axe d'`e2e/a11y.spec.ts`.

- [ ] **Step 4: `npm run lint && npm run typecheck && npm run build:test && npm run test:e2e`** → vert.

- [ ] **Step 5: Commit** — `feat(auth): inscription avec code, connexion avec next, mot de passe oublié, vérification d'e-mail, Turnstile`

---

### Task 12: Carte, modale de carte, formats et préférences

**Files:**
- Create:
  - Composants : `components/card/Card.tsx`, `components/card/CardModal.tsx`, `components/card/TagPicker.tsx`, `components/ui/Modal.tsx`, `components/ui/WCoin.tsx`
  - Lib : `lib/format.ts`, `lib/rarity.ts`, `lib/prefs.ts`, `lib/api.ts`
  - Tests : `components/card/Card.test.tsx`, `components/card/CardModal.test.tsx`, `lib/format.test.ts`
- Modify: `app/globals.css` (halos `glow-*`, fonds de rareté recréés en CSS, `legendary-shimmer-sheen`, `animate-card-flip`, variantes `motion-reduce`)

**Interfaces:**
- Produces :
  - `formatInt(n: number): string` (`Intl.NumberFormat('fr-FR')`, espace fine U+202F) et `formatCountdown(ms: number): string` (`m:ss`).
  - `RARITY` : `{code, label, css}` pour C…L, dans l'ordre d'affichage L…C. Libellés : Commune, Peu commune, Rare, Super rare, Ultra rare, Légendaire.
  - `usePrefs(): { sounds: boolean; hideSensitive: boolean; ready: boolean }`. La première lecture passe par `GET /api/settings/preferences`, avec un cache de module. `hideSensitive` vaut `true` tant que la lecture n'est pas finie.
  - `api<T>(path: string, init?: RequestInit & { idem?: boolean }): Promise<T>`. `idem` ajoute `Idempotency-Key: crypto.randomUUID()`. En cas d'erreur, la fonction lève `ApiError { status, body }`.
  - `<Card card={…} size="lg" | "grid" owned? starred? onToggleStar? count? isShiny? friendOwner? onClick? />`. Le DOM suit exactement le R§6.4 : racine `glow-{x}`, zone image à 45 %, badge, favori avec les `aria-label` exacts, `h3`, `p`, `div.mt-auto`, stats avec épées et bouclier, et le voile L. Avec `hide_image`, ou `nsfw_image` quand `hideSensitive` est actif, la carte affiche l'emblème de notre marque. L'image est un `<img loading="lazy" decoding="async" alt=<titre> crossorigin="anonymous">`.
  - `<CardModal item onClose onDiscarded? onChanged? />`. Portail `div.fixed.inset-0…` contenant `div.card-frame…` (R§6.5), avec `role="dialog"`, `aria-modal`, un piège de focus, la fermeture par Échap et un bouton `aria-label="Fermer"`. Contenu :
    - `[role=tablist][aria-label="Vue de la carte"]` avec « Détails » et « Marché » (pastille PRO ; le contenu Marché affiche « Arrive bientôt » jusqu'au M3) ;
    - section « ÉTIQUETTES » (TagPicker) ;
    - grilles ATK et DEF, et la méta « Q-Score : 51,24 » avec `formatInt` sur les vues, « Exemplaires : N » et « Vues (30j) : N » ;
    - lien « Voir l'article sur Wikipédia → » et la ligne « Texte de l'article : CC BY-SA 4.0 — crédits sur la page Wikipédia. » ;
    - pied : « Défausser » avec la pièce W et « +1 », qui appelle `POST /api/user-cards/{id}/discard`, puis un toast « Carte défaussée : +1 wikibidou » ;
    - pour une carte du catalogue (non possédée) : un bouton bascule « Ajouter à ma liste de souhaits » / « Retirer de ma liste de souhaits » (PostgREST `wishlist_items`) à la place des étiquettes et de la défausse.
  - `<TagPicker userCardId tags onChange />` : combobox `placeholder="Ajouter une étiquette…"`, liste `[role=listbox] li[role=option] button`, et des puces « #nom » dans la couleur de l'étiquette avec le bouton `aria-label="Retirer l'étiquette <nom>"`. Créer une étiquette fait un `POST rest/v1/tags`, la lier fait un `POST user_card_tags`, la retirer fait un `DELETE`.

- [ ] **Step 1: Tests qui échouent** (vitest + Testing Library, comme `Bell.test.tsx`) :
  - `Card` :
    - la racine porte `glow-l` pour une L et contient `div.legendary-shimmer-sheen[aria-hidden]`, absent sur une C ;
    - `hide_image` → emblème, aucune image Wikimedia ;
    - `nsfw_image` avec `hideSensitive` → emblème, sans `hideSensitive` → l'image ;
    - le favori a `aria-label="Ajouter aux favoris"`, puis « Retirer des favoris » une fois coché ;
    - les stats affichent `formatInt` ;
    - le sélecteur `div[class*="glow-"] h3` trouve le titre.
  - `CardModal` :
    - Échap ferme et rend le focus à l'élément d'origine ;
    - le tablist a son `aria-label` ;
    - « Défausser » appelle la bonne route avec une `Idempotency-Key` ;
    - « Retirer l'étiquette test » retire la puce.
  - `formatInt(6974)` vaut `'6 974'` et `formatCountdown(507000)` vaut `'8:27'`.

- [ ] **Step 2: `npm test`** → échec.

- [ ] **Step 3: Implémenter**, puis faire une **passe Impeccable** (skill `impeccable:impeccable`, finition de la carte et de la modale). Elle ne touche à aucune classe ni attribut du R§6.4 ou du R§6.5, et `docs/DESIGN.md` est complété si de nouveaux jetons apparaissent. Le contraste du texte noir sur chaque fond de rareté recréé est d'au moins 4,5:1 (`lib/contrast.test.ts` est étendu aux six fonds).

- [ ] **Step 4: `npm test && npm run lint && npm run typecheck`** → vert.

- [ ] **Step 5: Commit** — `feat(ui): carte et modale de carte au DOM d'origine, étiquettes, défausse, préférences`

---

### Task 13: `/pulls` et ouverture de paquet

**Files:**
- Create: `app/(game)/pulls/pulls-client.tsx`, `components/packs/PackOpening.tsx`, `components/packs/PackStock.tsx`, `components/packs/ProDailyBlock.tsx`, `components/packs/HowItWorks.tsx`, `lib/sounds.ts`, `lib/clock.ts`, `e2e/pulls.spec.ts`
- Modify: `app/(game)/pulls/page.tsx`, `e2e/a11y.spec.ts`

**Interfaces:**
- Consumes : `Card`, `Modal`, `api`, `usePrefs` et `formatCountdown` (Task 12) ; les routes de la Task 9 ; `rpc/sync_profile_packs` par le client navigateur, comme l'original.
- Produces :
  - `serverNow(): number`. Il corrige l'heure locale du décalage mesuré par l'en-tête `Date` de la dernière réponse (`noteServerDate(res: Response)`).
  - `playRip()`, `playFlip()` et `playLegendary()`, synthétisés en WebAudio. Rien ne joue si `sounds` est faux, et rien n'échoue sans `AudioContext`.
  - `<PackOpening cards={CardInPack[]} onDone={() => void} />`, qui expose `data-motion="reduced" | "full"` (lu dans `matchMedia('(prefers-reduced-motion: reduce)')`) sur sa racine.

- [ ] **Step 1: E2E qui échouent** (`e2e/pulls.spec.ts`, joueur créé par `makeUser` + `authCookie`) :
  - `repos` :
    - `div.card-frame` affiche « 1 / 10 » et « paquets disponibles » ;
    - avec un stock incomplet, « Prochain dans » apparaît, suivi d'un `span.font-mono` au format `\d+:\d\d` qui change en 2 s ;
    - la barre de stock compte 10 segments ;
    - le bouton « Ouvrir » est présent ;
    - le bloc « Paquet PRO du jour » affiche « Réservé aux membres Pro » pour un joueur gratuit ;
    - « Comment ça marche ? » ouvre une modale avec les seuils « L ≥ 20 000 » et « C < 50 » vues par mois.
  - `première ouverture → vérification anti-bot → révélation` :
    1. « Ouvrir » ; le banc n'a pas de clé de site, donc la vérification passe toute seule.
    2. « Carte 1 / 5 » s'affiche.
    3. `div.animate-card-flip.relative.touch-none.cursor-grab` est visible.
    4. « Encore 4 cartes » est désactivé.
    5. Flèche droite × 4 mène à « Carte 5 / 5 », et le bouton devient « Continuer », actif.
    6. Le récapitulatif montre 5 cartes, avec « Nouvelle » sur une première copie.
    7. La région `aria-live="polite"` contient « Carte 5 / 5 : » suivi du titre et de la rareté.
  - `balayage de 80 px → carte suivante` (pointeur) et `boutons ronds` (`aria-label` « Carte précédente » et « Carte suivante », le premier désactivé à la carte 1).
  - `stock vide` : stock mis à 0 par psql → « Ouvrir » désactivé, avec « Plus de paquets disponibles » et le compte à rebours.
  - `animation réduite` : `test.use({ reducedMotion: 'reduce' })` → `[data-motion="reduced"]` et aucun élément `[data-cinematic]`. Avec `reducedMotion: 'no-preference'` et une L forcée (catalogue réduit à une L par psql dans ce test), `[data-motion="full"]` et `[data-cinematic]` sont présents.
  - `Pro du jour` : avec un joueur Pro vérifié, « Récupérer » donne une révélation de 15 cartes (« Carte 1 / 15 »).

- [ ] **Step 2: `npm run build:test && npx playwright test e2e/pulls.spec.ts`** → échec.

- [ ] **Step 3: Implémenter**
  - Classes du R§2.2 : `div.relative.inline-flex.max-w-[min(100vw-2rem,28rem)]` autour de la carte glissable ; boutons ronds `w-12 h-12 disabled:opacity-20` ; 5 points `w-3 h-3`, l'actif en accent et `scale-125`.
  - Paliers de révélation SR, UR et L, avec une cinématique L (`data-cinematic`) en `motion-safe`, remplacée par un simple fondu en `motion-reduce`.
  - Le visuel du paquet est le nôtre, en CSS et avec le logo texte de la marque.
  - Toute action passe par `api(…, { idem: true })`, et le bouton est désactivé pendant la requête.
  - Sur 403 `human_verification_required` : afficher `<Turnstile>` et le texte de l'erreur, puis `POST /api/human-check` et relancer l'ouverture une fois.
  - Ajouter `/pulls`, au repos et en révélation, à la boucle axe.
  - **Passe Impeccable** sur le paquet et la révélation (mêmes limites qu'à la Task 12).

- [ ] **Step 4: `npm run lint && npm run typecheck && npm run build:test && npm run test:e2e`** → vert.

- [ ] **Step 5: Commit** — `feat(pulls): stock et compte à rebours, vérification anti-bot, révélation carte par carte, Pro du jour`

---

### Task 14: `/collection`

**Files:**
- Create: `app/(game)/collection/collection-client.tsx`, `components/collection/CollectionToolbar.tsx`, `components/collection/SelectionBar.tsx`, `components/ui/Pagination.tsx`, `components/ui/RarityChips.tsx`, `e2e/collection.spec.ts`
- Modify: `app/(game)/collection/page.tsx`, `e2e/a11y.spec.ts`

**Interfaces:**
- Consumes : les Tasks 10 et 12 ; PostgREST direct pour `tags`, `user_card_tags`, `wishlist_items` et `PATCH user_cards {starred}`.
- Produces : `<RarityChips value onChange />` (style `background-color: var(--color-rarity-x)30; color: var(--color-rarity-x)`, `opacity-50` quand la pastille est inactive, ordre L…C) et `<Pagination page totalPages onPage />` (« ← Précédent », « Page n / m », « Suivant → »), réutilisés à la Task 15.

- [ ] **Step 1: E2E qui échouent** (`e2e/collection.spec.ts`, joueur avec 60 copies insérées par psql à partir du catalogue d'essai) :
  - `grille et pagination` :
    - le titre est « Collection » ;
    - la grille `div.flex.flex-wrap.justify-center.gap-3` contient 50 tuiles `div.relative.isolate.group`, et « Page 1 / 2 » ;
    - « Suivant → » mène à 10 tuiles ;
    - une copie à `count = 3` affiche « x3 ».
  - `recherche` : `input[placeholder="Rechercher par titre ou catégorie..."]` a le focus au chargement. Taper « n° 0001 » ne laisse que les copies correspondantes (recherche serveur avec délai).
  - `tri et rareté` : le tri par défaut est « Rareté », et le passage à « Nom » réordonne la grille. La pastille « L » seule ne montre que des L.
  - `étiquette depuis la modale` :
    1. Ouvrir une tuile ; taper « test » dans « Ajouter une étiquette… », puis Entrée.
    2. La puce « #test » apparaît.
    3. Fermer ; la liste « Toutes les étiquettes » propose « test (1) ».
    4. Choisir « test (1) » : la grille montre 1 tuile.
  - `favori` : l'étoile de la tuile passe à « Retirer des favoris », et la valeur persiste au rechargement.
  - `défausse unitaire` : le solde affiché en haut à droite passe de N à N+1, et la tuile disparaît.
  - `multi-sélection` :
    1. « Sélectionner », puis « Tout sélectionner » : 50 cases cochées.
    2. « Défausser » ouvre un `dialog` « Défausser 50 cartes ? Tu gagneras 50 wikibidous. Action irréversible. ».
    3. Confirmer : le solde gagne 50 et il reste 10 tuiles.
  - `étiquette en masse` : sélectionner 3 tuiles, « Appliquer une étiquette » « lot », puis filtrer par « lot » → 3 tuiles. « Retirer l'étiquette » les enlève.
  - `collection vide` : un nouveau joueur voit un état vide « Ta collection est vide » avec un lien vers `/pulls`.

- [ ] **Step 2: `npm run build:test && npx playwright test e2e/collection.spec.ts`** → échec.

- [ ] **Step 3: Implémenter**
  - L'état est porté dans l'URL (`?page`, `q`, `sort`, `rarity`, `tag_id`) : le bouton Retour et le rechargement le gardent.
  - La défausse en masse découpe en lots de 50.
  - États vide, erreur et chargement traités (le chargement suit le R§6.3).
  - Ajouter `/collection`, grille et modale ouverte, à la boucle axe.

- [ ] **Step 4: `npm run lint && npm run typecheck && npm run build:test && npm run test:e2e`** → vert.

- [ ] **Step 5: Commit** — `feat(collection): grille paginée, recherche, tris, raretés, étiquettes, favoris, défausse unitaire et en masse`

---

### Task 15: `/global-collection` et `/settings`

**Files:**
- Create: `app/(game)/global-collection/global-client.tsx`, `app/(game)/settings/settings-client.tsx`, `e2e/global-collection.spec.ts`, `e2e/settings.spec.ts`
- Modify: `app/(game)/global-collection/page.tsx`, `app/(game)/settings/page.tsx`, `e2e/a11y.spec.ts`

**Interfaces:**
- Consumes : `RarityChips`, `Pagination`, `Card`, `CardModal`, `api` et `usePrefs` ; les routes `/api/cards` et `/api/settings/*` ; `supabase.auth.updateUser` et `signOut`.

- [ ] **Step 1: E2E qui échouent**
  - `catalogue` :
    - le h1 est « Collection Globale », avec « Toutes les cartes existantes dans le jeu » ;
    - l'en-tête `card-frame` affiche les totaux par rareté et « 2 000 cartes au total » (`formatInt`) ;
    - la grille contient 50 cartes, sans marqueur de possession ;
    - le bouton `aria-label="Trier les cartes"` affiche « Rareté » ;
    - « Rechercher » est désactivé tant que le champ est vide ;
    - rechercher « 0002 » affiche « Recherche active : pas de décompte par rareté ni de total exact ».
  - `liste de souhaits` : ouvrir une carte, puis « Ajouter à ma liste de souhaits ». La bascule « Liste de souhaits » (icône bookmark) ne montre plus que cette carte.
  - `paramètres` :
    - changer de pseudo vers un pseudo libre réussit, et un second changement affiche « Un seul changement de pseudo tous les 30 jours. » ;
    - décocher « Masquer les images sensibles » persiste après rechargement ;
    - « Sons » et « Profil public » se basculent ;
    - « Changer le mot de passe » permet ensuite de se connecter avec le nouveau ;
    - « Se déconnecter » mène à `/login`.

- [ ] **Step 2: `npm run build:test && npx playwright test e2e/global-collection.spec.ts e2e/settings.spec.ts`** → échec.

- [ ] **Step 3: Implémenter**
  - Grille `flex flex-wrap justify-center gap-3 sm:gap-[22px] md:gap-[26px]` (R§2.2).
  - Paramètres : onglet « Général » avec les sections Profil, Préférences et Compte. Les états vide, erreur et chargement sont traités avec le skill Intent `intent:fortify` : la page n'a jamais été capturée (D§8.5).
  - Ajouter les deux pages à la boucle axe.

- [ ] **Step 4: `npm run lint && npm run typecheck && npm run build:test && npm run test:e2e`** → vert.

- [ ] **Step 5: Commit** — `feat(ui): catalogue global avec liste de souhaits, paramètres de base`

---

### Task 16: Parcours complet, déploiement de la démo, passation

**Files:**
- Create: `e2e/journey.spec.ts`
- Modify: `docs/superpowers/HANDOFF.md`, `docs/m0-suivi.md` (renommé `docs/suivi.md`, liens mis à jour), `docs/decisions-graphify.md`, `docs/verifications.md`, `README.md`

- [ ] **Step 1: E2E du critère de fin de jalon** (`e2e/journey.spec.ts`, D§13 M1) : `inscription → code → /pulls → paquet → collection → étiquette → défausse`, en un seul test et sans aucune insertion psql.
  1. S'inscrire, saisir le code reçu dans Mailpit, arriver sur `/pulls`.
  2. Ouvrir le paquet (vérification automatique en banc), révéler les 5 cartes, cliquer « Continuer ».
  3. Aller sur `/collection` : 5 tuiles.
  4. Étiqueter la première « départ », puis filtrer : 1 tuile.
  5. Défausser cette copie : solde 1, et 4 tuiles.

- [ ] **Step 2: Suite complète en local** — `npm run lint && npm run typecheck && npm test && npm run test:db && npm run build:test && npm run test:contract && npm run test:e2e && npm run coverage:recap`. Attendu : tout est vert, axe ne trouve aucune violation *serious* ni *critical* sur chaque route ajoutée, et le rapport de couverture liste toutes les routes du R§3.1 au R§3.4.

> Ordre (R32) : le Step 4 (migrations et seed sur la démo) passe avant la fusion du Step 3, car `develop` est la branche de production de Vercel ; le Step 7 ajoute la sonde du cache de schéma de PostgREST (`HANDOFF.md`).

- [ ] **Step 3: Pousser la branche de travail et lancer `ci.yml` à la demande sur elle (`workflow_dispatch`).** Quand la CI est verte, fusionner dans `develop` (`git merge --no-ff`, comme pour le M0) et pousser `develop`.

- [ ] **Step 4: Base de la démo** (MCP Supabase, projet `iggurckxmoagsajzrnwd`)
  - `apply_migration` pour `0003`, `1100`, `1200`, `1300` et `1400`, dans cet ordre.
  - `execute_sql` de `supabase/seed.sql`.
  - `get_advisors` `security` : aucune nouvelle alerte, sinon la corriger ou la consigner dans `docs/verifications.md`.
  - Contrôle : `select count(*) from public.cards` = 2 000, `select * from wm.catalog_stats`, et `select tgname from pg_trigger where tgrelid = 'auth.users'::regclass` contient `wm_on_auth_user_created`.

- [ ] **Step 5: Variables Vercel** (MCP `create_project_env`, projet `wmr`, Production et Preview) :
  - `NEXT_PUBLIC_TURNSTILE_SITE_KEY` = `1x00000000000000000000AA` ;
  - `TURNSTILE_SECRET_KEY` = `1x0000000000000000000000000000000AA`.

  Ce sont les clés de test publiques de Cloudflare, toujours valides (défaut D§15 n° 2). Redéployer après le merge, puis vérifier `/api/health` à 200 en production.

- [ ] **Step 6: Étapes humaines à consigner dans `HANDOFF.md`.** Le MCP n'expose pas la configuration Auth, donc l'utilisateur fait ces réglages dans le tableau de bord Supabase :
  1. **Authentication → URL Configuration** : Site URL `https://wmr-ivm.vercel.app`, Redirect URLs `https://wmr-ivm.vercel.app/**` et `https://*-ivm-projects.vercel.app/**`.
  2. **Authentication → Emails → Templates** : coller `supabase/templates/confirmation.html` dans « Confirm signup » (sujet « Ton code de confirmation ») et `recovery.html` dans « Reset password ». Vérifier que la longueur de l'OTP vaut 6.
  3. **Authentication → Emails → SMTP** : Brevo avec un domaine d'expédition contrôlé (D§15 n° 2). Sans SMTP, le service intégré de Supabase n'envoie qu'aux adresses des membres de l'organisation, avec un débit très bas.
  4. **Authentication → Attack Protection → Captcha** : Turnstile, avec le secret de test (ou une vraie paire de clés, en mettant à jour les deux variables Vercel).
  5. Facultatif : vérifier dans **Settings → JWT Keys** que la clé de signature est asymétrique (ECC P-256), sinon `getClaims()` interroge GoTrue à chaque requête. Après la première vraie inscription, lire l'en-tête `alg` d'une session et consigner le résultat dans `docs/verifications.md` (point reporté du M0).

- [ ] **Step 7: Vérification en production**
  - `curl` : `/api/health` à 200, et `/signup` à 307 vers `/gate`.
  - Navigateur (Playwright sur la production, mauvais mot de passe de porte seulement, comme au M0) : la porte refuse.
  - Après les étapes humaines, un étudiant joue le parcours complet ; le résultat est consigné.

- [ ] **Step 8: Passation**
  - `HANDOFF.md` : état du M1, étapes humaines, plan M2.
  - `docs/suivi.md` : points différés, triés par jalon. M2 : cache partagé de `/api/cards`, retrait des cartes d'essai au chargement du vrai catalogue, *swap-with-last*. M4 : verrou d'échange de la défausse, amitié pour `wishlisted_by` et `owned_by`. M8 : `p_missing` sur le catalogue complet.
  - `docs/decisions-graphify.md` : les 5 décisions de ce plan.
  - `README.md` : prérequis `get-tools.sh`.

- [ ] **Step 9: Commit** — `docs: M1 livré — parcours complet, démo déployée, étapes humaines, passation`
