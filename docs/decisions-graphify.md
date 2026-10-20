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

## Décisions du plan M1

- M1-1 — Banc d'auth : vrai GoTrue en binaire épinglé, pas `supabase start` (pas de démon Docker dans le bac à sable, et C3 veut le même chemin en prod, en CI et en local) ; GoTrue migre lui-même le schéma `auth`, le stub `auth.users` disparaît et les tests SQL tournent sur la vraie table.
- M1-2 — Pas de helper `wm` sans HTTP pour les Server Components au M1 : les pages de jeu sont des composants client qui appellent les routes du contrat, comme l'original, et c'est ce trafic qu'observent les extensions (R§3.0) ; à reconsidérer au M3 pour les pages publiques mises en cache.
- M1-3 — Défausses hors grand livre (C5) : `wallet_apply` crédite `p_reason = 'discard'` sans écrire de ligne et le compte dans `wm.user_stats.discard_wb` ; l'invariant devient Σ ledger + `discard_wb` = solde, et l'écriture d'ouverture vaut `solde − discard_wb`.
- M1-4 — Catalogue d'essai synthétique (`supabase/seed.sql`, 2 000 cartes « Article d'essai n° NNNN ») : le bac à sable n'atteint pas Wikimedia et le M2 charge le vrai catalogue ; pas de cache partagé sur `/api/cards` au M1 (`shortcut:`, cache du D§9.5 au M2).
- M1-5 — Vérification humaine avant le tout premier paquet : un nouveau joueur n'a pas de `human_verified_until`, son premier « Ouvrir » renvoie 403, comme le veut D§7.0 (« sans elle, 403 »).

## Rulings du M1

Format : ce qui a été tranché — coût si c'est faux.

- R1 — Le cas de contrat d'auth de la Task 1 vérifie le JWT de session GoTrue (ES256, kid `wm-test-es256`) et que PostgREST l'accepte ; l'assertion du pseudo du profil passe aux cas GoTrue de la Task 10, car le trigger n'existe qu'à la Task 3 — une assertion ajoutée plus tard.
- R2 — Turnstile `dev-bypass` sans `NEXT_PUBLIC_TURNSTILE_SITE_KEY` admis : c'est de la configuration et le serveur échoue fermé (le vrai siteverify le rejette, sans secret → refus) — une démo déployée sans clé de site bloque les paquets, sans contournement.
- R3 — La Task 16 fusionne dans `develop` (`--no-ff`), applique les migrations de démo et règle les variables Vercel sans redemander (consignes de l'utilisateur, C24) — un merge réversible et des migrations idempotentes.
- R4 — Écarts de la Task 1 acceptés (`GOTRUE_MAILER_URLPATHS_*`, `GET /auth/v1/verify` et jwks sans `apikey` comme Supabase, `OTP_EXP` 3600, `makeUser` via `tests.make_user`) : ils alignent le banc sur Supabase — aucun en prod (banc seul).
- R5 — Constats A1 (lignes de `make_user` inutilisables par GoTrue `/user` : `instance_id`, `aud`, `role` et jetons nuls) et A3 (`GOTRUE_SMTP_MAX_FREQUENCY` de 60 s par défaut, qui casse le renvoi du code) traités comme importants et corrigés tout de suite, avec deux mineurs bon marché — un petit diff de plus.
- R6 — Trois mineurs de `route()` faits à la Task 9 (premier usage de `pre`) : `fail` exporté, `Retry-After: 1` par défaut sur tout 429/503, HEAD lit la requête comme GET — quelques lignes de plus.
- R7 — À toute consommation de paquet, `packs_last_regen_at = now()` quand le stock était plein ou la date nulle, sinon un profil migré sous le plafond ne régénère jamais — le premier minuteur d'un joueur migré part de sa première ouverture.
- R8 — Correction à la racine dans `wm.apply_regen` : stock sous le plafond et date nulle → l'horloge démarre (date = maintenant, aucun crédit), pour les inscriptions comme pour les lignes migrées ; R7 reste pour la Task 5 — un joueur migré régénère à partir de sa première visite (comportement d'origine le plus plausible, R§5.1).
- R9 — Une passe sur trois mineurs : fuseau nul ou inconnu de Postgres → `Europe/Paris` par un helper SQL commun à toutes les fonctions de paquets ; `check (size > 0)` sur `special_packs` et `grace_grants` ; commentaire de `pg_temp.err` corrigé — un petit diff.
- R10 — `safe_tz` par sonde de l'exception 22023 plutôt que `pg_timezone_names` (10 ms par appel sous le verrou de ligne) — aucun effet atteignable par l'API.
- R11 — Une passe sur quatre mineurs de confidentialité et d'exactitude : filtres d'étiquette sur la collection d'un autre limités aux étiquettes du lecteur ; `p_sort` nul → `rarity` ; remplissage initial de `user_rarity_counts` sous `lock_timeout` après purge des lignes périmées ; deltas des triggers par colonnes explicites, pas par cast positionnel — un petit diff.
- R12 — Pas de paramètre `p_pending` (D§7.3 : `pending=1` accepté sans effet, la Task 10 l'accepte et l'ignore) ; `rarityCounts` ignore `q` dans `profile_collection` (comptes du profil entier, R§3.3) — une clause SQL plus tard.
- R13 — La Task 7 remplace le `truncate` du remplissage par `delete` et retire `usage` du type `wm.rarity_delta` à `public` — aucun.
- R14 — Fonction d'index immuable sortie de `wm` vers le schéma dédié `wm_index` (usage et execute à `public`, non exposé à PostgREST), `language sql immutable parallel safe`, noms qualifiés, sans `security definer` : sinon tout écrivain de `public.cards` (option A) aurait besoin d'`EXECUTE` — un nom de schéma de plus à porter, réversible.
- R15 — Ordre dans une rareté = `draw_pool.seq` (D§7.4) dans tous les modes (`order by rarity desc, seq nulls last, id`) — une clause ORDER BY.
- R16 — Passe de tests seulement, car la CI ne relance pas : 429 déterministe (`last_open_at` dans le futur), cas du fuseau invalide exact par le plafond quotidien (600 → 429 `rate_limit_daily`, `retry_after` = prochain minuit à Paris), message anti-bot et `retry_after` ISO épinglés — aucun (tests).
- R17 — Consigne du contrôleur corrigée : `captchaToken` passé tel quel (`dev-bypass` compris, le GoTrue du banc a le captcha désactivé) ; la seule branche qui dépend de la clé reste dans `<Turnstile>` — aucun.
- R18 — Aucune dépendance ajoutée (ni Testing Library ni jsdom) : tests vitest par `renderToStaticMarkup` pour le DOM de Card et la modale initiale ; les cas d'interaction (Échap et focus, `Idempotency-Key` de « Défausser », retrait d'étiquette) passent dans les E2E de `/collection` (Task 14) — bugs d'interaction trouvés une tâche plus tard.
- R19 — Q-Score affiché comme sur l'original (« Q-Score : 51.24 », deux décimales et un point, R§6.5), car les extensions lisent le DOM ; les autres nombres restent en fr-FR (`formatInt`) — un appel de format.
- R20 — Couleurs de la modale changées pour le contraste (ATK/DEF `red-400`/`blue-400`, extrait `neutral-900/90`, méta `/60`) : la barrière D§8.6 l'emporte sur les classes descriptives du R§6.5, qui ne sont pas des sélecteurs du R§6.8 ; à consigner dans `allowed-diffs.yaml` au M7 — une extension qui stylerait par ces classes (aucune connue).
- R21 — `[role=listbox] li[role=option] button` gardé (fidélité R§6.5), boutons d'option non focalisables (`tabindex -1`, clavier par le combobox, `aria-activedescendant`) ; nested-interactive restant listé comme écart de contrat connu pour le M7 — une exception axe listée.
- R22 — Une passe sur six mineurs visibles avant la démo : compteur de génération pour qu'une relecture du stock lancée avant une ouverture n'écrase pas le compte ; « Réessayer » à côté du stock après un échec ; état en cours visible en animation réduite ; `PackOpening` protège un paquet vide et replace le focus quand « Carte suivante » est désactivé ; `AudioContext` créé dans le clic « Ouvrir » (premier son sur iOS) ; surcharge `draw_weights` des E2E rendue sous condition — un petit diff.
- R23 — Aucune tâche ne porte le solde du shell : la Task 14 l'affiche en haut à droite de `/collection` (WCoin + `formatInt`, `GET /api/wikibidous`, mis à jour par les réponses de défausse) ; le solde dans tout le shell vient avec la boutique (M6) — déplacer un composant.
- R24 — `opacity-80` sur les RarityChips non sélectionnées au lieu de 50, pour le contraste (précédent R20) ; à consigner au M7 avec R20 et R21 — une classe.
- R25 — Une passe : `next.toString()` au lieu de `URLSearchParams.size` (absent de navigateurs pris en charge par Next 16) ; E2E de recherche déterministe ; focus jamais sur body ; requête d'API construite depuis les cinq clés lues ; sélection vidée au changement de filtre, de tri ou de recherche ; favori à 0 ligne = erreur et retour arrière ; erreurs de lecture des étiquettes et du solde visibles ; nom d'étiquette blanc refusé ; confirmation de défausse en masse en style danger — un petit diff.
- R26 — zod accepté dans le bundle client de `/collection` (le client écarte les mauvaises valeurs d'URL avec les schémas du serveur, sans dérive) ; à revoir seulement si un budget de bundle est fixé au M7 — un validateur écrit à la main.
- R27 — État de `/global-collection` gardé dans React, pas dans l'URL (le brief ne le demande pas, `shortcut:` en place) — porter l'helper d'URL à cinq clés de `/collection`.
- R28 — `select` natif avec `aria-label="Trier les cartes"` accepté (le recap retient l'aria-label comme sélecteur, pas l'élément, et seul le tri par rareté existe dans l'API) ; « bouton » contre `select` consigné pour la parité M7 — changer l'élément.
- R29 — Une passe : le formulaire de mot de passe ne s'envoie jamais nativement (bouton désactivé avant l'hydratation, plus `method="post"`, audit de tous les formulaires d'`app/`), et les mineurs de la revue (grille vide périmée, refus serveur gardé au blur, message de succès seulement si le serveur a gardé la valeur, classe de bouton partagée, focus nommé dans les tests) — un petit diff.
- R31 — Revue finale de toute la branche AVANT la fusion dans `develop` et le déploiement (`develop` est la branche de production de Vercel), puis une vague de correction, puis les Steps 3 à 7 de la Task 16 — la démo en ligne un cycle de revue plus tard.
- R32 — Une vague de correction en trois agents successifs (ports du banc partagés) : A auth et navigation (`URL.canParse`, navigation de document après chaque succès d'auth, adresse hors de l'URL, codes d'erreur hébergés, boutons d'envoi `aria-disabled` après l'hydratation) ; B interface de jeu (`userMessage` pour les 5xx, une Idempotency-Key par intention, stock vide annoncé, défausse après fermeture, favori gardé sur grille périmée, ouvreur de modale par montage, en-tête animé une fois, lien Wikipédia de 44 px) ; C base, tests, CI et docs (`where true` pour pg-safeupdate, rejeu et concurrence des paquets Pro, spéciaux et de grâce, téléchargements réessayés et mis en cache, journaux de CI en échec, passation). Différé : `maskPath` sur segment littéral (journaux seulement). Base de démo (Step 4) avant la fusion (Step 3), sonde du cache de schéma au Step 7 — un cycle de revue de plus avant la démo.

## Écart au design

- Écart : tables miroir créées par domaine, au jalon qui les utilise (M0 cœur, M3 marché, M4 échanges et social, M5 batailles, guildes, progression) au lieu d'un seul `0001` complet : ne figer aucune colonne sans le contexte de son domaine.

## Résultats des vérifications du M0

- Vérifications M0 (2026-10-19) : Next 16.4.2 (`proxy` en runtime Node, `cacheComponents` actif, `'use cache: remote'` via une fonction auxiliaire dans les route handlers, `revalidateTag(tag, profile)` à deux arguments) ; Vercel Hobby : 1 règle de rate limit WAF par projet, `checkRateLimit` disponible mais consomme cette règle, Runtime Cache partagé par toute l'équipe et purges limitées à 50/s ; image `diegosouzapw/omniroute:3.8.51` active sur Docker Hub (tirage à confirmer en CI au M5) ; PostgREST v12.2.3 épinglé `9f71269e…7c` ; GRANT explicites et exposition de `wm` vérifiés à la Task 12 ; clés JWT asymétriques reportées au M1 ; TypeScript 5.9.3 builde, et TS 7 est pris en charge par `next build` via le `tsc` local (contrairement à la note du plan). Détail : `docs/verifications.md`.
