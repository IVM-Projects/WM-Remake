# Passation entre sessions

> À lire en premier par toute nouvelle session Claude sur ce dépôt.

## Où on en est (2026-10-20)

- **M0 livré** (2026-10-19) : fondations, CI, migrations `0001`, `0002`, `1000` sur la démo, production Vercel derrière la porte. Détail : `docs/verifications.md`.
- **M1 implémenté et relu** sur la branche `claude/clever-cannon-59x0dj` : les 16 tâches du plan `docs/superpowers/plans/2026-10-19-m1-comptes-paquets-collection.md` (plan 4a087d0 sur `develop` cb510d3, dernier commit de code 5153b0f, puis le commit de passation). Chaque tâche a eu une revue de conformité et une revue adverse, suivies de passes de correction ; les 29 arbitrages (R1 à R29) sont dans `docs/decisions-graphify.md`.
  - Livré : inscription (pseudo, 18+, code à 6 chiffres par e-mail), connexion, réinitialisation ; `/pulls` (vérification anti-bot, régénération, ouverture, révélation, Pro du jour, spéciaux, grâce) ; `/collection` (étiquettes, favoris, liste de souhaits, défausse unitaire et en masse, solde) ; `/global-collection` ; paramètres de base. Catalogue d'essai de 2 000 cartes (`supabase/seed.sql`).
  - Banc local : vrai GoTrue v2.197.0 et Mailpit v1.31.0 (binaires épinglés par `scripts/get-tools.sh`), en plus de PostgREST.
  - Critère de fin (D§13) : `e2e/journey.spec.ts` joue inscription → code → `/pulls` → paquet → collection → étiquette → défausse en un seul test, sans aucune insertion psql.
- **Suite locale verte** (2026-10-20, arbre du commit de passation) :

  | Commande | Résultat |
  |---|---|
  | `npm run lint` | 0 erreur, 0 avertissement |
  | `npm run typecheck` | OK |
  | `npm test` | 21 fichiers, 236 tests |
  | `npm run test:db` | 13 fichiers (9 `.sql`, 4 `.sh` de concurrence) |
  | `npm run build:test` | OK |
  | `npm run test:contract` | 82 cas |
  | `npm run test:e2e` | 102 tests, dont 20 passes axe sans violation *serious* ni *critical* |
  | `npm run coverage:recap` | 28 routes couvertes sur 90 : tout le R§3.1 à §3.4 ; les 62 manquantes sont du §3.5 au §3.10 |

- **CI, fusion dans `develop`, base de démo, variables Vercel, vérification en production** : *(à compléter par le contrôleur après déploiement)*
  - CI `ci.yml` (`workflow_dispatch`) sur la branche : …
  - Fusion `--no-ff` dans `develop` : …
  - Migrations `0003`, `1100`, `1200`, `1300`, `1400` et seed sur `iggurckxmoagsajzrnwd`, conseillers, contrôles (2 000 cartes, `wm.catalog_stats`, trigger `wm_on_auth_user_created`) : …
  - `NEXT_PUBLIC_TURNSTILE_SITE_KEY` et `TURNSTILE_SECRET_KEY` (Production et Preview), redéploiement : …
  - `/api/health` 200, `/signup` 307 vers `/gate`, porte qui refuse un mauvais mot de passe : …
- Comptes : org Supabase « WM Prod » `xyyxepqjbgmhyocqqcbx`, projet « WMR » `iggurckxmoagsajzrnwd` ; équipe Vercel IVM `team_nXdYy8ZVSzoNaYlzG7a1whey`, projet `wmr` (région `dub1`, branche de production `develop`) ; dépôt `IVM-Projects/wm-remake` (flux `develop` intégration, `master` production, `hotfix`).

## Étapes humaines ouvertes

1. **Faites** : `SUPABASE_SECRET_KEY` en Production (2026-10-19) et en **Preview** (constaté par le contrôle de production du 2026-10-20) ; branche de production réglée sur `develop`.
2. **Restant du M0** : ajouter le dépôt `IVM-Projects/wm-remake` à un espace de travail Graphify, puis rejouer les notes de `docs/decisions-graphify.md`.
3. **Restant du M0, facultatif** : ajouter `wm` dans Supabase → Settings → API → Exposed schemas, pour que le réglage du rôle (`pgrst.db_schemas`) ne puisse pas dériver.
4. **Réglages Auth de la démo** (tableau de bord Supabase, projet `iggurckxmoagsajzrnwd` ; le MCP n'expose pas la configuration Auth) :
   1. **Authentication → URL Configuration** : Site URL `https://wmr-ivm.vercel.app` ; Redirect URLs `https://wmr-ivm.vercel.app/**` et `https://*-ivm-projects.vercel.app/**`.
   2. **Authentication → Emails → Templates** : coller `supabase/templates/confirmation.html` dans « Confirm signup », avec le sujet « Ton code de confirmation », et `supabase/templates/recovery.html` dans « Reset password ». Vérifier que la longueur de l'OTP vaut 6 (le formulaire attend un code à 6 chiffres).
   3. **Authentication → Emails → SMTP** : Brevo, avec un domaine d'expédition contrôlé (D§15 n° 2). Sans SMTP, le service intégré de Supabase n'envoie qu'aux adresses des membres de l'organisation, avec un débit très bas.
   4. **Authentication → Attack Protection → Captcha** : Turnstile, avec le secret de test de Cloudflare `1x0000000000000000000000000000000AA` (sa clé de site `1x00000000000000000000AA` est posée dans Vercel au déploiement du M1). Avec une vraie paire de clés, mettre à jour aussi les deux variables Vercel `NEXT_PUBLIC_TURNSTILE_SITE_KEY` et `TURNSTILE_SECRET_KEY`, puis redéployer.
   5. Facultatif : vérifier dans **Settings → JWT Keys** que la clé de signature est asymétrique (ECC P-256), sinon `getClaims()` interroge GoTrue à chaque requête. Après la première vraie inscription, lire l'en-tête `alg` d'une session et le consigner dans `docs/verifications.md` (point reporté du M0).
5. **Après ces réglages** : un étudiant joue le parcours complet sur la démo (inscription avec le vrai widget Turnstile, code reçu par e-mail, premier paquet, collection, étiquette, défausse) et le résultat est consigné dans `docs/verifications.md`. Vérifier aussi, sur le projet hébergé, le changement de mot de passe et la déconnexion de `/settings` : si « Secure password change » est actif, Supabase peut exiger une réauthentification (`reauthentication_needed`), que l'app ne gère pas encore. Dans ce cas, désactiver le réglage pour la démo ou ajouter le flux au plan suivant.
6. **Pause Supabase Free** (7 jours sans activité) : écartée tant que `health.yml` interroge la production chaque jour ; s'il échoue, il ouvre une issue.

## Étape suivante : écrire le plan M2 (catalogue réel)

Périmètre du D§13 : parseurs et calculs sur fixtures, `catalog.yml` en modes `full` et `sample`, `catalog_merge`, pool par *swap-with-last*, `card_media`, page `/credits`. Reprendre la section M2 de `docs/suivi.md`, dont le cache partagé de `/api/cards`, le retrait des 2 000 cartes d'essai et les lignes `user_prefs` manquantes pour `wm.set_prefs`.

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
