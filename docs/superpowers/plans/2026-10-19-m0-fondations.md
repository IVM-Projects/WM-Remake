# M0 — Fondations : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poser un squelette qui tourne de bout en bout : app Next.js derrière une porte démo, schéma `public` miroir (tables du cœur) et schéma `wm` (erreurs, acteur, portefeuille, idempotence), helper `route()`, banc de tests SQL / contrat HTTP / E2E, CI, déploiement Vercel protégé avec `/api/health` vert.

**Architecture:** Next 16 (App Router, `proxy.ts`) à la racine du dépôt ; toute la logique métier en PL/pgSQL `security definer` dans le schéma `wm`, appelée par des route handlers d'une à trois lignes via `route()` → PostgREST (clé secrète). Les tests tournent dans le bac à sable sur PG16 local + binaire PostgREST + stub JWKS, et en CI sur `postgres:17`.

**Tech Stack:** next 16.4.2, react 19.3.1, typescript 5.9.3, tailwindcss 4.3.3, lucide-react 1.59.0, @supabase/ssr 0.12.7, @supabase/supabase-js 2.118.0, zod 4.6.7, vitest 5.0.5, @playwright/test 1.64.1, @axe-core/playwright 4.14.0, PostgREST v12.2.3, PostgreSQL 16 (bac à sable) / 17 (CI, Supabase).

**Spec:** `docs/superpowers/specs/2026-10-18-wikimasters-rebuild-design.md` (le « design », cité D§x) et sa référence `docs/rea-recap.md` (le « recap », cité R§x).

## Global Constraints

- Versions **exactes** dans `package.json` (aucun `^` ni `~`) : celles de la ligne Tech Stack, plus eslint 9.39.5, eslint-config-next 16.4.2, @tailwindcss/turbopack 4.3.3, @types/node 24.19.2, @types/react 19.3.0, @types/react-dom 19.3.0, server-only 0.0.1. TypeScript 5.9.3 et eslint 9.39.5 sont les versions installées par le create-next-app du dépôt ; TS 7.0 est le portage natif sans l'API JS dont `next build` a besoin (`shortcut:` à revoir quand Next annoncera TS 7).
- **Le dépôt part d'un create-next-app** (branche `develop`) : on le complète, on ne le recrée pas. On garde `AGENTS.md`, qui impose de lire le guide concerné dans `node_modules/next/dist/docs/` avant d'écrire du code touchant une API Next (proxy, cache, route handlers, polices) ; on garde `cacheComponents: true`, `partialPrefetching: true` et la règle Turbopack `@tailwindcss/turbopack` de `next.config.ts` (donc pas de `postcss.config.mjs`).
- Flux Git : branche de travail créée depuis `develop`, PR vers `develop`.
- Node 24 en CI et sur Vercel (`.nvmrc` = `24`, `engines.node` = `>=22.22`) ; tout doit aussi tourner sur Node 22.22 (bac à sable).
- Arborescence à la racine (`app/`, `components/`, `lib/`, `supabase/`, `contract/`, `e2e/`), alias `@/*` → `./*` (D§5.2).
- Aucun préfixe de locale dans les URL ; `<html lang="fr">` ; toute chaîne visible en français ; « tu » dans le jeu, « vous » dans les pages légales (D§14).
- Thème sombre uniquement (D§2.2).
- Chaque table de `public` a la RLS activée ; chaque migration porte ses `GRANT` explicites (règle Supabase des projets créés après le 30 mai 2026, D§3.2).
- Chaque fonction `wm.*` : `security definer`, `set search_path = ''`, noms qualifiés, `EXECUTE` révoqué à `public`/`anon`/`authenticated` et accordé à `service_role` seul (C2).
- Migrations idempotentes, expand-only, compatibles PG16 et PG17 (D§6.6) ; aucune n'utilise `MERGE … RETURNING`.
- Chaînes d'erreur exactes du D§8.2 ; `error` et `message` portent la même chaîne.
- Aucune PII dans les logs (uid haché, jamais d'e-mail).
- Pas de dépendance ajoutée hors de cette liste sans nécessité démontrée (Ponytail) ; Stripe, web-push et Turnstile arrivent à leur jalon.
- Écart au design assumé par ce plan : les tables miroir sont créées **par domaine, au jalon qui les utilise** (M0 : le cœur ; M3 : marché ; M4 : échanges et social ; M5 : batailles, guildes, progression), au lieu d'un seul `0001` complet, pour ne figer aucune colonne sans le contexte de son domaine. À consigner dans Graphify (Task 14).

## Review Focus

- **Contournement de la porte par le chemin** (`/api/health/../pulls`, `/GATE`, `/api/cronx`, `/gate?next=//evil.example`) : seules les exemptions exactes passent, et `next` n'accepte qu'un chemin relatif interne. → tests ajoutés à la Task 3.
- **Marque d'origine déguisée** (`Wiki Masters`, `WIKI-MASTERS`, `WikiMastérs`, ` wikimasters `) sans mot de passe de porte : le build et le démarrage échouent. → tests ajoutés à la Task 1.
- **En-têtes clients invalides** (`x-wiki-calendar-tz: ../../etc/passwd`, fuseau inconnu, `Idempotency-Key` de 500 caractères) : fuseau par défaut `Europe/Paris` sans erreur, clé trop longue → 400 en français, jamais de 500. → tests ajoutés à la Task 8.
- **Erreur base inattendue** (détail non JSON, SQLSTATE inconnu, réseau coupé) : 500 générique en français, sans message Postgres ni pile ; `57014` et `55P03` → 503 `BUSY` + `Retry-After: 1`. → tests ajoutés à la Task 8.
- **Crédits et débits concurrents** sur le même joueur (même `(reason, ref)` rejoué en parallèle, débits qui dépasseraient le solde) : un seul crédit, solde jamais négatif, invariants vides. → test de concurrence à la Task 7.

---

### Task 1: Squelette Next.js et marque (fail-closed)

**Files:**
- Modify: `package.json`, `package-lock.json`, `.gitignore`, `.env.example`, `tsconfig.json`, `next.config.ts`, `README.md` (une page courte : but du projet, commandes, liens vers `docs/`)
- Create: `.nvmrc`, `vitest.config.ts`, `lib/brand.ts`
- Delete: `public/{file,globe,next,vercel,window}.svg` (gabarit)
- Test: `lib/brand.test.ts`

**Interfaces:**
- Produces: `BRAND_DEFAULT: string` (= `'WikiCartes'`, nom neutre provisoire, décision de Claude) ; `normalizeBrand(name: string): string` ; `assertBrandSafe(name: string, gatePassword: string | undefined): void` ; `splitBrand(name: string): { name: string; prefix: string | null; rest: string }` ; `brand` (= `splitBrand` de la marque configurée) ; `pageTitle(page: string): string`.

- [ ] **Step 1: Compléter le create-next-app** — `package.json` (garder `name`, `"private": true`, ajouter `"type": "module"` et `engines`, versions exactes du Global Constraints, react/react-dom 19.3.1), scripts : `dev`, `build` (`next build`), `build:test` (`NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_test next build`, voir Task 9), `start`, `typecheck` (`next typegen && tsc --noEmit`), `lint` (`eslint .`), `test` (`vitest run`), `test:db` (`bash scripts/db-test.sh`), `test:contract` (`vitest run --config vitest.contract.config.ts`), `test:e2e` (`playwright test`), `coverage:recap` (`node contract/recap-coverage.ts`). `tsconfig.json` (existant) : ajouter `allowImportingTsExtensions: true`. `.env.example` : remplacer le texte d'exemple par la liste commentée des variables du D§12.2. `.gitignore` : `node_modules`, `.next`, `.cache`, `.env*` sauf `.env.example`, `test-results`, `playwright-report`, `next-env.d.ts`. `npm install` doit écrire un lockfile sans avertissement de peer bloquant.

- [ ] **Step 2: Écrire le test qui échoue** (`lib/brand.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { normalizeBrand, assertBrandSafe, BRAND_DEFAULT, pageTitle, splitBrand } from '@/lib/brand'

describe('marque', () => {
  it.each(['WikiMasters', 'Wiki Masters', 'WIKI-MASTERS', 'WikiMastérs', ' wikimasters '])(
    'refuse %j sans porte', (n) => {
      expect(normalizeBrand(n)).toBe('wikimasters')
      expect(() => assertBrandSafe(n, undefined)).toThrow(/DEMO_GATE_PASSWORD/)
      expect(() => assertBrandSafe(n, '')).toThrow(/DEMO_GATE_PASSWORD/)
    })
  it('accepte la marque d\'origine derrière la porte', () => {
    expect(() => assertBrandSafe('WikiMasters', 's3cret')).not.toThrow()
  })
  it('accepte une autre marque sans porte', () => {
    expect(() => assertBrandSafe(BRAND_DEFAULT, undefined)).not.toThrow()
  })
  it('découpe le préfixe Wiki pour le logo', () => {
    expect(splitBrand('WikiCartes')).toEqual({ name: 'WikiCartes', prefix: 'Wiki', rest: 'Cartes' })
    expect(splitBrand('Encyclodeck')).toEqual({ name: 'Encyclodeck', prefix: null, rest: 'Encyclodeck' })
  })
  it('titre de page', () => {
    expect(pageTitle('Connexion')).toBe(`Connexion — ${BRAND_DEFAULT}`)
  })
})
```

- [ ] **Step 3: Lancer, constater l'échec** — Run: `npx vitest run lib/brand.test.ts` · Expected: FAIL (module introuvable).

- [ ] **Step 4: Implémenter `lib/brand.ts`** — `normalizeBrand` : NFD, suppression des diacritiques, minuscules, suppression de tout ce qui n'est pas `[a-z0-9]`. `assertBrandSafe` lève `Error('Marque d\'origine configurée sans porte démo : définis DEMO_GATE_PASSWORD')`. `splitBrand(name): { name; prefix; rest }` (préfixe `'Wiki'` sensible à la casse). `brand = splitBrand(process.env.NEXT_PUBLIC_BRAND_NAME || BRAND_DEFAULT)`. **Ne pas** appeler `assertBrandSafe` au niveau module (le fichier est importé côté client, où le mot de passe n'existe pas).

- [ ] **Step 5: Brancher le fail-closed au build et au démarrage** — dans le `next.config.ts` existant (en gardant ses options), appeler `assertBrandSafe(process.env.NEXT_PUBLIC_BRAND_NAME || BRAND_DEFAULT, process.env.DEMO_GATE_PASSWORD)` en tête (lu par `next build` **et** `next start`). Ajouter : `poweredByHeader: false`, redirection `{ source: '/pull', destination: '/pulls', permanent: true }` (308, D§8.1), en-têtes `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` sur `/:path*`.

- [ ] **Step 6: Vérifier** — Run: `npx vitest run lib/brand.test.ts && NEXT_PUBLIC_BRAND_NAME=WikiMasters npx next build; echo "exit=$?"` · Expected: tests PASS ; le build échoue avec le message `DEMO_GATE_PASSWORD` (exit ≠ 0).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: squelette Next 16 et marque fail-closed"`

---

### Task 2: Jetons de design, polices, layout racine, DESIGN.md

**Files:**
- Modify: `app/globals.css`, `app/layout.tsx` (remplacer Geist par nos polices, `lang="fr"`)
- Create: `app/fonts/*.woff2` (+ `app/fonts/OFL.txt`), `app/icon.tsx`, `app/not-found.tsx`, `docs/DESIGN.md`
- Delete: `app/favicon.ico` (remplacé par `app/icon.tsx`)
- Test: `lib/contrast.test.ts`

**Interfaces:**
- Consumes: `brand`, `pageTitle` (Task 1).
- Produces: variables CSS `--color-background`, `--color-foreground`, `--color-surface`, `--color-surface-light`, `--color-border`, `--color-accent`, `--color-accent-light`, `--color-accent-foreground`, `--color-rarity-{c,pc,r,sr,ur,l}`, `--color-rarity-{…}-dark`, `--font-heading`, `--font-body` ; classes `card-frame`, `glow-{c,pc,r,sr,ur,l}`, `legendary-shimmer-sheen`, `animate-fade-in-up` (toutes avec `motion-safe:` pour l'animation).

- [ ] **Step 1: Écrire le test qui échoue** (`lib/contrast.test.ts`) — il lit `app/globals.css`, extrait les valeurs hex des variables du bloc `@theme`, et vérifie le contraste WCAG :

```ts
const pairs: [fg: string, bg: string, min: number][] = [
  ['--color-foreground', '--color-background', 4.5],
  ['--color-foreground', '--color-surface', 4.5],
  ['--color-accent', '--color-background', 4.5],
  ['--color-accent-foreground', '--color-accent', 4.5],
  ...['c','pc','r','sr','ur','l'].map(r => ['#0d1117', `--color-rarity-${r}`, 4.5] as [string,string,number]), // texte du badge, R§6.4
]
it.each(pairs)('%s sur %s ≥ %s:1', (fg, bg, min) => expect(contrast(resolve(fg), resolve(bg))).toBeGreaterThanOrEqual(min))
it('valeurs imposées par le recap §6.1', () => {
  expect(resolve('--color-background')).toBe('#0d0d0d')
  expect(resolve('--color-accent')).toBe('#34d399')
  expect(['c','pc','r','sr','ur','l'].map(r => resolve(`--color-rarity-${r}`)))
    .toEqual(['#b8f2d5','#b1cff2','#c6a7f2','#ed6fa3','#fa9931','#ffe144'])
})
```

- [ ] **Step 2: Lancer, constater l'échec** — Run: `npx vitest run lib/contrast.test.ts` · Expected: FAIL (fichier CSS absent).

- [ ] **Step 3: Produire le design system avec Impeccable** — invoquer le skill `impeccable:impeccable` avec pour entrée le recap §6.1 à §6.6 et le design D§8.5 ; il écrit `docs/DESIGN.md` (jetons, typographie, anatomie de la carte, shell, mouvements) et propose les valeurs inconnues (`surface`, `surface-light`, `border`, `accent-light`, ombres `glow-*`). Contrainte : il ne renomme ni ne supprime aucune classe ou attribut exigé par R§6.4 et R§6.8.

- [ ] **Step 4: Écrire `app/globals.css`** — `@import "tailwindcss";`, bloc `@theme` avec les valeurs du test et de `docs/DESIGN.md`, teintes foncées de R§6.1 (`#2b7d58`, `#2c5c99`, `#6439b8`, `#a8235b`, `#9a4f05`, L → `#fa9931`), `body { background: var(--color-background); color: var(--color-foreground) }`, classes de la liste Produces. Fonds de rareté recréés en CSS (rayures SR, ondes UR, scintillement L) ; aucun PNG d'origine.

- [ ] **Step 5: Polices locales** — récupérer `@fontsource-variable/rubik@5.3.0` et `@fontsource-variable/inter@5.3.0` par `npm pack` dans le scratchpad (pas de dépendance ajoutée), copier les fichiers `*-latin-wght-normal.woff2` et `*-latin-ext-wght-normal.woff2` dans `app/fonts/` avec la licence OFL ; `app/layout.tsx` les charge par `next/font/local` en `variable: '--font-heading'` (Rubik) et `'--font-body'` (Inter). Raison : `next/font/google` télécharge au build et le bac à sable n'atteint pas Google.

- [ ] **Step 6: Layout racine** — `<html lang="fr" className="dark">`, `metadata.title = { default: brand.name, template: '%s — ' + brand.name }`, `metadata.robots = { index: false, follow: false }` quand `process.env.DEMO_GATE_PASSWORD` est défini. `app/icon.tsx` : favicon 32×32 par `ImageResponse`, initiales de la marque en accent sur fond `#0d0d0d`. `app/not-found.tsx` : « Page introuvable » + lien « Retour aux paquets » vers `/pulls`.

- [ ] **Step 7: Vérifier** — Run: `npx vitest run lib/contrast.test.ts && npm run typecheck && npm run build` · Expected: PASS, build OK.

- [ ] **Step 8: Commit** — `git commit -am "feat: jetons de design, polices locales et layout racine"` (ajouter les nouveaux fichiers).

---

### Task 3: Porte démo, session et `proxy.ts`

**Files:**
- Create: `lib/gate.ts`, `lib/routes.ts`, `lib/supabase/proxy.ts`, `proxy.ts`, `app/robots.ts`, `app/(public)/gate/page.tsx`, `app/(public)/gate/actions.ts`
- Test: `lib/gate.test.ts`, `lib/routes.test.ts`

**Interfaces:**
- Consumes: `brand`, `assertBrandSafe` (Task 1).
- Produces:
  - `GATE_COOKIE = 'wm_gate'` ; `gateToken(secret: string, password: string): Promise<string>` (HMAC-SHA256 hex de `gate:v1:<password>`, Web Crypto) ; `isGateCookieValid(value: string | undefined, secret: string, password: string): Promise<boolean>` (comparaison à temps constant) ; `gateDecision(pathname: string, gateEnabled: boolean, cookieValid: boolean): 'pass' | 'redirect' | 'unauthorized'` ; `safeNext(next: string | null | undefined): string`.
  - `GAME_PREFIXES: readonly string[]` = `/pulls`, `/collection`, `/global-collection`, `/trades`, `/marketplace`, `/profile`, `/guild`, `/friends`, `/dms`, `/battle`, `/achievements`, `/leaderboard`, `/settings`, `/admin` ; `isGameRoute(pathname: string): boolean` (égalité ou préfixe suivi de `/`).
  - `updateSession(req: NextRequest): Promise<{ response: NextResponse; userId: string | null }>` (`@supabase/ssr` + `auth.getClaims()`, cookies `getAll`/`setAll`, nom de cookie forcé par `NEXT_PUBLIC_AUTH_COOKIE_NAME` s'il est défini — préfixe `NEXT_PUBLIC_` parce que le client navigateur en a aussi besoin ; écart de nom assumé par rapport à `AUTH_COOKIE_NAME` du D§12.2).

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// lib/gate.test.ts
it.each([
  ['/api/health', 'pass'], ['/api/stripe/webhook', 'pass'], ['/api/cron/push', 'pass'], ['/gate', 'pass'],
  ['/robots.txt', 'pass'], ['/icon', 'pass'],
  ['/', 'redirect'], ['/pulls', 'redirect'], ['/GATE', 'redirect'], ['/api/health/../pulls', 'redirect'],
  ['/api/cronx', 'unauthorized'], ['/api/health2', 'unauthorized'], ['/api/marketplace', 'unauthorized'],
])('porte active sans cookie : %s → %s', (p, d) => expect(gateDecision(p, true, false)).toBe(d))
it('cookie valide ou porte inactive → pass', () => {
  expect(gateDecision('/pulls', true, true)).toBe('pass')
  expect(gateDecision('/api/marketplace', false, false)).toBe('pass')
})
it.each([['/collection', '/collection'], ['//evil.example', '/pulls'], ['/\\evil', '/pulls'],
  ['https://evil.example', '/pulls'], [null, '/pulls'], ['/pulls?x=1', '/pulls?x=1']])('safeNext(%j) = %j', (i, o) => expect(safeNext(i)).toBe(o))
it('jeton de porte vérifiable et lié au mot de passe', async () => {
  const t = await gateToken('k', 'pw')
  expect(await isGateCookieValid(t, 'k', 'pw')).toBe(true)
  expect(await isGateCookieValid(t, 'k', 'autre')).toBe(false)
  expect(await isGateCookieValid(undefined, 'k', 'pw')).toBe(false)
})
// lib/routes.test.ts
it('routes de jeu', () => {
  expect(isGameRoute('/pulls')).toBe(true); expect(isGameRoute('/marketplace/abc')).toBe(true)
  expect(isGameRoute('/pullsx')).toBe(false); expect(isGameRoute('/login')).toBe(false); expect(isGameRoute('/')).toBe(false)
})
```

`gateDecision` compare le chemin **brut** (sans normalisation) à la liste d'exemptions exactes `['/gate', '/api/health', '/api/stripe/webhook', '/robots.txt', '/icon']` et au préfixe `/api/cron/` ; tout le reste sous `/api/` → `unauthorized`, sinon `redirect`.

- [ ] **Step 2: Lancer, constater l'échec** — Run: `npx vitest run lib/gate.test.ts lib/routes.test.ts` · Expected: FAIL.

- [ ] **Step 3: Implémenter `lib/gate.ts`, `lib/routes.ts`, `lib/supabase/proxy.ts`.**

- [ ] **Step 4: Écrire `proxy.ts`** — `export async function proxy(request: NextRequest)` et `export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:woff2|png|svg|ico)$).*)'] }`. Ordre :
  1. `assertBrandSafe(...)` (échec → 500 « Configuration invalide »).
  2. Porte, si `DEMO_GATE_PASSWORD` et `GATE_COOKIE_SECRET` sont définis : `redirect` → 307 vers `/gate?next=<chemin+query>` ; `unauthorized` → 401 JSON `{ error: 'Accès réservé', message: 'Accès réservé' }`.
  3. `updateSession(request)` ; si `isGameRoute(pathname)` et `userId === null` → 307 vers `/login?next=<chemin>`.
  4. Porte active → `X-Robots-Tag: noindex, nofollow, noarchive` sur la réponse.

- [ ] **Step 5: Page et action de la porte** — formulaire : `<label for="gate-password">Mot de passe de la démo</label>`, `input#gate-password[type=password][autocomplete=current-password]`, bouton « Entrer ». `enterGate(formData)` (`'use server'`) compare à temps constant au mot de passe ; succès → cookie `wm_gate` (`httpOnly`, `secure` hors localhost, `sameSite: 'lax'`, 30 jours) puis `redirect(safeNext(next))` ; échec → état « Mot de passe incorrect. » (`role="alert"`). `app/robots.ts` (appelle `await connection()` pour être évalué à la requête et non au build) : porte active → `{ rules: { userAgent: '*', disallow: '/' } }`, sinon `allow: '/'`, `disallow: '/api/'`.

- [ ] **Step 6: Vérifier** — Run: `npx vitest run lib/gate.test.ts lib/routes.test.ts && npm run typecheck` · Expected: PASS. (Le comportement HTTP réel est couvert par la Task 9.)

- [ ] **Step 7: Commit** — `git commit -m "feat: porte démo, session et proxy"`

---

### Task 4: Banc de tests SQL local

**Files:**
- Create: `scripts/db-test.sh`, `supabase/tests/bootstrap_local.sql`, `supabase/tests/helpers.sql`, `supabase/tests/00_bootstrap.test.sql`

**Interfaces:**
- Produces:
  - `scripts/db-test.sh [--setup-only]` : sans `DATABASE_URL`, crée un cluster PG jetable (`initdb` dans `.cache/pg`, port 54329, binaires `${PGBIN:-/usr/lib/postgresql/16/bin}`) ; avec `DATABASE_URL`, (re)crée la base `wm_test`. Puis : `bootstrap_local.sql` (sauf si le schéma `auth` existe déjà), toutes les `supabase/migrations/*.sql` par ordre lexical (en sautant `9000_*` si `pg_cron` est absent), `helpers.sql`. Sans `--setup-only` : chaque `supabase/tests/*.test.sql` dans `BEGIN … ROLLBACK` avec `ON_ERROR_STOP=1`, puis chaque `supabase/tests/*.test.sh` (avec `DATABASE_URL` exporté). Affiche `ok <fichier>` ou `FAIL <fichier>` ; code de sortie ≠ 0 au premier échec. Avec `--setup-only`, imprime `DATABASE_URL=…` et laisse le cluster tourner.
  - Bootstrap : rôles `anon`, `authenticated`, `service_role` (`nologin`, `service_role` avec `bypassrls`), `authenticator` (`login noinherit`, membre des trois) ; schéma `extensions` avec `pgcrypto` et `pg_trgm` ; schéma `auth` : table `auth.users(id uuid pk default gen_random_uuid(), email text, encrypted_password text, email_confirmed_at timestamptz, raw_user_meta_data jsonb not null default '{}', raw_app_meta_data jsonb not null default '{}', banned_until timestamptz, created_at timestamptz not null default now())`, fonctions `auth.uid()`, `auth.role()`, `auth.jwt()` lues dans `current_setting('request.jwt.claims', true)`.
  - Helpers (schéma `tests`, jamais en prod) : `tests.make_user(p_username text, p_balance int default 0) returns uuid` (insère `auth.users` puis `public.profiles`, `on conflict (id) do update`) ; `tests.login(p_uid uuid)` (`set_config('role','authenticated',true)` + claims `{sub, role:'authenticated'}`) ; `tests.logout()` (rôle `anon`, claims vides) ; `tests.as_service()` (rôle `service_role`) ; `tests.reset_role()` (`reset role`).

- [ ] **Step 1: Écrire le test** (`supabase/tests/00_bootstrap.test.sql`) :

```sql
do $$ begin
  assert (select count(*) from pg_roles where rolname in ('anon','authenticated','service_role','authenticator')) = 4;
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  assert auth.uid() = '00000000-0000-0000-0000-000000000001'::uuid;
  perform set_config('request.jwt.claims', '', true);
  assert auth.uid() is null;
end $$;
```

- [ ] **Step 2: Lancer, constater l'échec** — Run: `bash scripts/db-test.sh` · Expected: échec (script absent), puis après écriture du script seul : `FAIL 00_bootstrap.test.sql`.

- [ ] **Step 3: Implémenter `bootstrap_local.sql`, `helpers.sql`, `db-test.sh`.** (`helpers.sql` référence `public.profiles` : il n'est chargé que si cette table existe, `\if` psql sur une requête `to_regclass`.)

- [ ] **Step 4: Vérifier** — Run: `bash scripts/db-test.sh` · Expected: `ok 00_bootstrap.test.sql`, exit 0. Relancer une seconde fois : même résultat (le cluster est recréé proprement).

- [ ] **Step 5: Commit** — `git commit -m "test: banc SQL local (PG16 jetable, stub auth)"`

---

### Task 5: Migration `0001_mirror_core.sql` (tables du cœur)

**Files:**
- Create: `supabase/migrations/0001_mirror_core.sql`
- Test: `supabase/tests/01_mirror_core.test.sql`

**Interfaces:**
- Consumes: banc de la Task 4.
- Produces, dans `public` (noms et sémantique de R§4.2, D§6.2) :
  - enum `rarity` (`'C','PC','R','SR','UR','L'`, dans cet ordre) — création gardée par `do $$ … if not exists (select 1 from pg_type …)`.
  - `profiles(id uuid pk → auth.users(id) on delete cascade, username text not null, avatar_url text, avatar_user_card_id uuid, bio text check (char_length(bio) <= 280), is_public boolean not null default true, created_at timestamptz not null default now(), last_seen_at timestamptz, is_pro boolean not null default false, is_vip boolean not null default false, pack_cap int not null default 10, packs_remaining int not null default 1, packs_last_regen_at timestamptz, wikibidous_balance int not null default 0 check (wikibidous_balance >= 0), activity_blocked_until timestamptz, packs_blocked_until timestamptz)` ; index unique `profiles_username_lower_key on (lower(username))`. (`packs_remaining` = 1 : dotation de départ, D§7.1.)
  - `cards(id uuid pk default gen_random_uuid(), wikipedia_title text not null, wikipedia_url text not null, lang text not null default 'fr', rarity public.rarity not null, atk int not null, def int not null, q_score numeric(6,2), pageviews int not null default 0, pageviews_refreshed_at timestamptz, qscore_refreshed_at timestamptz, category text, summary text, image_url text, hide_image boolean not null default false, nsfw_image boolean not null default false, created_at timestamptz not null default now()) with (fillfactor = 90)` ; unique `(lang, wikipedia_title)`.
  - `user_cards(id uuid pk default gen_random_uuid(), user_id uuid not null → profiles on delete cascade, card_id uuid not null → cards, count int not null default 1 check (count >= 1), starred boolean not null default false, is_shiny boolean not null default false, snapshot_title text not null, snapshot_rarity public.rarity not null, snapshot_category text, snapshot_atk int not null, snapshot_def int not null, obtained_at timestamptz not null default now())` ; FK `profiles.avatar_user_card_id → user_cards(id) on delete set null` ajoutée après.
  - `tags(id uuid pk default gen_random_uuid(), user_id uuid not null → profiles on delete cascade, name text not null check (char_length(name) between 1 and 48), color text check (color ~ '^#[0-9a-fA-F]{6}$'), created_at timestamptz not null default now(), unique (user_id, name))`.
  - `user_card_tags(user_card_id uuid → user_cards on delete cascade, tag_id uuid → tags on delete cascade, primary key (user_card_id, tag_id))`.
  - `wishlist_items(user_id uuid → profiles on delete cascade, card_id uuid → cards on delete cascade, created_at timestamptz not null default now(), primary key (user_id, card_id))`.
  - Index de clés étrangères minimaux : `user_cards(user_id)`, `user_cards(card_id)`, `user_card_tags(tag_id)`, `tags(user_id)` (`if not exists`). Les index de performance viennent avec leurs domaines (D§9.4).
  - `grant all on <chaque table> to service_role` (les privilèges RLS des autres rôles sont à la Task 6).

- [ ] **Step 1: Écrire le test qui échoue** (`01_mirror_core.test.sql`) — un bloc `do` par règle, les erreurs attendues capturées par `exception when sqlstate '…'` :

```sql
do $$ begin assert enum_range(null::public.rarity)::text = '{C,PC,R,SR,UR,L}'; end $$;
do $$ declare a uuid := tests.make_user('Alice'); begin
  begin perform tests.make_user('alice'); assert false, 'pseudo en double accepté';
  exception when unique_violation then null; end;
end $$;
-- solde négatif refusé (23514), count = 0 refusé (23514), étiquette de 49 caractères refusée (23514),
-- couleur 'red' refusée (23514), (user_card_id, tag_id) en double refusé (23505),
-- wishlist (user_id, card_id) en double refusée (23505),
-- suppression d'une étiquette → ses user_card_tags disparaissent,
-- suppression d'une copie → ses user_card_tags disparaissent et profiles.avatar_user_card_id passe à null.
```
(Écrire chacun de ces cas sur le modèle ci-dessus, avec une carte et une copie de fixture insérées dans le bloc.)

- [ ] **Step 2: Lancer, constater l'échec** — Run: `bash scripts/db-test.sh` · Expected: `FAIL 01_mirror_core.test.sql`.

- [ ] **Step 3: Écrire la migration** (idempotente : `create table if not exists`, contraintes nommées ajoutées sous garde `if not exists` sur `pg_constraint`).

- [ ] **Step 4: Vérifier, deux fois** — Run: `bash scripts/db-test.sh && psql "$URL" -f supabase/migrations/0001_mirror_core.sql` (avec l'URL imprimée par `--setup-only`) · Expected: tous `ok` ; la seconde application ne lève aucune erreur (idempotence).

- [ ] **Step 5: Commit** — `git commit -m "feat(db): tables miroir du cœur (profils, cartes, copies, étiquettes, souhaits)"`

---

### Task 6: Migration `0002_mirror_rls.sql`

**Files:**
- Create: `supabase/migrations/0002_mirror_rls.sql`
- Test: `supabase/tests/02_mirror_rls.test.sql`

**Interfaces:**
- Consumes: tables de la Task 5, `tests.login/logout/as_service` (Task 4).
- Produces (surface PostgREST directe de l'original, R§7.1, D§5.3) :
  - RLS activée sur les 6 tables.
  - `profiles` : `select` de sa propre ligne (`id = auth.uid()`) ; aucun droit d'écriture client.
  - `cards` : `select` pour `authenticated` (`using (true)`).
  - `user_cards` : `select` et `update` de ses lignes ; `grant select, update (starred)` à `authenticated` (aucune autre colonne modifiable, aucun `insert`/`delete`).
  - `tags` : `select/insert/update/delete` de ses lignes ; `grant select, insert, update (name, color), delete`.
  - `user_card_tags` : `select/insert/delete` si la copie **et** l'étiquette appartiennent à `auth.uid()` ; `grant select, insert, delete`.
  - `wishlist_items` : `select/insert/delete` de ses lignes ; `grant select, insert, delete`.
  - `anon` : aucun privilège sur ces tables.
  - Politiques créées sous garde `if not exists` (`pg_policies`).

- [ ] **Step 1: Écrire le test qui échoue** — cas, chacun dans son bloc :
  - aucune table de `public` sans `relrowsecurity` (`select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity` = 0) ;
  - Bob connecté ne voit ni les copies, ni les étiquettes, ni les souhaits d'Alice (`count(*) = 0`) ;
  - Alice peut `update user_cards set starred = true` sur sa copie ; `update user_cards set count = 5` → `insufficient_privilege` (42501) ; `update profiles set wikibidous_balance = 999` → 42501 ;
  - Alice ne peut pas lier son étiquette à la copie de Bob (`insert` → violation RLS 42501) ;
  - `anon` : `select * from cards` → 42501 ;
  - `service_role` voit tout.

- [ ] **Step 2: Lancer, constater l'échec** — Run: `bash scripts/db-test.sh` · Expected: `FAIL 02_mirror_rls.test.sql`.

- [ ] **Step 3: Écrire la migration.**

- [ ] **Step 4: Vérifier** — Run: `bash scripts/db-test.sh` · Expected: tous `ok`.

- [ ] **Step 5: Commit** — `git commit -m "feat(db): RLS et privilèges de la surface PostgREST d'origine"`

---

### Task 7: Migration `1000_wm_core.sql` (erreurs, acteur, portefeuille, idempotence, santé)

**Files:**
- Create: `supabase/migrations/1000_wm_core.sql`
- Test: `supabase/tests/10_wm_core.test.sql`, `supabase/tests/11_wallet_concurrency.test.sh`

**Interfaces:**
- Consumes: `public.profiles` (Task 5).
- Produces (schéma `wm`, D§6.5, D§7.0, C5, C6, C29) :
  - `wm.config(key text pk, value jsonb not null, note text)`, ligne initiale `('maintenance', 'false', 'Drapeau opérationnel')`.
  - `wm.raise_err(p_status int, p_code text, p_message text, p_extra jsonb default '{}') returns void` : `raise exception using errcode = 'P0001', message = p_message, detail = (jsonb_strip_nulls(jsonb_build_object('status', p_status, 'code', p_code, 'error', p_message, 'message', p_message)) || p_extra)::text`.
  - `wm.staff(user_id uuid pk → public.profiles on delete cascade, role text not null check (role in ('admin','moderator')), created_at timestamptz not null default now())`.
  - `wm.sanctions(id bigint generated always as identity pk, user_id uuid not null → public.profiles on delete cascade, kind text not null check (kind in ('warning','restriction','suspension','ban')), reason text, starts_at timestamptz not null default now(), ends_at timestamptz, revoked_at timestamptz, created_by uuid, created_at timestamptz not null default now())`.
  - `wm.actor(p_uid uuid, p_scope text default 'any') returns jsonb` → `{is_pro, is_vip, is_staff, staff_role}` ; lit sans verrou ; erreurs : `config.maintenance` → `raise_err(503,'maintenance','Maintenance en cours, reviens dans quelques minutes.')` ; profil absent → `raise_err(401,'unauthorized','Session expirée, reconnecte-toi.')` ; sanction active de type `restriction|suspension|ban` (non révoquée, `starts_at <= now()`, `ends_at` null ou futur) ou `activity_blocked_until > now()` → `raise_err(403, null, 'Ton compte est temporairement restreint.', {activity_blocked_until})` ; `p_scope = 'packs'` et `packs_blocked_until > now()` → idem avec `{packs_blocked_until}`.
  - `wm.wb_ledger(id bigint identity pk, user_id uuid not null → public.profiles on delete cascade, delta int not null, reason text not null, ref text not null, balance_after int not null, created_at timestamptz not null default now(), unique (reason, ref, user_id))` ; index `(user_id, created_at desc)`.
  - `wm.wallet_apply(p_uid uuid, p_delta int, p_reason text, p_ref text) returns int` (nouveau solde) : si le joueur n'a encore aucune écriture, insère d'abord `('opening','opening', solde courant)` ; insère l'écriture `on conflict do nothing` — doublon → renvoie le solde courant sans rien changer ; sinon `update public.profiles set wikibidous_balance = wikibidous_balance + p_delta where id = p_uid and wikibidous_balance + p_delta >= 0 returning …` ; aucune ligne → `raise_err(409,'insufficient_balance','Solde insuffisant')` (la transaction annule aussi l'écriture). Le verrou du profil est pris par l'`update` (l'appelant l'a déjà pris selon C4 quand il y en a plusieurs).
  - `wm.idempotency_keys(user_id uuid not null, key text not null, response jsonb, created_at timestamptz not null default now(), primary key (user_id, key))`.
  - `wm.idem_claim(p_uid uuid, p_key text) returns jsonb` : clé `null` → renvoie `null` ; longueur hors 1..128 → `raise_err(400,'invalid_request','Idempotency-Key invalide (1 à 128 caractères).')` ; insertion `on conflict do nothing` ; insérée → `null` (exécuter l'action) ; sinon → la réponse stockée.
  - `wm.idem_store(p_uid uuid, p_key text, p_response jsonb) returns jsonb` : met à jour la ligne si `p_key` non nul ; renvoie `p_response`.
  - `wm.health() returns jsonb` → `{ok: true, db: 'ok', now}`.
  - `wm.check_invariants() returns jsonb` → tableau des violations (vide = OK) : `{check:'ledger_balance', user_id, balance, ledger_sum}` pour tout profil ayant des écritures dont `Σ delta ≠ wikibidous_balance` ; `{check:'negative_balance', user_id}`.
  - Privilèges : `revoke all on schema wm from public, anon, authenticated` ; `grant usage on schema wm to service_role` ; `revoke execute on all functions in schema wm from public, anon, authenticated` ; `grant execute on all functions in schema wm to service_role` ; `alter default privileges in schema wm revoke execute on functions from public`.

- [ ] **Step 1: Écrire les tests qui échouent** (`10_wm_core.test.sql`) :

```sql
do $$ declare d jsonb; begin
  perform wm.raise_err(409, 'bid_too_low', 'Mise trop basse (minimum 110 wikibidous)', '{"min":110}');
  assert false;
exception when sqlstate 'P0001' then
  get stacked diagnostics d = pg_exception_detail;  -- texte, converti ci-dessous
  assert (d::jsonb) = '{"status":409,"code":"bid_too_low","error":"Mise trop basse (minimum 110 wikibidous)","message":"Mise trop basse (minimum 110 wikibidous)","min":110}'::jsonb;
end $$;
```
(`d` est déclaré `text` en réalité ; adapter.) Autres cas :
  - `wm.actor` : maintenance → détail `status = 503`, `code = 'maintenance'` ; profil inconnu → 401 ; sanction `ban` active → 403 avec le message exact ; sanction révoquée ou `warning` → passe ; `packs_blocked_until` futur → 403 seulement avec `p_scope = 'packs'` ; renvoie `is_staff = true` pour un membre de `wm.staff`.
  - `wm.wallet_apply` : 100 + (`+5`, `'test'`, `'r1'`) → 105 ; même appel rejoué → 105 et une seule écriture `r1` ; `-200` → P0001 avec `code = 'insufficient_balance'`, solde inchangé, aucune écriture ; première écriture précédée d'une écriture `opening` de 100 ; `wm.check_invariants()` = `'[]'`.
  - `update public.profiles set wikibidous_balance = 1` hors de `wallet_apply` pour un joueur qui a des écritures → `check_invariants()` contient `ledger_balance`.
  - `wm.idem_claim` : première fois `null` ; après `idem_store(…, '{"ok":1}')`, renvoie `{"ok":1}` ; clé de 129 caractères → 400.
  - Privilèges : en rôle `authenticated`, `select wm.health()` → 42501 ; en `service_role`, OK.

`11_wallet_concurrency.test.sh` : crée un joueur à 100 WB (transaction validée), lance **en parallèle** 20 `psql -c "select wm.wallet_apply('<uid>', -10, 'test', 'd<i>')"` et 20 `… 5, 'test', 'dup'` ; attend ; vérifie solde = 5, exactement 10 débits réussis, une seule écriture `dup`, `wm.check_invariants() = '[]'` ; supprime le joueur. Les échecs attendus `insufficient_balance` ne font pas échouer le test.

- [ ] **Step 2: Lancer, constater l'échec** — Run: `bash scripts/db-test.sh` · Expected: `FAIL 10_wm_core.test.sql`.

- [ ] **Step 3: Écrire la migration** (fonctions en `create or replace`, tables `if not exists`, insert de config `on conflict do nothing`).

- [ ] **Step 4: Vérifier** — Run: `bash scripts/db-test.sh` · Expected: tous `ok`, y compris `11_wallet_concurrency.test.sh`.

- [ ] **Step 5: Commit** — `git commit -m "feat(db): schéma wm (erreurs, acteur, portefeuille, idempotence, santé)"`

---

### Task 8: Clients Supabase, `route()` et `/api/health`

**Files:**
- Create: `lib/supabase/server.ts`, `lib/supabase/browser.ts`, `lib/supabase/admin.ts`, `lib/tz.ts`, `lib/route.ts`, `app/api/health/route.ts`
- Test: `lib/tz.test.ts`, `lib/route.test.ts`

**Interfaces:**
- Consumes: `wm.health()` et la convention d'erreur `P0001` (Task 7).
- Produces:
  - `createClient(): Promise<SupabaseClient>` (serveur, cookies `getAll`/`setAll` en try/catch, `cookieOptions.name = process.env.NEXT_PUBLIC_AUTH_COOKIE_NAME` si défini) ; `createBrowserSupabase(): SupabaseClient` (singleton) ; `createAdminClient(): SupabaseClient` (`import 'server-only'`, `SUPABASE_SECRET_KEY`, `persistSession: false`, `autoRefreshToken: false`).
  - `resolveTz(header: string | null): string` (IANA valide via `Intl.DateTimeFormat`, ≤ 64 caractères, sinon `'Europe/Paris'`).
  - `type RouteCtx = { uid: string | null; tz: string; idem: string | null; params: Record<string, string> }`.
  - `route<I = undefined>(opts: { fn: string; auth?: boolean /* défaut true */; input?: z.ZodType<I>; args?: (input: I, ctx: RouteCtx) => Record<string, unknown> }): (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>`. Arguments RPC par défaut : `auth ? { p_uid: uid } : {}`. Entrée : query string pour `GET`/`DELETE` sans corps, JSON sinon ; corps illisible → 400 « Corps JSON invalide ». Messages zod en français (`z.config(z.locales.fr())`), premier problème → `{ code: 'invalid_request', error, message }`.
  - `toHttpError(err: { code?: string; message?: string; details?: string | null }): { status: number; body: Record<string, unknown>; retryAfter?: number }`.
  - Constantes : `UNAUTHORIZED = 'Session expirée, reconnecte-toi.'`, `BUSY = 'Le site est très sollicité, réessaie dans un instant.'`, `INTERNAL = 'Erreur interne, réessaie dans un instant.'`.
  - Une ligne de log JSON par requête : `{ route, status, ms, rpc, pg_code, uid_hash, vercel_id }` (`uid_hash` = 12 premiers hex de SHA-256 de l'uid).

- [ ] **Step 1: Écrire les tests qui échouent** — `lib/tz.test.ts` : `'America/Montreal'` → lui-même ; `'../../etc/passwd'`, `'Mars/Phobos'`, `''`, `null`, 65 caractères → `'Europe/Paris'`. `lib/route.test.ts` (modules Supabase mockés par `vi.mock`) :
  1. sans claims → 401 `{ code: 'unauthorized', error: UNAUTHORIZED, message: UNAUTHORIZED }`, RPC non appelée ;
  2. claims `sub: 'u1'` → `rpc('fn', { p_uid: 'u1' })` sur `schema('wm')`, 200 avec `data` ;
  3. `input` zod en échec → 400 `code: 'invalid_request'`, message non vide en français, RPC non appelée ;
  4. erreur `{ code: 'P0001', details: '{"status":409,"code":"bid_too_low","min":110,"error":"m","message":"m"}' }` → 409, corps sans clé `status` ;
  5. `P0001` avec `{"status":429,"retry_after":3,…}` → en-tête `Retry-After: 3` ;
  6. `code: '55P03'` puis `'57014'` → 503 `{ code: 'BUSY', error: BUSY }`, `Retry-After: 1` ;
  7. `code: 'XX000', message: 'relation secrète'` et `P0001` à détail non JSON → 500 `INTERNAL`, le corps ne contient pas `relation` ;
  8. `x-wiki-calendar-tz` invalide → `ctx.tz === 'Europe/Paris'` (vérifié via `args`) ;
  9. `Idempotency-Key` de 129 caractères → 400 ;
  10. `auth: false` → `getClaims` jamais appelé.

- [ ] **Step 2: Lancer, constater l'échec** — Run: `npx vitest run lib/tz.test.ts lib/route.test.ts` · Expected: FAIL.

- [ ] **Step 3: Implémenter** les fichiers ci-dessus ; `app/api/health/route.ts` : `export const GET = route({ fn: 'health', auth: false })`.

- [ ] **Step 4: Vérifier** — Run: `npx vitest run && npm run typecheck && npm run lint` · Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: route(), clients Supabase et /api/health"`

---

### Task 9: Banc de contrat HTTP et rapport de couverture du recap

**Files:**
- Create: `scripts/get-postgrest.sh`, `contract/jwt.ts`, `contract/harness.ts`, `contract/serve.ts`, `contract/global-setup.ts`, `vitest.contract.config.ts`, `lib/contract.ts`, `contract/spec/index.ts`, `contract/spec/health.ts`, `contract/spec/gate.ts`, `contract/run.test.ts`, `contract/recap-coverage.ts`
- Test: `contract/recap-coverage.test.ts` (+ les specs ci-dessus)

**Interfaces:**
- Consumes: `scripts/db-test.sh --setup-only` (Task 4), le build (Tasks 1–8), `GATE_COOKIE`, `gateToken` (Task 3). Les fichiers de `contract/` lancés par `node` s'importent entre eux en chemins relatifs avec extension `.ts` (pas d'alias `@/`).
- Produces:
  - `scripts/get-postgrest.sh` : télécharge `postgrest-v12.2.3-linux-static-x64.tar.xz` dans `.cache/postgrest/`, vérifie un SHA-256 **épinglé dans le script** (le calculer au premier téléchargement et l'inscrire), idempotent.
  - `contract/jwt.ts` : `generateKeys(): { privateJwk: JsonWebKey; publicJwk: JsonWebKey }` (ES256, `kid` fixe) ; `signJwt(privateJwk: JsonWebKey, claims: Record<string, unknown>): string` (`node:crypto`, `dsaEncoding: 'ieee-p1363'`, aucune dépendance) ; `sessionCookie(supabaseUrl: string, accessToken: string, uid: string): { name: string; value: string }` — nom `sb-<1er label de l'hôte>-auth-token` (comme `@supabase/ssr` par défaut), valeur `base64-` + base64url du JSON de session (`access_token`, `refresh_token`, `expires_at`, `expires_in`, `token_type: 'bearer'`, `user: { id }`).
  - `startBackend(): Promise<Backend>` avec `Backend = { supabaseUrl: 'http://127.0.0.1:54321'; databaseUrl: string; privateJwk: JsonWebKey; stop(): Promise<void> }` : base via `db-test.sh --setup-only` (ou `DATABASE_URL`) ; PostgREST sur `54322` (`db-schemas = "public,wm"`, `db-anon-role = "anon"`, `jwt-secret` = JWKS JSON, `db-uri` en rôle `authenticator`) ; passerelle `node:http` sur `54321` qui sert `/auth/v1/.well-known/jwks.json` et relaie `/rest/v1/*` vers PostgREST en **imitant la passerelle Supabase des nouvelles clés** : `Authorization: Bearer sb_publishable_test` → JWT `anon`, `Bearer sb_secret_test` → JWT `service_role`, tout autre bearer transmis tel quel. Écrit `.cache/backend.json` (`supabaseUrl`, `databaseUrl`, `privateJwk`) pour les fixtures E2E.
  - `startNext(name: 'plain' | 'gated', backend: Backend): Promise<{ baseUrl: string; stop(): Promise<void> }>` : `next start` sur `3100` (`plain`) ou `3101` (`gated`, avec `DEMO_GATE_PASSWORD = 'test-gate'` et `GATE_COOKIE_SECRET = 'test-secret'`), `SUPABASE_SECRET_KEY = 'sb_secret_test'`.
  - Le build (`npm run build`) est fait **une fois**, avant, avec `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321` et `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_test` : les variables `NEXT_PUBLIC_*` sont figées au build, d'où les ports et clés fixes. Script npm `build:test` pour ce build.
  - `contract/serve.ts` (exécutable par `node`) : démarre le backend et les deux serveurs Next, puis reste au premier plan (utilisé par Playwright `webServer`).
  - `type RouteSpec = { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string /* paramètres en {nom} */; source: string /* ex. '§3.5 · S 2926-2940' ou 'D§8.3' */; confidence: 'conf.' | 'prob.' | 'inc.' | 'ajouté'; cases: Array<{ name: string; run: (env: { plain: string; gated: string; backend: Backend }) => Promise<void> }> }` et `routeKey(method: string, path: string): string` (`'GET /api/profile/{}/collection'` : paramètres normalisés en `{}`, query retirée).
  - `parseRecapRoutes(md: string): Array<{ method: string; path: string; section: string }>` : lit les lignes de tableau de R§3 dont la 1ʳᵉ cellule est une liste de méthodes séparées par `/` ; chaque segment entre accents graves qui commence par `/api/` ou `rest/v1/` est un chemin complet ; un segment qui commence par `/` sans `/api` est relatif au dossier du chemin complet précédent ; les chemins `…/auth/v1/…` sont ignorés (GoTrue, hors contrat) ; query retirée ; dédoublonnage par `routeKey`.
  - `contract/recap-coverage.ts` (exécutable par `node`) : imprime `Recap : N routes · couvertes : M · manquantes :` puis la liste ; code de sortie 0 jusqu'au M6 (rapport), à rendre bloquant au M7.

- [ ] **Step 1: Écrire les tests qui échouent** — `contract/recap-coverage.test.ts` :

```ts
const md = `
## 3. Contrat
| GET / POST / DELETE | \`rest/v1/wishlist_items\` | — |
| POST | \`/api/guilds/invite\`, \`/kick\`, \`/transfer-leadership\` | x |
| GET | \`/api/marketplace?mine=1\` | x |
| GET | \`/api/marketplace\` | x |
| GET | \`rest/v1/achievements?select=*\` et \`rest/v1/user_achievements?select=a&user_id=eq.<me>\` | x |
| POST | \`https://<ref>.supabase.co/auth/v1/token?grant_type=password\` | x |
## 4. Modèle`
expect(parseRecapRoutes(md).map(r => routeKey(r.method, r.path))).toEqual([
  'GET rest/v1/wishlist_items', 'POST rest/v1/wishlist_items', 'DELETE rest/v1/wishlist_items',
  'POST /api/guilds/invite', 'POST /api/guilds/kick', 'POST /api/guilds/transfer-leadership',
  'GET /api/marketplace',
  'GET rest/v1/achievements', 'GET rest/v1/user_achievements',
])
it('le vrai recap', () => {
  const keys = parseRecapRoutes(readFileSync('docs/rea-recap.md', 'utf8')).map(r => routeKey(r.method, r.path))
  expect(keys).toContain('POST /api/packs/open')
  expect(keys).toContain('PATCH /api/battles/{}')
  expect(keys).toContain('GET /api/guilds/leaderboard')
  expect(keys.some(k => k.includes('auth/v1'))).toBe(false)
  expect(keys.length).toBeGreaterThanOrEqual(70)
})
```
  `contract/spec/health.ts` : `GET /api/health` → 200, corps `{ ok: true, db: 'ok' }` (schéma zod strict sur ces clés, clés en plus permises). `contract/spec/gate.ts` (serveur `gated`) : `GET /` sans cookie → 307 vers `/gate?next=%2F` ; `GET /api/marketplace` sans cookie → 401 JSON `error: 'Accès réservé'` ; `GET /api/health` sans cookie → 200 ; toute réponse porte `X-Robots-Tag: noindex, nofollow, noarchive` ; `GET /robots.txt` contient `Disallow: /` ; avec le cookie `wm_gate` valide et sans session, `GET /collection` → 307 vers `/login?next=%2Fcollection` ; `GET /pull` → 308 vers `/pulls`. `contract/run.test.ts` itère sur `contract/spec/index.ts`.

- [ ] **Step 2: Lancer, constater l'échec** — Run: `npx vitest run contract/recap-coverage.test.ts` · Expected: FAIL.

- [ ] **Step 3: Implémenter** dans l'ordre : `get-postgrest.sh`, `lib/contract.ts`, `recap-coverage.ts`, `jwt.ts`, `harness.ts`, `serve.ts`, `global-setup.ts` (backend + deux serveurs Next, URLs et clé exposées aux tests par `provide`/`inject`), specs, `run.test.ts`. Délais vitest du contrat : 120 s au démarrage, 15 s par cas.

- [ ] **Step 4: Vérifier** — Run: `bash scripts/get-postgrest.sh && npm run build:test && npm run test:contract && npm run coverage:recap` · Expected: specs PASS ; le rapport liste N ≥ 70 routes du recap avec M = 0 couvertes (seules `health` et la porte existent, hors recap) et sort en 0.

- [ ] **Step 5: Commit** — `git commit -m "test: banc de contrat HTTP (PostgREST + JWKS) et couverture du recap"`

---

### Task 10: Shell de l'application, pages d'attente, E2E et a11y

**Files:**
- Create: `components/shell/nav.ts`, `components/shell/Logo.tsx`, `components/shell/Sidebar.tsx`, `components/shell/BottomBar.tsx`, `components/shell/Bell.tsx`, `components/shell/PageHeader.tsx`, `app/(game)/layout.tsx`, une `page.tsx` par entrée de `NAV` sous `app/(game)/`, `app/(public)/page.tsx` (et suppression de `app/page.tsx` du gabarit, qui entrerait en conflit sur `/`), `app/(public)/login/page.tsx`, `playwright.config.ts`, `e2e/fixtures.ts`
- Test: `e2e/shell.spec.ts`, `e2e/a11y.spec.ts`

**Interfaces:**
- Consumes: `brand`, `pageTitle` (Task 1) ; jetons (Task 2) ; `contract/serve.ts`, `signJwt`, `sessionCookie`, `.cache/backend.json` (Task 9).
- Produces:
  - `NAV: readonly { href: string; label: string; icon: LucideIcon; title: string }[]` dans l'ordre exact de R§2.2 : Paquets `/pulls` (`Puzzle`), Collection `/collection` (`BookOpen`), Échanges `/trades` (`Handshake`), Marché `/marketplace` (`Gavel`), Profil `/profile` (`User`), Toutes les cartes `/global-collection` (`Globe`), Guilde `/guild` (`Castle`), Amis `/friends` (`Users`), Messages `/dms` (`MessageCircle`), Bataille `/battle` (`Swords`), Succès `/achievements` (`Trophy`), Classement `/leaderboard` (`Medal`), Paramètres `/settings` (`Settings`). `title` = libellé, sauf `/global-collection` → « Collection Globale ».
  - `MOBILE_NAV` = les quatre premiers + bouton « Plus » qui ouvre une feuille (`role="dialog"`, `aria-modal`, piège de focus, Échap) contenant les neuf autres.
  - `PageHeader({ title, icon }): JSX` reprenant R§6.3 (`div.flex.items-start.justify-between.gap-4.animate-fade-in-up > h1.text-2xl.md:text-3xl.font-bold.inline-flex.items-center.gap-2`).
  - DOM du shell selon R§6.3 et D§8.5 : `body > div.flex.h-dvh`, `nav.hidden.w-64…md:flex`, `main.min-h-0.flex-1.overflow-y-auto`, lien actif avec `aria-current="page"` et les classes accent ; `button.relative.p-2.rounded-xl[aria-label="Notifications"]` (badge « 9+ » au-delà de 9, sans données au M0) ; barre basse avec `pb-[calc(6px+env(safe-area-inset-bottom,0px))]`.
  - Pages d'attente : `PageHeader` + un état vide « Cette section arrive bientôt. » (remplacé à son jalon). `/login` : titre « Connexion — {marque} », texte d'attente (le formulaire arrive au M1). `/` : logo, une phrase d'accroche **écrite par nous** (ne pas reprendre le texte de l'original), liens « Se connecter » (`/login`) et « Créer un compte » (`/signup`, page créée au M1 ; lien présent dès maintenant).

- [ ] **Step 1: Écrire les tests qui échouent** — `playwright.config.ts` : `webServer: { command: 'node contract/serve.ts', url: 'http://127.0.0.1:3100/api/health', reuseExistingServer: !process.env.CI, timeout: 120_000 }` ; `use.baseURL = 'http://127.0.0.1:3100'` (les tests de la porte visent `http://127.0.0.1:3101`) ; `launchOptions.executablePath = process.env.PW_CHROMIUM_PATH` (bac à sable : `/opt/pw-browsers/chromium-*/chrome-linux/chrome`). `e2e/shell.spec.ts` :

```ts
test('barre latérale : 13 entrées dans l\'ordre', async ({ page, login }) => {
  await login('00000000-0000-0000-0000-0000000000a1'); await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/pulls')
  const links = page.locator('nav.hidden a[href^="/"]').filter({ hasNotText: /^$/ })
  await expect(links).toHaveText(['Paquets','Collection','Échanges','Marché','Profil','Toutes les cartes','Guilde','Amis','Messages','Bataille','Succès','Classement','Paramètres'])
  await expect(page.locator('nav.hidden a[aria-current="page"]')).toHaveText('Paquets')
  await expect(page.locator('button[aria-label="Notifications"]').first()).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
})
test('mobile : 4 entrées + Plus', async ({ page, login }) => { /* 390×844 : Paquets, Collection, Échanges, Marché visibles ; « Plus » ouvre un dialog avec les 9 autres ; Échap le ferme et rend le focus au bouton */ })
test.describe('chaque page a son h1', () => { /* pour chaque NAV : goto(href) → h1 a le texte `title` */ })
```
  (Le logo du shell contient aussi un `h1` : cibler le `h1` de `main`.) `e2e/a11y.spec.ts` : `/`, `/login`, `/gate` (pile avec porte), `/pulls`, `/collection` → `new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag22aa']).analyze()` sans violation `serious` ni `critical`. Fixture `login(uid)` (`e2e/fixtures.ts`) : lit `.cache/backend.json`, crée l'utilisateur par `psql <databaseUrl> -c "select tests.make_user(…)"` (`execFileSync`), signe un JWT `authenticated` (`sub` = uid, `exp` = +1 h) et pose `sessionCookie(...)` dans le contexte du navigateur.

- [ ] **Step 2: Lancer, constater l'échec** — Run: `npm run build:test && npm run test:e2e` · Expected: FAIL (shell absent).

- [ ] **Step 3: Implémenter** les composants et pages (Server Components ; seuls `BottomBar` et la feuille « Plus » sont `'use client'`). Icônes `lucide-react` en `size-6` accent dans les en-têtes, lien logo vers `/pulls`.

- [ ] **Step 4: Vérifier** — Run: `npm run build:test && npm run test:e2e && npm run test:contract` · Expected: PASS (le contrat de la Task 9 reste vert).

- [ ] **Step 5: Finition** — passe `impeccable:impeccable` (mode critique/polish) sur le shell, sans toucher aux classes et attributs exigés ; relancer `npm run test:e2e`.

- [ ] **Step 6: Commit** — `git commit -m "feat: shell (barre latérale, barre basse, cloche), pages d'attente, E2E et a11y"`

---

### Task 11: Intégration continue

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/health.yml`

**Interfaces:**
- Consumes: scripts npm (Task 1), `db-test.sh` (Task 4), `get-postgrest.sh` (Task 9).

- [ ] **Step 1: `ci.yml`** — déclencheurs `push`, `pull_request`, `workflow_dispatch` ; `concurrency` par ref avec annulation. Job `checks` (ubuntu-24.04, `actions/setup-node` Node 24, cache npm) : `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run coverage:recap`. Job `integration` (`needs: checks`) : service `postgres:17` (`POSTGRES_PASSWORD: postgres`, health-check `pg_isready`), `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres` ; `npm ci`, `bash scripts/get-postgrest.sh`, `npm run test:db`, `npm run build:test`, `npm run test:contract`, `npx playwright install --with-deps chromium`, `npm run test:e2e` ; artefact `playwright-report` en cas d'échec. Délai max 20 min par job (C31 : budget Actions).

- [ ] **Step 2: `health.yml`** — `schedule: '17 6 * * *'` + `workflow_dispatch` ; `permissions: issues: write` ; `curl -fsS --max-time 30 "$DEMO_URL/api/health"` où `DEMO_URL` est écrit en clair dans le fichier (rempli à la Task 13 ; la route est publique et ne révèle rien) ; en cas d'échec, `gh issue create` ou commentaire sur l'issue ouverte titrée « Santé de la démo en échec ». Effet secondaire voulu : garder le projet Supabase Free éveillé (C25).

- [ ] **Step 3: Vérifier** — pousser la branche ; via le MCP GitHub (`actions_list`, `get_job_logs`), constater les deux jobs de `ci.yml` verts. En cas d'échec, diagnostiquer (superpowers:systematic-debugging) et corriger avant de continuer.

- [ ] **Step 4: Commit** — `git commit -m "ci: vérifications, intégration (PG17, PostgREST, Playwright) et santé quotidienne"`

---

### Task 12: Projet Supabase (migrations, schéma exposé, conseillers)

**Files:**
- Modify: `supabase/migrations/1000_wm_core.sql` (seulement si une correction s'impose)
- Create: `docs/verifications.md` (journal, complété à la Task 14)

- [ ] **Step 1: Appliquer les migrations** sur le projet « WMR » `iggurckxmoagsajzrnwd` via le MCP Supabase `apply_migration`, une par fichier, avec pour nom le nom de fichier sans extension (`0001_mirror_core`, `0002_mirror_rls`, `1000_wm_core`) pour pouvoir plus tard aligner `supabase migration repair` sur ces versions.

- [ ] **Step 2: Exposer `wm` à PostgREST** — via `execute_sql` : `alter role authenticator set pgrst.db_schemas = 'public, graphql_public, wm'; notify pgrst, 'reload config';`. La preuve viendra de `/api/health` en Task 13 ; si elle échoue avec `PGRST106` (schéma non exposé), **étape humaine** : l'utilisateur ajoute `wm` dans Supabase → Settings → API → Exposed schemas.

- [ ] **Step 3: Vérifier les privilèges** via `execute_sql` : `select has_table_privilege('authenticated','public.tags','insert'), has_table_privilege('anon','public.cards','select'), has_function_privilege('authenticated','wm.health()','execute'), has_function_privilege('service_role','wm.health()','execute')` → `t, f, f, t`.

- [ ] **Step 4: Conseillers** — `get_advisors` (`security` puis `performance`) ; corriger toute alerte `ERROR` par une nouvelle migration (TDD, banc local d'abord) ; consigner les `WARN` acceptés et leur raison dans `docs/verifications.md`.

- [ ] **Step 5: Commit** — `git commit -m "chore(db): migrations M0 appliquées au projet de démo"` (journal + corrections éventuelles).

---

### Task 13: Déploiement Vercel protégé

**Files:**
- Create: `vercel.json`
- Modify: `.github/workflows/health.yml` (URL de la démo)

- [ ] **Step 1: `vercel.json`** — `{ "regions": ["dub1"] }` (Dublin, à côté de la base en eu-west-1).

- [ ] **Step 2: Projet Vercel existant** — l'utilisateur a créé le projet `wmr` (`prj_bNmEEgvcwM6Mhb8jC8QWNUbLukiz`, équipe IVM `team_nXdYy8ZVSzoNaYlzG7a1whey`, Node 24). Via le MCP Vercel `get_project` : relever le dépôt lié et la branche de production, et les consigner dans `docs/verifications.md`. Si le projet n'est pas lié à `IVM-Projects/wm-remake`, ou si Vercel refuse nos commits (règle Hobby sur l'auteur des commits d'un dépôt privé, C32), **étape humaine** : l'utilisateur lie le dépôt depuis le tableau de bord ; sinon déploiement par le MCP. La Vercel Authentication reste active sur les déploiements (hors domaines personnalisés) : la démo publique passe par `https://wmr-ivm.vercel.app`, protégée par notre porte.

- [ ] **Step 3: Variables d'environnement** (production et preview) via `create_project_env` :
  - `NEXT_PUBLIC_SUPABASE_URL` (MCP Supabase `get_project_url`) et `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`get_publishable_keys`, clé `sb_publishable_…`) ;
  - `DEMO_GATE_PASSWORD` (`openssl rand -base64 18`) et `GATE_COOKIE_SECRET` (`openssl rand -hex 32`), en type *sensitive* ; le mot de passe est transmis à l'utilisateur dans la réponse finale, jamais commité ;
  - `SUPABASE_SECRET_KEY` : **étape humaine** (le MCP ne lit pas les clés secrètes) — l'utilisateur copie la clé `sb_secret_…` depuis Supabase → Settings → API Keys vers Vercel, type *sensitive* ;
  - `NEXT_PUBLIC_BRAND_NAME` non défini (marque provisoire `WikiCartes`).

- [ ] **Step 4: Déployer et vérifier depuis l'extérieur** — déclencher un déploiement de la branche (push ou MCP) puis, après fusion dans la branche de production, de `https://wmr-ivm.vercel.app` ; suivre `get_deployment` / `list_deployment_events` jusqu'à `READY`. Puis, via `web_fetch_vercel_url` (qui traverse la protection Vercel des previews) :
  - `/api/health` → 200 `{"ok":true,"db":"ok",…}` (prouve clé secrète, schéma `wm` exposé et privilèges) ;
  - `/` → redirection vers `/gate?next=%2F`, en-tête `X-Robots-Tag: noindex, nofollow, noarchive` ;
  - `/robots.txt` → `Disallow: /`.
  En cas d'échec : `get_runtime_logs`, diagnostic, correction, nouveau déploiement.

- [ ] **Step 5: URL de santé** — écrire `https://wmr-ivm.vercel.app` dans `health.yml` (domaine personnalisé, donc hors Vercel Authentication ; `/api/health` est exemptée de la porte) ; commit `git commit -am "chore: déploiement Vercel protégé (dub1) et URL de santé"`.

---

### Task 14: Journal des vérifications et Graphify

**Files:**
- Modify: `docs/verifications.md`

- [ ] **Step 1: Vérifications du design (D§13, M0)**, chacune consignée (élément, méthode, résultat, date) :
  1. Next 16.4.2 : nom d'export et runtime de `proxy.ts` (prouvé par la Task 9) ; `cacheComponents` actif ; `'use cache: remote'` utilisable dans un route handler et signature de `revalidateTag(tag, profile)` (lire `node_modules/next/dist/server/web/spec-extension/revalidate.d.ts` et les types de `use cache`) ;
  2. Vercel Hobby : règle WAF `rate_limit`, `@vercel/firewall` `checkRateLimit`, Runtime Cache (MCP `search_vercel_documentation`) ;
  3. image Docker `diegosouzapw/omniroute:3.8.51` (releases GitHub du projet) ;
  4. binaire PostgREST v12.2.3 et son SHA-256 (Task 9) ;
  5. règle des `GRANT` explicites et exposition de `wm` (Tasks 12–13) ;
  6. clés JWT asymétriques du projet : **reportée au M1** (inspection de l'en-tête `alg` d'une vraie session) ;
  7. TypeScript 6.0.3 avec `next build` (OK si la Task 1 passe) et statut de TS 7 pour Next.
- [ ] **Step 2: Graphify** — `remember` (espace de travail courant) : les décisions C1 à C34 en une note chacune (titre court + pourquoi), l'écart « tables miroir par domaine », et les résultats ci-dessus. **Étape humaine** signalée dans la réponse finale : ajouter `ilan9903/wikimaster` à l'espace Graphify pour l'indexation (aucun outil MCP ne l'enregistre).
- [ ] **Step 3: Commit** — `git commit -am "docs: journal des vérifications du M0"` ; pousser ; constater la CI verte.

---

## Done when (critère du M0, D§13)

CI verte sur la branche ; migrations appliquées sur PG16 local, sur `postgres:17` en CI et sur le projet Supabase ; démo déployée en `dub1`, derrière la porte et en noindex, avec `/api/health` à 200 ; test fail-closed vert ; rapport de couverture listant toutes les routes de R§3 ; vérifications consignées dans `docs/verifications.md` et dans Graphify.
