# Passation entre sessions

> À lire en premier par toute nouvelle session Claude sur ce dépôt.

## Où on en est (2026-10-20)

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
- Comptes : org Supabase « WM Prod » `xyyxepqjbgmhyocqqcbx`, projet « WMR » `iggurckxmoagsajzrnwd` ; équipe Vercel IVM `team_nXdYy8ZVSzoNaYlzG7a1whey`, projet `wmr` (région `dub1`, branche de production `develop`) ; dépôt `IVM-Projects/wm-remake` (flux `develop` intégration, `master` production, `hotfix`).

## Étapes humaines ouvertes

1. **Faites** : `SUPABASE_SECRET_KEY` en Production (2026-10-19) et en **Preview** (constaté par le contrôle de production du 2026-10-20) ; branche de production réglée sur `develop`.
2. **Restant du M0** : ajouter le dépôt `IVM-Projects/wm-remake` à un espace de travail Graphify, puis rejouer les notes de `docs/decisions-graphify.md`.
3. **Restant du M0, facultatif** : ajouter `wm` dans Supabase → Settings → API → Exposed schemas, pour que le réglage du rôle (`pgrst.db_schemas`) ne puisse pas dériver.
4. **Réglages Auth de la démo** (tableau de bord Supabase, projet `iggurckxmoagsajzrnwd` ; le MCP n'expose pas la configuration Auth) :
   1. **Authentication → URL Configuration** : Site URL `https://wmr-ivm.vercel.app` ; Redirect URLs `https://wmr-ivm.vercel.app/**` seulement. Pas de joker de préversion : les préversions sont derrière Vercel Authentication, aucun joueur ne les utilise ; n'ajouter un alias de préversion exact (par exemple `https://wmr-git-develop-ivm-projects.vercel.app/**`) que si quelqu'un doit y tester la réinitialisation.
   2. **Courriels** :
      - **Authentication → Emails → Templates** : coller `supabase/templates/confirmation.html` dans « Confirm signup », avec le sujet « Ton code de confirmation », et `supabase/templates/recovery.html` dans « Reset password », avec le sujet « Choisis un nouveau mot de passe ».
      - **Authentication → Sign In / Providers → Email** : longueur de l'OTP à 6 (le formulaire attend 6 chiffres) et expiration de l'OTP à 3600 s (le gabarit dit « Il expire dans une heure »). Désactiver « Secure password change » pour la démo : l'app ne joue pas le flux de réauthentification, et GoTrue ne la demande qu'aux sessions de plus de 24 h, si bien qu'un test le jour même ne verrait rien.
   3. **Authentication → Emails → SMTP** : Brevo, avec un domaine d'expédition contrôlé (D§15 n° 2). Sans SMTP, le service intégré de Supabase n'envoie qu'aux adresses des membres de l'organisation, avec un débit très bas. Avant le pitch, relever **Authentication → Rate Limits** → e-mails par heure : plusieurs inscriptions dans la même heure atteindraient sinon le plafond (« Trop d'e-mails envoyés, réessaie un peu plus tard. »).
   4. **Authentication → Attack Protection → Captcha** : Turnstile, avec le secret de test de Cloudflare `1x0000000000000000000000000000000AA` (sa clé de site `1x00000000000000000000AA` est posée dans Vercel au déploiement du M1). Avec une vraie paire de clés, mettre à jour aussi les deux variables Vercel `NEXT_PUBLIC_TURNSTILE_SITE_KEY` et `TURNSTILE_SECRET_KEY`, puis redéployer.
   5. Facultatif : **Authentication → Attack Protection → Leaked password protection** (signalé par le conseiller sécurité ; refuse les mots de passe connus de HaveIBeenPwned, selon l'offre du projet).
   6. Facultatif : vérifier dans **Settings → JWT Keys** que la clé de signature est asymétrique (ECC P-256), sinon `getClaims()` interroge GoTrue à chaque requête. Après la première vraie inscription, lire l'en-tête `alg` d'une session et le consigner dans `docs/verifications.md` (point reporté du M0).
   7. **Comptes de démo** : les créer par `/signup`. « Add user » ou « Invite » du tableau de bord, comme `auth.admin.createUser` sans les métadonnées `{username, age_confirmed: true, terms_version}`, sont refusés par le trigger d'inscription (`consent_required`, affiché « Database error creating new user »).
5. **Après ces réglages** : un étudiant joue le parcours complet sur la démo (inscription avec le vrai widget Turnstile, code reçu par e-mail, premier paquet, collection, étiquette, défausse) et le résultat est consigné dans `docs/verifications.md`. Vérifier aussi, sur le projet hébergé, le changement de mot de passe et la déconnexion de `/settings` (« Secure password change » désactivé à l'étape 4.2).
6. **Pause Supabase Free** (7 jours sans activité) : écartée tant que `health.yml` interroge la production chaque jour ; s'il échoue, il ouvre une issue.

## Étape suivante : écrire le plan M2 (catalogue réel)

Périmètre du D§13 : parseurs et calculs sur fixtures, `catalog.yml` en modes `full` et `sample`, `catalog_merge`, pool par *swap-with-last*, `card_media`, page `/credits`. Reprendre la section M2 de `docs/suivi.md`, dont le cache partagé de `/api/cards` et le retrait des 2 000 cartes d'essai.

Trancher d'abord :

- le sort des copies de cartes d'essai déjà détenues par des joueurs de la démo au retrait du seed ;
- la clé du cache de `/api/cards` et son invalidation après `catalog_merge` (C16) ;
- la forme des fixtures Wikimedia rejouables dans le bac à sable, qui n'atteint pas Wikimedia.

## Points différés

Triés par jalon dans `docs/suivi.md`. Les fichiers de suivi des tâches (`.superpowers/sdd/…/progress.md`) sont ignorés par git et seront supprimés : tout ce qui compte est dans `docs/suivi.md` et `docs/decisions-graphify.md`.

## Rappels pour l'exécution

- Choix du modèle de chaque sous-agent selon le skill `model-routing` (silencieusement).
- Suite locale complète : `npm run lint && npm run typecheck && npm test && npm run test:db && npm run build:test && npm run test:contract && PW_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e && npm run coverage:recap` (prérequis dans `README.md`). Le `webServer` de Playwright démarre et arrête le banc.
- Réseau du bac à sable : wiki-masters.com, Wikimedia, Stripe, Brevo et l'hôte Postgres Supabase sont bloqués ; Supabase passe par son MCP (design §3.3).
- Les décisions de l'utilisateur sont listées au design §4.1.
