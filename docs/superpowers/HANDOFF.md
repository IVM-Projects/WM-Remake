# Passation entre sessions

> À lire en premier par toute nouvelle session Claude sur ce dépôt.

## Où on en est (2026-10-22)

- **M3 livré sur la démo** (2026-10-22) : le marché, tâches 1 à 15 du plan `docs/superpowers/plans/2026-10-21-m3-marche.md` sur la branche `claude/clever-cannon-59x0dj` (base ff6ac58). Chaque tâche a eu une revue de conformité, une revue adverse et ses tours de correction. La revue finale de la branche (7 lentilles, puis un sceptique par lentille et un critique) n'a trouvé aucun Critical. Sa vague de corrections (fd17911, ca4e91a, be36e86, 8d66a5d, c6467b7) traite 1 Important et 14 Minor. Décisions M3-1 à M3-27, P1 à P30 et rulings M3-R1… : `docs/decisions-graphify.md` ; reportés : `docs/suivi.md`.
  - Livré :
    - migrations `0004` (miroir `auctions`, `auction_bids`, `notifications`), `1600` (socle : séquestre, file, verrous, garde anti-rafale, invariants `market_money`, `reservation` et `escrow`), `1610` (vente, retrait, baisse), `1620` (mise), `1630` (règlement unique : cron, `/settle`, paresseux), `1640` (lectures), `1650` (alertes de liste de souhaits, purges, `health`) et `9000` (pg_cron, quatre jobs) ;
    - routes `/api/marketplace…` (201 à la création, 503 `BUSY` sur les codes occupés, idempotence sur chaque écriture) ;
    - cache partagé de la liste, du détail et du résumé des ventes (`lib/market-cache.ts`, profils `market` 2/3 s, `auction` 1/2 s, `sales` 60/120 s), avec l'overlay `owned` par joueur ;
    - pages `/marketplace` (onglets, recherche, tri, raretés, « Charger la suite », polling visible) et `/marketplace/[auctionId]` (miser, historique, retrait, baisse, « Finaliser la vente », liste de souhaits, analyse Pro) ;
    - boîte de vente et onglet « Marché » dans la modale de carte ;
    - benchs journalisés `load/bench/run.sh`.
  - Critères du D§13 et leurs preuves :
    - contrat §3.5 complet (`coverage:recap` : 39 routes sur 90, plus aucune du §3.5 manquante) ;
    - guerre d'enchères qui conserve M : `supabase/tests/16_market_concurrency.test.sh` (60 mises croisées, invariants vides) ;
    - règlement en moins de 15 s : sur 1 h 19 d'historique de `wm-settle` sur la démo, 475 runs sans échec, p99 de l'écart 10,305 s + p99 de la durée 0,071 s, soit une borne de 10,38 s ; les deux ventes réelles du joueur de démo ont été réglées par le cron en 4,50 s et 2,60 s (« M3 — livraison » de `docs/verifications.md`) ;
    - retrait et invendu rendent une nouvelle ligne sans étiquettes : `supabase/tests/27_market.test.sql` ;
    - parcours mise en vente → mise → remboursement → règlement : `e2e/market-journey.spec.ts` (A débité à 90, remboursé à 100, B gagnant à 89, vendeur à 11, règlement par la seule lecture du détail).
  - Suite locale (tête c6467b7) : `npm test` 44 fichiers, 429 tests ; `test:db` 19 fichiers ; contrat 136 cas ; E2E 166 tests ; `coverage:recap` 39/90. CI verte sur postgres:17 (run 39744063469).
  - Démo, dans l'ordre R32 et M3-27 :
    - `deploy-m3.sql` (concaténation de `0004`, `1600`…`1650`, `9000`, de l'historique et du `notify`) lancé par l'utilisateur dans le SQL Editor, après une répétition sur une base d'avant le M3 (deux passes, `27_market` vert, même empreinte des fonctions `wm` que la branche) ;
    - pg_cron 1.6.4 créé et quatre jobs actifs ; contrôles du MCP verts ;
    - fusion `--no-ff` 36646a5 dans `develop`, production `dpl_AtktHPnjNy6pUfUjQFcMG2h4cdzW` READY, `/api/health` 200, `health.yml` vert.
  - M2-12 fait le même jour : les 2 000 cartes d'essai et leurs copies sont supprimées (117 112 cartes, toutes sourcées, invariants vides).
  - Benchs (PG 16.15 local, fsync on, chiffres indicatifs) : ≈ 280 mises/s sur une enchère disputée, ≈ 1 250 mises/s réparties, 5 000 règlements en ≈ 6 s (500 en ≈ 0,6 s). Le M8 refait la mesure sur Pro.

- **M0 livré** (2026-10-19) : fondations, CI, migrations `0001`, `0002`, `1000` sur la démo, production Vercel derrière la porte. Détail : `docs/verifications.md`.
- **M1 implémenté et relu** sur la branche `claude/clever-cannon-59x0dj` : les 16 tâches du plan `docs/superpowers/plans/2026-10-19-m1-comptes-paquets-collection.md` (plan 4a087d0 sur `develop` cb510d3). Chaque tâche a eu une revue de conformité et une revue adverse, suivies de passes de correction. Le commit de passation 96dd8c7 ajoute aussi l'E2E du parcours (`e2e/journey.spec.ts`) et une correction de lint (dépendances d'effet de `global-client.tsx`). La revue finale de la branche (R31) a été suivie de trois vagues de correction (R32) : A auth et navigation (b691c33), B interface de jeu (8691e1d), C base, tests, CI et documentation (18c4b68), puis un dernier tour de code (R33 : d1f8474, 9139851, 3b2be6a). Les arbitrages R1 à R33 (R30 non attribué) sont dans `docs/decisions-graphify.md`.
  - Livré : inscription (pseudo, 18+, code à 6 chiffres par e-mail), connexion, réinitialisation ; `/pulls` (vérification anti-bot, régénération, ouverture, révélation, Pro du jour) ; routes `/api/packs/special` et `/api/packs/grace` (sans UI au M1, prévue au M6 dans `docs/suivi.md`) ; `/collection` (étiquettes, favoris, liste de souhaits, défausse unitaire et en masse, solde) ; `/global-collection` ; paramètres de base. Catalogue d'essai de 2 000 cartes (`supabase/seed.sql`).
  - Banc local : vrai GoTrue v2.197.0 et Mailpit v1.31.0 (binaires épinglés par `scripts/get-tools.sh`), en plus de PostgREST.
  - Critère de fin (D§13) : `e2e/journey.spec.ts` joue inscription → code → `/pulls` → paquet → collection → étiquette → défausse en un seul test, sans aucune insertion psql.
- **Suite locale verte** (2026-10-20, tête finale 3b2be6a) :

  | Commande | Résultat |
  |---|---|
  | `npm run lint` | 0 erreur, 0 avertissement |
  | `npm run typecheck` | OK |
  | `npm test` | 21 fichiers, 242 tests |
  | `npm run test:db` | 14 fichiers (9 `.sql`, 5 `.sh` dont 4 de concurrence) |
  | `npm run build:test` | OK |
  | `npm run test:contract` | 82 cas |
  | `npm run test:e2e` | 122 tests, dont 20 passes axe sans violation *serious* ni *critical* |
  | `npm run coverage:recap` | 28 routes couvertes sur 90 : tout le R§3.1 à §3.4 ; les 62 manquantes sont du §3.5 au §3.10 |

- **Ce que la CI a validé** : `ci.yml` (`workflow_dispatch`) vert sur 5153b0f (run 11), sur 96dd8c7 (run 12, parcours E2E compris) et sur 18c4b68 (run 13, après les vagues A, B et C, cache des outils et tests de concurrence 12 et 14 sur postgres:17). Puis sur la tête finale 3b2be6a (run 16), après le dernier tour de code (R33, d1f8474) et ses retouches.
- **Ordre du déploiement (R32)** : base de démo (Step 4 du plan) **avant** la fusion dans `develop` (Step 3). `develop` est la branche de production de Vercel : fusionner d'abord servirait `/signup` sur une base sans le trigger `wm_on_auth_user_created`, et un compte créé dans cette fenêtre resterait sans profil. Les migrations sont additives et le code du M0 n'appelle que `wm.health` ; si le Step 4 échoue, la production reste intacte.
- **Démo M1 en production (2026-10-20)**, dans l'ordre R32 ; détail dans `docs/verifications.md` :
  - CI verte sur la tête finale 3b2be6a (run 16) ; le run 14 avait été rouge sur une analyse axe faite pendant une transition, corrigé.
  - Base `iggurckxmoagsajzrnwd` : `0003` et `1100` par le MCP ; `1200`, `1300`, `1400` et le catalogue d'essai par le SQL Editor (le MCP exige une confirmation pour tout SQL contenant `DELETE`, qui n'arrivait pas). Historique des migrations complété. 2 000 cartes, `wm.catalog_stats` conforme, trigger `wm_on_auth_user_created`, invariants vides, conseillers sans nouvelle alerte à nous.
  - `NEXT_PUBLIC_TURNSTILE_SITE_KEY` et `TURNSTILE_SECRET_KEY` (clés de test de Cloudflare) en Production et Preview, posées avant la fusion.
  - Fusion `--no-ff` dans `develop` : 247065d, déployée (`dpl_EPo32jCzs9Khpx6HYeuxHyQK8upY`, READY).
  - `/api/health` 200 avec `db: ok`, `/signup` 307 vers `/gate`, porte qui refuse un mauvais mot de passe sans cookie, cache de schéma de PostgREST à jour (401 `42501` sur `wm.cards_page`), aucune erreur d'exécution.
  - Leçon pour la suite : appliquer par le MCP les migrations sans `DELETE`, et passer celles qui en contiennent par le SQL Editor (ou approuver la confirmation du MCP si elle s'affiche), puis inscrire la ligne d'historique.
- **M2 implémenté, relu et fusionné** (2026-10-21) : les 17 tâches du plan `docs/superpowers/plans/2026-10-21-m2-catalogue-reel.md` sur la branche `claude/clever-cannon-59x0dj` (base 68f5d78, tête 79b46c6), chacune avec une revue de conformité et une revue adverse, puis la revue finale de la branche et la vague M2-R10 (e874d1a, baafaf8, 79b46c6). Décisions M2-1 à M2-20, P1 à P17, arbitrages M2-R1 à M2-R10 et écarts au design dans `docs/decisions-graphify.md`.
  - Livré : pipeline `catalog/src/*.ts` (`node catalog/src/cli.ts <commande>`, Node 24, sans dépendance) et `catalog.yml` (modes `fixtures`, `sample`, `full` ; jobs `dumps`, `pageviews`, `select`, `text` sur 21 parts, `wikidata`, `commons`, `compute`, `load`) ; vraies tranches commitées dans `catalog/fixtures` ; migrations `1500` (pool *swap-with-last*, `pick_card`), `1510` (tables du catalogue, `catalog_merge`, `catalog_finalize`), `1520` (page partagée, overlay, crédits) ; cache partagé de `/api/cards` ; `POST /api/cron/revalidate` ; `GET /api/cards/[id]/credits` ; crédit de l'image dans la modale ; page `/credits` et pied de page.
  - Suite : `npm test` 39 fichiers, 379 tests ; `test:db` 17 fichiers ; contrat 90 cas ; E2E 127 tests. CI verte sur baafaf8 (run 39614871733) et sur `develop` 0ac05cb (run 39615754311).
  - Démo, dans l'ordre R32 et M2-18 : secrets posés par l'utilisateur ; `1500`, `1510` et `1520` en un fichier par le SQL Editor, historique complété ; contrôles de la base (invariants, pool dense, cache de schéma, conseillers) ; fusion `--no-ff` 0ac05cb, production `dpl_6bKr6XuD1hX1C7BuVUqQJs25bVWP` READY, `/api/health` 200, revalidation refusée sans secret (401). Détail : `docs/verifications.md`, section « M2 — livraison ».
  - Chargement de l'échantillon : run 39615766155 (`mode: sample`, `target: free`, `sample_rate` 0,045 lu dans `wm.config`), lancé à 14:19Z sur `develop`, vert en 1 h 58 (dont `compute` 57 min, surtout le complément TextExtracts, et `load` 3 min 51 s). 117 112 cartes chargées sur 2 602 470 pages (4,5 % de chaque rareté), 62 126 avec image ; les 2 000 cartes d'essai sont sorties du pool. Base à 185,5 Mo (273,9 Mo au plus haut pendant les lots) ; écart de parts maximal 0,0006 point ; χ² 1,82 (rareté, seuil 20,52) et 34,37 (`seq`, seuil 43,82). Relance du seul `load` (run 39633657505) : 117 112 lignes inchangées, 0 insérée, mêmes empreintes, invariants vides.
  - Critère « licence affichée dans la modale » (D§13) : prouvé par l'E2E de la Task 16 (`e2e/credits.spec.ts` : auteur et licence de l'image affichée avec le lien de licence, rien quand l'image est masquée, sensible ou absente, « voir la page du fichier » sans auteur à 320 px), par les contrôles de données du Step 6 sur la démo (0 carte du pool avec image sans ligne `card_media`, 0 licence nulle, `card_credits` rend ses quatre clés), et par la vérification visuelle humaine du Step 7, qui reste à faire (étape humaine 7).
  - C31 « dépôt privé » est remplacé par un dépôt **public** (M2-R1, décision de l'utilisateur : Vercel Hobby ne déploie pas le dépôt privé d'une organisation). Artefacts et journaux d'Actions sont visibles de tous ; aucun secret n'y est imprimé ; aucun nouveau fichier ne nomme la marque d'origine ni le pitch.
  - `schedule` mensuel de `catalog.yml` (le 3 à 05:41 UTC, P12) : ajouté après ce premier chargement réussi (Task 17, Step 8), actif dès la fusion dans `develop` ; il recharge l'échantillon avec `target: free` au taux de `wm.config`. Si la démo passe sur Pro avec le catalogue complet, la garde de taille de `free` refusera chaque passage : changer d'abord la cible par défaut du `schedule`, ou le désactiver.
- Comptes : org Supabase « WM Prod » `xyyxepqjbgmhyocqqcbx`, projet « WMR » `iggurckxmoagsajzrnwd` ; équipe Vercel IVM `team_nXdYy8ZVSzoNaYlzG7a1whey`, projet `wmr` (région `dub1`, branche de production `develop`) ; dépôt `IVM-Projects/wm-remake` (flux `develop` intégration, `master` production, `hotfix`).

## Étapes humaines ouvertes

1. **Faites** : `SUPABASE_SECRET_KEY` en Production (2026-10-19) et en **Preview** (constaté par le contrôle de production du 2026-10-20) ; branche de production réglée sur `develop`. Au M2 (2026-10-21) : secrets GitHub `SUPABASE_DB_URL` et `CRON_SECRET`, `CRON_SECRET` dans Vercel, migrations `1500` à `1520` lancées dans le SQL Editor.
2. **Restant du M0** : ajouter le dépôt `IVM-Projects/wm-remake` à un espace de travail Graphify, puis rejouer les notes de `docs/decisions-graphify.md`.
3. **Restant du M0, facultatif** : ajouter `wm` dans Supabase → Settings → API → Exposed schemas, pour que le réglage du rôle (`pgrst.db_schemas`) ne puisse pas dériver.
4. **Réglages Auth de la démo** (tableau de bord Supabase, projet `iggurckxmoagsajzrnwd` ; le MCP n'expose pas la configuration Auth) :
   1. **Authentication → URL Configuration** : Site URL `https://wmr-ivm.vercel.app` ; Redirect URLs `https://wmr-ivm.vercel.app/**` seulement. Pas de joker de préversion : les préversions sont derrière Vercel Authentication, aucun joueur ne les utilise ; n'ajouter un alias de préversion exact (par exemple `https://wmr-git-develop-ivm-projects.vercel.app/**`) que si quelqu'un doit y tester la réinitialisation.
   2. **Courriels** :
      - **Authentication → Emails → Templates** : coller `supabase/templates/confirmation.html` dans « Confirm signup », avec le sujet « Ton code de confirmation », et `supabase/templates/recovery.html` dans « Reset password », avec le sujet « Choisis un nouveau mot de passe ».
      - **Authentication → Sign In / Providers → Email** : longueur de l'OTP à 6 (le formulaire attend 6 chiffres) et expiration de l'OTP à 3600 s (le gabarit dit « Il expire dans une heure »). Désactiver « Secure password change » pour la démo : l'app ne joue pas le flux de réauthentification, et GoTrue ne la demande qu'aux sessions de plus de 24 h, si bien qu'un test le jour même ne verrait rien.
   3. **Authentication → Emails → SMTP** : Brevo, avec un domaine d'expédition contrôlé (D§15 n° 2). Sans SMTP, le service intégré de Supabase n'envoie qu'aux adresses des membres de l'organisation, avec un débit très bas (quelques e-mails par heure). Conseil donné à l'utilisateur le 2026-10-21 : son compte Brevo est déjà connecté (offre gratuite, 300 e-mails par jour) ; relais `smtp-relay.brevo.com`, port 587, avec l'expéditeur déjà vérifié sur ce compte et une clé SMTP de Brevo comme mot de passe (à saisir dans le tableau de bord, jamais dans le dépôt). Avant le pitch, relever **Authentication → Rate Limits** → e-mails par heure : plusieurs inscriptions dans la même heure atteindraient sinon le plafond (« Trop d'e-mails envoyés, réessaie un peu plus tard. »).
   4. **Authentication → Attack Protection → Captcha** : Turnstile, avec le secret de test de Cloudflare `1x0000000000000000000000000000000AA` (sa clé de site `1x00000000000000000000AA` est posée dans Vercel au déploiement du M1). Avec une vraie paire de clés, mettre à jour aussi les deux variables Vercel `NEXT_PUBLIC_TURNSTILE_SITE_KEY` et `TURNSTILE_SECRET_KEY`, puis redéployer.
   5. Facultatif : **Authentication → Attack Protection → Leaked password protection** (signalé par le conseiller sécurité ; refuse les mots de passe connus de HaveIBeenPwned, selon l'offre du projet).
   6. Facultatif : vérifier dans **Settings → JWT Keys** que la clé de signature est asymétrique (ECC P-256), sinon `getClaims()` interroge GoTrue à chaque requête. Après la première vraie inscription, lire l'en-tête `alg` d'une session et le consigner dans `docs/verifications.md` (point reporté du M0).
   7. **Comptes de démo** : les créer par `/signup`. « Add user » ou « Invite » du tableau de bord, comme `auth.admin.createUser` sans les métadonnées `{username, age_confirmed: true, terms_version}`, sont refusés par le trigger d'inscription (`consent_required`, affiché « Database error creating new user »).
5. **Après ces réglages** : un étudiant joue le parcours complet sur la démo (inscription avec le vrai widget Turnstile, code reçu par e-mail, premier paquet, collection, étiquette, défausse) et le résultat est consigné dans `docs/verifications.md`. Vérifier aussi, sur le projet hébergé, le changement de mot de passe et la déconnexion de `/settings` (« Secure password change » désactivé à l'étape 4.2).
6. **Pause Supabase Free** (7 jours sans activité) : écartée tant que `health.yml` interroge la production chaque jour ; s'il échoue, il ouvre une issue. Sur un dépôt public, GitHub désactive les workflows planifiés après 60 jours sans activité du dépôt : `health.yml` et le `schedule` de `catalog.yml` s'arrêteraient alors sans bruit, et la base serait mise en pause 7 jours plus tard. Un commit, ou « Enable workflow » dans l'onglet Actions, les relance.
7. **Vérification visuelle du M2** (Task 17, Step 7), si elle n'est pas faite : derrière la porte, `/global-collection` montre de vraies cartes et les vrais totaux ; la modale d'une carte avec image affiche « Image : <auteur>, <licence> », avec un lien de licence et un lien vers la page du fichier qui marchent ; `/credits` s'affiche. Résultat consigné dans `docs/verifications.md`.
8. **Faite (2026-10-22)** : suppression des 2 000 cartes d'essai et de leurs copies (M2-12), lancée par l'utilisateur dans le SQL Editor après le déploiement du M3. Le script réglait d'abord les enchères éventuelles sur ces cartes, puis supprimait enchères, notifications, copies et cartes. Résultat : 117 112 cartes, toutes sourcées, invariants vides.
9. **Retirer `SUPABASE_DB_URL` des variables Vercel** (Production) : l'app ne la lit pas, seul `catalog.yml` s'en sert comme secret GitHub (moindre privilège).
10. **Facultatif, vérification visuelle du M3** (Task 16, Step 6) : derrière la porte, mettre une carte en vente depuis la modale de `/collection`, voir sa tuile dans `/marketplace` et son détail, miser depuis un second compte si l'on en a un. Pour mesurer le cron seul, fermer l'onglet avant l'échéance : un détail ouvert réglerait par la voie paresseuse.

## Exploitation du marché

- **Arrêt d'urgence du cron**, par le MCP : `select cron.alter_job(jobid, active := false) from cron.job where jobname like 'wm-%'`. Reprise avec `active := true`.
- `maintenance = true` (`wm.config`) bloque les mises et les ventes, mais pas le règlement (cron, `/settle` et détail paresseux).
- **À relire après 25 h** :
  - aucune ligne de `cron.job_run_details` de plus de 25 h (purge horaire à :17, rétention 24 h) ;
  - taille de la base stable (relevés du déploiement dans `docs/verifications.md`).
- `health.yml` échoue si `settle_lag_s` dépasse 60 s ou si une enchère échue reste non réglée (`overdue_s`).

## Étape suivante : écrire le plan M4 (échanges et social)

Périmètre du D§13 :
- échanges : création, contre-offre, acceptation, refus, annulation, expiration ;
- amis, profil, vitrine, messages privés ;
- notifications et cloche, signalements ;
- Web Push.

Terminé quand :
- l'acceptation 100 ↔ 100 prend moins de 500 ms et reste atomique (une erreur injectée annule tout) ;
- le rejeu d'`Idempotency-Key` renvoie le résultat stocké ;
- un push est reçu sur un point d'entrée de test en CI ;
- le contrat §3.6 et §3.7 est vert.

Reprendre la section M4 de `docs/suivi.md` :
- le verrou d'échange à ajouter en même temps dans `create_auction`, `discard` et `bulk_discard` ;
- les notifications déjà insérées par le marché, sans lecteur ;
- `wm.idem_claim` sans empreinte du corps.

## Points différés

Triés par jalon dans `docs/suivi.md`. Les fichiers de suivi des tâches (`.superpowers/sdd/…/progress.md`) sont ignorés par git et seront supprimés : tout ce qui compte est dans `docs/suivi.md` et `docs/decisions-graphify.md`.

## Rappels pour l'exécution

- Choix du modèle de chaque sous-agent selon le skill `model-routing` (silencieusement).
- Suite locale complète : `npm run lint && npm run typecheck && npm test && npm run test:db && npm run build:test && npm run test:contract && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e && npm run coverage:recap` (prérequis dans `README.md`). Le `webServer` de Playwright démarre et arrête le banc.
- Réseau du bac à sable : le site d'origine, Stripe, Brevo et l'hôte Postgres Supabase sont bloqués ; Supabase passe par son MCP (design §3.3). Wikimedia passe par le proxy (fr.wikipedia.org et ses API répondent ; le `fetch` de Node demande `NODE_USE_ENV_PROXY=1`), mais les miniatures d'upload.wikimedia.org renvoient 429 ; les dumps ne se lisent que dans Actions.
- Catalogue : `catalog.yml` se lance par le MCP GitHub (`workflow_dispatch` sur `develop` ou la branche) ; pour rejouer seulement `load`, passer `artifacts_run_id` d'un run qui a produit `catalog-out` (gardé 7 jours).
- Les décisions de l'utilisateur sont listées au design §4.1.
