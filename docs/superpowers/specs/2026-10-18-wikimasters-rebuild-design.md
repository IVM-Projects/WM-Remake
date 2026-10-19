# WikiMasters : conception de la reconstruction

> **Date** : 2026-10-18. **Statut** : conception finale. Le builder planifie et construit à partir de ce document sans repasser par l'utilisateur. Chaque point ouvert a un **défaut** à appliquer.
> **Référence de comportement** : `docs/rea-recap.md` (le « recap », cité §x.y). Ce document ne recopie pas le recap : il tranche, fixe les défauts et dit où vit chaque chose. Pour le détail d'un comportement, lire la section citée. Quand ce document contredit le recap, ce document l'emporte : la décision a été prise en connaissance du recap et de ses conflits (§8.4, §10).
> **Origine** : proposition gagnante « parité et migration d'abord », avec les meilleures idées des propositions « performance d'abord » et « simplicité d'abord », et la correction de toutes les erreurs relevées par les deux juges. Une correction est signalée par « **(corrige …)** ».

---

## 1. Intention et pourquoi

### 1.1 Ce qu'on construit
Une reconstruction complète de WikiMasters (recap §1). Elle garde le même jeu, les mêmes pages (§2), la même API (§3), les mêmes données (§4), les mêmes règles (§5) et la même interface (§6), sur Next.js, Supabase et Vercel. Elle doit pouvoir **remplacer l'original sans que les joueurs ni les outils tiers ne voient de différence**, sinon qu'elle fonctionne mieux.

### 1.2 Pourquoi : la vente à Naïm
L'original (Naïm Ouellet et 2 développeurs, code en grande partie écrit avec Claude, §1.2) est passé d'environ 10 k à plus de 200 k joueurs par jour après le ZEvent, et il tombe sous la charge (§1.4). Le but est de lui proposer de reprendre notre reconstruction. Le pitch a lieu quand l'app est opérationnelle et finie (§4.1).

Arguments de vente, chacun démontrable en direct au pitch :
1. **Elle tient la charge là où la sienne tombe.** Rapport k6 (§9) mis en regard de chaque incident du §1.4 : collection à 20 s, 504, saturation du pool, gros échanges en échec, bots.
2. **La bascule se fait sans perte et sans déconnexion.** Option A (on se branche sur son projet Supabase), kit de migration répété, rapprochement à zéro écart (§11).
3. **La parité est prouvée, pas affirmée.** Tests de contrat route par route, captures REA ancien contre nouveau, test des sélecteurs DOM des extensions, matrice `docs/parity.md` (§11.6).
4. **Bonus : les failles de l'original sont corrigées.** Paquets ouverts pour autrui, historique « Gagnées » tronqué, images sans licence, modération absente (masquage automatique des images signalées, sanctions, audit).

### 1.3 Plan B
S'il n'achète pas, le même dépôt sort sous **notre marque** (une valeur de configuration) avec **notre catalogue** (formules `stats_v1`, §10). Aucune donnée de joueur de l'original n'est jamais aspirée. Le schéma MIRROR devient tout simplement notre schéma. Changent alors : la marque, les pages légales, Stripe en mode live et les plans payants (Vercel Pro est obligatoire pour un usage commercial).

---

## 2. Objectifs, non-objectifs, anti-objectifs

### 2.1 Objectifs
- **O1. Parité fonctionnelle complète.** Toutes les pages des §2.1 et §2.2, toutes les routes du §3, toutes les règles du §5. Chaque entrée de la navigation marche de bout en bout : « tout doit marcher » (§4.1), donc aucune page vide ni bouton factice.
- **O2. Contrat d'API identique** (§8 de ce document) pour l'UI officielle et les plus de 20 outils tiers (§7.2 du recap).
- **O3. Migration A ou B sans perte** (§11). Les colonnes sacrées (§4.4) ne sont jamais recalculées.
- **O4. Tenir la charge cible** avec des chiffres mesurés (§9).
- **O5. Preuves présentables au pitch** : rapport de charge, rapport de parité, rapport de répétition de migration.
- **O6. Maintenable par 3 étudiants** : une seule app, un seul endroit pour la logique, aucun service superflu.
- **O7. Accessible** (WCAG 2.2 AA) et entièrement en français.

### 2.2 Non-objectifs (ne pas construire)
- App native ou Capacitor, achats intégrés Apple/Google, version anglaise (§1.1, §7.1).
- Supabase Realtime ou WebSocket (l'original n'en a pas, §7.1).
- Thème clair (conflit §8.4 n° 19).
- Concours, parrainage, collections sponsorisées « en collectionner 10 » (§10.4 : non spécifiés). Les paquets spéciaux (§7.2) suffisent pour un événement.
- Lancement public à 200 k DAU sur les plans gratuits : la démo est privée.
- Aide aux bots tiers (snipe, auto-enchère) : interdits par /rules.
- Copie des assets de l'original : logo, PNG de rareté, sons, visuel du paquet.

### 2.3 Anti-objectifs (échec, même si l'app « marche »)
- **A1. Usurpation publique.** La marque WikiMasters visible hors de la porte démo, une page indexée par un moteur, ou un asset original copié.
- **A2. Perte ou corruption de données.** Une colonne sacrée recalculée, un UUID changé, un `count` éclaté ou fusionné, des WB crédités deux fois, une copie dupliquée ou perdue en séquestre, des étiquettes perdues hors des cas prévus (§4.2 : retour de vente, échange).
- **A3. Régression du contrat.** Chemin, forme JSON, base de pagination, chaîne d'erreur française, en-tête ou sélecteur DOM du §6.8 modifié sans être listé dans `parity/allowed-diffs.yaml`.
- **A4. Reproduire un incident du §1.4** : statement timeouts, 504, saturation du pool, collection à 20 s, gros échange en échec ou à moitié commité, paquets ouverts pour autrui, historique tronqué, images sans licence.
- **A5. Démo trompeuse** : faux totaux, cotes faussées par un sous-catalogue, chiffres estimés présentés comme mesurés.
- **A6. Jouer ou aspirer l'original sans consentement** (/rules §3, RGPD).
- **A7. Une bataille bloquée par un LLM**, ou un paiement crédité deux fois ou pas du tout.
- **A8. Des joueurs déconnectés** à la bascule en option A.

---

## 3. Contraintes

### 3.1 Pile imposée et versions (épingles exactes dans `package.json`, sans `^` ni `~`)

| Élément | Version |
|---|---|
| next | 16.4.2 (App Router, `proxy.ts`, `cacheComponents`) |
| react / react-dom | 19.3.1 |
| typescript | strict, dernière stable au M0 |
| tailwindcss | 4.3.3 (jetons dans `@theme`) |
| lucide-react | 1.59.0 |
| @supabase/ssr / @supabase/supabase-js | 0.12.7 / 2.118.0 |
| zod | dernière 4.x stable au M0, épinglée |
| stripe | 23.0.0 |
| web-push | 3.6.7 |
| @marsidev/react-turnstile | 1.6.2 |
| vitest / @playwright/test (+ @axe-core/playwright) | 5.0.5 / 1.64.1 |
| omniroute | 3.8.51, image `diegosouzapw/omniroute:3.8.51` (tag à vérifier au M0) |
| rea-agents | 6.7.0 |
| PostgREST (tests du bac à sable) | v12.2.3, binaire statique |
| Postgres | 17.11 en prod ; 16 dans le bac à sable (SQL compatible 16 et 17, sans `MERGE … RETURNING`) |
| Node | 24 en CI et sur Vercel ; le code doit aussi tourner sur 22.22 (bac à sable) |

### 3.2 Plans et comptes
> **Décidé avec l'utilisateur (2026-10-19)** : plans **gratuits** (Supabase Free, Vercel Hobby) pendant toute la construction (M0 à M7). **Supabase Pro pendant environ un mois autour du pitch (M8)** pour charger le catalogue complet et faire le vrai test de charge (≈ 25 à 35 $), puis retour au Free. Vercel ne passe en Pro qu'en cas de vente ou de plan B commercial.
> **Règle Supabase à respecter** : les projets créés après le 30 mai 2026 (le nôtre date du 16 octobre) n'exposent plus les tables à PostgREST par défaut. Chaque migration qui crée une table ou une fonction exposée doit contenir ses `GRANT` explicites (à vérifier au M0).
- **Supabase** : projet `vlazmfshvuborizccqza` (eu-west-3 Paris, PG 17.11, vide). Plan Free supposé : 500 Mo de base, pause après 7 jours sans activité, 2 projets actifs. Le plan Pro coûte 25 $/mois, inclut 8 Go de disque et facture le compute à l'heure. Extensions disponibles : pg_cron 1.6.4, pg_net, pg_trgm, unaccent, pgtap, plpgsql_check, pg_partman 5.3.1. Côté e-mails : l'expéditeur intégré n'envoie que quelques e-mails par heure, et un SMTP personnalisé est limité par défaut à 30 inscriptions par heure (réglable).
- **Vercel** : équipe XBZ, plan Hobby (usage non commercial, crons au plus quotidiens, quota d'invocations limité). Fonctions en région `cdg1`. La disponibilité de la règle WAF `rate_limit`, de `@vercel/firewall` et du runtime cache sur Hobby est **à vérifier au M0** ; aucune fonction critique n'en dépend (§7.0).
- **GitHub** : dépôt `ilan9903/wikimaster`. Actions : 2 000 min/mois si le dépôt est privé, 6 h maximum par job.
- **Services** : Stripe en mode test (CAD), Cloudflare Turnstile, Brevo SMTP, clés de fournisseurs pour OmniRoute.

### 3.3 Réseau du bac à sable
- **Joignables** : npm, GitHub, y compris les binaires de release (le binaire statique PostgREST v12.2.3 se télécharge, HTTP 200), et les MCP Supabase, Vercel, GitHub et Stripe.
- **Injoignables** : wiki-masters.com, Wikimedia (dumps et API), l'API Stripe, l'hôte Postgres Supabase en direct, Docker.
- **Outillage local** : Node 22.22.0 (OmniRoute exige ≥ 22.22.2, il n'est donc pas installable ici) ; PG16 local avec pg_trgm et pgcrypto, sans pg_cron ni pgTAP.
- **Conséquence** : tout ce qui touche Wikimedia, OmniRoute, Stripe réel, un navigateur ou la pile Supabase complète tourne dans GitHub Actions. Le bac à sable teste le SQL, le contrat HTTP (PostgREST local) et les unités sur fixtures.

### 3.4 Légal et éthique (non négociable)
- **Marque** : une seule valeur de configuration. La marque d'origine n'apparaît que derrière la porte démo, et le démarrage échoue si cette marque est configurée sans porte. Toutes les pages sont en noindex.
- **Aucun asset original copié** : les fonds de rareté, le pack, les sons et le logo sont recréés.
- **Aucune automatisation ni aspiration de wiki-masters.com sans consentement.** Sans accord, on se limite aux pages publiques à faible volume et à l'observation passive (REA) de sessions jouées à la main. Les données de joueurs ne viennent que du dump fourni par l'exploitant (§8.0 du recap).
- **Licences** : la ligne CC BY-SA 4.0 du texte, plus l'auteur et la licence Commons de chaque image (§7.3 du recap).
- **Âge et jeux d'argent** : case 18+ obligatoire. Le Checkout contient la renonciation au droit de rétractation pour le contenu numérique. Pour les loot boxes (ANJ, PEGI 16), on n'affiche jamais de cotes inventées et on ne promet pas de « meilleures cotes » Pro tant qu'elles n'existent pas (§7.11).
- **RGPD** : export et suppression du compte dans les Paramètres. À la migration, les joueurs sont informés avant le changement de responsable de traitement.
- **Stripe** reste en mode test jusqu'à un accord explicite.

---

## 4. Décisions

### 4.1 Décisions prises avec l'utilisateur (telles que décidées)
1. Reconstruire WikiMasters à l'identique fonctionnel sur **Next.js, Supabase et Vercel**, avec **zéro régression** et une **migration sans perte de données ni de clients**.
2. Le but est de **vendre la reconstruction à Naïm**. **Plan B** : la sortir sous notre propre marque.
3. Les **trois arguments de vente** : elle tient la charge, la bascule est sans douleur, la parité est prouvée.
4. **Marque en configuration et démo privée** (porte par mot de passe et noindex). Aucune copie des assets d'origine.
5. **Éthique de capture** : ni jeu scripté ni aspiration sur le site live sans consentement. Les données des joueurs ne viennent que de l'exploitant.
6. **Outils** : OmniRoute génère les quiz de bataille ; REA sert à la rétro-ingénierie et à la preuve de parité ; Graphify fournit le graphe de code ; Impeccable porte le design system. Le catalogue est construit dans GitHub Actions, parce que le bac à sable n'atteint pas Wikimedia.
7. **Comptes cibles** : projet Supabase `vlazmfshvuborizccqza`, équipe Vercel XBZ, dépôt `ilan9903/wikimaster`.
8. **Maintenance** par une équipe de 3 étudiants.
9. Le recap REA est **juste** et sert de référence. Le pitch a lieu **dès que l'app est opérationnelle et finie**, et **tout doit marcher** (dernier message de l'utilisateur).

### 4.2 Décisions de Claude
Chaque ligne ci-dessous est une **décision de Claude**. Elle s'applique tant que l'utilisateur ne la change pas, et chacune se renverse à faible coût.

| # | Décision (de Claude) | Pourquoi |
|---|---|---|
| C1 | **Schéma miroir + schéma `wm`.** `public` reprend les noms, types et UUID du §4. Tout ce qui est nouveau va dans `wm`. En option A, les seuls ajouts permis sur `public` sont des triggers, des index créés `CONCURRENTLY` et des policies RLS de **lecture** manquantes. | On se branche sur son projet sans changer la forme d'aucune table, et aucune table nouvelle ne peut entrer en collision avec une table inconnue (§9.1, §10.2). |
| C2 | **Une fonction PL/pgSQL `SECURITY DEFINER` par opération** dans `wm`, avec `EXECUTE` réservé à `service_role`. Elle construit le JSON exact de la réponse. Les route handlers restent minces : un seul helper `route()`. | Une transaction et un aller-retour par requête. La forme de chaque réponse est définie à un seul endroit. Personne ne peut agir pour autrui en appelant la base directement (§1.4). |
| C3 | **Transport unique : supabase-js vers PostgREST**, en prod, en CI et dans le bac à sable (binaire PostgREST local). Vercel n'ouvre jamais de connexion Postgres. **(corrige** la proposition gagnante : l'adaptateur `pg` est supprimé, car le binaire se télécharge.**)** | Le pool fixe de PostgREST supprime la saturation de connexions de l'original. Les tests du bac à sable passent par le même chemin que la prod. |
| C4 | **Un seul ordre de verrouillage** : ligne métier (enchère, échange, souhait de guilde), puis `profiles` triés par id, puis `wm.user_state` dans le même ordre, puis `user_cards`. `wm.actor()` vérifie l'acteur **sans verrouiller**. **(corrige** la défausse de la proposition gagnante, qui verrouillait la copie avant le profil, et le `actor(lock)` de « simplicité », qui provoquait un interblocage entre deux surenchères croisées.**)** | Aucun interblocage possible. Un test de concurrence le prouve (§12). |
| C5 | **Portefeuille** : la colonne `profiles.wikibidous_balance` reste le modèle de lecture, doublée d'un grand livre `wm.wb_ledger` à clé unique `(reason, ref, user_id)`. Seul écrivain : `wm.wallet_apply()`. Une mise débite tout de suite et rembourse le meneur précédent. Les défausses unitaires sont comptées dans `wm.user_stats`. Le grand livre **n'est pas partitionné au départ** : l'unicité globale de la clé est incompatible avec un partitionnement par date. Seuil de bascule : 20 M de lignes (`shortcut:` dans le code). | Audit par joueur après la bascule (§8.2 du recap), double crédit impossible, volume raisonnable. |
| C6 | **Idempotence** par gardes d'état, clé du grand livre et `stripe_events`, plus un **en-tête `Idempotency-Key` facultatif** stocké dans la même transaction pendant 24 h. Notre UI l'envoie sur chaque action. | Un retry après timeout rejoue la réponse stockée au lieu d'agir deux fois (le « 500 mais peut-être commité » du §5.6). Les clients tiers sans en-tête gardent le comportement d'origine. |
| C7 | **Échec rapide** : `lock_timeout = 2s` sur les fonctions monétaires, qui répondent alors 503 `BUSY` avec `Retry-After: 1`. `statement_timeout` à 5 s pour `service_role` et `authenticated`. | Les requêtes échouent vite au lieu de s'empiler. |
| C8 | **Tirage** : rareté tirée par poids (`null` = part de la rareté dans le catalogue chargé), puis numéro uniforme dans `wm.draw_pool(rarity, seq)`, dense et maintenu par échange avec le dernier (*swap-with-last*). Les 5 tirages sont indépendants, donc les doublons restent possibles. | Exactement uniforme sur le catalogue, l'hypothèse du §5.1. Moins d'1 ms. `public.cards` n'est pas touchée. |
| C9 | **Catalogue sur le plan Free** : échantillon stratifié **proportionnel** d'environ 9 % de chaque rareté (≈ 250 k cartes), choisi par hachage du `page_id`. Les totaux affichés sont les vrais totaux chargés. **(corrige** la proposition gagnante : son sous-ensemble « toutes les L, UR et SR » rendait les L environ 14 fois trop fréquentes.**)** | Les cotes et les proportions restent celles du vrai jeu. |
| C10 | **`count`** : copié tel quel ; les lignes à `count > 1` sont gérées partout, à raison d'une unité par action. Les nouveaux tirages créent une ligne par copie via `wm.grant_copy()`. | Ne rien éclater ni fusionner (§4.2). Un seul endroit à changer si DUMP-D montre un modèle empilé. |
| C11 | **Rareté affichée en collection** : `user_cards.snapshot_rarity`. | Figée par copie comme pour les enchères, ce qui tranche le §10.1 n° 3. |
| C12 | **Séquestre** : la copie mise en vente quitte `user_cards`. La ligne entière est gardée en jsonb dans `wm.auction_escrow`, puis réinsérée avec un nouvel id et sans étiquettes. | Reproduit le §4.2 et résiste aux colonnes inconnues de sa table. |
| C13 | **Verrou d'échange au niveau `card_id`.** `pendingTradeCardIds` renvoie l'union des `card_id` et des `user_card_id` concernés. | Tranche le §10.1 n° 4 côté serveur, et les tests d'appartenance des clients passent dans les deux lectures. |
| C14 | **Règlement des enchères** : pg_cron toutes les 10 s (`skip locked`), plus `/settle`, plus un règlement paresseux au GET. Les trois appellent la même fonction idempotente. Les enchères échues non réglées restent listées tant qu'elles sont `active` (parité). | Couvre le conflit n° 15. Le gagnant reçoit sa carte en moins de 15 s, au lieu d'1 à 2 min. |
| C15 | **Pas de Realtime.** On interroge (polling) seulement quand l'onglet est visible. La cloche lit PostgREST en direct. | 25 k sockets dépassent les quotas. Une lecture indexée coûte environ 1 ms. |
| C16 | **Cache** : `'use cache: remote'` pour les lectures partagées, plus un *overlay* par utilisateur. Pas de `revalidateTag` à chaque mise : on s'appuie sur un TTL court. Pour le catalogue : `revalidateTag('catalog', 'max')`. **(corrige** la proposition gagnante : `'use cache'` seul ne cache que dans la mémoire de chaque instance, et `revalidateTag` à un argument est déprécié en Next 16.**)** | Le polling des bots devient presque gratuit pour la base. |
| C17 | **Anti-abus** : les compteurs en base, dans les RPC, font autorité. Le WAF Vercel et `checkRateLimit` sont un bonus s'ils existent sur le plan. | Aucune dépendance à une fonction non confirmée sur Hobby. |
| C18 | **Quiz** : OmniRoute tourne seulement comme service container dans GitHub Actions (`quiz-bank.yml`) et remplit une banque de questions par carte. Les batailles lisent la banque, sinon des modèles SQL instantanés. Aucun hôte permanent. **(corrige** les deux déploiements OmniRoute de la proposition gagnante.**)** | Une bataille ne bloque jamais sur un LLM. Pas d'hébergement à payer. |
| C19 | **Un seul cron vers Node** : pg_cron appelle `/api/cron/push` via pg_net **seulement si l'outbox n'est pas vide**. Le push immédiat passe par `after()`. **(corrige** les appels pg_net non conditionnés, environ 216 k invocations par mois.**)** | Économise le quota d'invocations Hobby. |
| C20 | **Auth** : Supabase Auth (e-mail, mot de passe, OTP), Turnstile en captcha intégré de GoTrue, trigger sur `auth.users`. Clés de signature JWT **asymétriques**, donc `getClaims()` vérifie en local. Nom du cookie fixé par variable d'environnement en option B. | Fonctions natives de la plateforme, aucun aller-retour vers GoTrue par requête, aucun secret JWT dans Vercel. |
| C21 | **Stripe** : Checkout, Portal et webhook vers `wm.stripe_apply`. `is_pro` est dérivé de l'abonnement. Test clocks pour la démo. | Idempotent, rien à construire côté paiement, renouvellement démontrable en direct. |
| C22 | **Licences des images** récupérées par le pipeline (Commons `extmetadata`) et stockées dans `wm.card_media`, sans aucun appel à Commons depuis le navigateur. **(corrige** la proposition gagnante : des millions d'appels navigateur vers Commons.**)** | Respect des règles d'usage de Wikimedia, et licence affichée pour chaque image. |
| C23 | **Catalogue** construit dans GitHub Actions à partir des dumps Wikimedia. Correspondance par `page_id`, puis par titre. Ids stables. Formules `stats_v1`, gelées sur le catalogue de Naïm. | §10. |
| C24 | **Une seule base Supabase** pour la démo et les previews. Migrations *expand-only*. Pendant la construction, Claude les applique lui-même sur le projet de démo via le MCP Supabase ; l'approbation manuelle est réservée à la bascule de production (§11.5). La CI tourne sur une pile Supabase locale. | Le plan Free limite le nombre de projets, et il n'y a pas encore de vrais joueurs : bloquer chaque migration sur un humain ralentirait sans rien protéger. |
| C25 | **Santé** : `health.yml` tourne une fois par jour. Il évite la pause du plan Free et ouvre une issue en cas d'échec. **(corrige** le `uptime.yml` toutes les 10 min, environ 4 320 jobs par mois.**)** | Respecte le budget de minutes Actions. |
| C26 | **Test de charge** : jeu de données dimensionné pour tenir dans 8 Go. k6 vise `next start` sur des runners GitHub, avec une courte passe sur Vercel. **(corrige** le seed de 20 M copies, qui dépassait le disque.**)** | Disque Pro respecté, quota Hobby préservé. |
| C27 | **Pro** : mêmes cotes que le gratuit tant que Naïm n'a pas confirmé les siennes. La boutique ne promet pas de meilleures cotes. | Honnêteté sur les loot boxes (§3.4). Les poids sont réglables dans `wm.config`. |
| C28 | **Pseudos** : nouveaux noms en ASCII `^[A-Za-z0-9_.-]{3,24}$`, unicité sur `lower()`, liste de noms réservés. Les pseudos existants restent valides tels quels. | Évite l'usurpation par homoglyphes dans les noms de vendeurs et ne casse aucun compte existant. |
| C29 | **Erreurs** : chaînes françaises levées en SQL (`P0001` avec un `detail` JSON) et recopiées telles quelles par `route()`. Un test de contrat vérifie les chaînes du §6.7. | Les messages vivent à côté des règles, et les regex des outils tiers continuent de matcher. |
| C31 | **Le dépôt reste privé** (vérifié) : le recap ne doit pas fuiter avant le pitch. Budget Actions de 2 000 min/mois tenu par une CI sobre : `ci.yml` léger sur chaque PR, job d'intégration (Supabase local + Playwright) seulement sur `main` et à la demande ; `quiz-bank.yml` une fois par jour au lieu de toutes les 6 h ; construction complète du catalogue seulement en plan Pro (sinon le mode échantillon). | Rendre le dépôt public exposerait la rétro-ingénierie (A1). |
| C32 | **Déploiement** : intégration Git Vercel si elle accepte nos commits ; sinon (règle Hobby sur l'auteur des commits d'un dépôt privé) déploiement par le MCP Vercel ou la CLI avec jeton. | Ne dépend pas d'un réglage de plan non confirmé. |
| C33 | **Qui construit** : Claude construit, teste, applique les migrations de démo et déploie ; les étudiants relisent, jouent les parcours et font les étapes qui exigent leurs comptes (créations de comptes, DNS, secrets). Les tâches du plan sont découpées pour un builder IA, avec une revue humaine par jalon. | Défaut tant que l'utilisateur ne dit pas que les étudiants codent aussi. |
| C34 | **Aucune capture de session connectée sur wiki-masters.com sans l'accord de Naïm**, même jouée à la main : /rules §3 interdit l'interception du trafic, et un pitch entaché vaut moins que des specs inférées. Sans accord : pages publiques seulement ; les §3.7 à §3.10 restent « inféré » dans la matrice. | Prudence éthique et commerciale (A6). |
| C30 | **Constantes inconnues** dans `wm.config`, avec la confiance du recap en commentaire (§7). Un quota inconnu est désactivé par défaut plutôt qu'inventé. | Corriger une valeur revient à modifier une donnée, pas le code. |

---

## 5. Architecture

### 5.1 Schéma d'ensemble

```
Navigateur (UI Next, polling visible seulement)
 │ HTTPS
 ├──────────► Vercel cdg1 · Next 16.4.2
 │             proxy.ts      : refresh de session @supabase/ssr, redirection /login, porte démo, X-Robots-Tag
 │             app/(game)/*  : Server Components ──┐
 │             app/api/*     : route() = getClaims → zod → 1 RPC wm.* → JSON | erreur FR
 │             after()       : push immédiat
 │                                                 │ HTTPS keep-alive (PostgREST, pool fixe ; aucune connexion pg)
 │                                                 ▼
 └─ PostgREST direct ──────► Supabase eu-west-3 · PG 17 · Auth (GoTrue) · PostgREST · pg_cron · pg_net
   (seulement ce que         public : tables miroir du §4 + RLS + RPC sync_profile_packs / get_my_profile
    fait l'original :        wm     : toute la logique (PL/pgSQL), config, grand livre, compteurs, séquestre, quiz…
    tags, user_card_tags,    pg_cron: règlement 10 s, expirations, rétention ; pg_net → /api/cron/push si outbox ≠ ∅
    wishlist_items, starred,
    chat read, lectures cards/auctions/auction_bids/achievements, cloche)

GitHub Actions : ci · db (migrations, approbation) · catalog (Wikimedia → COPY → wm.catalog_merge)
                 quiz-bank (OmniRoute en service container → wm.card_quizzes) · parity (REA + HAR) · load (k6) · health
Externes       : Stripe (Checkout, Portal, webhook) · Turnstile (captcha GoTrue + /api/human-check)
                 Brevo SMTP (e-mails d'auth FR) · upload.wikimedia.org (miniatures en lien direct)
```

### 5.2 Arborescence du dépôt (`ilan9903/wikimaster`)

```
package.json · next.config.ts (cacheComponents, headers noindex) · proxy.ts
app/
  layout.tsx · globals.css (@theme) · robots.ts · icon.tsx · not-found.tsx
  (public)/   page (landing) · login · signup · forgot-password · reset-password · verify-email · rules · terms · privacy · credits · gate
  callback/route.ts
  (game)/     layout.tsx (shell §6.3) · pulls · pull (308 → /pulls) · collection · global-collection · trades · trades/[id]
              marketplace · marketplace/[auctionId] · battle · battle/[id] · guild · friends · dms · profile · profile/[username]
              achievements · leaderboard · settings
  admin/      health · reports · cards · users · audit
  api/        un dossier par route du §3 + stripe/{checkout,portal,webhook} · push/subscribe · settings/* · cards/[id]/credits
              cards/[id]/image-report · username-available · leaderboard · admin/* · cron/{push,revalidate} · health
components/   card/{Card,CardModal,SellBox} · packs/PackOpening · shell/{Sidebar,BottomBar,Bell} · ui/*
lib/          route.ts · supabase/{server,browser,admin}.ts · brand.ts · tz.ts · turnstile.ts · stripe.ts · push.ts
              poll.ts (usePoll, pause si onglet caché) · format.ts (fr-FR, espace fine) · contract.ts (schémas zod du §3)
supabase/     config.toml · templates/*.html (e-mails FR)
  migrations/ 0001_mirror_core.sql · 0002_mirror_rls.sql · 0003_mirror_rpc.sql      (MIRROR : jamais en option A)
              1000_wm_core.sql · 1100_wm_packs.sql · … · 1900_wm_moderation.sql      (ADDITIVE : partout)
              9000_wm_cron.sql                                                       (seulement si pg_cron/pg_net existent)
  tests/      bootstrap_local.sql (stub auth.users, auth.uid(), rôles) · *.test.sql
  seed.sql    (2 000 cartes de fixture ; comptes alice, bob, carol (Pro), mod)
catalog/      src/{sqldump,pageviews,cirrus,extracts,wikidata,commons,compute,emit,load}.ts · fixtures/
scripts/quiz/ generate.ts · prompt.ts · schema.ts
contract/     spec/*.ts (une RouteSpec par route) · run.test.ts · recap-coverage.ts
parity/       scenarios/*.json · run-rea.mjs · har-shape-diff.ts · allowed-diffs.yaml · matrix.ts
migration/    preflight.sql · schema-diff.sql · freeze.sql · backfill.sql · reconcile.sql · reconcile-diff.ts
              rollback-escrow.sql · synth.sql · smoke.ts · stripe-backfill.ts · RUNBOOK.md
load/         bench/*.sql (pgbench, tables journalisées) · k6/*.js · seed.sql
e2e/          *.spec.ts (Playwright + axe) · selectors.spec.ts (§6.8)
docs/         parity.md (matrice générée) · DESIGN.md (Impeccable)
.github/workflows/ ci · db · catalog · quiz-bank · parity · migration-rehearsal · load · health
```

### 5.3 Où vit la logique

| Couche | Elle possède | Elle ne fait jamais |
|---|---|---|
| `proxy.ts` | Le refresh du cookie de session, la redirection vers `/login` des routes de jeu sans session (§2.2), la porte démo et `X-Robots-Tag`. | Lire la base. |
| `lib/route.ts` → `route()` | `getClaims()` (vérification locale du JWT, 401 sinon) ; validation zod des paramètres et du corps (400 en français) ; validation de `x-wiki-calendar-tz` contre `Intl` (défaut `Europe/Paris`) ; lecture d'`Idempotency-Key` ; **un** appel `admin.schema('wm').rpc(fn, {p_uid, …})` ; recopie du statut et du corps de l'erreur `P0001` ; `Retry-After` ; un log JSON. Un handler fait 1 à 3 lignes. | Contenir une règle de jeu. |
| `wm.*` (PL/pgSQL, `security definer`, `set search_path = ''`) | Toutes les règles, toutes les écritures et la forme JSON de chaque réponse (`jsonb_build_object`). | Faire confiance à un id envoyé par le client sans vérifier la propriété. |
| Server Components | Le rendu, en appelant **les mêmes** fonctions `wm.*` avec le même uid. Il n'y a pas de seconde couche de données. | Écrire. |
| RLS de `public` | Uniquement les accès PostgREST directs de l'original (§7.1 du recap), plus la lecture de ses propres notifications pour la cloche. | Laisser le client écrire `wikibidous_balance`, `count`, `packs_*`, `snapshot_*`, ou insérer et supprimer des `user_cards`. |
| pg_cron | Le règlement des enchères (10 s), les expirations (échanges toutes les heures, invitations et batailles inactives toutes les 15 min), la rétention, la diffusion des alertes de liste de souhaits (10 s) et le réveil du push (15 s, si l'outbox n'est pas vide). | Appeler Vercel sans travail en attente. |
| `/api/cron/push`, `/api/cron/revalidate` | Le Web Push (VAPID, aes128gcm), qui a besoin de Node, et `revalidateTag('catalog', 'max')` appelé par `catalog.yml` en fin de chargement. Protégés par `x-cron-secret` (secret aussi rangé dans Supabase Vault et dans les secrets GitHub). | Autre chose que ces deux tâches. |
| GitHub Actions | La construction du catalogue, la banque de quiz, la parité, la charge et la santé. | Servir du trafic. |

---

## 6. Modèle de données et compatibilité avec l'original

### 6.1 Deux pistes de migration

| Piste | Contenu | Appliquée à | Jamais appliquée à |
|---|---|---|---|
| **MIRROR** | Les tables, enums, contraintes et RLS de `public` du §4, plus les deux RPC publiques `sync_profile_packs` et `get_my_profile` | Nos projets (démo, CI, charge), le plan B, et l'option B avant restauration (ou sautée si le dump fournit ce schéma) | **Le projet de Naïm (option A)** |
| **ADDITIVE** | Le schéma `wm`, des triggers sur les tables de `public`, des index et les policies de lecture manquantes. Tout est idempotent (`if not exists`, et `create or replace` seulement à l'intérieur de `wm`). | Toutes les cibles, y compris l'option A | — |

**Porte de fidélité du miroir.** Dès réception du DUMP-S (§10, codes de preuve) :
1. `migration/schema-diff.sql` charge le dump dans PG16 à côté du miroir et liste les écarts (tables, colonnes, types, contraintes, policies, triggers, fonctions, `cron.job`, `storage`).
2. On corrige le miroir jusqu'à zéro écart.
3. Les suites SQL et de contrat doivent passer **sur le miroir et sur le schéma du DUMP-S** chargé avec `migration/synth.sql`. PL/pgSQL ne résout les colonnes qu'à l'exécution : faire tourner les suites est la seule vraie preuve que nos fonctions marchent sur ses tables.

### 6.2 Correspondance avec le §4 du recap

| Entité (recap) | Table miroir (`public`) | Ajouts dans `wm` (jamais sur la table d'origine) |
|---|---|---|
| `auth.users` (§4.2) | Supabase Auth : importée telle quelle en option B, inchangée en option A | — |
| `profiles` | Colonnes du §4.2 : `username`, `avatar_url`, `avatar_user_card_id`, `bio`, `is_public`, `created_at`, `last_seen_at`, `is_pro`, `is_vip`, `pack_cap`, `packs_remaining`, `packs_last_regen_at`, `wikibidous_balance`, `activity_blocked_until`, `packs_blocked_until`. Index unique `lower(username)`. `CHECK (wikibidous_balance >= 0)` **dans le miroir seulement**. | `user_state` (vérification humaine, compteurs anti-abus, ouvertures du jour), `user_stats`, `notification_prefs`, `staff`, `stripe_customers`, `subscriptions` |
| `cards` | Colonnes de `rest/v1/cards` (§3.4) : `id`, `wikipedia_title`, `wikipedia_url`, `lang`, `rarity`, `atk`, `def`, `q_score`, `pageviews`, `pageviews_refreshed_at`, `qscore_refreshed_at`, `category`, `summary`, `image_url`, `hide_image`, `nsfw_image`, `created_at`. `fillfactor 90` dans le miroir. | `card_source(card_id, page_id)`, `card_media(card_id, file, author, license, license_url)`, `draw_pool`, `catalog_stats`, `card_removals`, `card_quizzes`, `catalog_stage` |
| `user_cards` | `id`, `user_id`, `card_id`, `count`, `starred`, `is_shiny`, `snapshot_title`, `snapshot_rarity`, `snapshot_category`, `snapshot_atk`, `snapshot_def`, `obtained_at` | `user_rarity_counts(user_id, snapshot_rarity, is_shiny, copies)`, maintenue par un trigger *statement-level* à tables de transition (un upsert par instruction) |
| `tags`, `user_card_tags`, `wishlist_items` | Comme au §4.2 : PK `(user_card_id, tag_id)`, cascade, unique `(user_id, name)` et unique `(user_id, card_id)`. Les étiquettes `[LOCKED]` et `[…]` sont conservées (§4.2). | — |
| `auctions`, `auction_bids` | Champs fusionnés du §3.5 (objet `Auction`) et du §4.2 | `auction_escrow(auction_id, user_card jsonb, duration_minutes)`, `wishlist_alert_queue` |
| `trades`, `trade_items` | §4.2, avec `expires_at` | — |
| `friendships`, `chat_messages`, `notifications`, `push_subscriptions`, `showcase`, `reports` | §4.2 | `push_outbox`, `card_image_reports` |
| `achievements`, `user_achievements` | §4.2 | `achievement_rules(achievement_id, metric, threshold)` |
| `battles`, `battle_decks` | §4.2 (`game_state` jsonb) | `battle_secrets(battle_id, question_id, correct_option_id)` |
| Guildes : `guilds`, `guild_members`, `guild_wishlists`, `guild_donations`, `guild_chat_messages`, `guild_weekly_scores(week_start, guild_id, …)` | §4.2 | — |
| Paiements, modération, paquets | Inconnus dans l'original (§10.2) | `stripe_events`, `sanctions`, `staff_actions`, `pro_daily_claims`, `special_packs`, `special_pack_claims`, `grace_grants`, `idempotency_keys`, `wb_ledger`, `config` |

Les enums sont ceux du §4.1 (`rarity` est un enum PG ordonné C < PC < R < SR < UR < L). La durée d'enchère accepte `10, 30, 60, 180, 360, 720, 1440` (1440 pour les données héritées seulement, conflit n° 1).

### 6.3 Colonnes sacrées (§4.4) : comment elles restent intactes
- **Aucun droit client** sur ces colonnes : pas d'`UPDATE` sur `wikibidous_balance`, `count`, `packs_*`, `snapshot_*` ni `obtained_at`. Seul `starred` est modifiable, par un grant de colonne.
- **Le job catalogue** ne met à jour qu'une liste blanche : `rarity`, `pageviews`, `pageviews_refreshed_at`, `qscore_refreshed_at`, `summary`, `category`, `image_url`. Il touche aussi `atk`, `def` et `q_score`, mais seulement si `wm.config.catalog_stats_frozen = false`. Un test vérifie qu'aucune autre colonne ne change.
- **Les fonctions ne recréent une ligne** (nouvel id) que dans les cas du §4.2 : retour d'une enchère invendue ou annulée, copie gagnée. Partout ailleurs, la ligne garde son id.
- **Le rapprochement** (§11.3) hache ces colonnes avant et après chaque migration, y compris en option A, où il prouve que nos migrations n'ont rien modifié.

### 6.4 Points ambigus du §4 et du §10.1 : choix retenus

| Point | Choix | Se renverse par |
|---|---|---|
| `count` (conflit n° 11, §10.1 n° 2) | Copié tel quel. Défausse, mise en vente, échange et don portent sur **une unité** : décrément, ou suppression à 1. Les nouvelles copies passent par `wm.grant_copy()` (une ligne, `count = 1`). | Une instruction dans `grant_copy()`, après la requête DUMP-D `select count, count(*) from user_cards group by 1` |
| Rareté affichée en collection (n° 3) | `snapshot_rarity` : badge, halo, filtres, compteurs, badge « Nouvelle » | Une expression dans `wm.my_collection` |
| Copie en vente (§10.2) | Retirée de `user_cards`, ligne complète en jsonb dans `wm.auction_escrow` (une unité si `count > 1`). Un retour réinsère via `jsonb_populate_record(null::public.user_cards, …)` : nouvel id, sans étiquettes, `starred = false`, `obtained_at` d'origine. Le gagnant reçoit un nouvel id avec `obtained_at = settled_at`. | — |
| Durée pour la baisse de prix (n° 6) | Une baisse exige l'absence de mise, donc `end_at` n'a jamais été prolongé : durée = `end_at - created_at`. Pour les nouvelles enchères, elle est aussi stockée dans `auction_escrow`. | — |
| Granularité du verrou d'échange (n° 4) | `card_id` pour l'utilisateur qui offre. `pendingTradeCardIds` renvoie l'union des `card_id` et des `user_card_id`. | Une clause `exists` |
| Portefeuille (§10.2) | Colonne + grand livre ; la réservation de mise est un débit immédiat avec remboursement (C5) | — |
| WB des échanges (§10.1 n° 1) | **Pas de séquestre**. L'invariant de bascule n'a donc **pas** de terme « WB des échanges en attente » (§11.3). | Remettre le terme si le DUMP-S montre un séquestre |
| `obtained_at` contre `created_at` (n° 12) | Le miroir stocke `obtained_at`, l'API émet `obtained_at`. `schema-diff` tranche ; au besoin, un alias de lecture dans les fonctions, jamais un renommage. | — |
| Stockage de la durée d'enchère | `auction_escrow.duration_minutes` | — |

### 6.5 Configuration : `wm.config(key text pk, value jsonb, note text)`
Toutes les constantes du §5 y vivent, chacune avec la confiance du recap dans `note`. Les valeurs par défaut sont données domaine par domaine au §7. Changer une constante = un `update` SQL, sans déploiement. Drapeaux opérationnels : `maintenance` (toutes les fonctions qui écrivent répondent 503), `catalog_frozen`, `catalog_stats_frozen`.

### 6.6 Règles d'écriture des migrations
- **Expand-only** : jamais de `drop` ni de `rename` sur une colonne lue par l'ancienne version de l'app.
- **Idempotentes** : rejouables sans effet.
- **Index des grosses tables** : créés `CONCURRENTLY` à la main depuis le runbook en option A ; le `if not exists` de la migration devient alors un no-op.
- **Compatibles PG16 et PG17.**
- **Une fonction `wm.*` = au moins un test SQL** ; les fonctions monétaires ont en plus un test d'invariant (`wm.check_invariants()`).
- **Fonctions conditionnelles** : `9000_wm_cron.sql` ne s'applique que si `pg_cron` et `pg_net` existent (absents du bac à sable).

---

## 7. Mécaniques de jeu

Chaque domaine donne : **logique** (où elle vit), **atomicité et idempotence**, **constantes** (clés `wm.config`, avec renvoi au recap), **points ouverts** avec le défaut à appliquer.

### 7.0 Règles transverses (valables pour tous les domaines)

**`wm.actor(p_uid)`.** Premier appel de chaque fonction qui écrit. Il lit le profil **sans le verrouiller** et lève une erreur dans trois cas :
- `config.maintenance` est actif : 503 `maintenance` ;
- une sanction est active ou `activity_blocked_until > now()` : 403 avec la date ;
- pour les fonctions de paquets, `packs_blocked_until > now()` : 403.

Il renvoie les drapeaux utiles (`is_pro`, `is_vip`, staff). Les verrous sont pris **ensuite**, dans l'ordre C4.

**Ordre de verrouillage (C4).**
1. La ligne métier : enchère, échange ou souhait de guilde.
2. Les lignes `profiles` concernées, `FOR UPDATE`, triées par id.
3. Les lignes `wm.user_state` correspondantes, dans le même ordre.
4. Les `user_cards`.

Une opération sans ligne métier (ouvrir un paquet, défausser, mettre en vente) commence à l'étape 2. Un test lance 2 × 50 appels concurrents qui se croisent (surenchères croisées sur deux enchères, défausse pendant l'acceptation d'un échange, double règlement) et exige 0 interblocage et 0 invariant violé.

**Idempotence.**
- *Gardes d'état* : régler exige `status = 'active' and end_at <= now()` sous verrou ; réclamer exige `claimed_at is null` ; accepter un échange exige `status = 'pending'` ; défausser exige que la ligne existe et appartienne à l'appelant.
- *Grand livre* : la clé `(reason, ref, user_id)` est unique, où `ref` vaut par exemple `settle:<auction_id>`, `trade:<trade_id>`, `ach:<achievement_id>`, `stripe:<checkout_session_id>` ou `bid:<bid_id>`.
- *Stripe* : la PK de `stripe_events` rejette les livraisons en double.
- *`Idempotency-Key` (C6)* : la clé est insérée dans `wm.idempotency_keys(user_id, key)` dans la même transaction que l'action. Un doublon concurrent attend sur l'unicité, puis reçoit la réponse stockée. Les clés sont purgées toutes les heures au-delà de 24 h.
- *Sans en-tête* : chaque ouverture de paquet et chaque mise est un nouvel appel, comme dans l'original. L'UI désactive le bouton pendant la requête.

**Erreurs (C29).** `wm.raise_err(status, code, message, extra jsonb)` lève `P0001`, avec `message` = la chaîne française et `detail` = `{status, code, error, message, …extra}`. `route()` renvoie ce JSON avec ce statut. Les clés `error` et `message` portent **la même** chaîne, car les clients lisent l'une ou l'autre (§3.0). Catalogue complet au §8.2.

**Anti-abus (C17)**, état stocké dans `wm.user_state`, toujours mis à jour après le verrou du profil :

| Mécanisme | Défaut | Effet | Recap |
|---|---|---|---|
| Intervalle minimal entre deux ouvertures | 1 s | 429 `rate_limited: true` + `retry_after` | §5.1 |
| Plafond quotidien d'ouvertures | 600 (jour du fuseau du joueur) | 429 `rate_limit_daily: true` | §5.1 |
| Rafale de mises | 10 en 60 s | `human_check_required` | §5.5, §7.2 |
| Rafale de mises en vente | 5 en 60 s | `human_check_required` | §3.5 |
| Rafale d'ouvertures | 30 en 10 min | `human_check_required` | §5.1 |
| Vérification humaine | valable 12 h | sans elle, 403 `human_verification_required` sur paquets, mises et mises en vente (**ensemble**) ; jamais sur la défausse | §7.2 |

En complément, si le plan le permet : WAF Vercel par IP (`/api/*` 600 req/min, GET `/api/marketplace*` 120 req/min) et `checkRateLimit` par utilisateur et par minute (ouverture 60, mise 30, mise en vente 10, défausse 120, défausse en masse 30, chat 30, création d'échange 20, recherche d'amis 30). Dans tous les cas, le 429 renvoie `{error: 'Le site demande de ralentir', message: idem, retry_after}` avec l'en-tête `Retry-After`.

**Temps.** Les comptes à rebours partent de dates absolues renvoyées par le serveur (`end_at`, `next_regen_at`). Le client corrige le décalage de son horloge grâce à l'en-tête `Date` (§5.9). Les bornes de jour suivent `x-wiki-calendar-tz` (validé, défaut `Europe/Paris`) pour le paquet Pro du jour, les quotas de bataille, le plafond quotidien de paquets et les dons de guilde.

### 7.1 Authentification, inscription, compte

- **Logique.**
  - Supabase Auth (§3.11) : e-mail et mot de passe, OTP par e-mail à l'inscription, captcha Turnstile **intégré à GoTrue** (`captchaToken` sur `signUp`, `signInWithPassword`, `resetPasswordForEmail`).
  - Un trigger `after insert on auth.users`, `wm.handle_new_user`, crée les lignes `profiles`, `wm.user_state` et `wm.user_stats`. Il **refuse** l'inscription si le pseudo est invalide (C28), déjà pris (`lower()`) ou réservé (admin, staff, modérateur, support, nom de la marque…), ou si `age_confirmed` ou `terms_version` manquent dans les métadonnées.
  - `GET /api/username-available?u=` sert à la vérification préalable dans l'UI. Le refus du trigger est traduit en « Ce pseudo est déjà pris » ou « Pseudo invalide (3 à 24 caractères) ».
- **Pages** (§2.1) : `/signup` garde `form#signup-form`, `#username`, `#password`, `#signup-otp-code` et les textes exacts des deux cases. `/login` garde `#email`, `#password`, « Adresse courriel », « Mot de passe oublié ? » et redirige vers `/pulls`. Les pages `/forgot-password`, `/callback?next=/reset-password` (« Lien invalide ou expiré ») et `/verify-email` suivent le §2.1.
- **Vérification humaine des paquets** : `POST /api/human-check {token}` appelle `siteverify` côté serveur, puis `wm.set_human_verified(uid)` (12 h, et `human_check_required` repasse à false).
- **Bannissement** : bannissement GoTrue (`ban_duration`) **et** `activity_blocked_until = 'infinity'`. `wm.actor` le vérifie, donc il s'applique même avec un JWT encore valide.
- **Paramètres** (`/settings`, routes `/api/settings/*`) :
  - changement de pseudo (`wm.change_username`, règles C28, au plus un tous les 30 jours) ;
  - e-mail et mot de passe (GoTrue `updateUser`, avec confirmation) ;
  - préférences : push par type, sons, `hide_sensitive` (vrai par défaut), visibilité du profil ;
  - **export RGPD** : JSON de toutes ses données, y compris ses écritures du grand livre ;
  - **suppression du compte** : blocage et anonymisation immédiats (pseudo → `supprime-<8 hex>`, abonnements push effacés). Les échanges en attente sont annulés, les enchères sans mise retirées, les autres se règlent normalement. Un job quotidien supprime `auth.users` dès qu'il ne reste plus d'enchère active.
- **Atomicité** : chaque action du compte est une seule fonction.
- **Constantes** : pseudo de 3 à 24 caractères (§4.2) ; OTP de 6 chiffres dans la config Auth, avec un champ qui accepte 6 à 12 chiffres (§2.1) ; Turnstile sur l'inscription, la connexion, la réinitialisation et les paquets.
- **Points ouverts → défaut.**
  - Dotation de départ (§10.5) : 1 paquet disponible, 0 WB.
  - OAuth (§9.3 n° 19) : aucun.
  - Délai de renommage : 30 jours.
  - Expiration du JWT : la configuration de son projet n'est **jamais** modifiée en option A.

### 7.2 Paquets

- **Logique.**
  - `public.sync_profile_packs(user_id)` et `public.get_my_profile()` existent dans le miroir (§3.1) et délèguent à `wm.apply_regen`. Les appeler pour un autre utilisateur est refusé (`auth.uid()` doit être égal à `user_id`).
  - Les routes `POST /api/packs/open`, `GET/POST /api/packs/pro-daily`, `GET/POST /api/packs/special` et `POST /api/packs/grace` appellent respectivement `wm.open_pack`, `wm.pro_daily`, `wm.special_packs` et `wm.claim_grace`.
- **Régénération paresseuse** (§5.1), calculée sous le verrou du profil :
  ```
  period = (is_pro or is_vip) ? 180 : 600
  if packs_remaining < pack_cap and packs_last_regen_at is not null:
     n = floor((now - last) / period); packs_remaining = min(pack_cap, remaining + n)
     last = (packs_remaining >= pack_cap) ? null : last + n * period
  à la consommation depuis un stock plein : last = now()
  ```
  En option A, `wm.apply_regen` est aligné ligne à ligne sur le corps de sa fonction `sync_profile_packs`, qui n'est pas remplacée.
- **Tirage (C8).** Pour chacune des 5 cartes :
  1. choisir la rareté `r` avec la probabilité `n_r / N` lus dans `wm.catalog_stats` (ou selon les poids de config s'ils sont définis) ;
  2. tirer `seq = 1 + floor(random() * n_r)` ;
  3. lire `wm.draw_pool[(r, seq)]`, une lecture par PK.

  Le pool reste dense, car un retrait de carte fait l'échange avec le dernier dans la même transaction : il n'y a ni trou ni nouvel essai. Les cartes `hide_image` et `nsfw_image` restent tirables, comme dans l'original ; les cartes retirées par le staff ne sont pas dans le pool. Brillante : `random() < shiny.rate` si `r` fait partie de `shiny.scope`. Chaque carte est remise par `wm.grant_copy` avec ses snapshots (titre, rareté, catégorie, ATK, DEF).
- **Réponse** (§3.1) : `{cards: CardInPack[5], packs_remaining, packs_last_regen_at, owned_copies: [{card_id, is_shiny, count}]}`. `owned_copies` est un tableau, comme dans la réponse réelle du 27/09 (conflit n° 10). Chaque carte porte l'union des champs : `id` et `card_id`, `user_card_id`, `card{}` imbriqué et champs à plat, `snapshot_rarity`, `is_shiny`, `summary` et `description`. **La meilleure carte vient en dernier** (tri par rareté croissante, la brillante après la normale).
- **Erreurs.**
  - Stock vide : 403 `{error, message: 'Plus de paquets disponibles', packs_remaining: 0, next_regen_at}` (conflit n° 9).
  - Anti-bot : 403 `{code: 'human_verification_required', human_verification_required: true, error: 'Vérification anti-bot requise pour continuer à ouvrir des paquets.'}`.
  - Limites : les cas du §7.0.
- **Atomicité** : verrou du profil, puis de `user_state`, puis régénération, contrôles, décrément, tirage, 5 insertions, compteurs. Tout dans une seule transaction.
- **Constantes** (§5.1) :

  | Clé | Valeur |
  |---|---|
  | `pack_size` | 5 |
  | `pack_period_s` | `{free: 600, pro: 180}` |
  | Réserve | `pack_cap` (colonne, défaut 10) |
  | `pro_daily` | `{size: 15, exclude: ['C'], min_gap_h: 20}` |
  | `shiny` | `{rate: 0.01, scope: ['L']}` |
  | `draw_weights` | `{free: null, pro: null}` |

  Les anti-abus sont ceux du §7.0.
- **Paquet Pro du jour** : un seul par jour calendaire dans le fuseau du joueur (PK `wm.pro_daily_claims(user_id, day)`), **et** au moins 20 h depuis la dernière réclamation, pour empêcher de sauter d'un fuseau à l'autre. Les poids excluent C.
- **Points ouverts → défaut.**
  - Cotes Pro : identiques au gratuit (C27).
  - Taux de brillantes : 1 % des L (conflit n° 13, tranché par DUMP-D) ; les statistiques d'une brillante sont celles de la carte, seul le rendu change.
  - Paquets spéciaux : données dans `wm.special_packs`, aucun actif par défaut ; la forme de la réponse suit le §3.1.
  - Paquet « grâce » : distribue les dotations `wm.grace_grants` accordées par le staff (compensations) ; réponse `{cards}`.
  - Recharges payantes : non vendues tant que le produit n'est pas connu.

### 7.3 Collection, étiquettes, liste de souhaits, défausse

- **Logique.**
  - `GET /api/my-collection` passe par `wm.my_collection(uid, page, limit, sort, q, rarity, tag_id, untagged, wishlisted_by, owned_by, pending)`. `/stats` passe par `wm.my_collection_stats`, et `/api/profile/{username}/collection` par `wm.profile_collection`. Formes : §3.3.
  - Les étiquettes, les liaisons étiquette/copie, la liste de souhaits et `starred` se lisent et s'écrivent **en direct par PostgREST** sous RLS, exactement comme les §3.3 et §7.1 du recap (y compris le 409 `23505` sur un doublon et la cascade de suppression).
- **Requête.** Jointure différée : un offset sur une sous-requête *index-only*, puis jointure des 50 lignes. L'ordre est stable (`clé de tri, obtained_at desc, id`). `limit` est plafonné à 50 et `page` part de 0.
  - Tris acceptés : `rarity` (défaut, sur `snapshot_rarity`), `obtained_at`, `added` (alias), `name`, et en plus `atk`, `def` et `starred` (§10.1 n° 8).
  - `total` vient de `wm.user_rarity_counts` en O(1) sans filtre, sinon d'un comptage *index-only*.
  - `pendingTradeCardIds` est toujours présent (C13). `pending=1` est accepté, sans effet de filtrage.
  - `wishlisted_by=<userId>` renvoie mes copies dont le `card_id` figure dans la liste de souhaits de ce joueur ; il faut être ami ou soi-même (§10.1 n° 9).
  - `owned_by` respecte `is_public` et l'amitié.
- **Défausse** (`wm.discard`). Étapes :
  1. `actor` ;
  2. verrou du profil ;
  3. verrou de la copie `where id = $ and user_id = uid` (sinon 403 `{code: '42501', error: 'Vous ne possédez pas cette carte'}`) ;
  4. contrôle du verrou d'échange (409 « Cette carte est déjà engagée dans un échange en attente ») ;
  5. décrément d'une unité ou suppression de la ligne ; nettoyage des références vitrine et avatar ;
  6. solde +1 via `wallet_apply` (raison `discard`, comptée dans `user_stats.discard_wb`, sans ligne de grand livre).

  Réponse `{balance}`.
- **Défausse en masse** (`wm.bulk_discard`) : 1 à 50 ids de copie uniques, traités en une passe ensembliste dans une seule transaction. Réponse `{discarded_count, failed: [{id, reason}]}`.
- **Performance** : l'index `user_card_tags(tag_id)` corrige à la racine le timeout de la suppression en cascade (§1.4). Un lot de 100 liaisons est une seule insertion.
- **Constantes** : étiquette ≤ 48 caractères, couleur `#rrggbb` ou null (§4.2) ; défausse +1 WB (§5.3).
- **Points ouverts → défaut.**
  - Défausse d'une ligne à `count > 1` : une unité par appel (§10.1 n° 2).
  - La liste de souhaits n'est pas vidée quand on obtient la carte (le contraire ne vient que du clone).

### 7.4 Catalogue

- **Logique.** `GET /api/cards` passe par `wm.cards_page`, en deux parties :
  - **partagée** et cachée 1 h (tag `catalog`) : `cards`, `total`, `rarityCounts`, `searchHasMore` ;
  - **overlay** par utilisateur, en une requête indexée sur les 50 ids : `ownedCardIds`, `wishlistCardIds`, `friendOwners`.

  `rest/v1/cards` reste lisible par la clé anon (§3.4), et la modale continue de lire `cards?select=summary&id=eq.` en direct.
- **Pages en O(1).** Avec `sort=rarity`, sans recherche ni filtre de liste de souhaits, la page `p` se convertit arithmétiquement en un intervalle `(rarité, seq)` grâce aux cumuls de `wm.catalog_stats`, dans l'ordre L, UR, SR, R, PC, C. Chacune des pages (55 470 sur le catalogue complet) devient un seul parcours d'intervalle sur la PK de `draw_pool`. Le filtre de rareté passe par la même arithmétique.
- **Recherche.** `q` de 2 caractères : préfixe sur `lower(wikipedia_title) text_pattern_ops`. Trois caractères ou plus : trigramme sur `unaccent(lower(titre || ' ' || catégorie))`. Pendant une recherche, `total` vaut `null` et `rarityCounts` est omis, ce qui produit le bandeau « Recherche active… » (§2.2). `wishlist=1` filtre sur ma liste.
- **Crédits.** `GET /api/cards/{id}/credits` (route nouvelle) renvoie `{file, image_author, image_license, license_url}` depuis `wm.card_media`, avec un cache CDN de 30 jours.
- **Constantes** : 50 par page, base 0 ; seuil de recherche de 2 caractères côté serveur (conflit n° 17).
- **Points ouverts → défaut.**
  - Le mode « pas encore à moi » utilise le paramètre additif `missing=1` (§10.4).
  - L'ordre à l'intérieur d'une rareté est celui de `seq`, stable.

### 7.5 Marché (enchères)

- **Logique.** Toutes les routes du §3.5, chacune appelant une fonction `wm.*` : `market_list`, `market_mine`, `create_auction`, `auction_detail`, `place_bid`, `cancel_auction`, `settle_auction`, `reprice_auction`, `card_sales`.

| Opération | Étapes (une transaction) | Réf. grand livre |
|---|---|---|
| Mise en vente | `actor` ; verrous profil → `user_state` → copie. **Résolution** : un id de copie, sinon en repli un id catalogue, auquel cas on prend la copie la plus ancienne sans verrou d'échange (conflit n° 5). **Contrôles** : limite de ventes simultanées (409 « Limite de N enchères actives atteinte »), verrou d'échange (409), vérification humaine, compteur anti-abus. **Écritures** : séquestre (C12), `snapshot_*`, `snapshot_search_document` (titre, catégorie, 300 premiers caractères du résumé), mise en file `wishlist_alert_queue`. Réponse `{auction_id, id, end_at}` (201). | — |
| Mise | Verrou de l'enchère : elle doit être `active` avec `end_at > now()`. Le vendeur ne peut pas miser (409 « Tu ne peux pas enchérir sur ta propre vente »), le meneur ne peut pas remiser (409 « Tu es déjà en tête »). `min = current_bid null ? base_amount : max(ceil(cur × 1,1), cur + 1)` ; en dessous, 409 `{code: 'bid_too_low', min, error: 'Mise trop basse (minimum {min} wikibidous)'}`. Verrou de l'enchérisseur et de l'ancien meneur, triés par id. Débit (sinon 409 `insufficient_balance` « Solde insuffisant ») et remboursement de l'ancien meneur. Insertion dans `auction_bids` ; mise à jour de `current_bid`, `current_bidder_id`, `bids_count`. **Anti-snipe** : si `end_at - now() < 10 s`, `end_at += 60 s`. Notification `auction_outbid`, compteur anti-abus. Réponse `{current_bid, bidder_balance, balance, end_at, min_next_bid}`. | `bid:<bid_id>` (débit), `refund:<bid_id remboursé>` |
| Retrait | Vendeur uniquement, sans aucune mise (sinon 409 « Une enchère en cours ne peut pas être retirée ») ; statut `cancelled` ; retour depuis le séquestre. | — |
| Baisse de prix | Vendeur uniquement, sans mise, `base_repriced_at is null`, `now ≥ created_at + durée / 2`, `new_base_amount ≤ floor(listing_base_amount / 2)`. | — |
| Règlement | Sans mise : `settled_unsold`, la carte revient au vendeur. Avec mise : `settled_sold`, `winner_id`, `final_price`, `settled_at`, la copie part au gagnant (nouvel id) et le vendeur est crédité. Guilde du vendeur : `score_wb += final_price`. Notifications `auction_won`, `auction_sold` ou `auction_unsold`. Statistiques mises à jour. | `settle:<auction_id>` |

- **Déclencheurs du règlement (C14)** : `cron.schedule('wm-settle', '10 seconds', 'select wm.settle_due_auctions(500)')` avec `FOR UPDATE SKIP LOCKED`, plus `POST /settle`, plus le GET de détail quand l'enchère est échue et que le cache est manqué. Rejouer un règlement ne fait rien.
- **Lectures** (cache partagé, plus `owned` en overlay) :
  - liste : 3 s par requête normalisée ; tri `ending_soon` avec les enchères échues non réglées en tête (§3.5) ; filtre `card_id` **strict** (écart admis) ; recherche `q` par trigramme sur l'index partiel des enchères actives ;
  - détail : 1 s ; réponse `{auction, bids}` ;
  - `?mine=1` : `{mine: true, selling, bidding, won, history}` ; `won` contient **tout** l'historique, paginé par `settled_at desc` (corrige la fenêtre glissante du §1.4) ;
  - `/mine` : `{sellingCount, maxConcurrentAuctions, auctions: [{id, card_id, user_card_id}]}` (conflit n° 6).
- **Statistiques de vente** :
  - `?scope=summary` (gratuit) : moyenne des 200 dernières ventes réglées par rareté, via l'index `(card_id, snapshot_rarity, settled_at desc) where status = 'settled_sold'`, en cache 60 s ;
  - détail (Pro, sinon 403 `{code: 'pro_required'}`) : 30 jours, 2 000 lignes au plus (conflit n° 8).
- **Alertes de liste de souhaits.** Pg_cron les diffuse toutes les 10 s, par tranches de 5 000 notifications avec un curseur, **sans plafond**. La transaction de mise en vente reste ainsi rapide.
- **Constantes** (§5.5) :

  | Clé | Valeur |
  |---|---|
  | `auction_durations` | `[10, 30, 60, 180, 360, 720]` (+ 1440 accepté) |
  | `max_concurrent_auctions` | `{free: 5, pro: 10}` (conflit n° 3) |
  | Incrément | `max(ceil(1,1x), x+1)` (conflit n° 2) |
  | `antisnipe` | `{window_s: 10, extend_s: 60}` |
  | Prix de départ | ≥ 1, défaut UI 10 |
  | Commission | aucune |

- **Points ouverts → défaut.**
  - Formule 100 → 110 ou 111 : 110, et `min` est exposé dans l'erreur.
  - Les WB « gagnés aux enchères » pour la guilde vont au vendeur, membre au moment de la vente.

### 7.6 Échanges

- **Logique.** Routes du §3.6 : `GET /api/trades` (`active=1`) passe par `wm.trades_list`, qui renvoie tous les échanges en attente et les 200 derniers clos. `GET /api/trades/{id}` renvoie `{trade}`, `POST /api/trades` passe par `wm.create_trade` et `PATCH /api/trades/{id} {action}` par `wm.trade_action`. Forme de l'objet `Trade` : §3.6.
- **Création.**
  - Entre amis acceptés uniquement.
  - De 1 à 100 cartes et de 0 à 10 000 WB par côté. Chaque élément vaut une unité ; plusieurs éléments peuvent viser la même ligne tant que leur nombre ne dépasse pas `count`.
  - La possession est vérifiée à la création, sans séquestre (§5.6).
  - Une contre-offre est un nouvel échange avec `parent_trade_id`. Le parent, qui doit être en attente et adressé à l'initiateur de la contre-offre, passe à `countered` dans la même transaction.
  - Réponse : `{id, …trade}`.
- **Acceptation.**
  1. Verrou de l'échange (sinon 409 « Cet échange n'est plus en attente (déjà traité) »).
  2. Verrou des deux profils par id.
  3. Revérification **ensembliste** : chaque élément est encore possédé par le bon côté et les deux soldes suffisent.
  4. Déplacements en 3 ou 4 instructions, quelle que soit la taille : `update user_cards set user_id = …` pour les lignes à `count = 1` (même id) ; insert-select + décrément pour les unités tirées d'une pile ; suppression des étiquettes, de `starred` et des références vitrine et avatar des copies déplacées.
  5. WB dans les deux sens, `accepted_at`, notifications.

  Un échange 100 ↔ 100 tient en moins de 500 ms, là où l'original tombait au-delà d'environ 30 cartes. `decline` est réservé au destinataire, `cancel` à l'initiateur.
- **Verrou d'échange.** `wm.card_locked(uid, card_id)` est vrai si une copie de ce `card_id` est offerte par `uid` dans un échange en attente. Il bloque la défausse, la mise en vente et le don.
- **Idempotence** : garde d'état, plus `Idempotency-Key` envoyée par notre UI ; un nouvel essai après timeout renvoie le résultat stocké. Réf. grand livre : `trade:<trade_id>` pour chaque côté.
- **Constantes** (§5.6) : `trade_limits {cards: 100, wb: 10000, expiry_h: 168}`. Expiration par pg_cron toutes les heures. `x-wiki-calendar-tz` est lu, sans quota par défaut.
- **Points ouverts → défaut.**
  - Délai d'expiration : 168 h (les 48 h viennent du clone).
  - Quota quotidien : aucun.
  - Champ message : aucun (§5.6).

### 7.7 Batailles et quiz (OmniRoute)

- **Logique.** `wm.battle_action(uid, id, action, payload)` gère les actions du §3.9 (accept, decline, withdraw_invite, forfeit, submit_deck, submit_attack, submit_single_answer). `GET /api/battles` passe par `wm.battles_list` (avec `challenge_quota`), `GET /api/battles/{id}` par `wm.battle_detail`.
- **Machine à états** : `pending` (24 h) → `deck_selection` → `generating_quizzes` → `active` (phases `attack` et `quiz`) → `completed`, ou `cancelled`.
  - Deck : 3 copies distinctes possédées (repli : ids catalogue). PV = Σ `snapshot_def`.
  - Le challenger attaque en premier et chaque carte attaque une fois.
  - À l'attaque, le serveur tire 3 questions encore inutilisées dans la banque de la carte. `pendingAttack.questions` est envoyé **sans** les réponses, qui ne vivent que dans `wm.battle_secrets` (lisible par `service_role` seulement).
  - `submit_single_answer` renvoie `{correct, correct_answer_id, last_turn, status}`. Répondre deux fois à la même question renvoie le résultat déjà enregistré.
  - Dégâts : `round(snapshot_atk × mauvaises réponses / nombre de questions)`.
  - Victoire : KO, sinon meilleur ratio PV/PV max, puis PV bruts, puis défenseur du dernier tour (§5.7).
  - Un joueur inactif depuis 48 h perd : pg_cron vérifie toutes les 15 min.
- **Atomicité** : chaque action est une transaction. Récompenses à la fin : réf. `battle:<battle_id>` ; guilde du gagnant : `score_battles += 500`.
- **Banque de quiz (C18).** Table `wm.card_quizzes(card_id pk, prompt_version, source 'llm'|'template', model, questions jsonb, created_at)` : 6 questions de 4 options, une seule bonne. Les batailles **ne lisent que** cette table. Une carte sans banque reçoit sur le moment un pool de **modèles SQL** (`wm.template_quiz`, instantané) et passe dans `wm.quiz_queue` avec une priorité de 100. Le passage par `generating_quizzes` se fait donc dans le même appel ; le statut est gardé pour le contrat. **Une bataille ne bloque jamais.**
- **Modèles de secours** (à partir des données de la carte uniquement) :
  - « « {titre} » est… ? » avec la vraie description Wikidata et 3 descriptions d'autres cartes de même rareté ;
  - « De quel article provient cet extrait ? » sur la 1re puis la 2e phrase du résumé, titre masqué, avec 3 titres de même rareté ;
  - un texte à trous sur une année ou un nombre du résumé, les distracteurs étant décalés de ± quelques unités.
- **Remplissage par `quiz-bank.yml`** (GitHub Actions, toutes les 6 h et à la demande) :
  - service container `diegosouzapw/omniroute:3.8.51` (port 20128), clés des fournisseurs passées en secrets ;
  - `scripts/quiz/generate.ts` prend au plus 1 500 cartes dans la file, récupère le texte de l'article (≤ 4 000 caractères, Actions a internet) et appelle `POST http://localhost:20128/v1/chat/completions` (modèle : un combo `wm-quiz`, ou `auto`) avec un JSON schema ;
  - validation zod : 4 options distinctes, exactement une bonne réponse, énoncé ≤ 200 caractères, option ≤ 80, une `evidence` qui est une sous-chaîne normalisée du texte source, aucune question qui ne fait que répéter le titre ;
  - un seul nouvel essai, sinon la carte garde ses modèles ;
  - écriture avec la clé secrète et enregistrement du `model` lu dans `X-OmniRoute-Decision` ;
  - le job sort tout de suite si la file est vide.

  Amorçage : toutes les L, UR et SR, plus les decks des comptes de démo. Le texte de l'article est traité comme une donnée (risque d'injection de prompt) : seule la sortie validée est stockée, et le staff peut effacer une banque.
- **Bac à sable** : un faux serveur compatible OpenAI d'environ 30 lignes sert aux tests de `generate.ts`.
- **Constantes** (§5.7) :

  | Clé | Valeur |
  |---|---|
  | `battle.questions` | 3 |
  | `battle.pool` | 6 |
  | `quota_free` / `quota_pro` | 3 / 10 par jour (fuseau du joueur) |
  | `invite_ttl_h` / `idle_loss_h` | 24 / 48 |
  | `reward_win` / `reward_loss` | 50 / 10 |
  | `guild_points_win` | 500 |

- **Points ouverts → défaut.**
  - Nombre de questions : 3.
  - Minuteur : aucun.
  - Génération en direct par `after()` : non, sauf si un hôte OmniRoute est approuvé (§15).
  - Polling : 3 s dans l'arène, 15 s sur la liste (§3.9).

### 7.8 Guildes

- **Logique.** Les routes du §3.10 sont des fonctions `wm.guild_*`.
  - Une guilde par joueur.
  - On entre sur invitation d'un membre ami. L'invitation est une notification `guild_invite` avec `data.guild_id`, et `DELETE /api/guilds/invites/{guildId}` la refuse.
  - Le chef exclut et transfère le rôle ; il doit transférer avant de partir s'il reste des membres.
- **Entraide.** Chaque membre demande une carte à la fois (`guild_wishlists`). Le don (`wm.guild_donate`) suit l'ordre de verrouillage : souhait, puis profils triés, puis copie du donneur. La copie ne doit pas être verrouillée. Le receveur reçoit au plus 1 don par jour. La copie est déplacée, le souhait clos et le donneur gagne 1 point de karma.
- **Scores hebdomadaires.** Indexés par `week_start` (lundi 00:00 UTC) dans `guild_weekly_scores`, avec `total_score` généré. Aucun job de remise à zéro : on change simplement de clé. La saison « S{nn} » est le numéro de semaine ISO. `GET /api/guilds/leaderboard` reprend la forme du §3.10 et est caché 30 s.
- **Atomicité** : chaque action est une transaction. Le score est incrémenté dans la transaction qui le cause : victoire en bataille ou règlement d'une vente.
- **Constantes** (§5.8) :

  | Clé | Valeur |
  |---|---|
  | Nom / description / message de chat | ≤ 40 / ≤ 280 / ≤ 1 000 caractères |
  | `guild_max_members` | 200 (la plus grosse guilde vue en compte 184) |
  | `guild_create_cost` | 0 |
  | `guild_donations_per_day` | 1 |

- **Points ouverts → défaut.**
  - Rôle d'officier : non.
  - Jour du don : jour UTC du receveur.
  - Polling du chat de guilde : 5 s quand la page est visible.

### 7.9 Social, notifications, Web Push

- **Amis** (§3.7) : `friendships` avec un index unique sur `(least, greatest)`, la recherche `q` (≥ 2 caractères, préfixe sur `lower(username)`), « Tout accepter », `PATCH` et `DELETE`. Erreurs `ALREADY_FRIENDS`, `REQUEST_PENDING` et `FRIEND_LIMIT` en `code`, avec un message français.
- **Profil** : public ou réservé aux amis. Bio ≤ 280 caractères. L'avatar est une copie possédée qui a une image et n'est pas en `hide_image`. **Vitrine** de 4 emplacements (`GET`, `PUT` et `DELETE /api/showcase`, avec un corps JSON y compris sur le `DELETE`).
- **Messages privés** : entre amis uniquement (sinon `FORBIDDEN`, « Vous devez être amis pour vous écrire »), ≤ 2 000 caractères, 30 par minute. Le fil se marque comme lu par `PATCH` direct sur `rest/v1/chat_messages` (§3.7). Polling de 5 s sur un fil ouvert.
- **Signalements** : un par couple (auteur, cible), modifiable. Motifs : `cheating`, `inappropriate_content`, `spam`. Détails ≤ 500 caractères.
- **Notifications.** Table miroir `{id, type, data, read, created_at}`, avec les types du §4.1, plus `wishlist_listed`. `GET /api/notifications` renvoie les 50 dernières ; `PATCH {ids}` ou `{}` les marque lues. La **cloche** lit `rest/v1/notifications?read=eq.false&limit=10` en direct toutes les 30 s (index partiel `where read = false`), sans invoquer Vercel. **Aucune purge** des notifications migrées.
- **Web Push.**
  - `POST` et `DELETE /api/push/subscribe` écrivent dans `push_subscriptions`. `public/sw.js` est écrit à la main.
  - Un trigger *statement-level* sur `notifications` alimente `wm.push_outbox`, pour les seuls utilisateurs abonnés qui ont activé ce type.
  - Envoi immédiat par `after()` pour les événements nés d'une requête. Pour ceux nés d'un cron, pg_cron réveille `/api/cron/push` toutes les 15 s, uniquement s'il y a quelque chose à envoyer (C19).
  - Le handler réserve au plus 500 lignes (`delete … returning`, `skip locked`) et envoie avec `web-push` en parallèle par 50. Un 404 ou un 410 supprime l'abonnement.
  - Les clés VAPID de Naïm sont reprises en option A et B.
- **Atomicité** : la notification est insérée dans la transaction de l'événement qui la cause.

### 7.10 Succès et classements

- **Succès** (§3.8, §5.8).
  - Les tables miroir `achievements` et `user_achievements` sont lues en direct par PostgREST. Les critères vivent dans `wm.achievement_rules(metric, threshold)` : `cards_total`, `first_rarity`, `battles_won`, `showcase_full`, `trades_done`, `auctions_sold`, `guild_donations`…
  - `POST /api/achievements/check` (limité à 1 appel par 5 min et par joueur) évalue les règles à partir de `wm.user_stats`, `wm.user_rarity_counts` et de la vitrine, puis insère les déblocages avec `claimed_at = null`.
  - `POST /api/achievements/claim` fait `update … set claimed_at = now() where … and claimed_at is null`, crédite le joueur (réf. `ach:<id>`) et renvoie `{ok: true}`.
- **Données** : on amorce les **12 succès connus** (§5.8) et **39 succès inférés** dans les 5 catégories, marqués « inféré » dans `docs/parity.md`. À la migration, ils sont remplacés par les 51 lignes de Naïm, avec leurs ids.
- **Classement des joueurs** (route nouvelle, §3.8 inconnu) : `GET /api/leaderboard?board=battles|collection|legendary&period=week|all`. Top 100 plus le rang du joueur, connecté uniquement, à partir de `wm.user_stats` et `wm.user_rarity_counts` indexés, en cache 60 s.
- **Points ouverts → défaut** : métrique par défaut = victoires en bataille sur la semaine (§5.8 : « alimenté par les batailles »).

### 7.11 Pro et boutique (Stripe)

- **Produits** en mode test, en CAD, déclarés dans `lib/shop.ts` : `pro_monthly` (9,99 CAD/mois, abonnement) et `wb_2500` (4,99 CAD, paiement unique).
- **Routes.**
  - `POST /api/stripe/checkout {item}` crée une Checkout Session avec `client_reference_id` et `metadata.uid`. Elle exige `consent_collection.terms_of_service`, avec un texte personnalisé de **renonciation au droit de rétractation**.
  - `POST /api/stripe/portal` ouvre le portail client.
  - `POST /api/stripe/webhook` lit le corps brut (`req.text()`), vérifie la signature avec `constructEvent`, puis fait **un** appel à `wm.stripe_apply(event)`.
- **`wm.stripe_apply`.**
  - Il insère d'abord dans `stripe_events` : en cas de conflit, il ne fait rien.
  - `checkout.session.completed` et `async_payment_succeeded` en mode paiement créditent 2 500 WB (réf. `stripe:<session_id>`, la même pour les deux événements).
  - `customer.subscription.*` et `invoice.*` mettent à jour `wm.subscriptions`, et `profiles.is_pro` passe à `status in ('active', 'trialing')`. `is_pro` n'est **jamais** modifié à la main, sauf par une action staff auditée.
  - `charge.dispute.created` ajoute le cas à une file staff, sans reprise automatique (les achats sont définitifs, /terms).
  - Si le traitement échoue, la route renvoie 500 et Stripe réessaie ; un doublon ne fait rien.
- **Avantages Pro** (§5.4) : régénération en 180 s, paquet Pro du jour, 10 ventes simultanées, historique des ventes détaillé, 10 batailles par jour, pastille PRO sur l'onglet Marché de la modale. Même réserve (10) et mêmes cotes (C27). `is_vip` reçoit les mêmes avantages (différence inconnue).
- **UI** : modale boutique, encarts d'abonnement, bannière d'achat quand le stock est à 0 (§2.2). Démo : **test clocks** pour montrer un renouvellement en direct.
- **Tests** : événements de fixture signés avec `generateTestHeaderString` dans le bac à sable, `stripe trigger` en CI.
- **Points ouverts → défaut** : recharges de paquets non vendues ; Apple et Google hors périmètre.

### 7.12 Modération et administration

- **Rôles et accès.** `wm.staff(user_id, role 'moderator'|'admin')`. Les pages `/admin/*` sont des Server Components qui vérifient `wm.is_staff`. Chaque action passe par une fonction `wm.admin_*` **auditée** dans `wm.staff_actions`.
- **Files de traitement.**
  - Signalements d'image : le bouton « Signaler l'image » bascule `aria-pressed` et écrit dans `wm.card_image_reports`. À **10 signaleurs distincts**, `hide_image` est activé automatiquement en attendant la revue (incidents du §1.4).
  - Signalements de joueurs (`reports`).
  - Messages : le staff peut supprimer des messages privés et de guilde.
- **Outils sur les cartes** : basculer `hide_image` et `nsfw_image` ; retirer une carte (`wm.card_removals`, ce qui la sort du pool par *swap-with-last*, et chaque reconstruction du catalogue respecte ce retrait) ; forcer un renommage.
- **Sanctions** (§7.3 du recap) : avertissement, restriction, suspension, bannissement. Elles se traduisent par `activity_blocked_until` ou `packs_blocked_until`, un bannissement GoTrue, un ajustement de WB (réf. `staff:<action_id>`) ou un retrait d'objets. Toutes sont réversibles et auditées.
- **Filtre sensible** : `hide_sensitive` vaut vrai par défaut. Les cartes `nsfw_image` affichent alors l'emblème jusqu'à ce que le joueur choisisse de les voir.
- **`/admin/health`** : statut des crons, enchères en retard, retard du push, file de quiz, âge du catalogue, invariant monétaire. Un bouton « Réinitialiser la démo » remet en état les comptes de démo ; il n'existe que si `DEMO_MODE=true`.

---

## 8. Contrat d'API, UI et branding

### 8.1 Règles de parité (appliquées par les tests de contrat)
1. **Mêmes chemins et méthodes**, sans préfixe de locale : les pages du §2 et les routes du §3. La surface `rest/v1` du §3 (lectures et écritures directes) est gardée sous RLS. Les pages connectées sans session redirigent vers `/login`. `/pull` renvoie en 308 vers `/pulls` (§10.1 n° 14).
2. **Formes JSON** : on renvoie **l'union** des champs observés (objets `Auction`, `Trade` et `CardInPack`, réponses de `mine`, `stats`…). Les clés requises sont vérifiées strictement ; les clés en plus sont permises. Les enveloppes listées au §3 sont respectées : `{auction, bids}`, `{trade}`, `{collection, total}`.
3. **Pagination** : base 0 pour `my-collection`, `cards` et `profile/*/collection` ; base 1 pour `marketplace`. 50 éléments par page, `limit` plafonné à 50. Une page courte signale la fin, et on renvoie aussi `hasMore` ou `searchHasMore`, ainsi que `total`. PostgREST garde `max_rows = 1000` (`Range: 0-999`).
4. **Erreurs** : corps `{error, message, code?, …}`, la même chaîne française dans `error` et `message`, avec les statuts du §8.2. Les codes Postgres `42501` et `23505` restent visibles sur PostgREST en direct.
5. **En-têtes** :
   - `x-wiki-calendar-tz` est lu ;
   - `Date` est fiable ;
   - `Retry-After` accompagne chaque 429 et 503 ;
   - les `Set-Cookie` de rafraîchissement de session sont ceux de `@supabase/ssr` ;
   - le cookie s'appelle `sb-<ref>-auth-token` (découpé en `.0`, `.1`…), et en option B il est forcé à `sb-cyrxjeppjqsxxjayfrur-auth-token` par `AUTH_COOKIE_NAME`.
6. **Session** : 401 sans session, 403 si le compte est restreint (§3.0).
7. **DOM** : chaque sélecteur du §6.8 existe sur sa page. Un test Playwright (`e2e/selectors.spec.ts`) le prouve : c'est la garantie de compatibilité avec les extensions.

### 8.2 Catalogue des erreurs (chaînes exactes ; le recap §6.7 fait foi pour celles qu'il cite)

| Situation | Statut | Corps (`error` = `message`) |
|---|---|---|
| Sans session | 401 | `{code:'unauthorized', error:'Session expirée, reconnecte-toi.'}` |
| Entrée invalide | 400 | `{code:'invalid_request', error:'<message français précis>'}` |
| Stock de paquets vide | 403 | `{error:'Plus de paquets disponibles', packs_remaining:0, next_regen_at}` |
| Vérification humaine requise | 403 | `{code:'human_verification_required', human_verification_required:true, error:'Vérification anti-bot requise pour continuer à ouvrir des paquets.'}` (pour les mises et mises en vente : « Vérification anti-bot requise pour continuer. ») |
| Ouvertures trop rapprochées | 429 | `{rate_limited:true, retry_after, error:'Le site demande de ralentir'}` |
| Plafond quotidien de paquets | 429 | `{rate_limit_daily:true, error:'Limite quotidienne de paquets atteinte'}` |
| Compte restreint | 403 | `{activity_blocked_until \| packs_blocked_until, error:'Ton compte est temporairement restreint.'}` |
| Copie non possédée | 403 | `{code:'42501', error:'Vous ne possédez pas cette carte'}` |
| Copie engagée dans un échange | 409 | `{error:'Cette carte est déjà engagée dans un échange en attente'}` |
| Trop de ventes simultanées | 409 | `{error:'Limite de {n} enchères actives atteinte'}` |
| Mise trop basse | 409 | `{code:'bid_too_low', min, error:'Mise trop basse (minimum {min} wikibidous)'}` |
| Solde insuffisant | 409 | `{code:'insufficient_balance', error:'Solde insuffisant'}` |
| Retrait d'une vente avec mises | 409 | `{error:'Une enchère en cours ne peut pas être retirée'}` |
| Fonction Pro | 403 | `{code:'pro_required', error:'Fonction réservée aux membres Pro'}` |
| Carte ou enchère introuvable | 404 | `{error:'Carte introuvable'}` / `{error:'Enchère introuvable'}` (l'UI affiche « Auction not found », §2.2) |
| Échange déjà traité | 409 | `{error:"Cet échange n'est plus en attente (déjà traité)"}` |
| Amitié requise | 403 | `{code:'FORBIDDEN', error:'Vous devez être amis pour …'}` |
| Limite de débit générale | 429 | `{error:'Le site demande de ralentir', retry_after}` |
| Contention de verrous | 503 | `{code:'BUSY', error:'Le site est très sollicité, réessaie dans un instant.'}` + `Retry-After: 1` |
| Maintenance | 503 | `{code:'maintenance', error:'Maintenance en cours, reviens dans quelques minutes.'}` |

Les messages du domaine social, des guildes et des batailles ne sont pas connus (§10.3) : on écrit des messages français clairs, on garde les `code` normalisés d'E (`ALREADY_FRIENDS`, `REQUEST_PENDING`, `FRIEND_LIMIT`, `FORBIDDEN`), et la matrice de parité les marque « inféré ».

### 8.3 Routes ajoutées (absentes de l'original, §10.3)
`/api/stripe/{checkout,portal,webhook}` · `/api/push/subscribe` · `/api/settings/*` (pseudo, préférences, export, suppression) · `/api/cards/{id}/credits` · `/api/cards/{id}/image-report` · `/api/username-available` · `/api/leaderboard` · `/api/admin/*` · `/api/cron/{push,revalidate}` · `/api/health`.

### 8.4 Versionnage et écarts admis
- **Pas de préfixe de version.** Le contrat est celui du recap §3, plus des champs ajoutés. Il est interdit de supprimer, renommer ou retyper un champ ou un paramètre. Les nouvelles routes sont permises.
- **Chaque écart observable** est déclaré dans `parity/allowed-diffs.yaml` (route, écart, raison, source). Liste initiale :
  - règlement en ≤ 15 s au lieu d'1 à 2 min ;
  - filtre `card_id` du marché strict ;
  - `role="dialog"`, `aria-modal` et piège de focus sur les modales ;
  - champ `min_next_bid` ajouté ;
  - fonds de rareté en CSS au lieu des PNG ;
  - cache de 1 à 3 s sur les lectures publiques du marché ;
  - en-tête `Idempotency-Key` pris en charge ;
  - `pendingTradeCardIds` = union des deux sortes d'id ;
  - historique `won` complet ;
  - fenêtre de vues = mois civil précédent, sous le libellé « Vues (30j) » ;
  - nouvelles limites et nouveaux 429 ;
  - `owned_copies` sous forme de tableau ;
  - ordre stable de la collection ;
  - tris `atk`, `def` et `starred` ajoutés ;
  - paramètre `missing=1` ajouté.

### 8.5 UI et branding (référence : recap §6)
- **Shell** (§6.3) : `body > div.flex.h-dvh`.
  - Barre latérale desktop `nav.hidden.w-64…md:flex` avec les 13 entrées dans l'ordre exact du §2.2 et leurs icônes lucide.
  - Barre basse mobile (Paquets, Collection, Échanges, Marché, feuille « ••• Plus ») avec la marge `safe-area`.
  - C'est `main` qui défile. La cloche porte `aria-label="Notifications"` et un badge « 9+ ».
- **Composant carte** (§6.4) : le DOM est reproduit, car les extensions s'en servent comme contrat :
  - racine `glow-{x}`, zone image à 45 %, badge de rareté ;
  - bouton favori avec les `aria-label` exacts ;
  - `h3`, `p`, `div.mt-auto` et la ligne de stats avec les icônes épées et bouclier ;
  - voile `legendary-shimmer-sheen` pour les L ;
  - tailles `w-72 h-[420px]` et `clamp(…)`.

  Les fonds de rareté sont **recréés en CSS/SVG** : rayures pour SR, ondes pour UR, scintillement pour L. Les images sont des `<img loading="lazy" decoding="async">` qui pointent sur les miniatures de 330 px d'`upload.wikimedia.org`, sans l'optimiseur Vercel. Sans image, on affiche l'emblème de **notre** marque.
- **Modale de carte** (§6.5), avec la boîte de vente (`input[aria-label="Mise de départ"]`, 6 durées, « Marché · <rareté> », « Lancer l'enchère », toast exact). La ligne de licence CC BY-SA est complétée par l'auteur et la licence de l'image (`/api/cards/{id}/credits`).
- **Ouverture de paquet** (§2.2, §6.6) :
  - repos, puis révélation carte par carte (« Carte n / 5 », la meilleure en dernier), puis récapitulatif ;
  - balayage par pointeur (seuil de 80 px), flèches ← → du clavier, boutons ronds, 5 points ;
  - « Encore N cartes » reste désactivé tant que toutes les cartes n'ont pas été vues ; badges « Nouvelle » et « Brillante » ;
  - paliers SR, UR et L, avec une cinématique pour L ;
  - **nos** sons sont synthétisés en WebAudio, avec réglage de coupure dans les Paramètres ;
  - compte à rebours « Prochain dans m:ss » et barre de stock en 10 segments.
- **Jetons** (`@theme`) : valeurs du §6.1 (fond `#0d0d0d`, accent `#34d399`, les six couleurs de rareté et leurs teintes foncées). Titres en Rubik, texte courant en Inter, via `next/font`. **Sombre uniquement.**
- **Marque (§3.4).**
  - `NEXT_PUBLIC_BRAND_NAME` est la seule valeur. `lib/brand.ts` en dérive le logo texte (préfixe « Wiki » en accent s'il est présent), le favicon généré (`app/icon.tsx`), les titres (« Connexion — {marque} ») et les mentions légales.
  - Aucune image de logo n'est copiée.
  - **Porte démo** : avec `DEMO_GATE_PASSWORD` et `GATE_COOKIE_SECRET`, `proxy.ts` envoie toute requête sans cookie HMAC `wm_gate` vers `/gate` (les API reçoivent un 401 JSON). Exceptions : `/api/stripe/webhook`, `/api/cron/*` (en-tête secret) et `/api/health`. Avec la porte : `X-Robots-Tag: noindex, nofollow, noarchive` partout, `robots.txt` qui interdit tout, `<meta name="robots" content="noindex">`.
  - **Fail-closed** : si la marque, normalisée, vaut « wikimasters » et qu'aucun mot de passe de porte n'est défini, `lib/brand.ts` lève une erreur au démarrage.
- **Design system avec Impeccable.** Au M0, le skill Impeccable produit `docs/DESIGN.md` et les jetons à partir du §6. Il sert ensuite aux passes de finition sur la carte, le paquet, la modale et le shell, **sans toucher** aux classes et attributs exigés par les §6.4 et §6.8.
- **Pages jamais capturées** (§9.3 n° 15 : profil, guilde, amis, messages, bataille, succès, classement, paramètres, détail d'échange, boutique) : elles sont dessinées selon les conventions du shell et du §6, et leurs états vide, erreur et chargement sont traités avec Intent `fortify`.

### 8.6 Accessibilité (barrière de CI)
- WCAG 2.2 AA.
- Playwright + axe sur chaque route : 0 violation *serious* ou *critical*.
- Contraste du texte ≥ 4,5:1, focus visible.
- Parcours complets au clavier : ouverture de paquet, vente, mise, échange, bataille.
- Modales en `role="dialog"` avec piège de focus et fermeture par Échap.
- `aria-live="polite"` à la révélation d'une carte (« Carte 3 / 5 : <titre>, Légendaire »).
- `prefers-reduced-motion` : un simple fondu.
- Cibles tactiles ≥ 44 px.
- `lang="fr"`, nombres au format fr-FR avec une espace fine comme séparateur.
- `alt` = titre pour l'image d'une carte, `alt=""` pour les images décoratives (§6.4).

---

## 9. Performance et robustesse

### 9.1 Modèle de charge
- 200 k DAU, soit 25 à 30 k joueurs simultanés au pic, avec des rafales ×3 pendant 15 min (type ZEvent).
- Environ 3 k req/s humaines et 2 k req/s de bots : un seul outil a lancé 6 229 appels en 4 min (§1.4).
- Écritures au pic :

  | Action | Débit |
  |---|---|
  | Ouvertures de paquet | 300/s (1 000/s en rafale) |
  | Défausses | 500/s |
  | Mises | 150/s, dont 50/s sur une seule enchère |
  | Mises en vente | 30/s |
  | Acceptations d'échange | 5 à 20/s |
  | Messages de chat | 50/s |

- Environ 15 M de `user_cards` créées par jour.

### 9.2 Cibles chiffrées (contre l'original, §1.4)

| Flux | Cible (p95, côté serveur depuis cdg1) | Original |
|---|---|---|
| Ouverture de paquet | < 300 ms de bout en bout ; < 15 ms en base | paquets affichés à 0 |
| Mise | < 150 ms ; < 20 ms en base | — |
| Page de collection d'un compte de 100 k copies, n'importe quelle page, `sort=rarity` | < 150 ms | 20 s, 504 |
| Acceptation d'un échange 100 ↔ 100 | < 500 ms, atomique | timeout au-delà d'environ 30 cartes |
| Liste du marché (cache) | < 100 ms | recherche en environ 30 s |
| Délai de règlement | p99 < 15 s | 1 à 2 min |
| Suppression d'une étiquette posée sur 10 k copies | < 1 s | timeout |
| Ensemble | erreurs < 0,1 %, 0 interblocage, CPU base < 70 %, attente du pool PostgREST < 5 % | saturation |
| Bot qui déborde | 429 en < 5 ms, sans effet sur les autres (p95 des autres à moins de +10 %) | serveur saturé |

### 9.3 Pourquoi ça tient
1. **Une requête = une RPC courte**, via le pool fixe de PostgREST. Aucune connexion pg depuis Vercel, ce qui écarte la saturation de connexions de l'original.
2. **Échec rapide** : `lock_timeout` de 2 s et `statement_timeout` de 5 s (C7).
3. **Ordre de verrouillage fixe** (C4) : aucun interblocage. Une enchère très disputée sérialise ses mises, à quelques ms chacune.
4. **Agrégats précalculés** : `user_rarity_counts` (collection, totaux et statistiques en O(1)), `catalog_stats` (cumuls des pages), `user_stats` (succès et classements).
5. **Échanges, défausses en masse et étiquettes ensemblistes** : quelques instructions, quelle que soit la taille.
6. **Cache des lectures partagées** (C16) avec overlay par utilisateur : un bot qui interroge une enchère toutes les 150 ms coûte au plus environ 1 requête base par seconde **pour cette enchère**.
7. **Polling uniquement sur onglet visible** ; la cloche lit PostgREST en direct.
8. **Co-localisation** : Vercel en `cdg1` et Supabase en eu-west-3, Paris, moins de 2 ms entre les deux.
9. **Catalogue compatible HOT** : `fillfactor 90`, et `pageviews` n'est dans aucun index, donc le rafraîchissement mensuel ne réécrit pas les index.
10. **Grand livre sobre** : les défausses unitaires sont comptées, pas journalisées.

### 9.4 Index (piste ADDITIVE ; créés `CONCURRENTLY` sur les grosses tables)
- `user_cards` : `(user_id, obtained_at desc, id)`, `(user_id, snapshot_rarity desc, obtained_at desc, id)`, `(card_id, user_id)` ; index partiel sur `starred`.
- `user_card_tags (tag_id)` · `wishlist_items (card_id)`.
- `cards` : unique `(lang, wikipedia_title)`, `lower(wikipedia_title) text_pattern_ops`, GIN trigramme sur `unaccent(lower(titre || ' ' || catégorie))`.
- `auctions` :
  - partiels `where status = 'active'` sur `(end_at)`, `(created_at desc)`, `coalesce(current_bid, base_amount)` et `(current_bidder_id)`, plus un GIN trigramme sur `snapshot_search_document` ;
  - `(seller_id, status, created_at desc)`, `(winner_id, settled_at desc)` ;
  - `(card_id, snapshot_rarity, settled_at desc) where status = 'settled_sold'`.
- `auction_bids (auction_id, placed_at desc)`, `(bidder_id, placed_at desc)`.
- `trades (initiator_id, status, created_at desc)`, `(recipient_id, status, created_at desc)` · `trade_items (trade_id)`, `(offered_by, card_id)`.
- `notifications (user_id, created_at desc)` et partiel `(user_id) where read = false` · `chat_messages (sender_id, recipient_id, created_at desc)`.
- `profiles` : unique `lower(username)` · `wm.wb_ledger (user_id, created_at desc)` · `wm.user_stats` sur les colonnes de classement.

### 9.5 Cache et polling

| Lecture | Cache partagé (`'use cache: remote'`) | Invalidation |
|---|---|---|
| Page de `/api/cards` | 1 h | `revalidateTag('catalog', 'max')` appelé en fin de job catalogue |
| Liste du marché | 3 s par requête normalisée | TTL |
| Détail d'une enchère | 1 s | TTL (la réponse d'une mise renvoie l'état frais à celui qui mise) |
| Résumé des ventes | 60 s | TTL |
| Classement des guildes / des joueurs | 30 s / 60 s | TTL |
| Crédits d'une image | 30 jours (CDN) | — |

Le M0 vérifie sur 16.4.2 ces trois points : `cacheComponents`, `'use cache: remote'` dans les route handlers, et le runtime cache sur le plan. Si le cache distant manque, on se replie sur un cache mémoire par instance de 1 à 3 s (`shortcut:`), plus faible mais sans effet sur le contrat.

| Écran | Intervalle de polling (onglet visible seulement) |
|---|---|
| Détail d'une enchère | 2 s sous 2 min restantes, sinon 10 s |
| Liste du marché / échanges | 15 s / 20 s |
| Arène / liste des batailles | 3 s / 15 s |
| Cloche | 30 s (PostgREST direct) |
| Message privé ouvert / chat de guilde | 5 s |

### 9.6 Mesures indicatives déjà faites (PG16 local, 4 vCPU, données synthétiques)
Ce sont des chiffres **optimistes** : les tables `profiles`, `user_cards` et le catalogue étaient en `UNLOGGED`, et le bench de règlement ne recréait ni la copie ni les notifications.

| Mesure | Résultat |
|---|---|
| Tirage de 5 cartes | 0,09 ms ; distribution égale aux parts du catalogue |
| `open_pack` complet | environ 3 200 tx/s |
| Compte baleine de 100 k copies, `sort=rarity`, offset 98 000 | 84 ms (offset 99 950 en jointure différée : 20,7 ms) |
| Déplacer 100 copies dans un échange | 2,3 ms |
| Mises sur une seule enchère | 589/s, 0 interblocage |
| Règlement | 5 000 enchères en 97 ms |

**À refaire avec des tables journalisées** (`load/bench/*.sql`, scripts commités) au M3 et au M8. Seuls les nouveaux chiffres sont présentés au pitch, avec leur méthode.

### 9.7 Plan de test de charge (`load.yml`, k6 dans Actions)
- **Cible** : un projet Supabase Pro temporaire `wm-load`, passé en compute 4 cœurs le temps des tirs (environ 2 h), puis supprimé.
- **Jeu de données** (`load/seed.sql`), dimensionné pour **tenir dans 8 Go** (sinon, pré-provisionner le disque avant le seed) : le catalogue complet (réel s'il est chargé, sinon synthétique de 2,77 M), 200 k profils, 6 M `user_cards` dont 10 baleines de 100 k copies, 45 k enchères actives, 300 k mises, 20 k échanges en attente.
- **Méthode** : k6 vise `next start` sur des runners GitHub, pour ne pas consommer le quota Hobby, et mesure le temps base par `Server-Timing` et `pg_stat_statements`. Une passe de fumée de 10 min sur la vraie preview Vercel (environ 100 à 200 req/s) mesure la latence de bout en bout depuis cdg1.

| # | Scénario | Critère de réussite |
|---|---|---|
| S1 | Tempête de paquets : 300 ouvertures/s pendant 10 min, puis 1 000/s pendant 2 min | p95 base < 15 ms, 0 erreur, invariants OK |
| S2 | Bots : 3 k req/s sur la liste et le détail du marché | QPS base de ces lectures < 100 ; p95 < 200 ms |
| S3 | Guerre d'enchères : 500 VU sur 5 enchères dans les 30 dernières secondes | Σ solde + Σ mises en tête conservé à l'unité, p95 < 100 ms, anti-snipe correct |
| S4 | Collection des baleines : pages au hasard, `sort=rarity` | p95 < 150 ms |
| S5 | 10 échanges 100 ↔ 100 avec WB en parallèle | < 500 ms chacun, atomiques ; une erreur injectée annule tout |
| S6 | Mélange ZEvent, 25 k joueurs simulés pendant 30 min | lectures p95 < 250 ms, écritures < 400 ms, erreurs < 0,1 %, CPU < 70 %, attente du pool < 5 % |
| S7 | Inondation par des bots : 200 comptes interrogent une enchère toutes les 150 ms | 429 pour eux, p95 des autres à moins de +10 % |

**Sans projet Pro temporaire** (question 1 du §15) : les tirs visent un Postgres 17 et PostgREST lancés dans un runner GitHub, et les chiffres sont présentés comme indicatifs, jamais comme une mesure sur l'infrastructure réelle.

Après chaque tir, on archive en artefacts `select wm.check_invariants()` et le top 20 de `pg_stat_statements`.

### 9.8 Recommandation de capacité pour la production (pour Naïm)
Supabase Pro en compute XL (4 cœurs dédiés), passé en 2XL les soirs d'événement : la montée prend moins de 2 min d'interruption et se fait **avant** l'événement. Vercel Pro (usage commercial) en `cdg1`. Le grand livre passe en partitions au-delà de 20 M de lignes (C5).

---

## 10. Pipeline catalogue

### 10.1 Règles
- **Rareté** (§5.2) : C < 50 ≤ PC < 250 ≤ R < 1 000 ≤ SR < 5 000 ≤ UR < 20 000 ≤ L, en vues **humaines** mensuelles de fr.wikipedia. La fenêtre est le **mois civil précédent**, le libellé UI reste « Vues (30j) » (écart admis, §10.1 du recap non tranché).
- **Notre formule `stats_v1`** (plan B et démo). Avec `pct()` = rang percentile dans le catalogue :
  - `q_score = round(100 × (0,45·pct(text_bytes) + 0,35·pct(ln(1 + liens entrants)) + 0,20·badge), 2)`, où badge vaut 1 pour un AdQ, 0,6 pour un BA, 0 sinon ;
  - `ATK = round(1000 + 9000 · pct(text_bytes))` ;
  - `DEF = round(1000 + 9000 · pct(q_score))` ;
  - plafond de 10 000, ce qui reste cohérent avec les plages observées (une C a environ 1 650 d'ATK).
- **Le catalogue de Naïm** : `catalog_stats_frozen = true`. ATK, DEF et `q_score` ne sont **jamais** recalculés, puisqu'on ne connaît pas sa formule. Seuls la rareté et les vues sont rafraîchies. Les copies gardent toujours leurs snapshots (§5.2).
- **Brillantes** : mêmes statistiques que la carte (la plage 10 001–15 000 ne vient que du clone).
- **Contenu d'une carte** (§5.2) :
  - titre exact de l'article ;
  - image principale libre (`page_image_free`) en miniature Commons de 330 px (`.png` ajouté pour un SVG) ;
  - `category` = description Wikidata en français ;
  - `summary` = introduction en texte brut, coupée sur une fin de phrase à 1 200 caractères (600 en mode échantillon) ;
  - les pages d'homonymie et les redirections sont exclues.

### 10.2 Workflow `catalog.yml` (le 3 de chaque mois, et à la demande ; entrées `mode: full|sample` et `target`)

| Job | Source (Actions a internet) | Sortie | Durée estimée |
|---|---|---|---|
| dumps | `frwiki-latest-page.sql.gz` et `page_props.sql.gz`, lus en flux (tuples `INSERT` MySQL) | `pages.tsv` (page_id, titre, longueur ; ns 0, hors redirections) ; `props.tsv` (page_image_free, wikibase_item, homonymie) | ~15 min |
| pageviews | `pageview_complete/monthly/…/pageviews-YYYYMM-user.bz2` en flux (`curl \| lbzip2 -d \| grep '^fr.wikipedia '`), jamais stocké | `views.tsv` | 30–45 min |
| text | dump `cirrussearch` content (`opening_text`, `text_bytes`, `incoming_links`, modèles AdQ/BA). **Repli** si le format change : API TextExtracts (`exintro&explaintext`, 20 titres par appel, reprenable) | `text.tsv` | 40 min / ~4 h en repli |
| wikidata | `wbgetentities?props=descriptions&languages=fr` par lots de 50, 4 en parallèle, `maxlag=5`, User-Agent explicite, point de reprise dans `actions/cache` ; ensuite un delta mensuel | `desc.tsv` | ~2 h la 1re fois |
| commons | `imageinfo&iiprop=extmetadata` (Artist, LicenseShortName, LicenseUrl) par lots de 50 fichiers, reprenable | `media.tsv` | ~1 h la 1re fois |
| compute + emit | Les fichiers ci-dessus ; mode `sample` = hachage du `page_id` < 9 % au sein de chaque rareté (C9) | `cards.csv` (colonnes miroir exactes), `media.csv` | ~10 min |
| load | `psql` via l'URL **session** de Supavisor (IPv4) → `\copy wm.catalog_stage` → `select wm.catalog_merge(mode)` | — | ~20 min |

Chaque job reste sous la limite de 6 h. Première construction : environ 5 à 8 h de runner au total (estimation), puis environ 2 h par mois.

### 10.3 `wm.catalog_merge`
1. **Correspondance** par `page_id` (`wm.card_source`), sinon par `(lang, wikipedia_title)`. En option A, le premier passage remplit `card_source` par titre. Les nouveaux articles reçoivent `gen_random_uuid()`.
2. **Mise à jour par lots de 50 k**, uniquement sur la liste blanche du §6.3. `image_url` n'est pas touché si le staff a posé un drapeau image.
3. **Jamais de suppression.** Un titre absent du dump sort seulement du pool. Les retraits du staff sont respectés.
4. **Pool** : *swap-with-last* pour chaque changement de rareté ou exclusion, `catalog_stats` mis à jour dans la même transaction. Ensuite, le workflow appelle `POST /api/cron/revalidate` (`x-cron-secret`), qui revalide le tag `catalog`.
5. **Gel** : le job ne fait rien si `catalog_frozen` est actif (bascule).
6. **Idempotence** : deux passages donnent le même état, avec des ids inchangés (test sur fixtures).

### 10.4 Fixtures et développement dans le bac à sable
`catalog/fixtures/` contient environ 300 enregistrements de chaque format. Ils sont produits une seule fois par un job `fixtures` dans Actions (tête de chaque vrai dump, avec l'attribution CC BY-SA) puis commités. Les tests unitaires des parseurs et des calculs tournent sur ces fixtures. Un chargement de bout en bout dans PG16 vérifie les comptes, la répartition par rareté, l'idempotence et la stabilité des ids.

### 10.5 Taille contre plans

| Variante | Cartes | Taille estimée (tas, index, pool, licences) | Plan |
|---|---|---|---|
| Complet | 2 773 461 | ≈ 2,9 à 3,3 Go, + ≈ 0,2 Go de licences | **Pro** (8 Go inclus) |
| Échantillon proportionnel 9 % | ≈ 250 k | ≈ 0,25 Go | Free (500 Mo, il reste ≈ 0,2 Go pour l'auth, les joueurs de démo et les copies) |
| Dev et CI | 2 000 (seed) | négligeable | — |

L'en-tête de « Collection Globale » affiche toujours les **vrais totaux chargés** : on n'affiche jamais 2 773 461 si ces cartes ne sont pas toutes là.

### 10.6 Images et licences
- **Miniatures en lien direct** vers `upload.wikimedia.org`, en chargement paresseux et sans optimiseur. Si Wikimedia se met à limiter le débit, un cache d'images deviendrait un coût nouveau : c'est un risque, hors périmètre.
- **Licences affichées** : la ligne CC BY-SA 4.0 du texte, l'auteur et la licence de l'image (`wm.card_media`), une page `/credits`, et la mention « Projet indépendant de la Fondation Wikimedia ».

---

## 11. Kit de migration et preuve de parité

### 11.1 Prérequis : la coopération de l'exploitant (§8.0)
Aucune migration n'a lieu sans l'accord écrit de Naïm. Il faut, dans cet ordre :
1. le **DUMP-S** (`pg_dump --schema-only` de `public`, `auth`, `storage` et `cron`), demandé en premier ;
2. les agrégats **DUMP-D** sans données personnelles (§10.6 du recap) ;
3. l'accès au projet : transfert, ou accès collaborateur ;
4. le domaine, Stripe, les clés VAPID, Turnstile et les variables d'environnement Vercel.

Dès réception du DUMP-S, appliquer la porte de fidélité du §6.1 et corriger `wm.config` à partir de ce qu'il révèle.

### 11.2 Option A : se brancher sur son projet (préférée, aucun déplacement de données)
1. **Répéter d'abord** sur une copie restaurée de son dump (projet Pro temporaire, ou PG16 local).
2. **Inventaire** avec `migration/schema-diff.sql` : tables, colonnes, fonctions, triggers, `cron.job`, RLS, `storage`. Pour chacun de ses jobs et triggers, décider de le garder ou de le remplacer. Son job de règlement et son job de rareté sont **déprogrammés** quand les nôtres démarrent, car deux régleurs ne doivent jamais tourner ensemble.
3. **Index** `CONCURRENTLY` lancés à la main depuis le runbook, puis migrations ADDITIVE. Aucun fichier MIRROR, aucune colonne de `public` ajoutée ni modifiée. On n'ajoute que des policies de lecture absentes, après revue.
4. **Rattrapages** (`migration/backfill.sql`, par lots, reprenables) :
   - une écriture d'ouverture par joueur dans le grand livre, égale au solde courant ;
   - `user_rarity_counts` et `user_stats` (au mieux, à partir de l'historique) ;
   - `draw_pool`, `catalog_stats` et `card_source` (correspondance par titre) ;
   - `auction_escrow` pour les enchères actives, construit à partir de **sa** représentation du séquestre ;
   - `subscriptions`, via `stripe-backfill.ts` ;
   - `catalog_stats_frozen = true`.
5. **`wm.apply_regen`** aligné sur sa fonction `sync_profile_packs`. Celle-ci n'est pas remplacée, et **la configuration Auth de son projet n'est pas modifiée**.
6. **Clé de signature JWT asymétrique** ajoutée pendant le gel (T0), **sans révoquer le secret hérité** : la clé anon et les jetons existants restent valides (à vérifier en répétition). `getClaims()` vérifie ensuite en local.
7. **Bascule** : le domaine Vercel pointe vers la nouvelle app ; le webhook Stripe vers le nouveau point d'entrée ; ses clés Turnstile et VAPID passent dans l'environnement. **Personne n'est déconnecté** (même cookie, même clé anon), et les outils tiers continuent de marcher.
8. Interruption visée : **moins de 15 min**.

### 11.3 Option B : restaurer son `pg_dump` dans notre projet
1. Projet **Pro** (ses données dépassent largement 500 Mo). Restauration selon la procédure Supabase « migrer depuis un autre projet » : rôles, puis schéma (`public` et `auth`), puis données avec `session_replication_role = replica` et `--no-owner`, puis `pg_restore -j 8`. Les index sont construits après les données. `cron.job` n'est gardé que pour référence.
2. Étapes 2 à 5 de l'option A. Les rattrapages sont **obligatoires**, puisque nos triggers ne se sont pas déclenchés pendant le chargement.
3. **Sessions** : on restaure `auth.users` (empreintes bcrypt), `identities`, `sessions` et `refresh_tokens`, on importe le **secret JWT hérité** (à vérifier en répétition, §9.1 n° 2) et on fixe `AUTH_COOKIE_NAME`. Si l'import du secret est impossible :
   - tout le monde se reconnecte, avec un mot de passe toujours valable ;
   - une bannière « Reconnecte-toi » s'affiche ;
   - les intégrations `rest/v1` directes cassent (nouvelle URL, nouvelle clé), tandis que `/api/*` reste identique.
4. **Auth** : SMTP, modèles français, longueur de l'OTP, captcha, et limites relevées pour environ 1 700 inscriptions par heure.

### 11.4 Rapprochement et invariants (tolérance zéro)
`migration/reconcile.sql` tourne sur la source et sur la cible et produit un document JSON. `reconcile-diff.ts` compare les deux : le résultat décide du go ou no-go. **En option A**, la source et la cible sont la même base, avant et après nos migrations : le rapprochement prouve qu'elles n'ont rien changé.

- **Nombre de lignes** de chaque table de `public` et `auth`.
- **Empreintes des colonnes sacrées** : `md5(string_agg(… order by id))` réparti en **256 seaux** (premier octet de l'uuid), pour savoir où se trouve un écart :
  - `user_cards(id, user_id, card_id, count, starred, is_shiny, snapshot_*, obtained_at)` ;
  - `tags`, `user_card_tags`, `wishlist_items` ;
  - `auctions(id, snapshot_rarity, listing_base_amount, base_amount, base_repriced_at, end_at, current_bid, current_bidder_id, status)`, `auction_bids` ;
  - `trades`, `trade_items` ;
  - `profiles(id, username, wikibidous_balance, packs_remaining, packs_last_regen_at, pack_cap, is_pro, is_vip, *_blocked_until)` ;
  - `user_achievements(user_id, achievement_id, claimed_at)`, `cards(id, wikipedia_title, rarity)` ;
  - `auth.users(id, email, encrypted_password, email_confirmed_at, banned_until)`.
- **Masse monétaire.** `M = Σ profiles.wikibidous_balance + Σ current_bid des enchères actives qui ont un meneur`. Les mises sont réservées par débit immédiat : elles ne sont donc plus dans les soldes et il faut les ajouter. On n'ajoute **aucun terme** pour les WB des échanges en attente : non séquestrés, ils sont **déjà** dans les soldes, et les ajouter les compterait deux fois. **(corrige** l'invariant du §8.2 du recap, signalé au §10.1 n° 1.**)** La formule exacte de la source se fixe sur le DUMP-S :
  - si l'original réserve par débit (observé, prob.), `M_source` suit la même formule ;
  - s'il réserve par blocage sans débit, `M_source = Σ solde`, et la migration convertit chaque blocage en débit, avec une écriture `migr-hold:<auction_id>`.

  Dans les deux cas, `M_source = M_cible` à l'unité près.
- **Autres agrégats** : Σ `count` par (`snapshot_rarity`, `is_shiny`), nombre d'enchères actives, d'échanges en attente et de succès réclamés, Σ `packs_remaining`.
- **Échantillons exacts** : 100 joueurs tirés au hasard et les 10 plus grosses collections, comparés ligne à ligne.
- **Après les migrations et rattrapages**, `wm.check_invariants()` renvoie 0 violation sur les règles suivantes :
  - pour chaque joueur, solde = ouverture + Σ grand livre + `discard_wb` depuis l'ouverture ;
  - globalement, `M(t) = M(ouverture) + Σ créations`, où les créations sont les défausses, les succès, les batailles, Stripe et les ajustements du staff. Aucune destruction n'est documentée, et une vente est un transfert ;
  - aucune copie n'est à la fois en séquestre et possédée ;
  - aucun solde n'est négatif ;
  - chaque enchère active qui a un meneur a exactement une réservation non remboursée, égale à `current_bid` ;
  - Σ `count` par joueur = `user_rarity_counts`.
- **Seul écart permis** : `end_at += durée du gel` sur les enchères actives, journalisé enchère par enchère.

### 11.5 Runbook de bascule (`migration/RUNBOOK.md`, répété au moins deux fois et chronométré)
1. **J-7** : annonce sur Discord et par bannière. Fenêtre fixée au **lundi 00:05 UTC**, juste après la remise à zéro hebdomadaire des guildes.
2. **J-1** : dernière répétition sur le dump le plus récent. On nomme les responsables du go/no-go et on lit le plan de retour arrière à voix haute.
3. **T0 : gel des écritures**. L'ancienne app passe en maintenance, `wm.config.maintenance` est activé, le job de rareté est arrêté, et Stripe met ses webhooks en file (il réessaie tout seul).
4. **T+2** : on laisse l'ancien régleur vider les enchères échues, jusqu'à ce qu'aucune enchère ne soit `active` avec `end_at <= now()`.
5. **Option B seulement** : dump final et restauration.
6. **Migrations et rattrapages** : migrations ADDITIVE, rattrapages, déprogrammation de ses jobs, clé asymétrique (option A).
7. **Rapprochement**, puis go ou no-go.
8. **Bascule** : DNS et domaine Vercel, URL du webhook Stripe, rejeu des événements manqués (Stripe garde 30 jours d'historique).
9. **Fumée** : `migration/smoke.ts` avec un compte staff de test (connexion, sync des paquets, ouverture, mise en vente, mise, retrait, échange créé puis accepté, défausse, route Pro, push de test, `/api/health?deep=1`).
10. **Dégel**, avec `end_at += durée du gel`. Surveillance renforcée pendant 48 h : erreurs, p95, invariants toutes les heures.

### 11.6 Retour arrière
L'ancienne pile reste intacte jusqu'à J+14.
- **Pendant les 2 premières heures** : retour du DNS.
  - **Option A** : on déprogramme nos crons, on reprogramme les siens et on lance `migration/rollback-escrow.sql`. Ce script reconvertit nos séquestres `wm.auction_escrow` dans **sa** représentation, pour qu'aucune copie en vente ne se perde. Le schéma `wm` reste en place, inerte.
  - **Option B** : les écritures faites après la bascule sont exportées depuis le grand livre et les logs RPC, puis rejouées à la main.
- **Au-delà de 2 h** : on corrige uniquement vers l'avant.

### 11.7 Preuve de parité
1. **Tests de contrat.**
   - `contract/spec/*.ts` contient une `RouteSpec` par route du recap (environ 70) et par route ajoutée (environ 15) : schéma zod partagé avec `lib/contract.ts`, statuts, chaînes d'erreur exactes, base de pagination, en-têtes, citation de la source (`§3.5 · S 2926-2940`) et confiance (`conf.`, `prob.` ou `inc.`).
   - `contract/recap-coverage.ts` lit les tableaux du recap (lignes `| GET | /api/…` et `rest/v1/*`). Il fait échouer la CI s'il manque une spec, si une spec n'a pas de handler, ou si une route `rest/v1` n'a pas de test RLS. C'est un rapport jusqu'au M6, puis une barrière bloquante à partir du M7.
   - Modes d'exécution : HTTP dans le bac à sable (PostgREST local) ; HTTP en CI (`supabase start` + `next start`) ; lecture seule contre wiki-masters.com **uniquement avec le consentement de Naïm et ses comptes de test**.
2. **Sélecteurs DOM** : `e2e/selectors.spec.ts` couvre tous les sélecteurs du §6.8.
3. **REA ancien contre nouveau** (`parity.yml`, déclenché à la main ; entrées `old_base`, `new_base`, `scenarios`).
   - Environ 20 parcours dans `parity/scenarios/*.json` : connexion, paquet, collection (filtres, tris, pages, étiquettes), liste de souhaits, mise en vente, mise, retrait, échange, défausse, bataille, guilde, notifications.
   - `npx rea-agents@6.7.0` lance `capture_browser_scenario` sur chaque base, puis `compare_web_captures` (requêtes, statuts, DOM et a11y, avec des règles de normalisation pour les uuid, dates, soldes, pseudos et compteurs), puis `capture_web_screenshot` et `compare_web_screenshots` sur les états clés.
   - Les captures REA n'incluent pas les corps JSON. Le même parcours tourne donc aussi sous Playwright avec `recordHar: {content: 'embed'}`. Les HAR passent par `inspect_web_network_capture` et par `parity/har-shape-diff.ts`, qui compare, pour chaque couple (méthode, chemin normalisé), le statut, la forme récursive des clés et des types, les champs de pagination et les chaînes françaises.
   - **Côté original** : sans consentement, uniquement les pages publiques (/, /login, /signup, /rules, /terms, /privacy), à faible volume (C34 : aucune capture de session connectée sans accord). Avec consentement, la suite complète tourne depuis un portable en Chrome visible, parce que Turnstile bloque les IP de la CI.
4. **Matrice `docs/parity.md`** : une ligne par élément de spec (pages du §2, routes du §3, règles du §5, sélecteurs du §6.8), reliée à un id de test et à un statut : `ok`, `inféré` (notre valeur, à confirmer par Naïm) ou `à fournir par Naïm`. `parity/matrix.ts` la remplit à partir des rapports JSON de Vitest et de Playwright. Au pitch, elle affiche « N/M routes identiques en forme, K écarts admis, U non vérifiées ». Proposition faite à Naïm : « donnez-nous un compte gratuit et un compte Pro de test, on lance la suite devant vous ».

---

## 12. Tests, CI/CD, déploiement, observabilité, Graphify

### 12.1 Tests

| Niveau | Bac à sable (PG16, pas de Docker ni d'accès à Wikimedia ou Stripe) | CI (GitHub Actions) |
|---|---|---|
| SQL | `supabase/tests/*.test.sql` en `DO $$ … assert … $$`, après `bootstrap_local.sql` (stub du schéma `auth`, `auth.uid()` lu dans `request.jwt.claims`, rôles `anon`, `authenticated`, `service_role`). RLS testée avec `set role` + `set_config('request.jwt.claims', …)`. Tests de concurrence en sessions psql parallèles (ordre de verrouillage, invariants). | Les mêmes sur `postgres:17` et sur la pile Supabase, plus `plpgsql_check` |
| Unitaires | vitest : parseurs et calculs du catalogue sur fixtures, validation des quiz et modèles, `route()` et la traduction des erreurs, fuseaux, marque et porte (fail-closed), formats | idem |
| Contrat | HTTP : binaire PostgREST v12.2.3 + PG16 + petit stub JWKS (le builder fixe le détail) + `next start` | HTTP : `supabase start` + `next start` |
| Stripe | Événements de fixture signés | Clés de test + `stripe trigger` |
| Quiz | Faux serveur compatible OpenAI | `quiz-bank.yml --max 5 --dry-run` quand `scripts/quiz/**` change |
| E2E et a11y | — | Playwright + axe sur toutes les routes, `selectors.spec.ts`, parcours inscription → OTP (Mailpit) → `/pulls` |
| Migration | `migration-rehearsal` sur `synth.sql` | idem, puis sur DUMP-S dès réception |
| Charge | `load/bench/*.sql` (pgbench) | `load.yml` à la demande |

Règles : toute fonction `wm.*` est écrite en TDD (Superpowers), et toute fonction monétaire a son test d'invariant. Un test vérifie qu'**aucune** réponse client ne contient de bonne réponse de quiz, et un autre qu'aucune colonne hors liste blanche n'est touchée par le catalogue.

### 12.2 CI/CD et Vercel
- **`ci.yml`** (sur chaque PR) : `npm ci` (Node 24), `tsc --noEmit`, eslint, vitest, tests SQL, contrat HTTP, rapport de couverture du recap. Puis un job d'intégration : `supabase start` → `db reset` → `next build && next start` → contrat HTTP → Playwright + axe.
- **`db.yml`** (sur `main`) : `supabase db push` vers `vlazmfshvuborizccqza` **avant** la promotion Vercel (sans approbation pendant la construction, C24 ; approbation manuelle activée pour la bascule de production). Les migrations sont expand-only, donc l'ancien build continue de marcher pendant ce temps.
- **Vercel** (équipe XBZ, intégration Git) : une preview par PR et la production (démo privée), toutes **derrière la porte**. Région `cdg1`, Fluid compute.
- **Variables d'environnement** :
  - Supabase : `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (service role), `AUTH_COOKIE_NAME` (option B) ;
  - services : `TURNSTILE_SITEKEY` et `TURNSTILE_SECRET`, `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET` (test), `VAPID_PUBLIC` et `VAPID_PRIVATE`, `CRON_SECRET` (aussi dans Supabase Vault) ;
  - app : `NEXT_PUBLIC_BRAND_NAME`, `DEMO_GATE_PASSWORD`, `GATE_COOKIE_SECRET`, `DEMO_MODE`.
- **Secrets GitHub** : jeton d'accès Supabase, URL du pooler en mode session (catalogue), clés des fournisseurs OmniRoute, clés de test Stripe, comptes de parité.

### 12.3 Observabilité
- Une ligne de log JSON par requête d'API : `{route, status, ms, rpc, pg_code, uid_hash, vercel_id}`.
- **`/api/health`** : ping de la base, dernier règlement de moins de 30 s (`cron.job_run_details`), retard de l'outbox push, file de quiz, date du catalogue. Avec `?deep=1`, il lance aussi `wm.check_invariants()`. L'écran `/admin/health` affiche les mêmes informations.
- **`health.yml`** une fois par jour (C25) : vérification profonde, issue GitHub ouverte ou mise à jour en cas d'échec ; une fois par semaine en plus, `supabase inspect db outliers|bloat|index-usage`.
- Advisors Supabase (MCP) à chaque jalon. Logs Vercel, et Speed Insights s'il est disponible sur le plan.

### 12.4 Graphify et plugins
- **Graphify** :
  - enregistrer `ilan9903/wikimaster` dans l'espace de travail et réindexer à chaque merge sur `main` ;
  - **nommage 1:1** entre route et fonction SQL (par exemple `/api/marketplace/[auctionId]/bid` ↔ `wm.place_bid`), tenu dans le registre de `lib/contract.ts` ;
  - types Supabase générés (`Database['wm']['Functions']`) : chaque `rpc('…')` est typé et visible dans le graphe ;
  - avant de modifier `route.ts`, `Card`, le catalogue d'erreurs ou un helper SQL partagé : `graphify_impact` et `graphify_callers` ; `graphify_tests_for` pour vérifier que chaque route a sa spec ;
  - enregistrer avec `remember` les décisions C1 à C30 et tout écart.
- **Plugins** : Impeccable (design system et finition), Intent `fortify` (états vides, erreurs, chargement) et `include` (audit a11y), Superpowers TDD (fonctions SQL), revue Ponytail sur chaque PR.

---

## 13. Jalons de livraison
Après chaque jalon, l'app tourne de bout en bout sur la preview protégée, et tout ce qui est livré marche réellement. Le pitch a lieu après le M8.

| # | Nom | Périmètre | Terminé quand |
|---|---|---|---|
| M0 | Fondations | Dépôt et épingles ; `ci.yml` ; migrations MIRROR et `wm_core` ; `bootstrap_local.sql` ; `route()` et catalogue d'erreurs ; marque, porte fail-closed et `proxy.ts` ; shell navigable (13 entrées) ; `docs/DESIGN.md` (Impeccable) ; rapport de couverture du recap ; Graphify. **Vérifications** : APIs Next 16.4.2 (`proxy.ts`, `cacheComponents`, `'use cache: remote'` en route handler, signature de `revalidateTag`), runtime cache, WAF et `checkRateLimit` sur Hobby, tag Docker OmniRoute, binaire PostgREST dans le bac à sable, clés JWT asymétriques sur notre projet. | CI verte ; migrations appliquées sur PG16 et sur le projet Supabase (MCP) ; preview protégée et noindex déployée en `cdg1`, `/api/health` OK ; test fail-closed vert ; rapport de couverture listant toutes les routes du §3 ; résultats des vérifications consignés dans Graphify. |
| M1 | Comptes, paquets, collection (seed de 2 000 cartes) | Inscription, OTP, 18+, trigger de pseudo, connexion, réinitialisation, vérification ; Card et CardModal ; `/pulls` et human-check ; régénération, tirage, ouverture, Pro du jour, spéciaux, grâce ; `sync_profile_packs` et `get_my_profile` ; `/collection` (étiquettes, liste de souhaits, favoris en accès direct, défausse unitaire et en masse) ; `/global-collection` ; Paramètres de base | E2E inscription → OTP → `/pulls` → paquet → collection → étiquette → défausse vert en CI ; contrat §3.1 à §3.4 vert en HTTP (bac à sable et CI) ; tests SQL d'invariants et de concurrence verts ; axe à 0 violation sérieuse ; animation réduite testée activée et désactivée. |
| M2 | Catalogue réel | Parseurs et calculs sur fixtures ; `catalog.yml` en modes `full` et `sample` ; `catalog_merge` ; pool par *swap-with-last* ; `card_media` ; page `/credits` | Échantillon (Free) ou catalogue complet (Pro) chargé depuis Actions ; second passage idempotent, ids inchangés ; parts de rareté de l'échantillon à ± 1 % des vraies ; test χ² sur 100 k tirages OK ; licence affichée dans la modale. |
| M3 | Marché | Tout le §3.5 : séquestre, mises avec débit et remboursement, anti-snipe, règlement (cron, `/settle`, paresseux), baisse de prix, `mine`, ventes (résumé et détail Pro), alertes de liste de souhaits, cache ; benchs refaits en tables journalisées | Contrat §3.5 vert ; test SQL de guerre d'enchères qui conserve M ; règlement en moins de 15 s ; retrait et invendu rendent une nouvelle ligne sans étiquettes ; E2E mise en vente → mise → remboursement → règlement vert. |
| M4 | Échanges et social | Échanges (création, contre-offre, acceptation, refus, annulation, expiration) ; amis, profil, vitrine, messages privés, notifications et cloche, signalements ; Web Push | Acceptation 100 ↔ 100 en moins de 500 ms, atomique (une erreur injectée annule tout) ; rejeu d'`Idempotency-Key` qui renvoie le résultat stocké ; push reçu sur un point d'entrée de test en CI ; contrat §3.6 et §3.7 vert. |
| M5 | Batailles, guildes, progression | Machine à états avec les modèles d'abord, puis `quiz-bank.yml` et OmniRoute ; guildes (chat, entraide, karma, scores hebdomadaires, classement) ; succès ; classement des joueurs | Une bataille complète sans aucun LLM (modèles), puis une avec des banques générées par le workflow ; aucune bonne réponse dans une réponse client ; test de la borne hebdomadaire ; réclamation rejouée qui ne crédite qu'une fois ; contrat §3.8 à §3.10 vert. |
| M6 | Pro, modération, paramètres | Stripe (Checkout, Portal, webhook, test clocks) et avantages Pro ; modale boutique ; espace admin, sanctions, signalements d'image, retrait de cartes ; export et suppression RGPD ; pages légales de notre marque | Avec une carte de test, le compte devient Pro et a tous ses avantages ; webhook rejoué sans effet ; bannissement effectif malgré un JWT valide ; chaque action staff auditée ; export téléchargé ; suppression de compte de bout en bout. |
| M7 | Kit de migration et parité | Toutes les specs (couverture bloquante à 100 %) ; `selectors.spec.ts` ; `parity.yml` (REA et diff HAR) ; `allowed-diffs.yaml` ; matrice ; `schema-diff`, `reconcile` et diff, répétition sur `synth.sql`, `smoke.ts`, `stripe-backfill.ts`, `rollback-escrow.sql`, `RUNBOOK.md` | Couverture du recap à 100 % ; rapport de parité (pages publiques ancien contre nouveau, suite complète sur la nouvelle app) ; répétitions A et B sur données synthétiques avec rapprochement identique, 0 violation et durée mesurée ; répétition sur DUMP-S dès réception. |
| M8 | Charge et démo du pitch | Passage de l'organisation Supabase en Pro pour environ un mois (décision du 2026-10-19) ; catalogue complet ; k6 S1 à S7 sur ce projet Pro et corrections ; jeu de démo ; démo privée avec la marque choisie ; script du pitch (rapport de charge, matrice de parité, rapport de répétition, renouvellement Pro en test clock, offre de lancer la suite en direct) | Critères S1 à S7 atteints en tables journalisées ; porte et noindex vérifiés depuis l'extérieur ; clic dans chaque page du §2 et appel de chaque route du §3 sans erreur sur la démo ; `health.yml` vert 7 jours de suite. |

---

## 14. Ce qui est laissé au builder
- Le découpage en tâches et leur ordre à l'intérieur de chaque jalon, et les fichiers à l'intérieur de l'arborescence du §5.2.
- Le SQL exact des fonctions, les noms d'index, la façon de construire le JSON (le contrat fixe le résultat).
- La décomposition en composants, les keyframes, les valeurs de `glow-*`, les fonds de rareté recréés, le visuel du paquet de **notre** marque, les sons.
- Les textes des pages jamais capturées, dans le ton du §6.7 (« tu » dans le jeu, « vous » dans les pages légales). Les pages légales de notre marque s'écrivent sans recopier les siennes.
- La formulation du prompt de quiz et des modèles de secours, dans le respect des règles de validation du §7.7.
- Les 39 succès inférés (noms, seuils, récompenses), dans les 5 catégories du §5.8.
- Les scripts k6, le générateur de seed et les benchs.
- La mise en page de l'espace admin.
- Le stub JWKS et le mode de test de Turnstile dans le bac à sable.
- **Limites de cette latitude.**
  - Ne jamais toucher aux décisions du §4.1, ni affaiblir les §2.3 et §3.4.
  - Une décision du §4.2 peut être changée si les faits l'exigent : l'écart est alors consigné avec Graphify `remember`, ajouté à `allowed-diffs.yaml` s'il est observable, et expliqué dans la PR.
  - Un défaut du §7 se remplace par la valeur réelle dès que DUMP-S, DUMP-D ou Naïm la donnent, par un `update` de `wm.config`.

---

## 15. Questions ouvertes pour l'utilisateur
Seules figurent celles qui changent ce qui est construit, ce que ça coûte ou les comptes à utiliser. Sans réponse, le builder applique le défaut indiqué et repose la question au jalon qui en a besoin (Brevo et Turnstile au M1, OmniRoute au M5, Stripe au M6). (Le dépôt est privé, vérifié : voir C31.)

1. ~~Budget mensuel~~ **Répondu (2026-10-19)** : gratuit pendant la construction, Supabase Pro environ un mois autour du pitch (§3.2).
2. **Comptes et clés à fournir.**
   - Stripe : le connecteur donne le compte « XBZ Esport ». Y crée-t-on les produits de test (Pro 9,99 CAD/mois, 2 500 WB à 4,99 CAD), sachant que son nom s'affiche sur le Checkout ? Sinon, un compte dédié.
   - E-mails d'inscription : Brevo en SMTP, avec un domaine d'expédition que vous contrôlez (SPF/DKIM). Sans domaine ni SMTP, Naïm ne pourra pas s'inscrire en direct au pitch.
   - Cloudflare : un compte pour la clé Turnstile (gratuite). *Défaut : clés de test Cloudflare.*
   - OmniRoute : au moins une clé gratuite d'un fournisseur d'IA (Gemini ou Groq, par exemple). *Défaut : sans clé, les quiz viennent des seuls modèles de secours, ce qui marche mais rend les questions moins riches.*
3. **Marque et domaine** : nom de notre propre marque (plan B) et domaine de la démo. *Défaut : nom neutre provisoire et URL `*.vercel.app`.*
4. **Naïm avant le pitch ?** Le contacter tôt donnerait son accord pour les captures REA du site connecté, deux comptes de test et le schéma de sa base (DUMP-S), ce qui transforme les règles « inférées » en règles vérifiées. *Défaut : aucun contact avant le pitch, captures limitées aux pages publiques (C34).*
5. **Les 3 étudiants codent-ils ?** *Défaut : Claude construit, les étudiants relisent et jouent les parcours (C33).*
