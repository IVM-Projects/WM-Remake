# Notes Graphify en attente

Le MCP Graphify n'a qu'un espace de travail actif, « Moi » (`moi-30e114`), et son seul dépôt est `XBZ-E-Sport/xbz-web`, un autre projet. `remember` rattache chaque note à un dépôt : aucune note n'a donc été écrite (2026-10-19, Task 14). Une fois le dépôt de ce projet ajouté à un espace Graphify (étape humaine), rejouer chaque ligne ci-dessous avec `remember`, une note par ligne.

## Décisions du design (D§4.2)

- C1 — Schéma miroir `public` + schéma `wm` : on se branche sur le projet de l'exploitant sans changer la forme d'aucune table, et rien de nouveau n'entre en collision avec une table inconnue.
- C2 — Une fonction PL/pgSQL `security definer` par opération dans `wm`, `EXECUTE` à `service_role` seul, route handlers minces via `route()` : une transaction par requête, la forme de chaque réponse définie à un seul endroit, personne n'agit pour autrui en appelant la base.
- C3 — Transport unique supabase-js → PostgREST partout (binaire PostgREST local dans le bac à sable) : le pool fixe de PostgREST évite la saturation de connexions, et les tests suivent le chemin de la prod.
- C4 — Un seul ordre de verrouillage (ligne métier, `profiles` par id, `wm.user_state`, `user_cards`), `wm.actor()` sans verrou : aucun interblocage possible, prouvé par un test de concurrence.
- C5 — Portefeuille : `profiles.wikibidous_balance` + grand livre `wm.wb_ledger` à clé `(reason, ref, user_id)`, seul écrivain `wm.wallet_apply()`, pas de partitionnement avant 20 M lignes : audit par joueur, double crédit impossible.
- C6 — Idempotence par gardes d'état, clé du grand livre et en-tête `Idempotency-Key` facultatif stocké 24 h : un retry après timeout rejoue la réponse au lieu d'agir deux fois.
- C7 — Échec rapide : `lock_timeout = 2s` sur l'argent (503 `BUSY`, `Retry-After: 1`), `statement_timeout` 5 s : les requêtes échouent vite au lieu de s'empiler.
- C8 — Tirage : rareté par poids puis numéro uniforme dans `wm.draw_pool` dense (swap-with-last) : exactement uniforme, moins d'1 ms, `public.cards` intacte.
- C9 — Catalogue Free : échantillon stratifié proportionnel ≈ 9 % par rareté, par hachage du `page_id` : les cotes restent celles du vrai jeu.
- C10 — `count` copié tel quel, une unité par action, nouveaux tirages en une ligne par copie via `wm.grant_copy()` : ne rien éclater ni fusionner.
- C11 — Rareté affichée en collection = `user_cards.snapshot_rarity` : figée par copie, tranche le §10.1 n° 3.
- C12 — Séquestre : la copie mise en vente quitte `user_cards`, gardée en jsonb dans `wm.auction_escrow`, réinsérée avec un nouvel id : reproduit l'original et résiste aux colonnes inconnues.
- C13 — Verrou d'échange au niveau `card_id`, `pendingTradeCardIds` = union des `card_id` et `user_card_id` : les clients tiers passent dans les deux lectures.
- C14 — Règlement des enchères par pg_cron 10 s + `/settle` + règlement paresseux au GET, une seule fonction idempotente : le gagnant reçoit sa carte en moins de 15 s.
- C15 — Pas de Realtime, polling quand l'onglet est visible : 25 k sockets dépasseraient les quotas, une lecture indexée coûte ≈ 1 ms.
- C16 — Cache `'use cache: remote'` + overlay par utilisateur, TTL court, `revalidateTag('catalog', 'max')` : le polling des bots devient presque gratuit pour la base.
- C17 — Anti-abus : les compteurs en base font autorité, WAF Vercel et `checkRateLimit` en bonus : aucune dépendance à une fonction non confirmée sur Hobby.
- C18 — Quiz : OmniRoute seulement en service container GitHub Actions qui remplit une banque de questions, modèles SQL en secours : une bataille ne bloque jamais sur un LLM, aucun hôte à payer.
- C19 — Un seul cron vers Node : pg_cron appelle `/api/cron/push` seulement si l'outbox n'est pas vide, push immédiat par `after()` : économise le quota d'invocations Hobby.
- C20 — Auth Supabase (e-mail, mot de passe, OTP), Turnstile intégré à GoTrue, clés JWT asymétriques, `getClaims()` local : aucun aller-retour GoTrue par requête, aucun secret JWT dans Vercel.
- C21 — Stripe Checkout + Portal + webhook vers `wm.stripe_apply`, `is_pro` dérivé, test clocks : idempotent et renouvellement démontrable en direct.
- C22 — Licences des images récupérées par le pipeline dans `wm.card_media`, aucun appel navigateur vers Commons : respect des règles Wikimedia, licence affichée.
- C23 — Catalogue construit dans GitHub Actions depuis les dumps Wikimedia, correspondance `page_id` puis titre, formules `stats_v1` gelées : ids stables (D§10).
- C24 — Une seule base Supabase pour démo et previews, migrations expand-only appliquées par Claude via le MCP, approbation manuelle réservée à la bascule : le plan Free limite les projets et il n'y a pas encore de vrais joueurs.
- C25 — `health.yml` une fois par jour (évite la pause du plan Free, ouvre une issue en cas d'échec) : respecte le budget de minutes Actions.
- C26 — Test de charge : données dimensionnées pour 8 Go, k6 sur `next start` dans des runners, courte passe sur Vercel : disque et quota Hobby respectés.
- C27 — Pro : mêmes cotes que le gratuit tant que l'exploitant n'a pas confirmé les siennes, la boutique ne promet pas de meilleures cotes : honnêteté sur les loot boxes.
- C28 — Nouveaux pseudos ASCII `^[A-Za-z0-9_.-]{3,24}$`, unicité sur `lower()`, noms réservés, anciens pseudos gardés : pas d'usurpation par homoglyphes, aucun compte cassé.
- C29 — Erreurs : chaînes françaises levées en SQL (`P0001` + `detail` JSON) et recopiées par `route()`, test de contrat sur les chaînes : les messages vivent avec les règles et les regex tierces matchent.
- C30 — Constantes inconnues dans `wm.config` avec la confiance du recap, quota inconnu désactivé par défaut : corriger une valeur = modifier une donnée, pas le code.
- C31 — Dépôt privé, CI sobre (`ci.yml` léger, intégration ciblée, `quiz-bank.yml` quotidien, catalogue complet seulement en Pro) : le recap ne fuite pas et le budget Actions tient.
- C32 — Déploiement par l'intégration Git Vercel si elle accepte nos commits, sinon MCP Vercel ou CLI avec jeton : ne dépend pas d'un réglage de plan non confirmé.
- C33 — Claude construit, teste, applique les migrations de démo et déploie ; les étudiants relisent et font les étapes liées à leurs comptes : défaut tant que l'utilisateur ne dit pas que les étudiants codent aussi.
- C34 — Aucune capture de session connectée sur le site d'origine sans l'accord de l'exploitant : les règles du site interdisent l'interception du trafic, et un pitch entaché vaut moins que des specs inférées.

## Rulings du M0 qui changent le plan

- R1 — Task 3 : `/api/health/../pulls` attendu `unauthorized` (et non `redirect`) : règle plus simple « tout `/api/*` non exempté → 401 », la propriété utile (refus) est gardée.
- R2 — `bootstrap_local.sql` donne au rôle `authenticator` le mot de passe de test `authenticator` : `postgres:17` en CI authentifie en scram.
- R3 — `bootstrap_local.sql` accorde `usage on schema public` à `anon`, `authenticated`, `service_role` comme Supabase : sinon les tests RLS échouent pour la mauvaise raison.
- R4 — La passerelle locale lit la clé dans `Authorization: Bearer` ou, à défaut, dans `apikey` (`sb_publishable_test` → JWT anon, `sb_secret_test` → JWT service_role) : imite la passerelle Supabase pour les nouvelles clés.
- R5 — `wm.wallet_apply` verrouille la ligne `profiles` (`for update`) avant de lire le solde pour l'écriture d'ouverture : pas de montant d'ouverture périmé sous concurrence.
- R7 — Matcher de `proxy.ts` sans l'exception `.*\.(woff2|png|svg|ico)$` (seuls `_next/static` et `_next/image` restent exclus) : n'importe quel chemin `*.png` contournait la porte et le noindex.
- R8 — `X-Robots-Tag: noindex, nofollow, noarchive` posé sans condition par `next.config` sur `/:path*`, en plus du proxy : couvre les redirections et les fichiers statiques (D§3.4 non négociable en démo).
- R10 — Redirection `/pull` → `/pulls` (308) déplacée de `next.config` vers `proxy.ts`, avant la porte : les en-têtes de `next.config` n'atteignent pas ses redirections.
- R11 — Index partiel `profiles_avatar_user_card_id_idx` (`where avatar_user_card_id is not null`) ajouté dans `1000_wm_core` : sinon `on delete set null` balaie `profiles` à chaque copie supprimée.
- R12 — `0002_mirror_rls` fait `revoke all` sur les 6 tables de `public` (de `public`, `anon`, `authenticated`) avant ses `GRANT` : un projet aux droits par défaut larges laisserait `count`/`snapshot_*` modifiables.
- R13 — Pas de `alter default privileges … revoke execute` dans `wm` (sans effet en PG) : chaque migration `wm` finit par sa paire revoke/grant, contrôlée par le scan de verrouillage de `10_wm_core.test.sql`.
- R14 — Bouton de fermeture de la feuille « Plus » libellé « Fermer le menu » (et non « Fermer », réservé à la modale de carte pour les extensions, R§6.8) ; focus rendu à « Plus » à la fermeture (D§8.6).
- R15 — `/api/health` à 200 sur Vercel reporté : bloqué par des étapes humaines (`SUPABASE_SECRET_KEY` + redéploiement, branche de production `develop` ou `master`) ; le chemin est prouvé par le contrat local et la CI.

## Écart au design

- Écart : tables miroir créées par domaine, au jalon qui les utilise (M0 cœur, M3 marché, M4 échanges et social, M5 batailles, guildes, progression) au lieu d'un seul `0001` complet : ne figer aucune colonne sans le contexte de son domaine.

## Résultats des vérifications du M0

- Vérifications M0 (2026-10-19) : Next 16.4.2 (`proxy` en runtime Node, `cacheComponents` actif, `'use cache: remote'` via une fonction auxiliaire dans les route handlers, `revalidateTag(tag, profile)` à deux arguments) ; Vercel Hobby : 1 règle de rate limit WAF par projet, `checkRateLimit` disponible mais consomme cette règle, Runtime Cache partagé par toute l'équipe et purges limitées à 50/s ; image `diegosouzapw/omniroute:3.8.51` active sur Docker Hub (tirage à confirmer en CI au M5) ; PostgREST v12.2.3 épinglé `9f71269e…7c` ; GRANT explicites et exposition de `wm` vérifiés à la Task 12 ; clés JWT asymétriques reportées au M1 ; TypeScript 5.9.3 builde, et TS 7 est pris en charge par `next build` via le `tsc` local (contrairement à la note du plan). Détail : `docs/verifications.md`.
