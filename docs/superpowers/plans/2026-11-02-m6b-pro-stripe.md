# M6b — Abonnement Pro, boutique, Stripe (Checkout, Portail, webhook), dérivation de Pro, dettes du suivi : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fermer la ligne M6 de D:1085 avec sa part M6b (M6a-1) : un joueur achète 2 500 wikibidous ou s'abonne à Pro depuis une modale boutique, paie sur la page Checkout hébergée de Stripe en mode test (CAD), et le webhook signé fait le reste en **une** transaction SQL (`wm.stripe_apply`) : crédit unique (réf. `stripe:<session_id>`), état de l'abonnement copié de l'instantané, `profiles.is_pro` dérivé de `status in ('active', 'trialing')`, notifications de la cloche, litiges en file staff. Le joueur gère et résilie dans le Portail client ; la suppression de compte résilie l'abonnement avant GoTrue et signale tout échec au staff. Critères de D:1085 pris ici : « avec une carte de test, le compte devient Pro et a tous ses avantages » et « webhook rejoué sans effet ». S'y ajoutent les dettes S:75, S:76, S:77, S:80 (UI), S:82, S:84 du suivi (G17 du M6a) et le point d'accroche de `lib/admin-auth.ts:64`.

**Architecture:**
- Tout l'état Stripe vit dans `wm` (jamais exposé) : `stripe_events` (dédoublonnage par PK), `stripe_customers`, `subscriptions`, `purchases`, `stripe_disputes`, plus `deleted_accounts.stripe_pending`. Migrations `2300` (socle et lectures), `2310` (`stripe_apply`), `2320` (invariants, export, tableau de bord, résiliation) ; aucun cron, aucun miroir, aucune table publique neuve.
- Trois routes : `POST /api/stripe/checkout` et `POST /api/stripe/portal` passent par `route()` (une RPC de préparation sous `wm.actor`, puis l'appel Stripe dans une enveloppe `call`) ; `POST /api/stripe/webhook` est un handler Node **hors** `route()` (corps brut, `constructEvent`, une RPC). Une lecture `GET /api/shop` (`wm.shop_state`) sert la boutique, l'en-tête, `/settings` et « Comment ça marche ? ».
- Le SDK `stripe@23.1.0` est enfermé dans `lib/stripe.ts` (serveur seulement) ; au banc, `STRIPE_API_URL` le pointe vers un faux Stripe servi par la passerelle de `contract/harness.ts` (même patron que `TURNSTILE_VERIFY_URL`). Les événements de test sont des fixtures signées par `Stripe.webhooks.generateTestHeaderString` ; l'acceptation réelle (cartes de test, horloges de test) est jouée par l'utilisateur sur la démo.
- UI : un `ShopProvider` dans la coquille `(game)` (état partagé, ouverture de la modale), le solde et la pastille PRO dans l'en-tête, la modale `ShopDialog`, les liens « Voir l'abonnement » des fonctions verrouillées, la section « Abonnement » de `/settings`, deux tuiles et une action « Résilier » au tableau de bord admin.

**Tech Stack:** celle du M6a (next 16.4.2, react 19.3.1, @supabase/supabase-js 2.118.0, zod 4.6.7, vitest 5.0.5, @playwright/test 1.64.1, @axe-core/playwright 4.14.0, PostgREST v12.2.3, GoTrue v2.197.0, PostgreSQL 17.11 sur la démo), plus **`stripe` 23.1.0** épinglé exactement (API `2026-10-28.endive`, aucune dépendance transitive), seule dépendance npm ajoutée. Aucun job pg_cron, aucun LLM.

**Spec:** `docs/superpowers/specs/2026-10-18-*-rebuild-design.md` (un seul fichier y répond ; nom non recopié, dépôt public), cité D:ligne : D:616-632 (§7.11), D:1085, D:102-104 (§3.4), D:131 (C6), D:146 (C21), D:152 (C27), D:259, D:269, D:329-330, D:381, D:629, D:681, D:692, D:738, D:741, D:1039, D:1053. Le récap `docs/rea-recap.md` est cité R:ligne (R:46, R:123, R:139, R:487, R:564-574, R:721). Le plan du M6a est cité P6a:ligne, `docs/decisions-graphify.md` DG:ligne, `docs/suivi.md` S:ligne (numérotation d'avant le M6a, comme DG:1099), `docs/superpowers/HANDOFF.md` H:ligne. Les rulings du contrôleur (B1 à B26, 2026-11-02) et les cinq rapports de repérage du M6b ne sont pas versionnés : ce plan recopie chaque valeur dont une tâche a besoin (G1 à G26 = B1 à B26).

## Global Constraints

- **Toutes les contraintes globales des plans M0 à M6a restent en vigueur** (P6a:20-44) :
  - versions exactes, épingles sans `^` ; lire le guide de `node_modules/next/dist/docs/` avant de toucher une API Next (`AGENTS.md`), et en plus pour le M6b : `01-app/03-api-reference/03-file-conventions/route.md` (corps brut d'un Route Handler, `request.text()`, runtime Node par défaut) ;
  - fonctions `wm.*` en `security definer` et `set search_path = ''`, sans autre entrée dans `proconfig`, `EXECUTE` à `service_role` seul ; chaque migration `wm` finit par les cinq lignes `revoke`/`grant` de `1000_wm_core.sql:173-177` (vérifiées par `10_wm_core.test.sql:143-160`) ; aucune exception, la fonction de trigger comprise ;
  - migrations idempotentes et rejouables deux fois, expand-only, PG16 et PG17 ; tables avant toute fonction `language sql` ; en-tête `ADDITIVE` et ligne pg-safeupdate de `2060:1-3` ;
  - une fonction redéfinie garde sa signature et sa réponse (clés en plus permises) et reprend **le corps entier** de sa dernière définition, plus ses ajouts, en-tête « même signature, même corps et même réponse qu'en XXXX (déployée, non retouchée), plus … ». **Redéfinies au M6b, toutes en `2320`** (dernières définitions vérifiées par `grep` le 2026-11-02 sur 4c032f6) : `wm.check_invariants` (`2250_wm_account_delete.sql:93-205`, `language sql`), `wm.account_export` (`2260_wm_account_export.sql:9`), `wm.staff_dashboard` (`2240_wm_guild_moderation.sql:131`, seule définition, `language plpgsql stable`) ; l'en-tête de chaque fonction (langage, volatilité) est repris tel quel. Aucune des trois ne porte de réglage dans `proconfig` (vérifié : aucun `set statement_timeout`/`set lock_timeout` de fonction dans `22xx`) ; une redéfinition qui en rencontrerait un le redit (leçon de `1960`) ;
  - **rejeux dans les tests** (M5b-18) : tout test qui `\ir` une migration redéfinissant l'une de ces trois fonctions est suivi de `\ir ../migrations/2320_wm_stripe_ops.sql` : `20_accounts.test.sql:184`, `31_battles.test.sql:74`, `34_guilds.test.sql:61` (après `2250`), `37_moderation.test.sql:770` (après `2240`), `39_account.test.sql:7-8` (après `2250` et `2260`) ; Task 3 ;
  - tout `DELETE`/`UPDATE` garde un `WHERE` (`scripts/check-dml.ts`) ;
  - chaînes d'erreur exactes, `error` = `message`, levées par `wm.raise_err(p_status, p_code, p_message, p_extra)` (`1000:58`) et recopiées par `route()` ;
  - aucune PII dans les logs ; le webhook journalise une ligne JSON sans corps brut ni signature ni secret (G14) ; « tu » dans tous les textes d'interface neufs, pages légales comprises ; apostrophe ASCII dans les chaînes ; thème sombre ; **aucun chemin de code réservé aux tests** (`STRIPE_API_URL` est une configuration facultative, comme `TURNSTILE_VERIFY_URL`, G36) ;
  - formes JSON : clés en plus permises, jamais de clé retirée ; aucun contrat existant ne change.
- **Dépôt public** (M2-R1) : aucun secret, aucune clé Stripe réelle, aucun identifiant de Price, d'endpoint ou de compte Stripe réel dans le dépôt ni dans `docs/` ; les fixtures utilisent des faux littéraux (`sk_test_bench_fake`, `whsec_test_bench_fake`, `price_test_bench_pro`, `price_test_bench_wb`, `cus_bench_…`, `cs_test_bench_…`, `sub_bench_…`, `evt_bench_…`) ; aucune marque du jeu d'origine ; aucun nom de joueur de la démo ; **aucun nom de modèle d'IA dans les fichiers** (les tâches portent « Modèle : fort » ou « Modèle : courant », voir « Conflits trouvés », C1). Chaque commit finit, après une ligne vide, par les lignes d'attribution que donne la session du contrôleur, et par elles seules.
- **La CI reste verte après chaque tâche.** Contrôles rapides : `npm run typecheck && npm run lint && npm test && npm run coverage:recap`. Contrôles complets : les rapides, puis `npm run test:db && npm run build:test && npm run test:contract && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e`. Comme au M6a (DG:1118), les tâches SQL 1, 2 et 4 font `test:db` et les contrôles rapides, et un seul point de contrôle complet a lieu à la fin de la Task 4 ; la Task 3, qui change deux réponses comparées par le contrat (`EXPORT_KEYS`, `Dashboard`), fait en plus `build:test` et `test:contract`.
- **Hygiène des invariants globaux** (le contrat tourne en séquence et six specs exigent `check_invariants() = '[]'` sans filtre : `contract/spec/admin.ts:529`, `:559`, `guilds.ts:212`, `account.ts:209`, `battles.ts:319`, `achievements.ts:68`) : un abonnement `active`/`trialing` posé à la main l'est sur un joueur `pro: true` ; un achat posé à la main est `pro_monthly` (`wb 0`), ou `wb_2500` avec sa ligne `stripe:` ; chaque test supprime ses joueurs, pierres tombales comprises (`wm.allow_tombstone_delete`), dans son `finally` ; aucun test ne reprend un joueur d'un autre fichier. Ids d'événement et de session posés par un test de contrat ou E2E : `evt_bench_${randomUUID().replaceAll('-', '')}` et `cs_test_bench_${randomUUID().replaceAll('-', '')}` (jamais un compteur : `--repeat-each` et `reuseExistingServer` partagent une base). `coverage:recap` reste à 90/90 (les routes Stripe ne sont pas au récap, R:973 ; specs `confidence: 'ajouté'`, M6a-14).
- **Chemin d'une écriture** : joueur — `idem_claim`, `wm.actor`, refus sans verrou, `perform set_config('lock_timeout', '2s', true)`, verrous C4, refus sous verrou, écritures, `idem_store` ; staff — celui du M6a (P6a:35, `staff_actor`, `admin_reason`, `staff_log` en dernier avant `idem_store`) ; **webhook** — `maintenance` (503), `lock_timeout`, `insert into wm.stripe_events … on conflict (id) do nothing` (premier verrou : l'index unique), puis `wm.lock_user(<joueur>)`, écritures ; aucun `idem_claim` (la PK de `stripe_events` est la clé d'idempotence, D:330) et aucun `wm.actor` (Stripe n'est pas un joueur ; un compte supprimé reçoit encore ses événements, G38).
- **Verrous (C4)** : `stripe_apply` ne prend qu'un profil (`wm.lock_user`), après la ligne `stripe_events` ; `wallet_apply` le reprend (déjà tenu). `account_delete` (inchangé) prend le profil par `lock_users` avant d'insérer `wm.deleted_accounts`, dont le trigger lit `wm.subscriptions` : un `stripe_apply` concurrent passe avant (le trigger voit l'abonnement) ou après (il voit la pierre tombale et pose `stripe_pending`), Task 4. Aucune fonction du M6b ne prend deux profils.
- **Argent** : seul `wm.wallet_apply` écrit un solde ; le seul nouveau motif est `stripe` (+2 500, réf. `stripe:<checkout_session_id>`, la même pour `completed` et `async_payment_succeeded`, D:625) ; la clé unique `(reason, ref, user_id)` de `wm.wb_ledger` (`1000:37-46`) rend le rejeu sans effet. Tout test qui crédite finit par `wm.check_invariants()` = `'[]'`.
- **Notifications** : quatre types neufs, cloche seulement (`wm.config.push_types` reste à 13 ; ni `PUSH_FAMILIES`, ni `e2e/settings.spec.ts` ne changent), insérés directement dans `public.notifications` par `stripe_apply`, jamais pour une pierre tombale (G38). Le webhook ne draine pas l'outbox (aucun type poussé).
- **DOM** (P6a:42) : aucun `id` fixe ; jamais `aria-label="Fermer"` nu ; cibles de 44 px ; nombres par `formatInt` ; `aria-disabled` et une garde, jamais `disabled` ; 360 px sans défilement horizontal ; focus jamais sur `body`.
- **Motifs imposés à chaque lecture** (P6a:43) : un 2xx illisible est une lecture en échec, avec la boucle E2E `for (const [label, reply] of [['500', { status: 500 }], ['200 illisible', { status: 200, body: 'x' }]] as const)` par `routeOnce` ; issue incertaine dite (`UNSURE`) ; `data-ready` ; clés `apiOnce` oubliées une fois l'issue connue.
- **E2E** (P6a:44) : chaque test crée ses joueurs (`makePlayer`), supprime tout dans un `finally` qui entoure tout le setup ; aucune requête réseau vers Stripe (la passerelle du banc répond, et `page.route('https://checkout.stripe.com/**')`, `page.route('https://billing.stripe.com/**')` servent une page factice) ; une valeur de `wm.config` changée l'est dans `try`/`finally`.

### Catalogue des erreurs (inféré, D:689, sauf mention)

Corps `{status, code?, error, message, …extra}`.

| Statut | `code` | Message | Où |
|---|---|---|---|
| 400 | `invalid_request` | « Article inconnu » (zod et SQL) · « Événement invalide » | checkout ; `stripe_apply` |
| 400 | `invalid_signature` | « Signature Stripe invalide » | webhook (aucune RPC) |
| 401 | `unauthorized` | « Session expirée, reconnecte-toi. » (existant) | partout ; compte supprimé |
| 403 | `pro_required` | « Fonction réservée aux membres Pro » (D:681, existant) | inchangé |
| 404 | `no_customer` | « Aucun abonnement à gérer » | portail |
| 409 | `already_subscribed` | « Tu as déjà un abonnement Pro : gère-le depuis les paramètres. » | checkout `pro_monthly` (G9) |
| 409 | — | « Aucune résiliation en attente » | `admin_stripe_cancel` |
| 502 | `stripe_unavailable` | « Le paiement est indisponible, réessaie dans un instant. » | checkout, portail (erreur du SDK) |
| 503 | `stripe_disabled` | « Paiement non configuré. » | checkout, portail (clé ou Price absents), webhook (secret absent) |
| 503 | `maintenance` | « Maintenance en cours, reviens dans quelques minutes. » (existant) | checkout, portail, webhook (G19) |
| 503 | `BUSY` | « Le site est très sollicité, réessaie dans un instant. » (existant) | webhook sur `55P03`/`40P01` |
| 500 | — | « Erreur interne, réessaie dans un instant. » (existant) | webhook sur toute autre erreur : Stripe réessaie |

Textes des notifications (`lib/notification-view.ts`, Task 9) : `pro_started` « Tu es membre Pro : merci ! » → `/settings` ; `pro_ended` « Ton abonnement Pro est terminé » → `/settings` ; `pro_payment_failed` « Le paiement de ton abonnement Pro a échoué » → `/settings` ; `wb_purchased` « {formatInt(amount)} wikibidous crédités » → `/collection`. Tous les textes d'interface neufs sont inférés (la boutique n'a jamais été capturée, R:897, D:741) et donnés mot pour mot dans leur tâche, le corps des pages légales excepté (G16 du M6a).

## Décisions (à consigner dans `docs/decisions-graphify.md`, Task 15)

Format : décision — pourquoi — coût si faux. **G1 à G26 recopient les rulings B1 à B26 du contrôleur (2026-11-02), dans leur ordre et sous leur numéro** ; G27 et suivantes sont prises par ce plan.

- **G1. Périmètre** : Stripe (Checkout, Portail, webhook, horloges de test par script manuel), dérivation de `is_pro`, modale boutique, section « Abonnement », bannière de stock à 0, S:75, S:76, S:77, S:80 (UI), S:82, S:84, résiliation à la suppression de compte, export RGPD des paiements, `/terms` et `/privacy`, `check_invariants`, tuile « Litiges Stripe ». Hors périmètre : live, Stripe Tax, essai gratuit, recharges de paquets, IAP, action staff sur `is_pro`, cosmétiques, meilleures cotes.
- **G2. SDK** `stripe@23.1.0`, `apiVersion: '2026-10-28.endive'` posée explicitement ; l'endpoint du Dashboard prend la même version — écart à D:73 (23.0.0).
- **G3. Endpoint** `https://wmr-ivm.vercel.app/api/stripe/webhook` (alias public hors Vercel Authentication, `docs/verifications.md:55`), sans contournement ; aucune préversion ne reçoit de webhook — si l'alias passe sous protection, 401 et retries 3 h en test.
- **G4. Pro** = au moins un abonnement `active` ou `trialing` ; `past_due` retire Pro ; `cancel_at_period_end` le garde jusqu'à la fin de période.
- **G5. Par état** : `stripe_apply` remplace la ligne `wm.subscriptions` par l'instantané reçu si `event.created` ≥ `event_created` stocké (égalité : réappliqué, sauf le départage de G44) ; aucun appel API dans le webhook ; fin de période = `items.data[0].current_period_end` ; abonnement d'une facture = `invoice.parent.subscription_details.subscription`.
- **G6. Prix** : ids de Price dans `STRIPE_PRICE_PRO_MONTHLY` et `STRIPE_PRICE_WB_2500` ; catalogue d'affichage dans `lib/shop.ts` (`pro_monthly` 999 cents CAD/mois, `wb_2500` 499 cents CAD et `wb: 2500`) ; la commande `prices` du script compare l'affichage aux Prices réels (Task 14).
- **G7.** CAD, locale `fr`, pas de Stripe Tax en test (prérequis du live, au suivi), aucun essai, aucune recharge, pas d'IAP.
- **G8. Litiges** : `charge.dispute.*` → `wm.stripe_disputes` ; tuile au tableau de bord ; aucune reprise ni remboursement automatique ; un remboursement fait au Dashboard ne retire pas les WB.
- **G9. Un seul abonnement** : 409 `already_subscribed` si un abonnement `active`, `trialing`, `past_due`, `incomplete`, `unpaid` ou `paused` existe ; le joueur va au Portail.
- **G10. Suppression** : résiliation immédiate (`subscriptions.cancel`, sans remboursement) avant GoTrue ; un échec ne bloque pas la suppression et laisse `wm.deleted_accounts.stripe_pending` vrai, visible au tableau de bord avec « Résilier » rejouable ; le Customer Stripe est gardé (comptabilité), dit dans `/privacy`. Mise en œuvre par G35 (voir « Conflits trouvés », C2).
- **G11.** Un bannissement ne résilie rien.
- **G12.** Aucune action staff sur `is_pro` ; `is_vip` reste le geste manuel (SQL Editor).
- **G13. Notifications** cloche seulement : `pro_started`, `pro_ended`, `pro_payment_failed`, `wb_purchased`.
- **G14. Webhook** : handler Node hors `route()`, `request.text()`, en-tête `stripe-signature`, `constructEvent` (tolérance 300 s) ; signature invalide → 400 sans RPC ; maintenance → 503 ; erreur de base → 500 ; événement inconnu → 200, consigné ; `stripe_events` inséré dans la transaction de l'effet ; réponse sans donnée personnelle ; journal sans secret ni corps.
- **G15. Tests** : pgTAP/SQL de `stripe_apply` ; contrat avec fixtures signées par `generateTestHeaderString` et un `whsec_` factice ; appels API par `lib/stripe.ts` contre un faux Stripe au banc (G36) ; E2E avec `page.route` ; acceptation réelle par l'utilisateur sur la démo (script `scripts/stripe-clock.mjs`, refus de toute clé hors `sk_test_`/`rk_test_`, jamais en CI). Écart à D:631 : pas de `stripe trigger` en CI.
- **G16. Clés** : posées par l'utilisateur dans Vercel (Production et Preview, « Sensitive ») ; clé restreinte : Checkout Sessions Write, Customer portal Write, Customers Write, Subscriptions Write, Prices/Products Read ; aucune clé d'horloge sur Vercel ; le MCP Stripe n'est pas utilisé.
- **G17. Checkout** : `consent_collection.terms_of_service = 'required'`, `custom_text.terms_of_service_acceptance.message` avec la renonciation ; consentement stocké avec l'achat ; `client_reference_id`, `metadata.uid`, `subscription_data.metadata.uid` ; un Customer par joueur, réutilisé ; `idempotencyKey` par intention ; `success_url` n'accorde rien (G33) ; `cancel_url` rouvre la boutique.
- **G18. Paquet de WB** : `completed` payé et `async_payment_succeeded` créditent 2 500 WB sous la même réf. ; motif `stripe` dans `check_invariants` ; table `wm.purchases`.
- **G19. Maintenance** : Checkout et Portail 503 ; `stripe_apply` lève, Stripe réessaie.
- **G20.** « Pro jusqu'au <date> » depuis la fin de période de l'item quand `cancel_at_period_end`.
- **G21. Boutique** : une modale (`Modal`, `HelpDialog`, `button.ts`, palette violette) ouverte depuis le solde de l'en-tête, la bannière de stock à 0 et les liens des fonctions verrouillées ; avantages de D:629 seulement ; états fortify ; section « Abonnement » ; badge Pro dans la coquille.
- **G22. Backlog** : S:75 clos par un test VIP et la doc ; S:76 décidé (paquets Pro, spéciaux, de grâce comptés) ; S:77 solde dans la coquille et bannière ; S:80 UI de réclamation (les fonctions `wm.special_packs`, `wm.claim_special`, `wm.claim_grace` existent, `1200:269-329` ; **aucune fonction d'octroi** n'existe : outils staff au M7) ; S:82 gardé et documenté ; S:84 « Comment ça marche ? » lu de `wm.config`.
- **G23.** Compte Pro « carol » dans les fixtures de test seulement (`makePlayer({ pro: true, username: 'carol…' })`), pas à la démo — écart à D:212.
- **G24. RGPD** : `account_export` ajoute abonnements et achats, jamais de carte ni de clé ; la suppression garde les références de paiement ; `/privacy` nomme Stripe ; `/terms` gagne l'abonnement ; `TERMS_VERSION` tranché par G40.
- **G25. `check_invariants`** : (a) `stripe_purchase` (ligne `stripe` du grand livre ↔ achat `wb_2500`, montant compris) ; (b) `stripe_pro` (abonnement `active`/`trialing` → `is_pro`) ; (c) unicité des événements, prouvée par contrainte (voir C3).
- **G26. Numérotation** : `2300`+, `deploy-m6b.sql` sur le modèle de `deploy-m6a.sql` ; la règle de relance s'étend à `deploy-m6b.sql` (Task 15).

### Décisions ajoutées par ce plan

- **G27. Tables** (`2300`, toutes dans `wm`, aucune politique RLS : `wm` n'est pas exposé, le `revoke` de fin de migration suffit) :

  | Table | Colonnes et contraintes | Index |
  |---|---|---|
  | `wm.stripe_events` | `id text primary key check (id like 'evt\_%')`, `type text not null`, `created timestamptz not null`, `livemode boolean not null`, `outcome text not null default 'applied' check (outcome in ('applied', 'ignored', 'stale', 'pending', 'unresolved'))`, `received_at timestamptz not null default now()` | — |
  | `wm.stripe_customers` | `customer_id text primary key check (customer_id like 'cus\_%')`, `user_id uuid not null unique references public.profiles (id) on delete cascade`, `created_at timestamptz not null default now()` | (unique) |
  | `wm.subscriptions` | `id text primary key check (id like 'sub\_%')`, `user_id uuid not null references public.profiles (id) on delete cascade`, `customer_id text not null`, `status text not null check (status in ('active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'paused', 'trialing', 'unpaid'))`, `price_id text`, `current_period_end timestamptz`, `cancel_at_period_end boolean not null default false`, `cancel_at timestamptz`, `canceled_at timestamptz`, `latest_invoice_status text check (latest_invoice_status in ('paid', 'payment_failed'))`, `latest_invoice_at timestamptz`, `event_created timestamptz not null`, `updated_at timestamptz not null default now()` | `subscriptions_user_idx (user_id)` |
  | `wm.purchases` | `session_id text primary key check (session_id like 'cs\_%')`, `user_id uuid not null references public.profiles (id) on delete cascade`, `item text not null check (item in ('pro_monthly', 'wb_2500'))`, `amount int not null check (amount >= 0)` (cents), `currency text not null`, `consent text` (`session.consent.terms_of_service`), `wb int not null default 0 check (wb >= 0)`, `created_at timestamptz not null default now()` | `purchases_user_idx (user_id, created_at)` |
  | `wm.stripe_disputes` | `id text primary key check (id like 'dp\_%')`, `charge_id text`, `amount int not null`, `currency text not null`, `reason text`, `status text not null`, `created_at timestamptz not null`, `event_created timestamptz not null`, `updated_at timestamptz not null default now()` | `stripe_disputes_open_idx (created_at desc) where status not in ('won', 'lost', 'warning_closed', 'prevented')` |
  | `wm.deleted_accounts` | `add column if not exists stripe_pending boolean not null default false` | `deleted_accounts_stripe_pending_idx (deleted_at) where stripe_pending` |

  `on delete cascade` ne joue qu'à une suppression dure de profil, jamais en exploitation (pierre tombale, G1 du M6a) — il garde les nettoyages des tests possibles.
- **G28. Config** (`on conflict do nothing`) : `shop` = `{"wb_2500": 2500}`, note « Wikibidous crédités par article payé (D:618, D:625) ». Montant de crédit lu par `stripe_apply` et rendu par `shop_state` ; `lib/shop.ts` porte la même valeur pour l'affichage, comparée par le contrat (Task 6).
- **G29. Correspondance par type d'événement** (`stripe_apply`, `o` = `p_event -> 'data' -> 'object'`, `t` = `to_timestamp((p_event ->> 'created')::bigint)`) :

  | `type` | Joueur (`wm.stripe_uid`) | Effet | `outcome` |
  |---|---|---|---|
  | `checkout.session.completed`, `checkout.session.async_payment_succeeded` | `client_reference_id`, puis `metadata.uid`, puis `stripe_customers` de `customer` | lien `customer` → joueur (`on conflict do nothing`) ; `metadata.item = 'wb_2500'`, `mode = 'payment'` et `payment_status = 'paid'` : `purchases` (`on conflict do nothing`, `amount = coalesce(amount_total, 0)`, `currency = coalesce(currency, '')` : le SDK les type nullables, un objet incomplet ne doit jamais donner un 500 rejoué) puis, si insérée, `wallet_apply(uid, shop.wb_2500, 'stripe', 'stripe:' || o.id)` et `wb_purchased` ; `payment_status <> 'paid'` : rien (`pending`) ; `mode = 'subscription'` : `purchases` (`item 'pro_monthly'`, `wb 0`) seulement, Pro vient des événements d'abonnement | `applied` / `pending` / `unresolved` |
  | `customer.subscription.created`, `.updated`, `.deleted` | `metadata.uid`, puis `stripe_customers` | upsert `subscriptions` gardé par `t >= event_created` et le départage de G44 (sinon `stale`) ; `is_pro` recalculé (G4), changé → `pro_started` / `pro_ended` ; pierre tombale → `stripe_pending` recalculé (G35) | `applied` / `stale` / `unresolved` |
  | `invoice.paid`, `invoice.payment_failed` | `parent.subscription_details.metadata.uid`, puis `stripe_customers` | `latest_invoice_status` (`paid` / `payment_failed`) et `latest_invoice_at = to_timestamp(o.created)` de l'abonnement `parent.subscription_details.subscription` s'il existe et si plus récent ; `payment_failed` → `pro_payment_failed` | `applied` / `unresolved` |
  | `charge.dispute.created`, `.closed` | aucun | upsert `stripe_disputes` gardé par `t >= event_created` | `applied` |
  | autre, ou `livemode` vrai | — | rien (D:104 : test seulement) | `ignored` |

  `unresolved` (joueur introuvable) répond 200 : un objet sans `uid` ni Customer connu n'est pas à nous ; la requête de « Exploitation de Stripe » (Task 15) les liste. Un `client_reference_id` ou un `metadata.uid` qui n'est pas un uuid est ignoré (jamais d'exception de cast).
- **G30. Signatures SQL** (toutes `security definer`, `set search_path = ''`) :
  - `2300` : `wm.stripe_pending_on_delete() returns trigger` + `create or replace trigger deleted_accounts_stripe_pending before insert on wm.deleted_accounts for each row execute function wm.stripe_pending_on_delete()` ; `wm.shop_state(p_uid uuid, p_session text default null) returns jsonb` (`stable`) ; `wm.stripe_checkout_prepare(p_uid uuid, p_item text) returns jsonb` ; `wm.stripe_customer_set(p_uid uuid, p_customer_id text) returns text` ; `wm.stripe_portal_prepare(p_uid uuid) returns jsonb` ; `wm.grace_status(p_uid uuid) returns jsonb` (`stable`).
  - `2310` : `wm.stripe_uid(p_candidates text[], p_customer text) returns uuid` (`stable`) ; `wm.stripe_apply(p_event jsonb) returns jsonb` → `{duplicate: boolean, outcome: text | null}`.
  - `2320` : `wm.check_invariants()`, `wm.account_export(p_uid uuid)`, `wm.staff_dashboard(p_uid uuid)` (redéfinies) ; `wm.stripe_cancel_targets(p_user_id uuid) returns jsonb` → `{subscription_ids: text[]}` (`stable`) ; `wm.stripe_cancel_done(p_user_id uuid, p_subscription_ids text[]) returns jsonb` → `{ok: true, stripe_pending: boolean}` ; `wm.admin_stripe_cancel(p_uid uuid, p_user_id uuid, p_reason text, p_idem text default null) returns jsonb` → `{stripe: {user_id, subscription_ids}}`.
- **G31. Routes** :

  | Route | Requête | Réponse 2xx | Erreurs |
  |---|---|---|---|
  | `GET /api/shop?session=` | `ShopQuery` (`session` facultatif, `^cs_(test\|live)_[A-Za-z0-9_]{1,200}$`) | `shop_state` (G34) | 401, 403 (`access_check`), 400 |
  | `POST /api/stripe/checkout` | `{item: 'pro_monthly' \| 'wb_2500'}`, `Idempotency-Key` | 200 `{url}` (Checkout hébergé) | 400, 401, 403, 409, 502, 503 |
  | `POST /api/stripe/portal` | aucun corps | 200 `{url}` | 401, 404, 502, 503 |
  | `POST /api/stripe/webhook` | corps brut, `stripe-signature` | 200 `{received: true}` (doublon compris) | 400, 500, 503 |
  | `GET /api/packs/grace` | — | `grace_status` | 401, 403 |
  | `POST /api/admin/users/{userId}/stripe-cancel` | `AdminReason`, `Idempotency-Key` | 200 `{stripe, stripe_synced}` | 400, 401, 403, 409 |
  | `POST /api/settings/delete-account` | inchangé | réponse inchangée plus `stripe_pending: boolean` | inchangées |

  `success_url` = `<origine>/pulls?shop=success&session={CHECKOUT_SESSION_ID}`, `cancel_url` = `<origine>/pulls?shop=cancel`, `return_url` du Portail = `<origine>/settings`, l'origine étant `new URL(req.url).origin` (un hôte forgé ne renvoie que l'attaquant chez lui).
- **G32. Variables d'environnement** (serveur seulement, lues à l'appel) : `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_WB_2500` (posées par l'utilisateur) ; `STRIPE_API_URL` facultative (vide → `api.stripe.com`, posée seulement par le banc). Aucune `NEXT_PUBLIC_*` (Checkout hébergé). Absentes → 503 `stripe_disabled` à l'usage, jamais au build ; une suppression de compte sans abonnement n'appelle jamais Stripe.
- **G33. Retour de Checkout** : la coquille lit `?shop=` au montage (`window.location.search`, pas `useSearchParams`) ; `success` → région `role="status"` « Paiement reçu, confirmation en cours… », relecture de `GET /api/shop?session=<id>` toutes les 2 s pendant 30 s jusqu'à `purchase` non nul (et `me.is_pro` pour `pro_monthly`), puis toast « 2 500 wikibidous crédités. » ou « Bienvenue chez les membres Pro ! » ; échéance → toast « Ton paiement est en cours de confirmation : il apparaîtra d'ici quelques minutes. » ; `cancel` → boutique rouverte, statut « Paiement annulé : rien n'a été débité. » ; puis `history.replaceState` retire `shop` et `session`.
- **G34. `shop_state`** : profil absent ou compte supprimé → 401 ; rend `{rules: {pack_size, pack_period_s: {free, pro}, pro_daily_size, max_concurrent_auctions: {free, pro}, battle_quota: {free, pro}, sales_detail_days, wb_2500}, me: {balance, is_pro, is_vip, pack_cap, has_customer, subscription: {status, current_period_end, cancel_at_period_end, cancel_at} | null}, purchase: {item, created_at} | null, maintenance: boolean}` (G46) — `subscription` = la plus récente (`event_created desc`) non terminale, sinon la plus récente ; `purchase` seulement pour une session de `p_uid` ; toutes les valeurs de `rules` lues de `wm.config` (`pack_size`, `pack_period_s`, `pro_daily.size`, `max_concurrent_auctions`, `battle.quota_free`/`quota_pro`, `sales_detail_window.days`, `shop.wb_2500`).
- **G35. `stripe_pending` posé dans la transaction de la suppression** : le trigger `deleted_accounts_stripe_pending` pose `new.stripe_pending := exists (abonnement non terminal du joueur)` ; `stripe_apply` le recalcule pour une pierre tombale à chaque événement d'abonnement (un abonnement créé après la suppression le pose) ; `stripe_cancel_done(p_user_id, p_subscription_ids)` le recalcule après une résiliation réussie, en excluant les seuls ids qu'elle vient de résilier : un second abonnement créé pendant les appels Stripe (G41, webhook en retard) le garde vrai. Ainsi `account_delete` n'est pas redéfinie et un processus tué entre la transaction et l'appel Stripe laisse le drapeau vrai (C2).
- **G36. Faux Stripe du banc** : la passerelle de `contract/harness.ts` répond à `POST /v1/customers` (`{id: 'cus_bench_<h>', object: 'customer'}`), `POST /v1/checkout/sessions` (`{id: 'cs_test_bench_<h>', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_test_bench_<h>'}`), `POST /v1/billing_portal/sessions` (`{id: 'bps_bench_<h>', url: 'https://billing.stripe.com/p/session/test_bench_<h>'}`), `<h>` = `randomUUID().replaceAll('-', '')` (jamais un compteur : une base de banc réutilisée garde les ids d'un run précédent), `DELETE /v1/subscriptions/{id}` (`{id, object: 'subscription', status: 'canceled'}`, sauf un id qui commence par `sub_bench_fail` → 500 `{error: {type: 'api_error', message: 'bench'}}`), `GET /stripe/requests` (journal `{method, path, form, idempotency_key, stripe_version}[]`) et `DELETE /stripe/requests` (remise à zéro) ; `startNext` pose `STRIPE_SECRET_KEY = 'sk_test_bench_fake'`, `STRIPE_WEBHOOK_SECRET = 'whsec_test_bench_fake'`, `STRIPE_PRICE_PRO_MONTHLY = 'price_test_bench_pro'`, `STRIPE_PRICE_WB_2500 = 'price_test_bench_wb'`, `STRIPE_API_URL = backend.supabaseUrl` (exportés par `contract/harness.ts`).
- **G37. `lib/gate.ts` et `proxy.ts`** : rien à changer. `EXEMPT` contient déjà `'/api/stripe/webhook'` (`lib/gate.ts:4`, test `lib/gate.test.ts:6`) ; `proxy.ts` appelle `updateSession` (sans effet sur un POST sans cookie) et `isGameRoute` ne couvre pas `/api/stripe` ; aucune vérification d'Origin. `/api/stripe/checkout` et `/portal` restent derrière la porte (joueur connecté). Le contrat le prouve sur le serveur à porte (Task 7).
- **G38. Pierre tombale** : `stripe_apply` traite ses événements (crédit inerte, état d'abonnement, `stripe_pending`) sans aucune notification ; `checkout_prepare` et `portal_prepare` la refusent en 401.
- **G39. Portail sans `wm.actor`** : `stripe_portal_prepare` vérifie `maintenance` et le compte supprimé, pas les sanctions — un joueur restreint ou suspendu garde le droit de résilier (comme `account_delete`, P6a:35).
- **G40. `TERMS_VERSION`** passe à `'2026-11-02'` : `/terms` gagne des clauses contractuelles (abonnement, renouvellement, résiliation) ; « Dernière mise à jour : 2 novembre 2026 » sur `/terms` et `/privacy` ; aucune réacceptation des comptes existants (G16 du M6a), l'acceptation au paiement passant par `consent_collection`.
- **G41. Deux abonnements par deux onglets** : `checkout_prepare` ne verrouille rien ; deux Checkout Pro ouverts avant tout paiement peuvent donner deux abonnements. `-- shortcut: garde de G9 sans verrou ; deux onglets peuvent créer deux abonnements, le second se résilie au Portail. Verrou consultatif par joueur si observé.`
- **G42. Rafraîchissement du solde** : la coquille relit `GET /api/shop` à chaque changement de chemin, au retour de Checkout et quand la page revient au premier plan ; `/collection` garde sa mise à jour immédiate après une défausse en appelant `useShop().setBalance(b)` (qui remplace `freshBalance`, `collection-client.tsx:61-64`, avec le même compteur de génération) et `useShop().reload()` (qui remplace `readBalance`) ; les autres pages qui déplacent des wikibidous (marché, échanges, batailles) ne préviennent pas l'en-tête — coût : un solde en retard d'une navigation sur ces pages.
- **G43. Horloges de test** : le script crée son propre Customer (`test_clock`, `metadata.uid`) ; `stripe_apply` le relie au joueur par `metadata.uid` (`stripe_customers` `on conflict do nothing`) ; à jouer avec un compte de démo neuf (le Portail ouvre le Customer relié).
- **G44. Départage à égalité de seconde (précise B5/G5, ruling du contrôleur sur la relecture 1)** : à `event.created` = `event_created` stocké, l'instantané reçu ne remplace **pas** la ligne si le statut stocké est terminal (`canceled`, `incomplete_expired`), ni si le statut reçu est `incomplete` et le statut stocké en est un autre ; sinon il la remplace. Un `event.created` strictement plus grand remplace toujours, un plus petit jamais (`stale`). Pourquoi : `created` (`incomplete`) et `updated` (`active`) d'un même Checkout tombent souvent dans la même seconde et Stripe ne garantit pas l'ordre ; sans départage, un payeur resterait non Pro jusqu'au renouvellement, et un `deleted` suivi d'un `updated` de la même seconde rallumerait Pro pour toujours (un abonnement résilié n'émet plus rien) — coût si faux : un abonnement réellement revenu à `incomplete` ou réactivé après une résiliation dans la même seconde serait ignoré (Stripe ne fait ni l'un ni l'autre).
- **G45. Clé d'idempotence du Customer** (relecture 1, n° 7) : `customer:<uid>:<16 premiers hex de sha256(email)>` ; un e-mail changé entre deux essais donne une autre clé (jamais d'`idempotency_error` pendant 24 h) ; le pire cas est un Customer orphelin chez Stripe quand la création a réussi mais que `stripe_customer_set` a échoué (le second devient le Customer relié) — coût si faux : un Customer vide de plus dans le Dashboard. L'e-mail reste envoyé (reçus et lien de connexion du Portail), dit dans `/privacy` (Task 12).
- **G46. Boutique en maintenance** (B21) : `shop_state` rend `maintenance: boolean` (`wm.config.maintenance`) ; la modale affiche alors « La boutique est fermée pendant la maintenance. » et ses boutons d'achat sont `aria-disabled` ; le 503 au clic reste le filet. Chargement : `Loading` « Chargement de la boutique… ».

**Écarts au spec (les décisions l'emportent, à consigner)** : D:73 23.0.0 → 23.1.0 (G2) ; D:631 et D:1039 `stripe trigger` en CI → fixtures signées et acceptation manuelle (G15) ; D:626 action staff auditée sur `is_pro` non livrée (G12) ; D:212 « carol (Pro) » dans les fixtures seulement (G23) ; D:1053 deux variables de Price en plus (G6) ; D:1055 aucun secret GitHub Stripe (aucun job ne l'utilise).

## Conflits trouvés

- **C1. Recommandation de modèle par nom (demandée par le brief du plan) contre la règle « aucun nom de modèle d'IA dans les fichiers »** (P6a:33, Global Constraints). Correctif minimal : chaque tâche porte « Modèle : fort » (argent, verrous, concurrence, webhook, suppression) ou « Modèle : courant » ; le contrôleur traduit selon `model-routing` (H:292).
- **C2. B10 pose `stripe_pending` après un échec dans la route** : un processus tué (délai Vercel, déploiement) entre le `COMMIT` d'`account_delete` et l'appel Stripe ne pose rien, et l'abonné supprimé reste facturé sans trace. Correctif minimal (G35) : le drapeau est posé dans la transaction de la suppression par un trigger `before insert` sur `wm.deleted_accounts`, et remis à faux après succès ; `account_delete` n'est pas redéfinie.
- **C3. B25(c) « aucun doublon d'événement »** est garanti par la PK de `wm.stripe_events` : un contrôle à l'exécution serait vide pour toujours. Correctif : (c) devient une assertion de structure dans `40_stripe.test.sql` (PK de `stripe_events`, PK `session_id` de `purchases`, clé unique du grand livre) ; le contrôle d'exécution de (a) couvre aussi le montant.
- **C4. B15(3) « `lib/stripe.ts` mocké au banc »** : un `vi.mock` n'atteint pas le serveur Next que lance le harness. Correctif : `STRIPE_API_URL` facultative (précédent `TURNSTILE_VERIFY_URL`, `contract/harness.ts:264`) vers le faux Stripe de la passerelle (G36) ; `lib/stripe.test.ts` garde des mocks vitest pour la construction des paramètres.
- **C5. D:626 « `invoice.*` met à jour `wm.subscriptions` » et B5 « aucun appel API »** : une facture ne porte pas le statut de l'abonnement. Correctif : `invoice.*` n'écrit que `latest_invoice_status`/`latest_invoice_at` et notifie l'échec ; le statut vient de `customer.subscription.updated`, que Stripe émet à chaque renouvellement et changement d'état.
- **C6. B22 « UI des paquets de grâce »** : `wm.claim_grace` existe mais aucune lecture ne dit si une dotation attend. Correctif : `wm.grace_status` (lecture `stable`) et `GET /api/packs/grace`. Aucune fonction d'octroi (`special_packs`, `grace_grants`) n'existe : les outils staff vont au M7, comme B22 le prévoit.
- **C7. `scripts/stripe-clock.mjs`** (B15) alors que les scripts du dépôt sont en `.ts` exécuté par Node 24 : sans effet, l'extension du ruling est gardée.
- **C8. Ids du faux Stripe par compteur** (trouvé pendant la relecture 1, prolonge son n° 10) : la passerelle du banc numérotait `cus_bench_<n>`/`cs_test_bench_<n>` ; une base réutilisée (`reuseExistingServer`) ou un redémarrage de la passerelle reprendrait les mêmes ids, et `purchases`/`stripe_customers` les refuseraient en silence. Correctif : ids `<uuid hex>` aussi dans G36.

## Review Focus

- **Double crédit sur un rejeu ou une relance** (même `event.id` deux fois, `completed` + `async_payment_succeeded`, deux livraisons simultanées, relance après un 500) → un seul `+2 500`, un seul achat, une seule `wb_purchased`, invariants vides. → Tasks 2 (SQL), 4 (concurrence), 7 (contrat signé), 15 (« Resend » du Dashboard).
- **Pro jamais allumé après le paiement** (événements dans le désordre, `created` `incomplete` arrivé après `updated` `active` dans la même seconde (G44), `subscription.created` avant `checkout.session.completed`, Customer non encore relié, retour de Checkout avant le webhook) → `is_pro` vrai dès l'instantané `active`, les six avantages ouverts, l'UI qui attend la confirmation. → Tasks 2, 4, 7, 9, 13, 15.
- **Pro jamais éteint** (`deleted`, `past_due`, `unpaid`, `canceled` à la fin de période, un `updated` périmé ou de la même seconde qui arrive après `deleted`) → `is_pro` faux et `pro_ended`, jamais rallumé par l'ancien instantané. → Tasks 2, 4, 7, 15 (horloge de test).
- **Webhook refusé par la porte ou 500 en boucle** (serveur à porte sans cookie, type inconnu, `livemode`, joueur introuvable, objet incomplet) → 400 pour une mauvaise signature, 200 consigné sinon, 503 seulement en maintenance ou verrou, jamais un 500 rejoué trois jours par un événement qui ne passera jamais. → Tasks 2, 7, 15 (`curl` de l'endpoint).
- **Compte supprimé, abonnement encore facturé** (Stripe en panne, clé absente, processus tué, abonnement créé après la suppression ou pendant la résiliation) → la suppression aboutit, `stripe_pending` vrai, tuile et « Résilier » rejouable, résiliation réussie qui remet le drapeau à faux. → Tasks 1, 4, 8, 11, 15.

## Fichiers

| Fichier | Rôle |
|---|---|
| `supabase/migrations/2300_wm_stripe_core.sql` | Config `shop`, cinq tables, colonne `stripe_pending`, index, trigger, `shop_state`, `stripe_checkout_prepare`, `stripe_customer_set`, `stripe_portal_prepare`, `grace_status` |
| `supabase/migrations/2310_wm_stripe_apply.sql` | `stripe_uid`, `stripe_apply` |
| `supabase/migrations/2320_wm_stripe_ops.sql` | `check_invariants`, `account_export`, `staff_dashboard` (redéfinies), `stripe_cancel_targets`, `stripe_cancel_done`, `admin_stripe_cancel` |
| `supabase/tests/40_stripe.test.sql`, `22_stripe_concurrency.test.sh` ; recalés : `20_accounts`, `31_battles`, `34_guilds`, `37_moderation`, `39_account` (rejeux, clés) | Tests SQL et concurrence |
| `lib/stripe.ts`, `lib/stripe.test.ts`, `lib/shop.ts`, `lib/shop.test.ts`, `lib/schemas.ts`, `lib/admin-auth.ts`, `lib/admin-auth.test.ts`, `package.json`, `package-lock.json`, `.env.example` | Bibliothèques |
| `app/api/stripe/{checkout,portal,webhook}/route.ts`, `app/api/shop/route.ts`, `app/api/packs/grace/route.ts`, `app/api/admin/users/[userId]/stripe-cancel/route.ts` | Routes |
| `contract/harness.ts`, `contract/stripe-events.ts`, `contract/spec/stripe.ts`, `contract/spec/admin.ts`, `contract/spec/account.ts`, `contract/spec/index.ts` | Contrat |
| `components/shop/{ShopProvider,ShopDialog,ShopOffers}.tsx`, `components/shop/ShopOffers.test.tsx`, `components/ui/ProBadge.tsx`, `components/shell/Balance.tsx`, `app/(game)/layout.tsx`, `app/(game)/collection/collection-client.tsx`, `components/card/CardModal.tsx`, `lib/notification-view.ts`, `lib/notifications.test.ts` | Coquille, boutique |
| `components/packs/{PackStock,ProDailyBlock,HowItWorks,BonusPacks}.tsx`, `app/(game)/pulls/{page,pulls-client}.tsx`, `components/market/MarketPanel.tsx`, `app/(game)/battle/battle-client.tsx` | `/pulls`, verrous Pro |
| `components/settings/Subscription.tsx`, `components/settings/DeleteAccount.tsx`, `app/(game)/settings/settings-client.tsx`, `app/(game)/admin/dashboard-client.tsx` | `/settings`, admin |
| `app/(public)/{terms,privacy,rules}/page.tsx`, `components/legal/LegalPage.tsx`, `lib/auth.ts` | Pages légales |
| `e2e/{shop,shop-journey}.spec.ts` ; étendus : `e2e/pulls.spec.ts`, `e2e/collection.spec.ts`, `e2e/settings.spec.ts`, `e2e/admin.spec.ts`, `e2e/legal.spec.ts`, `e2e/a11y.spec.ts`, `e2e/notifications.spec.ts` | E2E |
| `scripts/stripe-clock.mjs`, `scripts/stripe-clock.test.ts` | Horloges de test (manuel) |
| `docs/superpowers/HANDOFF.md`, `docs/suivi.md`, `docs/verifications.md`, `docs/decisions-graphify.md`, `docs/DESIGN.md` | Passation (Task 15) |

---

### Task 1: Socle `2300` — tables Stripe, drapeau de suppression, lectures et préparations

Modèle : fort · deux relecteurs (dont un adverse) : schéma d'argent et drapeau de suppression.

**Files:**
- Create: `supabase/migrations/2300_wm_stripe_core.sql`, `supabase/tests/40_stripe.test.sql`

**Interfaces:**
- Consumes : `wm.raise_err`, `wm.actor` (`2200:74`), `wm.lock_user` (`2250:215`), `wm.config` ; tables `wm.deleted_accounts` (`2200:49`), `wm.grace_grants` (`1200:53`).
- Produces : G27, G28 ; les fonctions `2300` de G30 :
  - `stripe_pending_on_delete()` : `new.stripe_pending := exists (select from wm.subscriptions where user_id = new.user_id and status in ('active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused'))` ; `return new`.
  - `shop_state(p_uid, p_session)` : G34.
  - `stripe_checkout_prepare(p_uid, p_item)` : `wm.actor(p_uid)` (maintenance 503, sanctions 403, supprimé 401) ; `p_item` hors des deux clés → 400 « Article inconnu » ; `'pro_monthly'` et un abonnement non terminal (liste de G9) → 409 `already_subscribed` ; rend `{customer_id: text | null, email: text}` (`auth.users.email`) ; aucune écriture, aucun verrou.
  - `stripe_customer_set(p_uid, p_customer_id)` : `perform set_config('lock_timeout', '2s', true)` ; `insert … on conflict do nothing` ; rend le `customer_id` stocké du joueur (celui d'avant si une autre requête l'a posé).
  - `stripe_portal_prepare(p_uid)` : maintenance 503 ; profil absent ou supprimé 401 ; aucun Customer → 404 `no_customer` « Aucun abonnement à gérer » ; rend `{customer_id}` (G39).
  - `grace_status(p_uid)` : `{available: <dotations non réclamées>, size: <taille de la plus ancienne> | null}`.
- [ ] **Step 1: Tests qui échouent** (`40_stripe.test.sql` : une seule transaction, aides `pg_temp.err` et `pg_temp.inv` recopiées de `34_guilds.test.sql:6-14`, règle d'en-tête du fichier : `check_invariants` global, sous-transaction `WMT00` pour une violation voulue ; joueurs par `tests.make_user`)
  - Config : `shop` = `{"wb_2500": 2500}` et sa note non vide ; rejeu de `2300` (`\ir`, deux fois) → mêmes valeurs, une valeur posée (`{"wb_2500": 10}`) survit ; colonnes, contraintes et index : `indexdef` complet des quatre index comparé comme `28_trades.test.sql:65-79` ; `wm.deleted_accounts.stripe_pending` faux par défaut.
  - **Structure (C3)** : `stripe_events_pkey` sur `(id)`, `purchases_pkey` sur `(session_id)`, la clé unique `(reason, ref, user_id)` de `wm.wb_ledger` présentes (`pg_constraint`) ; un second `insert` du même `evt_bench_1` → `unique_violation`.
  - ***Review Focus*, abonné supprimé** : joueur avec un abonnement `active` inséré à la main → `insert into wm.deleted_accounts (user_id)` → `stripe_pending` vrai ; `canceled` → faux ; `past_due` → vrai ; aucun abonnement → faux.
  - `shop_state` : clés exactes de premier niveau (`rules`, `me`, `purchase`, `maintenance`), de `rules` et de `me` ; `maintenance` suit `wm.config` ; `rules` = `{pack_size: 5, pack_period_s: {free: 600, pro: 180}, pro_daily_size: 15, max_concurrent_auctions: {free: 5, pro: 10}, battle_quota: {free: 3, pro: 10}, sales_detail_days: 30, wb_2500: 2500}` ; `me.subscription` nul sans abonnement ; deux abonnements (`canceled` récent, `active` plus ancien) → l'`active` ; `p_session` d'une session du joueur → `purchase = {item, created_at}` ; d'un autre joueur → nul ; compte supprimé → 401 exact ; `provolatile = 's'`.
  - `checkout_prepare` : `'x'` → 400 exact `{"status":400,"code":"invalid_request","error":"Article inconnu","message":"Article inconnu"}` ; `'pro_monthly'` avec `active`, `trialing`, `past_due`, `incomplete`, `unpaid`, `paused` → 409 exact (six cas) ; avec `canceled` ou `incomplete_expired` → passe ; `'wb_2500'` avec un `active` → passe ; `maintenance` → 503 ; restriction active → 403 « Ton compte est temporairement restreint. » ; supprimé → 401 ; `email` = celui de `auth.users`.
  - `customer_set` : premier appel → `'cus_bench_a'` ; second avec `'cus_bench_b'` → `'cus_bench_a'`, une seule ligne.
  - `portal_prepare` : sans Customer → 404 exact ; avec → `{customer_id}` ; restriction active → passe (G39) ; `maintenance` → 503 ; supprimé → 401.
  - `grace_status` : aucune → `{available: 0, size: null}` ; deux dotations (7 puis 5) → `{available: 2, size: 7}` ; une réclamée → `{available: 1, size: 5}`.
  - **S:75 (VIP = Pro)** : un joueur `is_vip` sans `is_pro` → `wm.pro_daily_status(v, 'UTC') ->> 'is_pro'` vrai et `eligible` vrai ; `wm.next_regen_at` à 180 s de `packs_last_regen_at` ; `wm.create_auction` accepte une sixième vente active (dette S:247) ; `pg_temp.inv` vide.
  - `lock_timeout` : `tests.lock_timeout_violations(array['stripe_customer_set'], array['insert into wm.stripe_customers'])` nul.
- [ ] **Step 2: `npm run test:db`** → `FAIL 40_stripe.test.sql`.
- [ ] **Step 3: Implémenter `2300`** ; fin `revoke`/`grant`.
- [ ] **Step 4: `npm run test:db` et contrôles rapides** → vert.
- [ ] **Step 5: Commit** — `feat(db): socle Stripe (événements, Customers, abonnements, achats, litiges, drapeau de résiliation posé à la suppression, état de la boutique, préparations du Checkout et du Portail, dotations de grâce lisibles)`

---

### Task 2: `wm.stripe_apply` — dédoublonnage, crédit unique, état d'abonnement ordonné, Pro dérivé, notifications, litiges

Modèle : fort · deux relecteurs (dont un adverse) : argent, ordre, idempotence.

**Files:**
- Create: `supabase/migrations/2310_wm_stripe_apply.sql`
- Modify: `supabase/tests/40_stripe.test.sql`

**Interfaces:**
- Consumes : Task 1 ; `wm.wallet_apply(p_uid, p_delta, p_reason, p_ref)` (`1300`, rejeu = no-op) ; `wm.lock_user`.
- Produces :
  - `wm.stripe_uid(p_candidates text[], p_customer text) returns uuid` : le premier candidat qui a la forme d'un uuid (`~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`) et existe dans `public.profiles`, sinon `user_id` de `stripe_customers` pour `p_customer`, sinon nul.
  - `wm.stripe_apply(p_event jsonb) returns jsonb` : `maintenance` → 503 exact de `1000:74-76` ; `id`, `type` ou `created` absents → 400 « Événement invalide » ; `lock_timeout` ; `insert into wm.stripe_events (id, type, created, livemode) … on conflict (id) do nothing` — pas de ligne → `{duplicate: true, outcome: null}` ; puis G29, joueur résolu → `wm.lock_user(uid)` avant toute lecture de son état ; `update wm.stripe_events set outcome = … where id = …` ; rend `{duplicate: false, outcome}`.
  - Pro (G4) : `v_pro := exists (… status in ('active', 'trialing'))` ; `update public.profiles set is_pro = v_pro where id = uid and is_pro is distinct from v_pro` ; ligne changée et pas de pierre tombale → `pro_started` `{subscription_id}` ou `pro_ended` `{subscription_id}`. `is_vip` n'est jamais lu ni écrit.
  - Notifications (`insert into public.notifications (user_id, type, data)`) : `wb_purchased` `{amount: 2500, session_id}` ; `pro_payment_failed` `{subscription_id, invoice_id}`.
  - Garde d'ordre de l'upsert d'abonnement : `t > event_created`, ou `t = event_created` et ni statut stocké terminal (`canceled`, `incomplete_expired`) ni (`incomplete` reçu sur un autre statut stocké) — G44.
  - Commentaire d'en-tête : G29 en tableau, G5, G44, G35, G38.
- [ ] **Step 1: Tests qui échouent** (`40_stripe.test.sql` ; aide `pg_temp.ev(p_id text, p_type text, p_created bigint, p_object jsonb) returns jsonb` qui bâtit `{id, object: 'event', type, created, livemode: false, data: {object}}`, et `pg_temp.sub(p_id, p_uid, p_status, p_period_end bigint, p_cancel boolean default false)` qui bâtit un abonnement `{id, object: 'subscription', customer: 'cus_bench_<…>', status, cancel_at_period_end, cancel_at, canceled_at, metadata: {uid}, items: {data: [{current_period_end, price: {id: 'price_test_bench_pro'}}]}}`)
  - ***Review Focus*, double crédit** : `checkout.session.completed` `evt_bench_c1` (`mode 'payment'`, `payment_status 'paid'`, `client_reference_id` = A, `metadata.item 'wb_2500'`, `amount_total 499`, `currency 'cad'`, `consent.terms_of_service 'accepted'`) → `{duplicate: false, outcome: 'applied'}`, solde +2 500, une ligne `stripe:cs_test_bench_1`, un achat (`amount 499`, `consent 'accepted'`, `wb 2500`), une `wb_purchased` ; le même événement → `{duplicate: true, outcome: null}`, rien de plus ; `checkout.session.async_payment_succeeded` `evt_bench_c2` de la même session → `applied`, solde inchangé, toujours un achat et une notification ; `pg_temp.inv` vide.
  - Paiement non abouti : `payment_status 'unpaid'` → `outcome 'pending'`, aucun crédit ni achat ; puis `async_payment_succeeded` payé → crédit unique.
  - Mode abonnement : `completed` `mode 'subscription'`, `metadata.item 'pro_monthly'` → achat `pro_monthly` `wb 0`, `is_pro` inchangé, lien Customer posé.
  - ***Review Focus*, Pro allumé** : `customer.subscription.created` `active` (période +30 j) **avant** tout `checkout.session.completed` et sans lien Customer (résolu par `metadata.uid`) → `is_pro` vrai, une `pro_started`, la ligne `subscriptions` exacte (`current_period_end` = `to_timestamp` de l'item), le lien `customer` → A posé ; `trialing` → Pro.
  - ***Review Focus*, Pro éteint** : `updated` `past_due` → `is_pro` faux, `pro_ended` ; `active` revenu → vrai ; `updated` `active` avec `cancel_at_period_end` vrai → Pro gardé ; `deleted` (`status 'canceled'`) → faux, `pro_ended` ; puis un `updated` `active` **plus ancien** (`created` − 10) → `outcome 'stale'`, `is_pro` reste faux, ligne inchangée ; même seconde → réappliqué (`applied`) ; `unpaid`, `incomplete`, `incomplete_expired`, `paused` → faux.
  - ***Review Focus*, départage à égalité (G44)** : `created` `incomplete` et `updated` `active` de même `created` T, envoyés dans l'ordre inverse (`updated` d'abord) → statut final `active`, `is_pro` vrai, le `created` → `stale` ; `deleted` (`canceled`) à T puis `updated` `active` à T → reste `canceled`, `is_pro` faux, `stale` ; `incomplete_expired` à T puis `active` à T → reste `incomplete_expired` ; deux `updated` `active` puis `past_due` à T → `past_due` (réappliqué).
  - Objet incomplet : `completed` payé `wb_2500` avec `amount_total` et `currency` nuls → `applied`, achat `amount 0`, `currency ''`, crédit unique, jamais d'exception.
  - Résolution : `metadata.uid` non uuid (`'abc'`) et Customer inconnu → `outcome 'unresolved'`, aucune exception ; uuid inexistant → `unresolved`.
  - Factures : `invoice.payment_failed` (`parent.subscription_details = {subscription: 'sub_bench_1', metadata: {uid}}`) → `latest_invoice_status 'payment_failed'`, une `pro_payment_failed` `{subscription_id, invoice_id}` ; `invoice.paid` plus récent → `'paid'` ; facture d'un abonnement inconnu → `applied`, rien écrit.
  - Litiges : `charge.dispute.created` (`dp_bench_1`, `amount 499`, `status 'needs_response'`) → une ligne ; `charge.dispute.closed` `status 'lost'` → mise à jour ; un `created` plus ancien rejoué après → ignoré par la garde.
  - Ignorés : type `customer.created` → `outcome 'ignored'`, ligne `stripe_events` présente ; `livemode` vrai sur un `completed` payé → `ignored`, aucun crédit.
  - Refus : `{}` → 400 exact « Événement invalide » ; `maintenance` → 503, **aucune** ligne `stripe_events` (le rejeu après la maintenance passe).
  - Pierre tombale (G38) : A supprimé (`insert into wm.deleted_accounts`) puis `customer.subscription.created` `active` → `stripe_pending` vrai, aucune notification ; `deleted` → `stripe_pending` faux.
  - Erreur injectée : `tests.boom` posé sur `wm.purchases` → l'appel lève, **aucune** ligne `stripe_events` ni de grand livre (même transaction, D:628).
  - `lock_timeout` : `tests.lock_timeout_violations(array['stripe_apply'], array['insert into wm.stripe_events', 'wm.lock_user('])` nul ; `prosrc` : `insert into wm.stripe_events` précède `wm.lock_user(`.
- [ ] **Step 2: `npm run test:db`** → `FAIL 40_stripe.test.sql`.
- [ ] **Step 3: Implémenter `2310`.**
- [ ] **Step 4: `npm run test:db` et contrôles rapides** → vert.
- [ ] **Step 5: Commit** — `feat(db): stripe_apply (événement dédoublonné dans la transaction de l'effet, 2 500 WB crédités une fois par session, abonnement remplacé par l'instantané le plus récent, is_pro dérivé, notifications de la cloche, litiges, pierre tombale signalée)`

---

### Task 3: `2320` — invariants, export, tableau de bord, résiliation

Modèle : fort · deux relecteurs (dont un adverse) : invariants d'argent et résiliation.

**Files:**
- Create: `supabase/migrations/2320_wm_stripe_ops.sql`
- Modify: `supabase/tests/40_stripe.test.sql`, `supabase/tests/20_accounts.test.sql:184`, `31_battles.test.sql:74`, `34_guilds.test.sql:61`, `37_moderation.test.sql:770` et le bloc du tableau de bord (`:910-934`), `39_account.test.sql:7-8` et la liste de clés de l'export (`:505-511`), `contract/spec/account.ts:19-21` (`EXPORT_KEYS` gagne `'purchases'`, `'stripe_customer_id'`, `'subscriptions'`, ordre alphabétique), `contract/spec/admin.ts:23-26` (`Dashboard` strict gagne `stripe_disputes_open: count`, `stripe_pending: count`, `stripe_disputes` et `stripe_pending_users`, tableaux stricts)

**Interfaces:**
- Consumes : Tasks 1, 2 ; `wm.staff_actor`, `wm.admin_reason`, `wm.staff_log`, `wm.idem_claim`, `wm.idem_store` ; corps entiers de `2250:93-205`, `2260:9` et `2240:131` (`staff_dashboard`), en-têtes repris tels quels (`language sql` de `check_invariants`, `stable` de `staff_dashboard`).
- Produces (en-tête « même signature, même corps et même réponse qu'en XXXX (déployée, non retouchée), plus … » pour chacune) :
  - `check_invariants()` : deux contrôles ajoutés en fin d'union — `stripe_purchase` : ligne `reason = 'stripe'` sans achat `wb_2500` de même session et même joueur, ou de `delta` différent de `purchases.wb` (`{check, ref, user_id, problem: 'no_purchase' | 'amount'}`) ; achat `wb_2500` sans ligne de grand livre (`{check, session_id, user_id, problem: 'no_ledger'}`) ; `stripe_pro` : abonnement `active`/`trialing` dont le profil a `is_pro` faux (`{check, subscription_id, user_id}`). Commentaire d'en-tête complété (« Stripe (M6b) : … »).
  - `account_export(p_uid)` : trois clés ajoutées, `stripe_customer_id` (texte ou nul), `subscriptions: [{id, status, current_period_end, cancel_at_period_end, cancel_at, canceled_at, latest_invoice_status, updated_at}]`, `purchases: [{session_id, item, amount, currency, consent, wb, created_at}]`, triées par date puis id ; ni `price_id` ni `customer_id` répété, aucun moyen de paiement (rien n'en est stocké).
  - `staff_dashboard(p_uid)` : clés ajoutées `stripe_disputes_open` (compte, statuts de l'index de G27), `stripe_pending` (compte), `stripe_disputes: [{id, amount, currency, reason, status, created_at}]` (les 20 plus récents ouverts), `stripe_pending_users: [{user_id, username, deleted_at}]` (au plus `admin.page`, plus anciens d'abord).
  - `stripe_cancel_targets(p_user_id)` : `{subscription_ids}` non terminaux (liste de G9), triés.
  - `stripe_cancel_done(p_user_id, p_subscription_ids)` : `lock_timeout` ; `update wm.deleted_accounts set stripe_pending = exists (select from wm.subscriptions where user_id = p_user_id and status in (<liste de G9>) and id <> all (p_subscription_ids)) where user_id = p_user_id` ; `{ok: true, stripe_pending}` (G35).
  - `admin_stripe_cancel(p_uid, p_user_id, p_reason, p_idem)` : chemin staff du M6a (`staff_actor(p_uid, 'admin')`) ; `lock_timeout` ; ligne `wm.deleted_accounts` du joueur `for update` ; absente ou `stripe_pending` faux → 409 « Aucune résiliation en attente » ; `staff_log(p_uid, 'stripe_cancel', 'user', p_user_id::text, v_reason, {subscription_ids})` ; `idem_store` de `{stripe: {user_id, subscription_ids}}`.
- [ ] **Step 1: Tests qui échouent**
  - `40_stripe.test.sql` : `stripe_purchase` — sous `WMT00`, un `wallet_apply(A, 2500, 'stripe', 'stripe:cs_test_bench_x')` sans achat → une violation `no_purchase` ; un achat `wb_2500` sans ligne → `no_ledger` ; un achat `wb 100` avec une ligne de 2 500 → `amount` ; `stripe_pro` — un abonnement `active` inséré à la main sur un profil `is_pro` faux → une violation ; après `stripe_apply`, aucune.
  - Export : après les événements de la Task 2, `account_export(A)` a `stripe_customer_id`, un abonnement, deux achats aux valeurs exactes ; `strpos(export::text, 'price_test_bench')` = 0 ; les clés de premier niveau de `39_account.test.sql:505-511` gagnent `'purchases', 'stripe_customer_id', 'subscriptions'`.
  - Tableau de bord : un litige ouvert et un fermé → `stripe_disputes_open` = 1 ; une pierre tombale `stripe_pending` → `stripe_pending` = 1 et sa ligne dans `stripe_pending_users` ; la liste exacte de `37_moderation.test.sql:924-925` gagne `stripe_disputes`, `stripe_disputes_open`, `stripe_pending`, `stripe_pending_users` (ordre alphabétique).
  - `admin_stripe_cancel` (les trois tests de chaque `wm.admin_*`, P6a:35) : modérateur → 403 « Action réservée aux administrateurs » sans audit ; même `p_idem` deux fois → même corps, **une** ligne d'audit ; motif `'ab'` → 400 ; pas de résiliation en attente → 409 exact ; succès → `{stripe: {user_id, subscription_ids: ['sub_bench_1']}}`.
  - `stripe_cancel_done(D, array['sub_bench_1'])` → `stripe_pending` faux ; ***Review Focus*, abonné supprimé** : un second abonnement `active` `sub_bench_2` inséré entre `stripe_cancel_targets` et `stripe_cancel_done(D, array['sub_bench_1'])` → `stripe_pending` reste vrai ; `stripe_cancel_targets` d'un joueur à `canceled` seul → `{"subscription_ids": []}`.
  - Scan du M6a (`37_moderation.test.sql`) : `admin_stripe_cancel` contient `wm.staff_actor(`, `wm.admin_reason(`, `wm.staff_log(`, `wm.idem_claim(`, `wm.idem_store(` (vert sans modifier le scan).
  - Rejeux : les cinq fichiers listés suivis de `\ir ../migrations/2320_wm_stripe_ops.sql` ; `md5(prosrc)` de `check_invariants`, `account_export`, `staff_dashboard` après le rejeu = avant (assertion dans `40_stripe.test.sql`, rejeu de `2250`, `2260`, `2240` puis `2320`).
  - `lock_timeout` : `tests.lock_timeout_violations(array['stripe_cancel_done', 'admin_stripe_cancel'], array['update wm.deleted_accounts', 'for update'])` nul.
- [ ] **Step 2: `npm run test:db`** → échec.
- [ ] **Step 3: Implémenter `2320` et recaler les rejeux.**
- [ ] **Step 4: `npm run test:db`, contrôles rapides, `npm run build:test && npm run test:contract`** → vert (les deux formes du contrat suivent).
- [ ] **Step 5: Commit** — `feat(db): invariants Stripe (achat ↔ grand livre, abonnement actif ↔ Pro), paiements dans l'export du compte, litiges et résiliations en attente au tableau de bord, résiliation rejouable par un admin`

---

### Task 4: Concurrence de `stripe_apply` et de la suppression

Modèle : fort · deux relecteurs (dont un adverse) : concurrence.

**Files:**
- Create: `supabase/tests/22_stripe_concurrency.test.sh`

**Interfaces:**
- Consumes : Tasks 1 à 3 ; les aides `q`, `fail`, `bg`, `bgo` (sortie gardée dans `$tmp/<nom>.out`, pour lire `{duplicate}`), `player` (qui inscrit le joueur dans `$tmp/users` pour le `cleanup`), `waitall`, `refusals`, `quiet`, `sleeping`, `hold`, `released`, `waiting`, `ms` et le `cleanup` en `trap` de `21_moderation_concurrency.test.sh`, recopiés tels quels, préfixe `22_stripe_concurrency :`, `tag="stripe_$RANDOM$RANDOM"`, ids d'événements `evt_bench_${tag}_<n>` ; le `cleanup` pose `wm.allow_tombstone_delete` puis supprime les joueurs du tag (cascade sur les tables Stripe) et les lignes `stripe_events`/`stripe_disputes` du tag.
- Produces : la liste des scénarios en tête du fichier ; chaque scénario attend : aucun `40P01`, aucun `55P03` hors celui qu'il prévoit, `check_invariants()` = `[]` (dont `stripe_purchase` et `stripe_pro`).
- [ ] **Step 1: Scénarios** (chaque mutation éprouvée rouge une fois, puis remise, notée dans le rapport de tâche)
  - **1. Même événement, deux livraisons** : derrière `hold s1 "perform from public.profiles where id = '$a' for update" 2`, deux `wm.stripe_apply` du même `completed` payé → un `{duplicate: false}` et un `{duplicate: true}`, solde +2 500 exactement, un achat, une `wb_purchased`. Mutation : `on conflict (id) do nothing` retiré → un `23505` (500).
  - **2. `completed` et `async_payment_succeeded` d'une même session, ensemble** → deux `applied`, un seul crédit, un achat, une notification. Mutation : réf. `'stripe:' || p_event ->> 'id'` au lieu de la session → solde +5 000 et `stripe_purchase` en violation.
  - **3. Dix livraisons simultanées** du même événement → neuf doublons, un effet.
  - **4. `updated` (`active`) et `deleted` (`canceled`) ensemble, dans les deux ordres de lancement, une fois à `created` T et T + 5, une fois à égalité (T et T)** → statut final `canceled`, `is_pro` faux dans les quatre cas. Mutations : garde `>=` retirée → l'ordre « `deleted` d'abord » à T + 5 finit `active` et Pro ; départage de G44 retiré → l'ordre « `deleted` d'abord » à égalité finit `active` et Pro.
  - **5. Suppression contre abonnement créé** (G35) : `wm.account_delete(D, …)` et `customer.subscription.created` `active` de D lancés ensemble, dix tours, ordre alterné → `wm.deleted_accounts.stripe_pending` vrai à la fin de chaque tour, aucune notification chez D, `deleted_account` vide. Mutation : `stripe_apply` qui lit `wm.deleted_accounts` avant `wm.lock_user` → au moins un tour avec `stripe_pending` faux.
  - **6. `admin_stripe_cancel` doublé** (même `p_idem`, deux sessions) → corps identiques, une ligne d'audit.
- [ ] **Step 2: `npm run test:db`** → vert ; mutations vues rouges puis remises.
- [ ] **Step 3: Point de contrôle complet** (fin du bloc SQL, DG:1118) : contrôles complets → vert.
- [ ] **Step 4: Commit** — `test(db): concurrence Stripe (événement livré deux et dix fois, deux événements d'une session, instantanés croisés, suppression contre abonnement créé, résiliation admin doublée)`

---

### Task 5: `lib/stripe.ts`, `lib/shop.ts`, schémas, dépendance

Modèle : fort · un relecteur : paramètres de paiement.

**Files:**
- Create: `lib/stripe.ts`, `lib/stripe.test.ts`, `lib/shop.ts`, `lib/shop.test.ts`
- Modify: `lib/schemas.ts`, `package.json`, `package-lock.json`, `.env.example` (après `STRIPE_WEBHOOK_SECRET=` : `STRIPE_PRICE_PRO_MONTHLY=`, `STRIPE_PRICE_WB_2500=` avec « ids price_… créés dans le Dashboard, en CAD (mode test) », et `STRIPE_API_URL=` avec « Facultatif ; vide : https://api.stripe.com (le banc pose son faux Stripe) »)

**Interfaces:**
- Consumes : `RpcResult` (`lib/route.ts:17`), `createAdminClient`.
- Produces :
  - `lib/shop.ts` (sans `server-only`, importable du client) : `SHOP = { pro_monthly: { label: 'Abonnement Pro', mode: 'subscription', cents: 999, currency: 'CAD', interval: 'month', priceEnv: 'STRIPE_PRICE_PRO_MONTHLY' }, wb_2500: { label: '2 500 wikibidous', mode: 'payment', cents: 499, currency: 'CAD', wb: 2500, priceEnv: 'STRIPE_PRICE_WB_2500' } } as const` ; `type ShopItem = keyof typeof SHOP` ; `formatPrice(cents: number): string` → `new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', currencyDisplay: 'code' }).format(cents / 100)` ; `type ShopState` (G34, en TypeScript).
  - `lib/schemas.ts` : `CheckoutInput = z.object({ item: z.enum(['pro_monthly', 'wb_2500'], { error: 'Article inconnu' }) })` ; `ShopQuery = z.object({ session: z.string().regex(/^cs_(test|live)_[A-Za-z0-9_]{1,200}$/).optional() })` (les ids du banc ont des `_`).
  - `lib/stripe.ts` (`import 'server-only'`) :
    - `STRIPE_API_VERSION = '2026-10-28.endive'` ;
    - `stripeClient(): Stripe | null` — nul sans `STRIPE_SECRET_KEY` ; `new Stripe(key, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 1, timeout: 10_000, ...(STRIPE_API_URL && apiTarget(STRIPE_API_URL)) })`, avec `apiTarget(url: string): { host: string; port: string; protocol: 'http' | 'https' }` — `const u = new URL(url)` ; `{ host: u.hostname, port: u.port, protocol: u.protocol.replace(':', '') }` (le SDK ne passe en HTTP clair que pour `protocol === 'http'`, `esm/net/NodeHttpClient.js:28` ; `u.protocol` vaut `'http:'`) ;
    - `stripeFail(status: number, code: string, message: string): RpcResult` — `{ data: null, error: { code: 'P0001', message, details: JSON.stringify({ status, code, error: message, message }) } }` (lu par `toHttpError`) ;
    - `TOS_MESSAGE(origin: string): string` = ``J'accepte les [conditions d'utilisation](${origin}/terms) et je demande l'accès immédiat au contenu numérique acheté : je renonce ainsi à mon droit de rétractation.`` ;
    - `checkoutParams(a: { uid: string; item: ShopItem; customer: string; price: string; origin: string }): Stripe.Checkout.SessionCreateParams` — `mode`, `customer`, `client_reference_id: uid`, `metadata: { uid, item }`, `line_items: [{ price, quantity: 1 }]`, `locale: 'fr'`, `consent_collection: { terms_of_service: 'required' }`, `custom_text: { terms_of_service_acceptance: { message: TOS_MESSAGE(origin) } }`, `success_url` et `cancel_url` de G31 ; `subscription_data: { metadata: { uid } }` pour `pro_monthly`, `payment_intent_data: { metadata: { uid, item } }` pour `wb_2500` ;
    - `checkoutCall(origin: string): (args: Record<string, unknown>) => Promise<RpcResult>` — `rpc('stripe_checkout_prepare', { p_uid: args.p_uid, p_item: args.p_item })` (jamais `args` tels quels : `route()` y ajoute `p_idem`, `lib/route.ts:137-141`, que la fonction n'a pas → PGRST202) ; une erreur de cette RPC ou de `stripe_customer_set` est rendue telle quelle (`toHttpError`) ; client ou Price absent → `stripeFail(503, 'stripe_disabled', 'Paiement non configuré.')` ; sans Customer : `customers.create({ email, metadata: { uid } }, { idempotencyKey: 'customer:' + uid + ':' + sha256hex(email).slice(0, 16) })` (G45) puis `stripe_customer_set` ; `checkout.sessions.create(checkoutParams(…), { idempotencyKey: p_idem ? 'checkout:' + uid + ':' + item + ':' + p_idem : undefined })` ; toute erreur du SDK → `stripeFail(502, 'stripe_unavailable', 'Le paiement est indisponible, réessaie dans un instant.')` et la ligne `{"stripe":"api_failed","op":"checkout"}` ; rend `{ data: { url }, error: null }` ;
    - `portalCall(origin: string)` — `rpc('stripe_portal_prepare', { p_uid: args.p_uid })`, puis `billingPortal.sessions.create({ customer, return_url: origin + '/settings', locale: 'fr' })`, mêmes erreurs ;
    - `cancelSubscription(id: string): Promise<boolean>` — `subscriptions.cancel(id)` ; une `StripeInvalidRequestError` de code `resource_missing` compte comme faite ; toute autre erreur → `false` et `{"stripe":"api_failed","op":"cancel"}` ;
    - `cancelSubscriptionsFor(userId: string): Promise<boolean>` — `stripe_cancel_targets` ; liste vide → `true` **sans créer de client** ; client absent → `false` ; chaque id annulé ; toutes réussies → `stripe_cancel_done({ p_user_id: userId, p_subscription_ids: <ids résiliés> })`, rend `!data.stripe_pending` (un abonnement né pendant les appels garde le drapeau, G35) ;
    - `verifyEvent(body: string, signature: string | null, secret: string): Stripe.Event` — `Stripe.webhooks.constructEvent(body, signature ?? '', secret, 300)` (statique, aucune clé d'API nécessaire).
- [ ] **Step 1: Tests qui échouent** (`vi.mock('server-only', () => ({}))` comme `lib/push.test.ts:6` ; le client Stripe et `@/lib/supabase/admin` mockés)
  - `lib/shop.test.ts` : `formatPrice(999)` = `'9,99 CAD'` et `formatPrice(499)` = `'4,99 CAD'` (comparer à la sortie d'`Intl` du test, pas à une espace tapée) ; `SHOP.wb_2500.wb` = 2500 ; aucune chaîne `meilleur`/`cote` dans `lib/shop.ts` (D:102).
  - `lib/stripe.test.ts` :
    - `checkoutParams pro_monthly` : `mode 'subscription'`, `subscription_data.metadata.uid`, pas de `payment_intent_data`, `consent_collection` et `custom_text` exacts, `success_url` = `'https://x.test/pulls?shop=success&session={CHECKOUT_SESSION_ID}'`, `cancel_url` = `'https://x.test/pulls?shop=cancel'`, `locale 'fr'` ;
    - `checkoutParams wb_2500` : `mode 'payment'`, `payment_intent_data.metadata = { uid, item: 'wb_2500' }`, pas de `subscription_data` ;
    - `checkoutCall sans clé → 503 stripe_disabled` (corps lu par `toHttpError`) ; `arguments de la RPC → exactement { p_uid, p_item }, même avec p_idem dans args` ; `sans Customer → customers.create avec idempotencyKey customer:<uid>:<16 hex de sha256(email)>, puis stripe_customer_set` ; `e-mail changé → autre clé` ; `stripe_customer_set en erreur → son erreur rendue, aucune session créée` ; `erreur du SDK → 502 stripe_unavailable, journal sans la clé ni l'e-mail` ; `idempotencyKey checkout:<uid>:<item>:<clé>` ;
    - `cancelSubscriptionsFor sans abonnement → true sans client` (`STRIPE_SECRET_KEY` absente) ; `resource_missing → true` ; `500 → false, stripe_cancel_done non appelée` ; `succès → stripe_cancel_done appelée avec les ids résiliés` ; `stripe_cancel_done qui rend stripe_pending: true → false` ;
    - `apiTarget('http://127.0.0.1:54321')` → `{ host: '127.0.0.1', port: '54321', protocol: 'http' }` ;
    - `ShopQuery` : `cs_test_bench_k` et `cs_test_a1B2` acceptés, `cs_x`, `cs_test_` et `cs_test_a-b` refusés ;
    - `verifyEvent` : un corps signé par `Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_bench_fake' })` → l'événement ; un octet changé → lève ; horodatage de 301 s → lève.
- [ ] **Step 2: `npm test`** → échec.
- [ ] **Step 3: `npm install --save-exact stripe@23.1.0`, puis implémenter.** Vérifier dans `node_modules/stripe/types/` les noms `Checkout.SessionCreateParams`, `StripeInvalidRequestError`, `items.data[0].current_period_end` avant d'écrire.
- [ ] **Step 4: Contrôles rapides** → vert.
- [ ] **Step 5: Commit** — `feat(lib): Stripe 23.1.0 épinglé (Checkout avec consentement et renonciation, Portail, résiliation, vérification de signature), catalogue de la boutique`

---

### Task 6: Routes boutique, Checkout et Portail, faux Stripe du banc, contrat

Modèle : fort · un relecteur : chemin de paiement.

**Files:**
- Create: `app/api/shop/route.ts`, `app/api/stripe/checkout/route.ts`, `app/api/stripe/portal/route.ts`, `contract/spec/stripe.ts`
- Modify: `app/api/packs/grace/route.ts` (ajout `GET`), `contract/harness.ts` (G36), `contract/spec/index.ts` (`...stripe`)

**Interfaces:**
- Consumes : Tasks 1, 5 ; `route()`, `makeUser`, `api`, `refused`, `psql` (`contract/users.ts`).
- Produces :
  - `GET /api/shop` : `route({ fn: 'shop_state', input: ShopQuery, args: (i) => ({ p_session: i.session ?? null }) })`.
  - `POST /api/stripe/checkout` : `export const POST = (req, ctx) => route({ fn: 'stripe_checkout_prepare', input: CheckoutInput, idem: true, args: (i) => ({ p_item: i.item }), call: checkoutCall(new URL(req.url).origin) })(req, ctx)` ; idem pour le Portail (`fn: 'stripe_portal_prepare'`, `call: portalCall(...)`). Commentaire : « `fn` journalisé ; l'appel Stripe vit dans `call` (G31). »
  - `GET /api/packs/grace` : `route({ fn: 'grace_status' })`.
  - `contract/harness.ts` : les faux de G36 dans `gateway()`, et `export const STRIPE = { key: 'sk_test_bench_fake', webhookSecret: 'whsec_test_bench_fake', pricePro: 'price_test_bench_pro', priceWb: 'price_test_bench_wb' }` ; `stripeRequests(env)` et `resetStripeRequests(env)` exportés.
  - `contract/spec/stripe.ts` : formes strictes `ShopState`, `UrlReply = z.strictObject({ url: z.url() })` ; `source: 'D§7.11'`, `confidence: 'ajouté'`.
- [ ] **Step 1: Tests qui échouent** (`contract/spec/stripe.ts`, chaque erreur au corps entier par `refused`)
  - `noSession` sur `GET /api/shop`, les deux `POST` et `GET /api/packs/grace` → 401.
  - `shop` : `ShopState` strict (dont `maintenance` faux) ; `rules.wb_2500` = `SHOP.wb_2500.wb` (G28) ; `?session=x` → 400 ; un achat `pro_monthly` (`wb 0`, hygiène des invariants) posé par `psql` sous `cs_test_bench_<uuid hex>` → 200 et `purchase` non nul ; `maintenance` à `true` → `maintenance` vrai.
  - `checkout wb_2500` → 200 `UrlReply` commençant par `https://checkout.stripe.com/` ; journal du faux Stripe : un `POST /v1/customers` (clé d'idempotence `customer:<uid>:<16 hex>`, `metadata[uid]`, `email`), puis `POST /v1/checkout/sessions` avec `mode=payment`, `customer=cus_bench_…`, `client_reference_id=<uid>`, `metadata[item]=wb_2500`, `line_items[0][price]=price_test_bench_wb`, `consent_collection[terms_of_service]=required`, `locale=fr`, un `custom_text[terms_of_service_acceptance][message]` qui contient `renonce`, et `stripe_version` = `'2026-10-28.endive'` ; `wm.stripe_customers` a la ligne ; un second achat → **aucun** nouveau `POST /v1/customers`.
  - `checkout pro_monthly` → `mode=subscription`, `subscription_data[metadata][uid]` ; puis abonnement `active` posé par `psql` sur ce joueur passé `is_pro = true` (hygiène) → 409 exact `already_subscribed`, aucun appel au faux Stripe.
  - `item: 'x'` → 400 « Article inconnu » ; `maintenance` (`wm.config`, `try`/`finally`) → 503 et `Retry-After` ; un joueur restreint → 403.
  - `portal` sans Customer → 404 exact ; avec → 200 `UrlReply` (`https://billing.stripe.com/`), `return_url` qui finit par `/settings` ; un joueur restreint → 200 (G39).
  - `grace` : `GET` → `{available: 0, size: null}` ; une dotation posée par `psql` → `{available: 1, size: 5}` ; `POST` (existant) → les cartes, puis `GET` → 0.
- [ ] **Step 2: `npm run build:test && npm run test:contract`** → échec.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert ; `coverage:recap` 90/90.
- [ ] **Step 5: Commit** — `feat(api): boutique (état, Checkout, Portail, dotations de grâce lisibles) et faux Stripe du banc, avec leur contrat`

---

### Task 7: Webhook hors `route()`, fixtures signées, contrat

Modèle : fort · deux relecteurs (dont un adverse) : webhook.

**Files:**
- Create: `app/api/stripe/webhook/route.ts`, `contract/stripe-events.ts`
- Modify: `contract/spec/stripe.ts`

**Interfaces:**
- Consumes : Tasks 2, 5, 6 ; `toHttpError`, `fail`, `INTERNAL` (`lib/route.ts`), `reply` (`lib/cron.ts:7`), `createAdminClient`.
- Produces :
  - `app/api/stripe/webhook/route.ts` : `export async function POST(req: Request): Promise<Response>` — `STRIPE_WEBHOOK_SECRET` absent → `reply(fail(503, 'Paiement non configuré.', 'stripe_disabled'))` ; `const body = await req.text()` ; `verifyEvent` lève → `reply(fail(400, 'Signature Stripe invalide', 'invalid_signature'))` sans RPC ; `createAdminClient().schema('wm').rpc('stripe_apply', { p_event: event })` ; erreur → `reply(toHttpError(error))` (P0001 400/503 recopiés, `BUSY_CODES` → 503, sinon 500) ; succès → `Response.json({ received: true })`. Une ligne JSON par requête : `{route: '/api/stripe/webhook', status, ms, rpc: 'stripe_apply', pg_code, event_type, event_id, duplicate, outcome, vercel_id}` — jamais le corps, la signature ni le secret. Aucun `runtime` exporté (Node par défaut), aucun `maxDuration`.
  - `contract/stripe-events.ts` : `checkoutCompleted(o: { uid: string; session: string; item: ShopItem; paid?: boolean; created?: number; type?: string }): Stripe.Event`, `subscriptionEvent(o: { id: string; uid: string; status: string; type: 'created' | 'updated' | 'deleted'; created: number; periodEnd: number; cancelAtPeriodEnd?: boolean; customer?: string }): Stripe.Event`, `invoiceEvent(…)`, `disputeEvent(…)` ; `signedPost(baseUrl: string, event: object, secret = STRIPE.webhookSecret): Promise<Response>` (`Stripe.webhooks.generateTestHeaderString({ payload, secret })`, en-tête `stripe-signature`). Ids `evt_bench_${randomUUID().replaceAll('-', '')}` à chaque appel (jamais un compteur de module) ; ids de session et d'abonnement des tests tirés de même.
- [ ] **Step 1: Tests qui échouent** (`contract/spec/stripe.ts`)
  - Signature : sans en-tête → 400 exact `invalid_signature` ; signé avec `whsec_test_autre` → 400 ; corps modifié après signature → 400 ; dans les trois cas aucune ligne `stripe_events` (`psql`).
  - ***Review Focus*, porte** : `signedPost` vers le serveur **à porte**, sans cookie → 200 `{received: true}` (jamais 401 ni redirection) ; un `POST /api/stripe/checkout` sans cookie vers le même serveur → 401 de la porte.
  - ***Review Focus*, double crédit (D:1085, « webhook rejoué sans effet »)** : `checkoutCompleted` payé `wb_2500` → 200, solde +2 500 (`GET /api/wikibidous`) ; **le même corps signé renvoyé** → 200, solde inchangé ; `async_payment_succeeded` de la même session → solde inchangé ; `check_invariants()` filtré sur le joueur = `[]`.
  - ***Review Focus*, Pro allumé (D:1085, « le compte devient Pro et a tous ses avantages »)** : `subscriptionEvent created active` → `GET /api/shop` `me.is_pro` vrai ; puis chaque avantage, par sa route : `GET /api/packs/pro-daily` `eligible` vrai et `POST` → 15 cartes, aucune `C` ; `GET /api/marketplace/cards/{id}/sales` → 200 (pas 403 `pro_required`) ; `GET /api/marketplace/mine` `maxConcurrentAuctions` = 10 ; quota de `GET /api/battles` à 10 ; `wm.next_regen_at` à 180 s (`psql`) ; la pastille PRO de la modale reste l'E2E existant (`CardModal.test.tsx:56-59`).
  - ***Review Focus*, Pro éteint** : `updated past_due` → `is_pro` faux et `GET /api/marketplace/cards/{id}/sales` → 403 exact « Fonction réservée aux membres Pro » ; `active` puis `deleted` → faux ; un `updated active` plus ancien envoyé après → reste faux ; `cancelAtPeriodEnd` → `me.subscription.cancel_at_period_end` vrai, `is_pro` vrai.
  - Ordre inversé : `subscriptionEvent created` avant `checkoutCompleted pro_monthly` → Pro ; puis le `completed` → un achat `pro_monthly`, Pro inchangé.
  - Non payé : `checkoutCompleted paid: false` → 200, aucun crédit.
  - ***Review Focus*, pas de 500 en boucle** : type `customer.created` → 200, `outcome 'ignored'` ; `livemode: true` → 200, aucun crédit ; `metadata.uid` inconnu → 200 `unresolved` ; `{"id":"evt_bench_x","object":"event"}` signé (sans `type`) → 400 « Événement invalide », jamais 500.
  - Maintenance : `maintenance` à `true` (`try`/`finally`) → 503, `Retry-After: 1`, aucune ligne `stripe_events` ; levée → le même corps signé → 200 et l'effet.
  - Notifications : `GET /api/notifications` après les cas ci-dessus contient `wb_purchased`, `pro_started`, `pro_ended` ; `pro_payment_failed` après `invoiceEvent payment_failed`.
  - Journal du serveur : la ligne du webhook a exactement les clés de l'Interface ; son texte ne contient ni `whsec_`, ni `t=` de l'en-tête, ni l'uid du joueur.
- [ ] **Step 2: `npm run build:test && npm run test:contract`** → échec.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(api): webhook Stripe (corps brut, signature vérifiée, une RPC, rejeu sans effet, 400/503/500 qui disent à Stripe quand réessayer) et son contrat signé`

---

### Task 8: Résiliation à la suppression de compte et action « Résilier » du staff

Modèle : fort · deux relecteurs (dont un adverse) : suppression.

**Files:**
- Create: `app/api/admin/users/[userId]/stripe-cancel/route.ts`
- Modify: `lib/admin-auth.ts:58-75` (`deleteAccountCall`, plus `withStripeCancel`), `lib/admin-auth.test.ts`, `contract/spec/account.ts`, `contract/spec/admin.ts` (le `Dashboard` strict est déjà recalé par la Task 3)

**Interfaces:**
- Consumes : Tasks 3, 5, 6 ; `cancelSubscriptionsFor` ; `AdminReason`, `UserParams` (`lib/schemas.ts`) ; `staffOf` (`contract/spec/admin.ts`).
- Produces :
  - `deleteAccountCall` : la ligne `// M6b : résilier l'abonnement Stripe ici…` devient `const stripeOk = await cancelSubscriptionsFor(String(args.p_uid))`, **avant** `applyAuthState` ; la réponse gagne `stripe_pending: !stripeOk` ; un échec ne change ni l'ordre ni `auth_pending`.
  - `withStripeCancel(fn: string): (args: Record<string, unknown>) => Promise<RpcResult>` — la RPC ; succès avec `data.stripe` → `cancelSubscriptionsFor(data.stripe.user_id)` ; rend `{ ...data, stripe_synced }`.
  - Route : `POST /api/admin/users/{userId}/stripe-cancel` → `route({ fn: 'admin_stripe_cancel', params: UserParams, input: AdminReason, idem: true, args: (i, { params }) => ({ p_user_id: params.userId, p_reason: i.reason }), call: withStripeCancel('admin_stripe_cancel') })`.
- [ ] **Step 1: Tests qui échouent**
  - `lib/admin-auth.test.ts` (mock de `@/lib/stripe`) : `cancelSubscriptionsFor` appelé avant `deleteUser` (ordre des appels) ; `false` → `stripe_pending: true`, `auth_pending` inchangé ; `withStripeCancel` ajoute `stripe_synced`.
  - Contrat `account.ts` :
    - ***Review Focus*, abonné supprimé, Stripe répond** : joueur `pro: true` (hygiène) avec un abonnement `sub_bench_ok_<uuid hex>` `active` posé par `psql` → `POST /api/settings/delete-account` → 200 avec `stripe_pending: false` ; journal du faux Stripe : un `DELETE /v1/subscriptions/sub_bench_ok_<uuid hex>` ; `wm.deleted_accounts.stripe_pending` faux ;
    - ***Review Focus*, Stripe en panne** : `sub_bench_fail_<uuid hex>` (joueur `pro: true`) → 200 `stripe_pending: true`, la suppression faite (`deleted_at` posé, GoTrue supprimé en douceur) ;
    - sans abonnement → aucun appel au faux Stripe, `stripe_pending: false` ; les cas existants de la suppression restent verts ; chaque cas supprime ses pierres tombales dans son `finally` (`wm.allow_tombstone_delete`).
  - Contrat `admin.ts` : le test crée **sa propre** pierre tombale (joueur `pro: true`, abonnement `sub_bench_fail_<uuid hex>` `active`, suppression par la route) et la supprime dans son `finally` ; elle figure dans `stripe_pending_users` ; un admin `POST …/stripe-cancel` → 200 `stripe_synced: false`, toujours en attente ; la ligne `sub_bench_fail_…` passée à `canceled` et une ligne `sub_bench_ok_<uuid hex>` `active` ajoutée (`psql`) → `stripe_synced: true`, plus en attente, une ligne d'audit `stripe_cancel` par appel ; modérateur → 403 ; joueur sans attente → 409 exact ; motif `'ab'` → 400 ; la ligne JSON de `route()` masque `[userId]`.
- [ ] **Step 2: `npm test && npm run build:test && npm run test:contract`** → échec.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(api): résiliation de l'abonnement Stripe à la suppression du compte, avant GoTrue ; échec signalé et rejouable par un admin`

---

### Task 9: Coquille et modale boutique — solde, pastille PRO, retour de Checkout, notifications

Modèle : courant · un relecteur.

**Files:**
- Create: `components/shop/ShopProvider.tsx`, `components/shop/ShopDialog.tsx`, `components/shop/ShopOffers.tsx`, `components/shop/ShopOffers.test.tsx`, `components/ui/ProBadge.tsx`, `components/shell/Balance.tsx`, `e2e/shop.spec.ts`
- Modify: `app/(game)/layout.tsx` (`ShopProvider` autour du contenu ; en-tête `<Logo/>`, puis `<div className="flex items-center gap-2"><Balance/><Bell/></div>`), `app/(game)/collection/collection-client.tsx:47-92` (solde local retiré, R23 ; `readBalance` → `useShop().reload`, `freshBalance` → `useShop().setBalance`, G42), tout `e2e/collection.spec.ts` (`:19` : `balance = (page) => page.locator('header button[title="Ouvrir la boutique"]')` ; les assertions de `:364`, `:376`, `:420`, `:433`, `:445`, `:544`, `:552`, `:580`, `:608`, `:659`, `:680`, `:693`, `:737`, `:844` gardent leurs textes, « 101 wikibidous », « —Solde indisponible », « 0 wikibidou » ; `routeOnce` sur `**/api/wikibidous` de `:429` devient `**/api/shop*`), `components/card/CardModal.tsx:281-286` (pastille extraite dans `ProBadge`), `lib/notification-view.ts`, `lib/notifications.test.ts`, `e2e/notifications.spec.ts`, `e2e/a11y.spec.ts`

**Interfaces:**
- Consumes : `GET /api/shop`, `POST /api/stripe/checkout`, `POST /api/stripe/portal` (Task 6) ; `Modal`, `HelpDialog` (patron), `button.ts`, `WCoin`, `toast`, `api`, `apiOnce`, `userMessage`, `Loading`, `LoadError` ; `SHOP`, `formatPrice`, `ShopState` (Task 5).
- Produces :
  - `ShopProvider({ children })` et `useShop(): { state: ShopState | null; failed: boolean; reload(): Promise<void>; setBalance(b: number): void; openShop(): void }` — `setBalance` pose `me.balance` et périme toute lecture partie avant (compteur de génération de `collection-client.tsx:52-64`) ; lit `/api/shop` au montage, à chaque changement de `usePathname()` et à `visibilitychange` visible (G42) ; gère le retour de Checkout (G33) ; monte `ShopDialog` quand ouvert.
  - `ShopDialog({ onClose })` : enveloppe de `ShopOffers` qui lit `useShop()` et porte les envois ; `state` nul sans échec → `Loading` « Chargement de la boutique… » ; `failed` → `LoadError` « Réessayer » ;
  - `ShopOffers({ state, busy, error, onBuy, onPortal }: { state: ShopState; busy: ShopItem | 'portal' | null; error: string | null; onBuy(item: ShopItem): void; onPortal(): void })` (présentation pure, testable par `renderToStaticMarkup`, comme `BellButton`) : `Modal` `labelledBy` (`useId`) dans `ShopDialog`, panneau `card-frame relative w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 animate-fade-in-up`, fermeture `size-11` `aria-label="Fermer la boutique"`, `h2` « Boutique ». Deux cartes :
    - « Abonnement Pro » (`ProBadge`, violet), « {formatPrice(999)} par mois », avantages lus de `rules` **et seulement ceux-là** (D:629) : « Un paquet toutes les {pro/60} minutes au lieu de {free/60} » ; « Un paquet Pro de {pro_daily_size} cartes chaque jour, sans aucune commune » ; « {pro} ventes en même temps au lieu de {free} » ; « L'historique détaillé des ventes sur {sales_detail_days} jours » ; « {quota pro} défis de bataille par jour au lieu de {quota free} ». Bouton `primary` « S'abonner » (`aria-label` « S'abonner à Pro pour {prix} par mois »). Déjà Pro par abonnement → « Tu es membre Pro. » et `ghost` « Gérer mon abonnement » (Portail) ; `is_vip` sans abonnement → « Avantages Pro accordés par l'équipe. », sans bouton.
    - « {formatInt(wb)} wikibidous » (`WCoin`), « {formatPrice(499)}, paiement unique », `primary` « Acheter » (`aria-label` « Acheter {n} wikibidous pour {prix} »).
    - `state.maintenance` → `role="status"` « La boutique est fermée pendant la maintenance. » et les deux boutons d'achat `aria-disabled` (G46).
    - Mentions (`text-sm text-foreground/70`) : « Achat de contenu numérique fourni tout de suite : au paiement, tu renonces à ton droit de rétractation. » + lien « Voir les conditions » (`/terms`) ; « Paiement sécurisé par Stripe. Mode test : aucune carte réelle n'est débitée. »
    - Achat : `apiOnce(keys, item, '/api/stripe/checkout', …)`, bouton `aria-disabled` pendant l'envoi, `role="status"` « Redirection vers le paiement… », puis `window.location.assign(url)` ; erreur `role="alert"` `userMessage(e, 'Le paiement n\'a pas pu démarrer.')` (409, 502, 503 recopiés) ; lecture en échec → `LoadError` « Réessayer ».
  - `Balance()` : `button` `aria-haspopup="dialog"` `title="Ouvrir la boutique"` `min-h-11`, contenu recopié de `collection-client.tsx:73-87` (`WCoin`, `formatInt(n)` et `<span className="sr-only"> {wikibidous(n)}</span>` ; en échec `—` `aria-hidden` et `sr-only` « Solde indisponible ») : le nom accessible est le texte, sans `aria-label` ; rien tant que `state` est nul sans échec ; `ProBadge` à côté si `is_pro || is_vip`.
  - `ProBadge({ active = false }: { active?: boolean })` : `<span>` « PRO » (`Sparkles size-3`) aux classes de `CardModal.tsx:281`, `inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold` plus `bg-[var(--color-accent-foreground)] text-violet-300` si `active`, sinon `bg-violet-500/20 text-violet-300` ; `CardModal` passe `active={tab === 'market'}` ; l'en-tête et la boutique, la variante inactive.
  - `notificationView` : les quatre cas du catalogue (bloc commenté « Cloche seulement : aucun type pro_* ni wb_* dans push_types (M6b) »).
- [ ] **Step 1: Tests qui échouent**
  - `ShopOffers.test.tsx` (`renderToStaticMarkup` de `ShopOffers`, comme `BellButton` dans `Bell.test.tsx:3-5`) : avantages exacts pour les `rules` de la Task 1 ; aucune occurrence de « cote », « réserve », « chance » ; prix « 9,99 CAD » et « 4,99 CAD » (via `formatPrice`) ; état VIP sans abonnement ; état Pro avec « Gérer mon abonnement » ; `maintenance` vrai → le statut exact et `aria-disabled="true"` sur les deux boutons.
  - `lib/notifications.test.ts` : les quatre textes et liens exacts ; `pushTypes()` toujours 13.
  - `e2e/shop.spec.ts` :
    - l'en-tête de `/pulls` montre le solde du joueur (`makePlayer({ balance: 120 })` → « 120 ») ; clic → la modale, focus dans le dialogue, Échap → focus rendu au bouton du solde ;
    - « Acheter » → la requête au faux Stripe, `page.route('https://checkout.stripe.com/**')` sert une page factice, l'URL atteinte commence par `https://checkout.stripe.com/c/pay/cs_test_bench_` ;
    - 409 forcé par `routeOnce` sur « S'abonner » → l'alerte exacte ; 503 `maintenance` → son message ;
    - **retour** : `goto('/pulls?shop=success&session=cs_test_bench_<uuid hex>')` puis, après 3 s, un achat `wb_2500` et sa ligne `stripe:` posés par `sql` (`insert into wm.purchases` puis `wm.wallet_apply(…, 2500, 'stripe', 'stripe:<id>')`, hygiène des invariants) → toast « 2 500 wikibidous crédités. », solde relu, URL sans `shop` ; sans achat, horloge avancée (`page.clock`) de 31 s → toast « Ton paiement est en cours de confirmation : il apparaîtra d'ici quelques minutes. » ; `?shop=cancel` → la modale ouverte et « Paiement annulé : rien n'a été débité. » ;
    - lecture en échec, boucle `500` / `200 illisible` sur `**/api/shop*` → « — » dans l'en-tête, `LoadError` dans la modale ;
    - le compte Pro de fixture « carol » (G23, `makePlayer({ pro: true, username: 'carol_' + suffixe })`) sans abonnement → pastille PRO dans l'en-tête, « Tu es membre Pro. » absent et « Avantages Pro accordés par l'équipe. » absent aussi (ni abonnement ni VIP : l'offre reste visible) ;
    - « Chargement de la boutique… » pendant une lecture retenue par `page.route` ;
    - 360 px : en-tête sans défilement horizontal, modale lisible.
  - tout `e2e/collection.spec.ts` vert avec le `balance` de l'en-tête (défausse → « 101 wikibidous » sans navigation).
  - `e2e/notifications.spec.ts` : une `wb_purchased` posée par `sql` → « 2 500 wikibidous crédités » vers `/collection`.
  - `e2e/a11y.spec.ts` : `axe /pulls` modale boutique ouverte → 0 violation grave (`label-content-name-mismatch` compris : l'`aria-label` contient le texte visible).
- [ ] **Step 2: `npm test && npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/shop.spec.ts e2e/collection.spec.ts e2e/notifications.spec.ts e2e/a11y.spec.ts`** → échec.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(ui): modale boutique (Pro et 2 500 WB, avantages lus de la config, mentions de rétractation), solde et pastille PRO dans la coquille, retour de Checkout confirmé par le serveur, notifications de paiement`

---

### Task 10: `/pulls` et fonctions verrouillées — bannière, liens vers l'abonnement, « Comment ça marche ? », paquets offerts

Modèle : courant · un relecteur.

**Files:**
- Create: `components/packs/BonusPacks.tsx`
- Modify: `components/packs/PackStock.tsx:36-52`, `components/packs/ProDailyBlock.tsx:50-55`, `components/packs/HowItWorks.tsx:14-18`, `app/(game)/pulls/pulls-client.tsx`, `components/market/MarketPanel.tsx:54`, `app/(game)/battle/battle-client.tsx:231`, `e2e/pulls.spec.ts`, `e2e/marketplace.spec.ts`, `e2e/battle.spec.ts`

**Interfaces:**
- Consumes : `useShop()` (Task 9) ; `GET`/`POST /api/packs/special`, `GET`/`POST /api/packs/grace` ; `PackOpening` ; `ApiError` (`lib/api.ts:4`).
- Produces :
  - `PackStock` : `remaining < 1` et ni `is_pro` ni `is_vip` → sous « Plus de paquets disponibles » : « Avec Pro, un paquet revient toutes les {pro/60} minutes. » + `link` « Voir l'abonnement » (`openShop`) ; rien pour un Pro (les WB n'achètent pas de paquets, G7).
  - `ProDailyBlock` non-Pro : « Réservé aux membres Pro » suivi du `link` « Voir l'abonnement ».
  - `MarketPanel` : `e instanceof ApiError && e.body.code === 'pro_required'` → le message plus « Voir l'abonnement ».
  - `battle-client` : quota épuisé et `limit < quota_pro` → « Voir l'abonnement » après « Tu as utilisé tes N défis du jour. ».
  - `HowItWorks` (S:84) : périodes, taille du paquet, réserve (`me.pack_cap`) et taille du Pro du jour lues de `useShop().state` ; `failed` → la liste remplacée par « Les règles n'ont pas pu être lues. » ; `state` nul sans échec → `Loading` ; aucune valeur en dur.
  - `BonusPacks({ onCards })` (S:80) : section `aria-labelledby` « Paquets offerts », masquée sans paquet ; un paquet spécial → « {name} : {size} cartes », sa description, `primary` « Récupérer » (`aria-label` « Récupérer {name} ») ; dotations → « Paquet offert par l'équipe : {size} cartes » et « Récupérer » (`aria-label` « Récupérer le paquet offert ») ; `apiOnce` ; succès → `onCards(cards)` (révélation de `PackOpening`) puis relecture ; 404/409 → `userMessage` ; montée par `pulls-client.tsx` sous `ProDailyBlock`.
  - S:82 : aucun changement de code ; commentaire d'une ligne au-dessus de la gestion d'erreur de `ProDailyBlock` qui renvoie à la décision (`docs/decisions-graphify.md`, G22).
- [ ] **Step 1: Tests E2E qui échouent**
  - `e2e/pulls.spec.ts` : stock à 0 d'un joueur gratuit → la bannière exacte et « Voir l'abonnement » ouvre la boutique ; d'un joueur Pro → pas de bannière ; non-Pro → « Voir l'abonnement » dans le bloc Pro du jour ; « Comment ça marche ? » avec `pack_period_s` changé à `{"free":1200,"pro":180}` (`try`/`finally`) → « toutes les 20 minutes » ; lecture `**/api/shop*` en échec → « Les règles n'ont pas pu être lues. » ; un paquet spécial posé par `sql` (`wm.special_packs`, nettoyé en `finally`) → « Récupérer » → la révélation de ses cartes, puis la section disparaît ; une dotation de grâce → idem ; boucle `500` / `200 illisible` sur `**/api/packs/special` et `**/api/packs/grace`.
  - `e2e/marketplace.spec.ts` : un gratuit sur l'onglet « Marché » de la modale → « Fonction réservée aux membres Pro » et « Voir l'abonnement ».
  - `e2e/battle.spec.ts` : quota de 3 épuisé d'un gratuit → « Voir l'abonnement ».
- [ ] **Step 2: `npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/pulls.spec.ts e2e/marketplace.spec.ts e2e/battle.spec.ts`** → échec.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(ui): bannière Pro à stock vide, liens vers l'abonnement des fonctions verrouillées, « Comment ça marche ? » lu de la config, paquets spéciaux et de grâce réclamables sur /pulls`

---

### Task 11: `/settings` « Abonnement » et tableau de bord admin

Modèle : courant · un relecteur.

**Files:**
- Create: `components/settings/Subscription.tsx`
- Modify: `app/(game)/settings/settings-client.tsx` (la section entre `PushSection` et « Compte »), `components/settings/DeleteAccount.tsx`, `app/(game)/admin/dashboard-client.tsx`, `components/admin/types.ts`, `e2e/settings.spec.ts`, `e2e/admin.spec.ts`

**Interfaces:**
- Consumes : `GET /api/shop`, `POST /api/stripe/portal` (Task 6) ; `POST /api/admin/users/{userId}/stripe-cancel` (Task 8) ; `Section`, `ReadError`, `ActionModal` (M6a).
- Produces :
  - `Subscription()` : `Section id="settings-subscription" title="Abonnement"`, lecture propre ; textes : aucun abonnement → « Tu n'as pas d'abonnement. » + `primary` « Voir l'abonnement » ; `active`/`trialing` → « Abonnement Pro actif. Prochain renouvellement le {date}. » ; `cancel_at_period_end` → « Abonnement Pro résilié : tu restes Pro jusqu'au {date}. » (G20) ; `past_due`/`unpaid` → « Le dernier paiement a échoué : ton abonnement Pro est suspendu. Mets à jour ton moyen de paiement. » ; `is_vip` sans abonnement → « Avantages Pro accordés par l'équipe. » ; `has_customer` → `ghost` « Gérer mon abonnement » (Portail, `aria-disabled` pendant l'envoi, erreur `role="alert"`). Dates `toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })`.
  - `DeleteAccount` : à l'ouverture, lit `/api/shop` ; abonnement non terminal → une ligne de plus dans la modale : « Ton abonnement Pro sera résilié tout de suite, sans remboursement. » ; réponse `stripe_pending: true` → le toast de succès gagne « La résiliation de ton abonnement sera terminée par l'équipe. »
  - Tableau de bord : tuiles « Litiges Stripe ouverts » ({n}) et « Résiliations Stripe en attente » ({n}), affichées comme `auth_pending` quand non nulles ; liste des litiges (montant `formatPrice`, motif, date, lien externe « Voir dans Stripe » vers `https://dashboard.stripe.com/test/disputes/{id}`) ; liste des comptes en attente avec « Résilier » (admin) → `ActionModal`, conséquence « L'abonnement Stripe de ce compte supprimé est résilié tout de suite, sans remboursement. » ; toasts « Abonnement résilié. » et, pour `stripe_synced: false`, « La résiliation a échoué chez Stripe : réessaie plus tard. ».
- [ ] **Step 1: Tests E2E qui échouent**
  - `e2e/settings.spec.ts` : les cinq états posés par `sql` (aucun, `active`, `cancel_at_period_end` avec la date exacte, `past_due`, VIP) → textes exacts ; « Gérer mon abonnement » → navigation vers `https://billing.stripe.com/p/session/test_bench_…` (servie par `page.route`) ; 404 forcé → « Aucun abonnement à gérer » ; lecture en échec (boucle) → `ReadError`, « Réessayer » rend le focus au titre ; la suppression d'un abonné montre la ligne de résiliation.
  - `e2e/admin.spec.ts` : une pierre tombale `stripe_pending` et un litige ouvert posés par `sql` → les deux tuiles et les listes ; « Résilier » avec motif → toast « La résiliation a échoué chez Stripe : réessaie plus tard. » (abonnement `sub_bench_fail_<uuid hex>` d'un joueur `pro: true`), puis, la ligne passée à `canceled` et une `sub_bench_ok_<uuid hex>` `active` ajoutée, « Abonnement résilié. » et la ligne disparaît ; un modérateur ne voit pas « Résilier ».
  - `e2e/a11y.spec.ts` : `axe /settings` avec la section, `axe /admin` avec les tuiles → 0 violation grave.
- [ ] **Step 2: `npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/settings.spec.ts e2e/admin.spec.ts e2e/a11y.spec.ts`** → échec.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `feat(ui): section « Abonnement » de /settings (statut, fin de période, Portail), résiliation annoncée à la suppression, litiges et résiliations en attente au tableau de bord admin`

---

### Task 12: Pages légales — abonnement, Stripe, paiements

Modèle : courant · un relecteur.

**Files:**
- Modify: `app/(public)/terms/page.tsx`, `app/(public)/privacy/page.tsx`, `components/legal/LegalPage.tsx:14` (date en prop `updated: string`, `/rules` passe « 31 octobre 2026 »), `app/(public)/rules/page.tsx` (la prop), `lib/auth.ts:2` (`TERMS_VERSION = '2026-11-02'`), `lib/auth.test.ts`, `e2e/legal.spec.ts:15` (date par page) et `:41` (« Version du 2026-11-02 »)

**Interfaces:**
- Consumes : `LegalPage` (M6a, G16) ; Tasks 1 à 3 (ce qui est stocké, gardé et exporté).
- Produces (intertitres et points obligatoires ; phrases rédigées par l'implémenteur, « tu », sans recopier le site d'origine) :
  - `/terms`, section `achats` complétée, section neuve `abonnement` (« Abonnement Pro ») : prix 9,99 CAD par mois et 2 500 wikibidous pour 4,99 CAD, taxes non calculées en mode test ; renouvellement mensuel automatique ; résiliation à tout moment par « Gérer mon abonnement » (Portail), effet à la fin de la période payée, sans remboursement au prorata ; perte de Pro si un paiement échoue ; résiliation immédiate à la suppression du compte, sans remboursement ; aucune promesse de meilleures cotes (C27) ; litiges : un paiement contesté est examiné par l'équipe, sans retrait automatique ; renonciation au droit de rétractation donnée au paiement (case du Checkout) ; mode test tant que l'éditeur ne l'a pas levé (D:104) ; un compte suspendu ou banni (qui ne peut plus se connecter, G11) résilie par le lien de connexion du Portail client reçu par e-mail, ou en écrivant à l'équipe (contact de `/privacy`). « Dernière mise à jour : 2 novembre 2026 » (G40).
  - `/privacy` : Stripe nommé comme prestataire de paiement (traite la carte ; l'application ne voit ni ne stocke aucun numéro de carte, R:487) ; à la création du Customer, l'adresse e-mail et l'identifiant interne du joueur sont transmis à Stripe, qui les garde après la suppression du compte (obligation comptable, G45) ; données gardées : identifiants Customer, abonnement et session, statut et fin de période, achats (article, montant, devise, date, consentement), litiges ; base légale : exécution du contrat et obligation comptable ; conservation : les références de paiement restent après la suppression du compte, le Customer Stripe n'est pas supprimé (G10) ; transfert hors UE par Stripe ; ces données figurent dans l'export (« Mes données ») ; Stripe ajouté à la liste des sous-traitants. « Dernière mise à jour : 2 novembre 2026 ».
- [ ] **Step 1: Tests qui échouent**
  - `lib/auth.test.ts` : `TERMS_VERSION` = `'2026-11-02'` (l'inscription l'enregistre ; le test existant suit la constante).
  - `e2e/legal.spec.ts` : `/terms` a les ancres `achats` et `abonnement`, contient « 9,99 CAD », « Gérer mon abonnement », « rétractation » ; `/privacy` contient « Stripe », « aucun numéro de carte », « e-mail », « export » ; `/terms` contient « banni » ; les deux montrent « 2 novembre 2026 » et `/rules` « 31 octobre 2026 » (`legal.spec.ts:15` par page) ; `/terms` montre « Version du 2026-11-02 » (`:41`) ; ni l'une ni l'autre ne contient « meilleures cotes ».
  - `e2e/auth.spec.ts:8` (case des conditions) reste vert tel quel.
- [ ] **Step 2: `npm test && npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/legal.spec.ts e2e/auth.spec.ts`** → échec.
- [ ] **Step 3: Implémenter.** Relire `/privacy` phrase par phrase contre `2300`, `2310`, `2320` et `lib/stripe.ts` (ce qui part chez Stripe : e-mail, uid en métadonnées ; leçon de DG:1129).
- [ ] **Step 4: Contrôles complets** → vert.
- [ ] **Step 5: Commit** — `docs(legal): abonnement Pro et paiements dans /terms, Stripe et données de paiement dans /privacy, conditions datées du 2 novembre 2026`

---

### Task 13: Parcours boutique de bout en bout (Checkout simulé, webhook signé)

Modèle : courant · un relecteur.

**Files:**
- Create: `e2e/shop-journey.spec.ts`

**Interfaces:**
- Consumes : Tasks 6 à 11 ; `contract/stripe-events.ts` (`checkoutCompleted`, `subscriptionEvent`, `signedPost`) ; `makePlayer`, `login`, `sql`, `routeOnce` ; patron de `e2e/moderation-journey.spec.ts`.
- [ ] **Step 1: Recette** (un seul `test`, `test.setTimeout(180_000)`, `finally` autour de tout le setup)
  1. Seule écriture SQL : le joueur P (`makePlayer({ balance: 0 })`).
  2. P : `/pulls` → solde « 0 » → la boutique → « Acheter » ; `page.route('https://checkout.stripe.com/**')` capture l'URL et répond une page factice ; l'id `cs_test_bench_…` est lu dans l'URL.
  3. Le test envoie `signedPost(baseURL, checkoutCompleted({ uid: P, session, item: 'wb_2500' }))` → 200 ; puis `page.goto('/pulls?shop=success&session=<id>')` → toast « 2 500 wikibidous crédités. », solde « 2 500 ».
  4. ***Review Focus*, rejeu** : le même corps signé renvoyé, puis `page.reload()` → solde toujours « 2 500 » ; `sql` : une ligne `stripe:<session>`.
  5. ***Review Focus*, Pro allumé** : la boutique → « S'abonner » → capture ; `signedPost` de `subscriptionEvent created active` puis du `checkoutCompleted pro_monthly` ; `goto('/pulls?shop=success&session=<id>')` → « Bienvenue chez les membres Pro ! », pastille PRO dans l'en-tête, le bloc Pro du jour offre « Récupérer » ; `/settings` → « Abonnement Pro actif. Prochain renouvellement le … ».
  6. ***Review Focus*, Pro éteint** : `subscriptionEvent deleted` signé → après `reload`, plus de pastille, « Réservé aux membres Pro » et « Voir l'abonnement » ; `/settings` → « Tu n'as pas d'abonnement. ».
  7. `check_invariants()` filtré sur P = `[]` ; la cloche contient `wb_purchased`, `pro_started`, `pro_ended`.
- [ ] **Step 2: `npm run build:test && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test e2e/shop-journey.spec.ts --repeat-each 3`** → vert du premier coup si les Tasks 6 à 11 sont justes ; sinon le défaut se corrige dans le code, jamais dans le parcours.
- [ ] **Step 3: Contrôles complets** → vert.
- [ ] **Step 4: Commit** — `test(e2e): parcours boutique (achat de WB et abonnement par Checkout simulé et webhook signé, rejeu sans effet, Pro allumé puis éteint)`

---

### Task 14: `scripts/stripe-clock.mjs` — horloges de test et contrôle des prix (manuel)

Modèle : courant · un relecteur.

**Files:**
- Create: `scripts/stripe-clock.mjs`, `scripts/stripe-clock.test.ts`

**Interfaces:**
- Consumes : `stripe` (Task 5), `lib/shop.ts` (`SHOP`, montants d'affichage) ; variables `STRIPE_SECRET_KEY` (clé `sk_test_` complète de l'utilisateur, jamais celle de Vercel), `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_WB_2500`.
- Produces :
  - `export function assertTestKey(key: string | undefined): string` — absente → lève « STRIPE_SECRET_KEY absente. » ; ne commence ni par `sk_test_` ni par `rk_test_` → lève « Clé refusée : seule une clé de test (sk_test_ ou rk_test_) est acceptée. » ; le message ne contient jamais la clé ; rend la clé.
  - Commandes (`node scripts/stripe-clock.mjs <commande>`), qui n'impriment que des ids, des statuts et des dates, jamais une clé ni un e-mail :
    - `prices` : lit les deux Prices ; compare `unit_amount`, `currency` (`cad`) et `recurring.interval` (`month` pour Pro, nul pour WB) à `SHOP` ; un écart → sortie 1 (G6) ;
    - `start --uid <uuid>` : `testHelpers.testClocks.create({ frozen_time: maintenant, name: 'wm-demo' })`, Customer `{ test_clock, metadata: { uid }, payment_method: 'pm_card_visa', invoice_settings: { default_payment_method: 'pm_card_visa' } }`, abonnement `{ customer, items: [{ price }], metadata: { uid } }` ; imprime `clock`, `customer`, `subscription`, `status` ;
    - `advance --clock <id> --days <n>` : `advance` puis `retrieve` toutes les 2 s jusqu'à `status === 'ready'` (5 min au plus) ;
    - `fail --clock <id>` : moyen de paiement par défaut remplacé par `pm_card_chargeCustomerFail` (les prochains débits échouent) ;
    - `cancel --clock <id>` : `cancel_at_period_end: true` sur l'abonnement de l'horloge ;
    - `delete --clock <id>` : `testHelpers.testClocks.del` (Customer et abonnement partent avec).
  - En tête du fichier : « Manuel, jamais en CI (le banc et la CI n'atteignent pas api.stripe.com, D:93). Clé de test lue dans l'environnement seulement. »
- [ ] **Step 1: Tests qui échouent** (`scripts/stripe-clock.test.ts`, aucun réseau)
  - `assertTestKey` : `undefined` et `''` → « STRIPE_SECRET_KEY absente. » ; `'sk_live_x'`, `'rk_live_x'`, `'pk_test_x'`, `'whsec_x'` → le message de refus, qui ne contient pas l'argument ; `'sk_test_x'` et `'rk_test_x'` → rendues.
  - `spawnSync(process.execPath, ['scripts/stripe-clock.mjs', 'prices'], { env: { ...process.env, STRIPE_SECRET_KEY: 'sk_live_bench_fake' } })` → sortie 1, `stderr` contient « Clé refusée », ni `stdout` ni `stderr` ne contiennent `sk_live_bench_fake`, aucune requête faite (aucun hôte joignable n'est requis : le refus précède la création du client) ; commande inconnue → sortie 1 et l'aide.
- [ ] **Step 2: `npm test -- scripts/stripe-clock.test.ts`** → échec.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Contrôles rapides** → vert.
- [ ] **Step 5: Commit** — `feat(scripts): horloges de test Stripe et contrôle des prix, à la main, clé de test exigée`

---

### Task 15 (contrôleur): Livraison — migrations sur la démo, réglages Stripe de l'utilisateur, recette en mode test, passation

**Files:**
- Modify: `docs/superpowers/HANDOFF.md`, `docs/suivi.md`, `docs/verifications.md`, `docs/decisions-graphify.md`, `docs/DESIGN.md` (section « Boutique et abonnement » après « Paramètres : données et suppression »)
- Create (non versionnés, `.superpowers/sdd/` ignoré) : `.superpowers/sdd/2026-11-02-m6b-pro-stripe/make-deploy-m6b.sh` et `deploy-m6b.sql`

> Ordre (R32) : base, puis réglages Stripe et variables, puis fusion. `develop` est la branche de production : ses routes appelleraient `wm.shop_state` absente (500 sur l'en-tête de chaque page de jeu).

- [ ] **Step 1: Contrôles complets, revue de branche, PG17.** Tout vert, `coverage:recap` 90/90 ; revue finale (cinq lentilles, puis vérificateurs) et ses corrections ; `ci.yml` (`workflow_dispatch`) → `checks` et `integration` verts sur `postgres:17` ; une correction SQL après le Step 4 est une migration `2330+` ; durées consignées dans `docs/verifications.md`.
- [ ] **Step 2 (contrôleur): Relevé de la démo en lecture seule** (MCP `execute_sql`) : `to_regclass('wm.stripe_events')` nul ; `wm.config` sans `shop` ; dernière ligne de `supabase_migrations.schema_migrations` = `20261031020007` ; `count(*)` de `public.profiles where is_pro` (consigné : les comptes Pro posés à la main le restent jusqu'à un événement d'abonnement, G12) ; `md5(replace(prosrc, E'\r', ''))` de `wm.check_invariants`, `wm.account_export`, `wm.staff_dashboard` = ceux d'une base du banc montée depuis `develop` ; sept jobs `cron.job` actifs ; taille de la base. Un écart se consigne avant d'aller plus loin.
- [ ] **Step 3 (contrôleur): `deploy-m6b.sql`** par `make-deploy-m6b.sh`, modèle de `make-deploy-m6a.sh` (hors dépôt : `/tmp/claude-0/-home-user/920aa50c-9781-594e-8242-046811805fd6/scratchpad/m6a-archive/make-deploy-m6a.sh`, recopié dans `.superpowers/sdd/2026-11-02-m6b-pro-stripe/` avant la tâche ; à défaut, sa description dans `docs/verifications.md`, M6a — livraison) (liste explicite, refus si une migration diffère de `HEAD`, en-tête « généré depuis <tête> ; tout ou rien, relançable tel quel », `begin`, `set local lock_timeout = '5s'`, `cat` de `2300`, `2310`, `2320` entre `-- ===== nom.sql =====`, trois lignes d'historique `2026110201000N` `created_by = 'sql-editor'` `on conflict (version) do nothing`, `notify pgrst, 'reload schema'`, `commit`). L'`alter table wm.deleted_accounts add column` prend un verrou exclusif bref : une expiration annule tout, relancé tel quel.
  - `grep` : aucune migration postérieure à `2320` ne redéfinit `check_invariants`, `account_export`, `staff_dashboard` ; fichiers qui ramènent une ancienne version, pour la passation : `deploy-m6a.sql` (les trois), `2240`, `2250`, `2260` rejouées seules, et ceux que liste déjà H:243-251.
  - **Répétition** (comme au M6a, `docs/verifications.md`) : base de `origin/develop` sans `seed.sql`, deux passes de `psql -X -v ON_ERROR_STOP=1 -f deploy-m6b.sql` → `COMMIT` ; historique inscrit ; `helpers.sql` puis `10_wm_core`, `20_accounts`, `31_battles`, `34_guilds`, `37_moderation`, `39_account` et `40_stripe` de la branche, chacun entre `begin` et `rollback` → verts ; `md5` des fonctions `wm` = tête ; `check_invariants()` = `[]` ; `md5` du fichier livré consigné.
- [ ] **Step 4 (humain, demandé maintenant).** Rien de ceci ne passe par la conversation ; seuls des noms et des « fait » y reviennent.
  1. `deploy-m6b.sql` lancé dans le SQL Editor du projet `iggurckxmoagsajzrnwd` (« Run without RLS »), sans sélection ; en cas d'erreur rien n'est appliqué, relire l'historique avant de relancer le fichier entier.
  2. Dashboard Stripe, **mode test** (compte choisi par l'utilisateur, voir les questions ouvertes) :
     - Catalogue : produit « Abonnement Pro », Price récurrent mensuel **9,99 CAD** ; produit « 2 500 wikibidous », Price unique **4,99 CAD** ; noter les deux ids `price_…` (hors conversation) ;
     - Settings → Public details : nom d'entreprise affiché, URL des conditions `https://wmr-ivm.vercel.app/terms` et de confidentialité `https://wmr-ivm.vercel.app/privacy` (exigée par `consent_collection`) ;
     - Settings → Billing → Customer portal : mise à jour du moyen de paiement et historique des factures activés ; résiliation activée **à la fin de la période** ; changement d'abonnement et mise à jour du client désactivés ; lien de retour par défaut `https://wmr-ivm.vercel.app/settings` ; **lien de connexion du Portail activé** (accès par e-mail, sans session de l'application : un compte banni ou suspendu peut résilier, Task 12) ;
     - Billing → Revenue recovery : relances par défaut, puis **résilier l'abonnement** après la dernière (un `deleted` termine Pro de façon déterministe) ;
     - Developers → Webhooks → Add endpoint `https://wmr-ivm.vercel.app/api/stripe/webhook`, **type de charge utile « Snapshot » (pas « Thin » : un événement thin n'a pas de `data.object`, tout finirait `unresolved`)**, **version d'API `2026-10-28.endive`**, événements : `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.dispute.created`, `charge.dispute.closed` ; copier le secret de signature (hors conversation) ;
     - Developers → API keys → clé restreinte (G16) : Checkout Sessions Write, Customer portal Write, Customers Write, Subscriptions Write, Prices Read, Products Read.
  3. Vercel, projet `wmr`, Production **et** Preview, type « Sensitive » : `STRIPE_SECRET_KEY` (la clé restreinte `rk_test_…`), `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_WB_2500` ; **jamais** `STRIPE_API_URL`.
- [ ] **Step 5 (contrôleur): Contrôles par le MCP**, consignés : aucune table publique neuve ; ACL de `wm` pour `anon`, `authenticated`, `PUBLIC` → 0 ; sondes publiables sans JWT `POST /rest/v1/rpc/stripe_apply` et `GET /rest/v1/stripe_events` (`Content-Profile`/`Accept-Profile: wm`) → 401 `42501` ; `check_invariants()` = `[]` ; `wm.config.shop` ; trigger `deleted_accounts_stripe_pending` présent ; `md5` des trois fonctions redéfinies = répétition ; conseillers `security` et `performance` (au plus des INFO « unused index » du M6b) ; sept jobs inchangés.
- [ ] **Step 6 (contrôleur): Fusion `--no-ff` dans `develop`**, push, déploiement READY ; `/api/health` 200 ; `health.yml` en `workflow_dispatch` → vert ; ***Review Focus*, porte** : `curl -sS -o /dev/null -w '%{http_code}' -X POST https://wmr-ivm.vercel.app/api/stripe/webhook -d '{}'` → **400** (pas 401, 302 ni 503 : l'alias est public, la porte exempte, le secret est posé) ; Dashboard → l'endpoint → « Send test webhook » d'un type ignoré → 200 ; après le premier vrai paiement du Step 7.1, MCP : la ligne `stripe_events` du `customer.subscription.created` a `outcome = 'applied'` (preuve que l'endpoint livre des instantanés).
- [ ] **Step 7: Recette en mode test sur la démo** (critères de D:1085 ; l'utilisateur joue, le contrôleur relève par le MCP ; seuls des comptes de recette, des ids et des statuts sont consignés) :
  1. **Pro avec une carte de test** : un compte neuf A, la boutique → « S'abonner » → Checkout, carte **4242 4242 4242 4242**, date future, CVC quelconque, case des conditions cochée → retour « Bienvenue chez les membres Pro ! » ; MCP : `wm.subscriptions` `active`, `is_pro` vrai, `purchases.consent = 'accepted'`, `stripe_events` `applied` ; A vérifie les avantages : « Récupérer » du Pro du jour (15 cartes sans commune), historique détaillé des ventes, prochain paquet à 3 minutes, pastille PRO.
  2. **2 500 WB** : A achète → +2 500 une fois ; MCP : une ligne `stripe:cs_…`, un achat `wb_2500`.
  3. ***Review Focus*, rejeu (D:1085)** : Dashboard → Webhooks → l'événement `checkout.session.completed` du point 2 → « Resend » → 200 ; MCP : `stripe_events` inchangé (doublon), solde inchangé, `check_invariants()` = `[]`.
  4. 3-D Secure : achat de WB avec **4000 0027 6000 3184** → défi accepté → crédité ; carte refusée **4000 0000 0000 0002** → aucun crédit.
  5. Portail : `/settings` → « Gérer mon abonnement » → résilier → retour → « Abonnement Pro résilié : tu restes Pro jusqu'au … » ; MCP : `cancel_at_period_end` vrai, `is_pro` vrai.
  6. **Horloges de test** (poste de l'utilisateur, sa clé `sk_test_` dans son terminal seulement ; un compte neuf B) : `node scripts/stripe-clock.mjs prices` → sortie 0 ; `start --uid <B>` → B Pro ; `advance --days 32` → `invoice.paid`, fin de période reculée d'un mois, Pro gardé ; `fail` puis `advance --days 32` → `invoice.payment_failed`, `past_due`, Pro retiré, notification « Le paiement de ton abonnement Pro a échoué » ; `delete`. Une seconde horloge : `start`, `cancel`, `advance --days 32` → `deleted`, Pro retiré, `pro_ended`.
  7. ***Review Focus*, suppression** : un compte C abonné (4242) supprime son compte depuis `/settings` → MCP : abonnement `canceled` (webhook `deleted` reçu), `wm.deleted_accounts.stripe_pending` faux, `check_invariants()` = `[]`.
  8. Litige : achat de WB avec la carte de litige de la page de test de Stripe (« Disputes », à relire sur docs.stripe.com/testing) → tuile « Litiges Stripe ouverts » à 1 sur `/admin`.
- [ ] **Step 8: Passation.**
  - `HANDOFF.md` : l'état du M6b ; chaque critère de D:1085 pris ici et sa preuve (Pro avec carte de test : Tasks 2, 7, 13 et Step 7.1 ; avantages : Task 7 et Step 7.1 ; rejeu sans effet : Tasks 2, 4, 7, 13 et Step 7.3) ; la ligne M6 de D:1085 close ; section « **Exploitation de Stripe** » : rejouer un événement (Dashboard → Webhooks → « Resend », 30 jours de rétention), lister les événements non rattachés (`select id, type, received_at from wm.stripe_events where outcome = 'unresolved' order by received_at desc limit 50`), résiliations en attente (tuile, « Résilier »), litiges (tuile, puis Dashboard), changer le secret de webhook (« Roll secret », nouvelle valeur dans Vercel, redéploiement), maintenance (Stripe réessaie 3 h en test, 3 jours en live), comptes Pro posés à la main (`is_pro` réécrit au prochain événement d'abonnement ; `is_vip` pour un geste durable), prérequis du live (nouveaux Prices, endpoint, clés, Stripe Tax et TVA, relecture juridique, D:24) ; la règle de relance des `deploy-*.sql` étendue : « … puis `deploy-m6a.sql`, puis `deploy-m6b.sql` », avec `deploy-m6a.sql` qui ramène `check_invariants` sans `stripe_purchase` ni `stripe_pro`, `account_export` sans paiements et `staff_dashboard` sans tuiles Stripe — **si on l'oublie** : export sans données de paiement, tuiles absentes, deux invariants manquants, sans erreur ; « Étapes humaines ouvertes » : relire `/terms` et `/privacy` (pas un conseil juridique).
  - `docs/suivi.md` : « Réglés au M6b » : S:75 (test VIP), S:76 (décision G22), S:77, S:80 (UI), S:82 (gardé, G22), S:84, la résiliation à la suppression ; reportés : outils staff d'octroi des paquets spéciaux et de grâce (M7, C6), Stripe Tax et TVA, live (D:24) ; « Écarts permis » : D:73, D:631, D:626, D:212 (écarts de ce plan).
  - `docs/decisions-graphify.md` : section « Décisions du plan M6b » (G1 à G26), « Écarts au design (M6b) », « Décisions ajoutées par le plan M6b » (G27 à G43), « Conflits trouvés (M6b) » (C1 à C7), puis les rulings d'exécution.
  - `docs/verifications.md` : relevé, répétition, PG17, contrôles MCP, `curl` de l'endpoint, recette du Step 7 (ids et statuts).
  - `docs/DESIGN.md` : « Boutique et abonnement » (modale, points d'entrée, palette violette, retour de Checkout, section « Abonnement », tuiles), au format de « Batailles ».
- [ ] **Step 9: Commit** — `docs: M6b livré — Pro par Stripe en mode test, boutique, webhook rejoué sans effet, résiliation à la suppression, passation`
- [ ] **Step 10 (contrôleur): Push et CI.** Pousser, `ci.yml` → vert, fusion `--no-ff` dans `develop`, push.

---

## Auto-revue

- **Couverture du spec (D:616-632, D:1085, rulings B1 à B26).**
  - D:618 produits et prix (Task 5, G6), D:620 Checkout avec consentement et renonciation (Tasks 5, 6), D:621 Portail (Tasks 5, 6, 11), D:622 webhook à corps brut et une RPC (Task 7), D:624 `stripe_events` d'abord (Task 2), D:625 crédit unique sous la même réf. (Tasks 2, 4, 7, 13), D:626 statut et `is_pro` dérivé (Tasks 2, 7 ; C5 pour `invoice.*`), D:627 litiges en file staff (Tasks 2, 3, 11), D:628 500 et doublon (Tasks 2, 7), D:629 avantages (Task 7 par route, Task 1 pour VIP), D:630 modale, encarts, bannière, horloges (Tasks 9 à 11, 14), D:631 fixtures signées (Task 7 ; `stripe trigger` remplacé, G15), D:632 recharges et IAP hors périmètre (G7), D:102 aucune promesse de cotes (Tasks 5, 9, 12), D:104 mode test (G29 `livemode`, Task 12), D:738 exemption de porte (Task 7, G37), D:741 états fortify (Task 9).
  - B1 à B26 : G1 à G26, chacune portée par une tâche ; S:75 (Task 1), S:76 et S:82 (G22, Task 10 commentaire, Task 15 suivi), S:77 (Tasks 9, 10), S:80 (Task 10), S:84 (Task 10), `lib/admin-auth.ts:64` (Task 8).
- **Scan des étapes.** Chaque test donne ses valeurs, chaque fonction sa signature, son fichier et ses règles ; aucun corps n'est écrit hors de la table de G29, des paramètres Checkout (G17, Task 5) et du message de consentement, que les tests fixent mot pour mot. Les pages légales gardent leurs points obligatoires sans phrases imposées (G16 du M6a).
- **Cohérence des noms.** Routes → RPC : `shop_state(p_uid, p_session)`, `stripe_checkout_prepare(p_uid, p_item)`, `stripe_customer_set(p_uid, p_customer_id)`, `stripe_portal_prepare(p_uid)`, `grace_status(p_uid)`, `stripe_apply(p_event)`, `stripe_cancel_targets(p_user_id)`, `stripe_cancel_done(p_user_id, p_subscription_ids)`, `admin_stripe_cancel(p_uid, p_user_id, p_reason, p_idem)` — définies aux Tasks 1 à 3 avec ces paramètres. `cancelSubscriptionsFor` (Task 5) sert `deleteAccountCall` et `withStripeCancel` (Task 8) ; `checkoutCall`/`portalCall` (Task 5) servent la Task 6 ; `STRIPE` et `stripeRequests` (Task 6) servent les Tasks 7, 8, 9, 11 ; `contract/stripe-events.ts` (Task 7) sert la Task 13 ; `useShop`/`openShop` (Task 9) servent les Tasks 10 et 11, `useShop().setBalance`/`reload` servent `/collection` ; `ShopOffers` (Task 9) est la présentation testée de `ShopDialog` ; `ProBadge({ active })` (Task 9) sert l'en-tête, la boutique et `CardModal`. Messages : « Article inconnu » en zod et en SQL ; « Aucun abonnement à gérer » seulement au Portail ; « Aucune résiliation en attente » seulement à l'admin.
- **Rulings → tâches (relu après la relecture 1).**

  | Ruling | Tâches | Ruling | Tâches |
  |---|---|---|---|
  | B1 périmètre | toutes | B14 webhook | 7 |
  | B2 SDK | 5, 15 | B15 tests | 2, 4, 6, 7, 9, 13, 14 |
  | B3 endpoint | 15 (Steps 4, 6) | B16 clés | 15 |
  | B4 Pro dérivé | 2, 7 | B17 Checkout | 5, 6 |
  | B5 par état (+ G44) | 2, 4, 7 | B18 paquet de WB | 2, 3 |
  | B6 prix | 5, 14 | B19 maintenance | 1, 2, 6, 7, 9 (G46) |
  | B7 CAD, locale | 5, 15 | B20 « Pro jusqu'au » | 11 |
  | B8 litiges | 2, 3, 11 | B21 boutique | 9, 10, 11 |
  | B9 un abonnement | 1, 6 | B22 dettes | 1, 10, 15 |
  | B10 suppression (+ C2, G35) | 1, 3, 4, 5, 8, 11 | B23 « carol » | 9 |
  | B11 bannissement | 12, 15 (Portail, aucun code) | B24 RGPD | 3, 12 |
  | B12 pas d'action staff | aucun code (G12) | B25 invariants | 1, 3 |
  | B13 notifications | 2, 9 | B26 numérotation | 15 |
- **Tests existants touchés, vérifiés sur le dépôt.** Contrat : `contract/spec/account.ts:19-21` (`EXPORT_KEYS`) et `contract/spec/admin.ts:23-26` (`Dashboard`) recalés à la Task 3, où les réponses changent ; `components/legal/LegalPage.tsx:14` et `e2e/legal.spec.ts:15`, `:41` à la Task 12. Rejeux de `2250` (`20_accounts.test.sql:184`, `31_battles.test.sql:74`, `34_guilds.test.sql:61`), de `2240` (`37_moderation.test.sql:770`) et de `2250`+`2260` (`39_account.test.sql:7-8`) suivis de `2320` ; clés de l'export (`39_account.test.sql:505-511`) et du tableau de bord (`37_moderation.test.sql:910-934`, `contract/spec/admin.ts:23-24`) étendues ; tout `e2e/collection.spec.ts` (le solde quitte `main h1 + p` pour l'en-tête, mêmes textes) ; `components/card/CardModal.test.tsx:56-59` vert avec `ProBadge` (variante inactive) ; `lib/notifications.test.ts` garde 13 `pushTypes()` ; `lib/gate.test.ts:6` inchangé ; `10_wm_core.test.sql:143-160` vert (trigger compris) ; `02_mirror_rls.test.sql` (aucune table publique neuve) ; `lib/auth.test.ts` suit `TERMS_VERSION`.
- **Review Focus.** Chaque ligne a son test dans la tâche qui possède le code : double crédit (Tasks 2, 4, 7, 13), Pro allumé (Tasks 2, 7, 13), Pro éteint (Tasks 2, 4, 7, 13), porte et 500 en boucle (Tasks 2, 7, Step 6 de la Task 15), abonné supprimé (Tasks 1, 4, 8, 11).
- **Proportion.** Quinze tâches (quatorze plus la livraison) pour trois migrations, six fichiers de route, une bibliothèque, une modale, une section de paramètres, deux pages légales et un script : plus petit que le M6a (vingt tâches). Les Tasks 2 et 7 sont les plus lourdes et les plus risquées (argent, ordre, réponses à Stripe) ; leur revue peut se faire en deux moitiés (paiement, puis abonnement et litiges).

## Relecture 1 (deux relectures, 24 constats, 2026-11-02)

Chaque constat vérifié sur le dépôt avant d'être appliqué ; numéros de `6-plan-review.md` (non versionné).

1. Important, égalité de seconde — appliqué selon le ruling du contrôleur : G44 (précise B5/G5), garde dans G29 et la Task 2, quatre tests de départage (Task 2), scénario 4 de la Task 4 aussi à égalité avec sa mutation.
2. Important, regex de `ShopQuery` — appliqué (ruling) : classe `[A-Za-z0-9_]{1,200}` dans G31 et la Task 5, cas acceptés et refusés au test unitaire, `?session=cs_test_bench_<hex>` → 200 au contrat (Task 6).
3. Important, `stripe_cancel_done` qui efface un second abonnement — appliqué (ruling) : `stripe_cancel_done(p_user_id, p_subscription_ids)` recalcule le drapeau hors des ids résiliés (G30, G35, Task 3), `cancelSubscriptionsFor` passe ses ids et rend `!stripe_pending` (Task 5), test d'un second abonnement inséré entre les deux appels (Task 3).
4. Important, e-mail transmis à Stripe absent de `/privacy` — appliqué (ruling, l'e-mail reste envoyé) : point obligatoire de `/privacy`, `lib/stripe.ts` dans la relecture phrase par phrase, mot « e-mail » au test (Task 12), G45.
5. Minor, `p_idem` passé à `stripe_checkout_prepare` — appliqué : arguments explicites `{ p_uid, p_item }` et test unitaire (Task 5) ; fusionné avec le n° 13.
6. Minor, banni sans moyen de résilier — appliqué (ruling, B11 intact) : lien de connexion du Portail activé (Task 15, Step 4) et phrase de `/terms` (Task 12).
7. Minor, clé d'idempotence du Customer et e-mail changé — tranché : la clé inclut 16 hex de `sha256(email)` (G45) plutôt qu'une relance sans clé (qui créerait des doublons à chaque relance réseau) ; une erreur de `stripe_customer_set` est rendue telle quelle (Task 5), avec tests.
8. Important, contrat rouge des Tasks 3 à 7 — appliqué : `EXPORT_KEYS` et `Dashboard` recalés à la Task 3, qui lance `build:test` et `test:contract` ; retiré de la Task 8 ; Global Constraints ajustées.
9. Important, solde de `/collection` — appliqué : `useShop().setBalance`/`reload` remplacent `freshBalance`/`readBalance`, le bouton de l'en-tête recopie le contenu de `collection-client.tsx:73-87` (mêmes textes, nom accessible = texte), sélecteur et lignes de `e2e/collection.spec.ts` nommés (Task 9), G42 corrigée.
10. Important, ids d'événement par compteur — appliqué : `evt_bench_<uuid hex>` dans `contract/stripe-events.ts` (Task 7) et dans la règle d'hygiène (Global Constraints) ; étendu aux ids du faux Stripe (G36), voir « Conflits trouvés » C8.
11. Important, invariants globaux salis par le contrat — appliqué : règle d'hygiène dans les Global Constraints (abonnement actif sur un joueur `pro: true`, achat `pro_monthly` ou avec sa ligne, pierres tombales supprimées), Tasks 6, 8 et 11 recalées, le test admin crée sa propre pierre tombale.
12. Minor, `protocol` `'http:'` — appliqué : `apiTarget(url)` et son test (Task 5) ; preuve `esm/net/NodeHttpClient.js:28` relue dans le paquet.
13. Minor, arguments de `checkoutCall`/`portalCall` — appliqué avec le n° 5.
14. Minor, `37_moderation.test.sql:924-925` compare la liste exacte — appliqué : la liste gagne les quatre clés (Task 3).
15. Minor, date en dur dans `LegalPage` — appliqué : prop `updated`, `/rules` au 31 octobre, `legal.spec.ts:15` et `:41` (« Version du 2026-11-02 » est sur `/terms`) (Task 12, Fichiers).
16. Minor, `HowItWorks` en erreur pendant le chargement — appliqué : message sur `failed`, `Loading` sinon (Task 10).
17. Minor, `ShopDialog` intestable en rendu statique — appliqué : `ShopOffers` de présentation et son test (Task 9).
18. Minor, `ProBadge` à deux variantes — appliqué : `ProBadge({ active })` aux classes exactes de `CardModal.tsx:281` (Task 9).
19. Minor, charge utile « Thin » — appliqué : « Snapshot » imposé au Step 4 et sonde `outcome = 'applied'` au Step 6 (Task 15).
20. Minor, `amount_total`/`currency` nuls — appliqué : `coalesce` dans G29 et un test (Task 2).
21. Minor, aides `bgo` et `player` — appliqué (Task 4), présentes en `21_moderation_concurrency.test.sh:70` et `:84`.
22. Minor, `2260:9` et en-têtes — appliqué : citations corrigées (Global Constraints, Task 3), en-têtes repris tels quels.
23. Minor, `make-deploy-m6a.sh` hors dépôt — appliqué : chemin absolu et copie dans `.superpowers/sdd/2026-11-02-m6b-pro-stripe/` (Task 15).
24. Minor, B23 sans tâche et états de la modale — appliqué : « carol » dans `e2e/shop.spec.ts` (Task 9), « Chargement de la boutique… » et état de maintenance (G46, `shop_state.maintenance`, Tasks 1, 6, 9) ; table des rulings → tâches ajoutée à l'auto-revue.
