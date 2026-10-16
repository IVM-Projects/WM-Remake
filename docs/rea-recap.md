# Récap REA : WikiMasters (www.wiki-masters.com)

> Rétro-ingénierie de l'application existante, préalable à sa reconstruction (Next.js + Supabase + Vercel) et à une migration sans perte.
> Date de consolidation : 2026-10-16. Données brutes fusionnées (8 rapports, non modifiés) : `docs/recon/recon-raw.json`.
> **Limite majeure** : wiki-masters.com est injoignable depuis le bac à sable (WebFetch `ENOTFOUND`). Rien n'a été observé en direct sur le site. Tout provient de code tiers qui consomme la vraie API (userscripts, extensions), de fixtures HTML réelles, de pages officielles indexées par les moteurs de recherche et de la presse.

---

## 0. Mode d'emploi du document

### 0.1 Sources et codes de citation

| Code | Rapport | Nature | Période couverte |
|---|---|---|---|
| **S** | `ext-straille64` | Fork privé de Sephiroth-ctrl/Wiki-Masters-Bot v1.3.13 (commit 3ef2719) : userscript bot (ouverture de paquets, sniping, revente). Fichiers lus : `src/open_cards.js` (11 876 l.), `docs/API.md`, `docs/AUDIT.md`, `upstream/CHANGELOG.md`. Analyse REA OK (12 endpoints, 81 stockages, 486 findings). Sauf mention contraire, `S 1234` désigne une ligne de `src/open_cards.js`. | jusqu'au 2026-08-21 |
| **T** | `ext-toolbox` | henchoznoe/WikiMasters-Toolbox (Chrome MV3 v1.3.0), qui intercepte fetch/XHR. `H:` = commit 95f8771^, la dernière version avant le retrait des modules gameplay. | 2026-09-29 → 10-05 |
| **E** | `ext-enhanced` | Nogze/wikimasters-enhanced v0.2.0 (059e27f) : client React complet qui remplace l'UI et joue sur le vrai backend. Son adaptateur `src/ext/wm.ts` couvre environ 63 routes. Ses mocks e2e reprennent les formes réelles avec des valeurs inventées. Sauf mention contraire, `E 123` désigne une ligne de `src/ext/wm.ts`. | 2026-10-07 |
| **X** | `ext-extended` | AlexherDev69/wikimasters-extended v0.1.5 (+ Oxys4 0.1.3). Il ne fait aucun appel API, mais fournit 15 fixtures HTML réelles (2026-09-20/21), `docs/DOM_NOTES.md`, `docs/PLAN.md` et 4 captures 1280×800. | 2026-09-21 |
| **R** | `web-rules` | Environ 45 recherches web, les pages officielles indexées (/terms, /rules, /privacy, /login, /signup) et la lecture de 10 dépôts sous `ext/` : ludomrn69, AndyB31/Wiki-Traders, MaKSiiMe, Astata, Lypningeuh/WikiRemastered, Sephiroth, maximus49000, qkerman, FCYPBA, maxime-lalo. | → 2026-10 |
| **F** | `web-features` | Web + 14 dépôts sous `ext2/` : AndyB31, qkerman, EnzoBncll, ThePommespanzer, Lypningeuh, LeKenT1, TendersTroll, MaistoGame, FCYPBA, maxime-lalo, Kitsoune, MaKSiiMe, AKemlin, Lucas-Mathieu, Lekarov. | → 2026-10-07 |
| **O** | `web-tech-ops` | Presse, pages légales et userscript Quatilyus/Wiki-Masters-Bot (`open_cards.js.txt`, même lignée que S). | → 2026-10-16 |
| **C** | `xbz-conventions` | Index Graphify de XBZ-E-Sport/xbz-web @794dab5 (le dépôt maison dont on reprend les conventions). | 2026-10-14 |

**Indépendance des sources.** S et O sont la même lignée de bot (Sephiroth-ctrl → Quatilyus) et ne comptent donc que pour une source. R et F recoupent plusieurs dépôts (AndyB31, Lypningeuh, maxime-lalo, FCYPBA, MaKSiiMe). Pour juger d'une confirmation, on compte les sources réellement indépendantes.

### 0.2 Légende de confiance

- **conf.** : observé dans du code réel, une fixture réelle ou une page officielle, ou au moins 2 sources indépendantes concordantes.
- **prob.** : une source fiable, ou une inférence cohérente avec le reste.
- **inc.** : presse seule, site concurrent, fonctionnalité propre à une extension, ou point contredit.
- **⚠ CONFLIT** : les sources divergent. Une résolution est proposée.

> **Piège récurrent : wikimasters.fr est un CLONE INDÉPENDANT** (« Alternative à wiki-masters.com », comptes séparés). Ses éléments ne s'appliquent pas à l'original : WikiCoins, Club 4,99 €, « Pack ++ », 43 succès, expiration des échanges à 48 h, 50/100 offres par jour, 10/20 enchères, fourchettes ATK/DEF par rareté, cotes 50,25/20/20/7/2,5/0,25 %, promesse de 10 % reversés à Wikimedia. Les moteurs de recherche le présentent pourtant souvent comme « officiel » (R, F, O, S). Dans ce document, tout fait issu uniquement de ce clone est marqué **inc.**

---

## 1. Présentation

### 1.1 Concept

| Élément | Détail | Conf. | Sources |
|---|---|---|---|
| Principe | Jeu de cartes à collectionner (TCG) **en français, dans le navigateur**. Chaque article de fr.wikipedia est une carte, soit environ 2,77 M de cartes. | conf. | toutes |
| Accroche officielle | « Collectionnez des cartes Wikipédia, ouvrez des paquets et affrontez vos amis ! » ; « Sa fréquentation fixe sa rareté, sa longueur son attaque, sa qualité sa défense. » | conf. | F (extraits de /signup et /) |
| Boucle de jeu | Paquets de 5 cartes (1 toutes les 10 min, réserve de 10). Collection avec étiquettes, favoris et liste de souhaits. Défausse à +1 WB. Marché aux enchères en wikibidous. Échanges entre amis. Batailles-quiz. Guildes. Succès. Classements. « Concours réguliers ». | conf. | S, T, E, X, R, F, O |
| Monnaie | **wikibidous** : « WB », « W » ou « wikis » dans l'UI ; icône de pièce « W ». | conf. | T, E, X, F |
| Monétisation | Abonnement **Pro** à 9,99 CAD/mois (≈ 6,50 € ; la presse française cite environ 7 €). **2 500 WB = 4,99 CAD** (Morandini : 3 €). « Recharges de paquets » mentionnées dans la politique de confidentialité. Paiement Stripe en CAD. | prob. | R, F, O (next.ink/258293, clubic, blick, /privacy) |
| Public | 18 ans et plus (case à cocher à l'inscription), français uniquement, 95 % des joueurs en France. | conf. | R, F, O (/terms) |
| Plateformes | Application web responsive (barre latérale sur desktop, barre basse sur mobile). Aucune app native au 2026-10-05, mais Capacitor est présent dans le code et les CGU parlent d'achats Apple/Google. Version anglaise et app native annoncées sans date. | conf. | X, F, O |

### 1.2 Chiffres clés

| Indicateur | Valeur | Date | Sources | Conf. |
|---|---|---|---|---|
| Taille du catalogue (affichée en jeu) | **2 773 461** cartes : L 1 761 · UR 12 368 · SR 66 788 · R 179 657 · PC 516 762 · C 1 996 125 | 2026-09-20 | X `tests/fixtures/global-collection-page.html` | conf. |
| Décompte Discord (cité sur un forum) | 2 773 279 : L 1 760 · UR 12 374 · SR 66 794 · R 179 596 · PC 516 508 · C 1 996 247 | ~2026-09-19 | R, O (forum jeuxvideo.com p.159) | prob. |
| Autres décomptes | Lexicodex 2 779 316 (1 672 L, C ≈ 72 %) ; Numerama 2 782 075 | plus tard | R, F | prob. |
| Pagination du catalogue | « Page 1 / 55470 » (50 cartes par page) | 2026-09-20 | X | conf. |
| Annonces au marché | ~6 000 (110+ pages) en août ; 45 424 lors de l'export de septembre | 08 → 09 | S `upstream/CHANGELOG.md:177`, X `PLAN.md` | prob. |
| Gros comptes | ~98 000 à 100 000 exemplaires, soit environ 1 960 à 2 000 pages de 50 | 08 | S CHANGELOG 120-122, O 4733-4740 | prob. |
| Audience | Environ 10 k → **200 k+ joueurs par jour** après le ZEvent (4–7 sept. 2026). 215 k DAU revendiqués fin septembre. **330 k+ comptes** début octobre. 40 k+ inscriptions par jour. 95 % de la France. | 09 → 10 | R, F, O (jeuxvideo.com news 2106010, next.ink, blick/AFP) | conf. |
| Communauté | Discord officiel : 11 k+ (R) ou environ 16 k (F, discord.com/invite/9D6qjpRATb, non lié depuis la page d'accueil). ⚠ écart mineur, probablement lié à la date de mesure. | 09 → 10 | R, F | prob. |
| Équipe | Naïm Ouellet (24 ans, Québec) et 2 développeurs. Code largement écrit avec Claude. Recrutement sur LinkedIn. | 2026 | R, F, O | conf. |

### 1.3 Historique

| Date | Événement | Sources |
|---|---|---|
| 2026-03-19 | `iat` de la clé anon Supabase. Le lancement date donc de mars 2026 (exp. 2036-03-18). | S 6008-6011, F, O 6138-6140 |
| 2026-07-20 | Version des « Règles de la communauté » (/rules). | R, F, O |
| 2026-08-10 → 08-17 | `GET /api/marketplace/mine` passe de listes (`selling`/`won`/`history`) à de simples compteurs. ⚠ La date varie selon la source : O dit 08-10, S environ 08-17. | S CHANGELOG 484-509, O CHANGELOG 494-500 |
| 2026-08-19 | `POST /api/marketplace` rejette les requêtes « hors UI » avec « Vous ne possédez pas cette carte ». Explication probable au §3.5. | S CHANGELOG 66-111 |
| 2026-09-04 → 07 | ZEvent : le jeu devient viral. | R, F, O |
| 2026-09-20/21 | Capture des fixtures DOM réelles. | X |
| 2026-09-23 | Mise à jour des CGU (/terms) et de la politique de confidentialité (/privacy). | R, F, O |
| 2026-09-27 | Capture d'une réponse réelle de `/api/packs/open`. | F (Lypningeuh `docs/TECHNIQUE.md`) |
| → 2026-10-01 | La vérification humaine (Turnstile) est redemandée toutes les 12 h. | F |
| 2026-10-03 | Fixture « Mes ventes (2/5) » (5 ventes simultanées). | F (AndyB31 `tests/fixtures/real-mes-ventes.html`) |
| 2026-10-07 | La recherche texte du marché couvre aussi les descriptions. | F (LeKenT1, ~l.365) |
| 2026-10-11 | Campagne Transavia × agence Marcel « Les cartes d'embarquement » : 120 cartes destinations, en collectionner 10 puis partager sur Instagram. Annonce probable de **collections sponsorisées et de sets**. | O (CB News) |
| 2026-10-12 → 16 | Gros incident de charge (voir §1.4). | O |
| Annoncé | Migration vers des serveurs français, stabilisation, puis app native et traduction anglaise. | O, F |

### 1.4 Incidents connus : régressions à ne PAS reproduire

| Incident | Détail | Sources |
|---|---|---|
| Latence | Du 19 au 25 sept., jusqu'à 10 s. Du 12 au 16 oct., la collection met environ 20 s, les connexions DB saturent, les batailles ne démarrent pas et les paquets affichent 0. | O |
| Timeouts Postgres (500) | Gros échanges (> ~30 cartes : rollback complet ; selon R, l'opération est parfois quand même commitée), gros lots d'étiquettes, suppression en cascade d'une étiquette. | S CHANGELOG 635-641, S 11206-11214, O, R |
| 504 | `my-collection` sur des pages profondes avec `sort=rarity`. | S 4702, R |
| Saturation par des tiers | 6 229 appels en 4 min ont saturé le serveur. Les bots scannent le marché toutes les 10 s et interrogent une enchère jusqu'à toutes les 150 ms. | S CHANGELOG 120-122, S 4280-4299 |
| Données incohérentes sous charge | `total` à 0 ou absent dans `my-collection` ; `/mine` sans ses champs ; recherche par nom au marché d'environ 30 s ; erreurs Cloudflare 52x. | S, R, F |
| Faille d'autorisation | Des tricheurs ont ouvert des paquets qui ne leur étaient pas destinés. | O |
| Historique perdu | L'historique « Gagnées » ne gardait qu'une fenêtre glissante : les achats anciens disparaissaient côté serveur. | O |
| Modération | Spéculation aux enchères sur des cartes de figures nazies ou d'extrême droite et sur des images pornographiques. Équipe de modération seulement « en cours de mise en place ». Une carte RN-jeunesse a été supprimée. | F, O (blick, clubic, jvflux) |
| Licences | Images affichées sans mention de licence (critique de Next.ink). | O |
| Infrastructure | Rumeur : l'hébergeur mettrait un mois à augmenter le stockage (non vérifié). | F, O |

---

## 2. Inventaire des pages et routes

### 2.1 Pages publiques

| Route | Rôle | Éléments UI notables | Sources | Conf. |
|---|---|---|---|---|
| `/` | Landing page et appel à l'inscription | Carrousel décoratif `.wm-belt-card`. Carte d'exemple avec un composant différent (`aspect-[5/7]`, sans `glow-*`, badge de rareté, h3, p, icônes épées/bouclier, tags « Sciences », « Histoire », « À échanger »). Sections tags/favoris, troc, guildes (exemple « Les Encyclopédistes », 12 membres), succès, classement, concours. | R (MaKSiiMe hud.user.js:79), X `PLAN.md:14`, F | conf. |
| `/signup` | « Inscription — WikiMasters » | `form#signup-form` contenant `#username` (3–24 caractères, autocomplete=username), l'e-mail et `#password` (new-password). Deux cases : « Je confirme avoir au moins 18 ans et je comprends que les cartes proviennent de Wikipédia et peuvent inclure du contenu sensible. » et « J'accepte les Conditions d'utilisation et les Règles de la communauté. » Puis **Cloudflare Turnstile**, puis une étape OTP par e-mail `input#signup-otp-code` (name=otp, 6 à 12 chiffres). | F (TendersTroll `content.js:586-705`), X | conf. |
| `/login` | « Connexion — WikiMasters » | `#email`, `#password`, libellés « Adresse courriel », « Mot de passe », lien « Mot de passe oublié ? » et lien vers l'inscription. Turnstile. Redirige vers `/pulls`. Aucune connexion OAuth vue. | R (Astata `main.py:17,84-94`), X `PLAN.md:11-12`, F | conf. |
| `/callback` | Callback Supabase Auth (liens e-mail), titre « Connexion — WikiMasters » | — | F (URL indexée) | prob. |
| `/forgot-password` | Demande de réinitialisation : « Nous vous enverrons un lien pour choisir un nouveau mot de passe. » | — | F, R | conf. |
| `/reset-password` | « Nouveau mot de passe — WikiMasters », erreur « Lien invalide ou expiré » | — | F | conf. |
| `/verify-email` | « Vérifier l'e-mail » : « Confirmez votre adresse e-mail pour activer votre compte WikiMasters. » | Liens vers connexion et inscription si l'adresse manque. | F, O | conf. |
| `/rules` | Règles de la communauté (v. 2026-07-20, 9 sections) | Page de texte. | T `README.md:37`, X, R, F, O | conf. |
| `/terms`, `/privacy` | CGU et politique de confidentialité (v. 2026-09-23) | — | R, F, O | conf. |
| `/register`, `/auth`, `/legal`, `/cgu`, `/cgv`, `/mentions` | Simple hypothèse de regex de l'auteur d'E | — | E `extension/loader.js:10` | inc. |

### 2.2 Application connectée

Ordre de la barre latérale, confirmé par deux fixtures réelles (X `site-header.html`, F `site-nav.html`) : **Paquets, Collection, Échanges, Marché, Profil, Toutes les cartes, Guilde, Amis, Messages, Bataille, Succès, Classement, Paramètres**. Sur mobile, une barre basse propose Paquets, Collection, Échanges, Marché et « ••• Plus » (F). Toute route applicative visitée sans session redirige vers `/login` (X `PLAN.md:11`).

| Route | Libellé nav (icône lucide) | Rôle | Éléments UI notables | Sources | Conf. |
|---|---|---|---|---|---|
| `/pulls` | Paquets (puzzle, prob.) | Page d'accueil après connexion (le logo y renvoie). Ouverture des paquets. | État repos : visuel du paquet (pack blanc nacré, pièces de puzzle pastel, logo « WM » noir en forme de pièce de puzzle, halo orange), bouton vert « Ouvrir » (ou « Ouvrir un paquet » selon R), `div.card-frame` avec `2 / 10` et « paquets disponibles », « Prochain dans `8:27` » (`span.font-mono`, couleur accent, mis à jour chaque seconde), barre de stock à 10 segments (F), bloc « Paquet PRO du jour », bannière d'achat de paquets quand le stock est à 0 (F). État révélation (exclusif) : compteur « Carte **1** / 5 », carte glissable `div.animate-card-flip.relative.touch-none.cursor-grab.active:cursor-grabbing.select-none` dans `div.relative.inline-flex.max-w-[min(100vw-2rem,28rem)]`, boutons ronds précédent/suivant w-12 h-12 (`disabled:opacity-20`), 5 points w-3 h-3 (le point actif est en accent et `scale-125`), bouton « Encore 4 cartes » (désactivé tant que des cartes restent à voir ; R parle de « Continuer »), badge « Nouvelle/New », récapitulatif. Une modale « Comment ça marche ? » détaille les seuils de rareté. | X (`pull-idle.html`, `pull-reveal.html`, `DOM_NOTES.md:71`), T (`routes.ts:7-15`, `pulls-observer.ts:85-128`), R (Astata `main.py:96-130`), F | conf. |
| `/pull` | — | Garde de vérification humaine (Turnstile) avant l'ouverture des paquets. ⚠ Il s'agit peut-être du préfixe de `/pulls` : AndyB31 matche `/pull*`. | — | F (TendersTroll README), R (AndyB31 `site-ui.ts:78`) | prob. |
| `/collection` | Collection (book-open, prob.) | Exemplaires possédés | Titre « Collection ». Recherche `input[placeholder="Rechercher par titre ou catégorie..."]` (debounce, recherche côté serveur, autofocus). Liste déroulante « Toutes les étiquettes » (avec le nombre de cartes par étiquette, F). Tri, « Rareté » par défaut (date d'ajout, nom, rareté, ATK, DEF, favoris). Pastilles de rareté L UR SR R PC C (style `background-color: var(--color-rarity-x)30; color: var(--color-rarity-x)`, `opacity-50` quand inactives). « Sélectionner » pour la multi-sélection (appliquer/retirer une étiquette, défausse en masse, tout sélectionner). Solde de WB en haut à droite (pièce W + « 221 »). Pagination « ← Précédent / Page 1 / 47 / Suivant → » (50 par page). Grille `div.flex.flex-wrap.justify-center.gap-3`, chaque carte dans `div.relative.isolate.group`. Étoile favori et quantité « xN ». Modale de carte (voir §6). | X (`collection-filters.html`, `DOM_NOTES.md:73`, `3-vue-compacte.png`), S 5196, F (FCYPBA `DOCS.md`), R | conf. |
| `/global-collection` | Toutes les cartes (globe) | Catalogue complet | h1 « Collection Globale » et « Toutes les cartes existantes dans le jeu ». En-tête `card-frame` avec les totaux par rareté et « 2 773 461 cartes au total ». Pendant une recherche, cet en-tête devient « Recherche active : pas de décompte par rareté ni de total exact ». Recherche + bouton « Rechercher » (désactivé si vide ; ≥ 3 caractères selon F). Bouton de tri `aria-label="Trier les cartes"` (« Rareté » par défaut). Bascule « Liste de souhaits » (lucide-bookmark). Grille `flex flex-wrap justify-center gap-3 sm:gap-[22px] md:gap-[26px]` sans wrapper ni marqueur de possession. Pastille « ami possède » `span.rounded-full.bg-sky-300/65` (lucide-users + nom de l'ami ; un clic ouvre son profil). 50 cartes par page. Cache natif dans sessionStorage `gc_v11_/api/cards?<query>`. | X (`global-collection-page.html`, `global-collection-filters.html`), T (`page-adapters.ts:22-26`, `prices.ts:524-546`), F | conf. |
| `/trades` (+ `/trades/{id}`) | Échanges (handshake, prob.) | Offres d'échange | Onglets « Reçues », « Envoyées », « Historique » (l'actif est en `text accent` + `border-b-2`). Chaque offre est un `div.card-frame.p-4` contenant un bouton `aria-label="Voir le détail de l'échange"` : « De <pseudo> », statut « · Refusé » (`text-red-400`) ou « · Accepté » (`text-green-400`), date courte « 20 sept. », colonne « <pseudo> offre », icône `lucide-arrow-left-right`, colonne « En échange de ». Les puces sont des `span[title=<titre complet>]` (`background-color: var(--color-rarity-sr)22`) avec le texte « SR · <titre tronqué ~20 car.>… ». Bouton « Message à <pseudo> » (lucide-message-circle). Vue détail « Détail de l'échange » (non capturée). | X (`trades-list.html`, `4-cartes-des-echanges.png`), T (`prices.ts:430-438`), F, R | conf. |
| `/marketplace` | Marché (gavel) | Hôtel des ventes. Sous-titre « Enchérissez sur des cartes ou vendez les vôtres contre des wikis. » | h1 « Marché » (lucide-gavel). Onglets « Parcourir », « Mes ventes (n/5) », « Mes enchères (n) », « Gagnées », « Historique (n) ». Tuiles `div#marketplace-auction-<uuid> > a.card-frame[href=/marketplace/<uuid>]` avec « Mise de départ » ou « Mise actuelle », « Durée » (compte à rebours, par ex. « 3m 18s », `text-amber-600 tabular-nums`), `time[datetime]`, « Vendu par X » (`p.truncate`) et ✨ pour les brillantes. Environ 40 tuiles par lot avec « Charger la suite » (ajout dans le DOM). Recherche, tri (récentes, prix croissant, prix décroissant, fin proche), pastilles de rareté. Onglet actif en `border-b-2 border-amber-500 text-amber-600`. | X (`DOM_NOTES.md:72`, `PLAN.md:67,223`), F (AndyB31 `real-mes-ventes.html` 2026-10-03), R (AndyB31 `site-ui.ts:106-118`) | conf. |
| `/marketplace/{auctionId}` | — | Détail d'une enchère et mise | h1 = titre de la carte, bloc « Miser », historique des mises avec les noms, vendeur, boutons ronds liste de souhaits et « analyse du marché » (historique Pro), bouton « Retour au marché », état « Auction not found ». La création d'une annonce redirige ici. | T (`prices.ts:464-506`), S 3384, 5246-5258, F (FCYPBA), O | conf. |
| `/battle` (+ `/battle/{uuid}`) | Bataille (swords) | Lobby de bataille : défier un ami, choisir 3 cartes. L'arène est sur `/battle/{uuid}`. | Rien de capturé côté officiel. L'UI d'E (En cours/Terminées, quota « used / limit défis aujourd'hui », « Comment ça marche ? ») reprend probablement la logique, pas le DOM. | X, F, E (`nav.ts:16,76`) | conf. (route) |
| `/guild` | Guilde (castle) | Membres, chat, classement, invitations | Non capturé. | X, F | conf. (route) |
| `/friends` | Amis (users) | Amis, demandes, recherche de joueurs | `input#friend-list-search`, boutons « Message » et « Échanger ». | F (FCYPBA `wiki-masterbetter.me.js:204`) | conf. (route) |
| `/dms` | Messages (message-circle) | Messages privés (entre amis uniquement) | Non capturé. E utilise `?with=<userId>`. | X, F | conf. (route) |
| `/profile`, `/profile/{username}` | Profil (user) | Profil personnel ou public (connexion requise) : vitrine, statistiques, boutons ajouter en ami, message, échanger | Non capturé. | X, F (FCYPBA route table) | conf. (route) |
| `/achievements` | Succès (trophy) | Liste des succès et bouton de réclamation de chaque récompense | Non capturé. | X, F, R (Lypningeuh `achievements.js`) | conf. (route) |
| `/leaderboard` | Classement (medal) | Classement général des joueurs et classement des guildes | Non capturé. | X, F | conf. (route) |
| `/settings` | Paramètres (settings) | Onglet « Général » : profil, compte, notifications, préférences, contact. Filtre de contenu sensible et visibilité du profil non confirmés. | Non capturé. | F (AndyB31 `site-ui.ts:131,769`), /privacy | prob. |
| *(overlay)* Notifications | Cloche `button.relative.p-2.rounded-xl[aria-label="Notifications"]` à côté du logo, rendue deux fois (desktop et mobile) | Panneau avec badge de non-lus (rouge, sans doute plafonné à « 9+ »), marquer comme lu, tout marquer comme lu. Notifications quand une carte de la liste de souhaits est mise en vente. | — | X (`site-header-unread.html`), F | conf. |
| *(overlay)* Boutique / PRO | Modale boutique (paquets, wikibidous, abonnement Pro), encarts d'abonnement, onglets réservés au PRO | — | — | F (Lypningeuh `DESIGN.md`, `TECHNIQUE.md`) | prob. |
| `/home`, `/market`, `/settings` d'E | Écrans propres à l'extension E (« Aujourd'hui », alias de marché, réglages de l'extension) | **À ne pas reproduire** : absents de la nav officielle (X). | — | E (`nav.ts`) | inc. |

---
## 3. Contrat d'API complet (fusionné)

### 3.0 Conventions transverses

| Sujet | Règle observée | Sources | Conf. |
|---|---|---|---|
| Origine | Les route handlers Next.js sont servis sous `https://www.wiki-masters.com/api/*` (même origine). Le site appelle les mêmes URL, en relatif ou en absolu. | S 11185, T, E, R, F, O | conf. |
| Authentification `/api/*` | Cookie de session `@supabase/ssr` nommé `sb-cyrxjeppjqsxxjayfrur-auth-token` et envoyé avec `credentials:'include'`. Sa valeur est `base64-` + base64url(JSON {access_token, refresh_token, expires_at, user…}). Il peut être découpé en `.0`, `.1`… (morceaux de 3 180 caractères). Les handlers rafraîchissent la session par `Set-Cookie`. Un en-tête Origin est envoyé. | S 6359-6400, E `background.js:5-41`, R (ludomrn69 1164-1211) | conf. |
| Authentification PostgREST | `https://cyrxjeppjqsxxjayfrur.supabase.co/rest/v1/...` avec les en-têtes `apikey: <anon JWT>` et `Authorization: Bearer <access_token utilisateur>`, `credentials:'omit'` (pas d'ACAC). La clé anon est publique : elle se trouve dans les chunks `/_next/static/chunks/*.js` et sur `/login`, au format `eyJhbGciOi…` ou `sb_publishable_…`. La racine OpenAPI `/rest/v1/` renvoie 401. | S 6008-6011, E `background.js:44-59`, F, O | conf. |
| Pagination | `my-collection`, `cards` et `profile/*/collection` sont **indexés à partir de 0**. `marketplace` est **indexé à partir de 1**. Pages de 50. Une page courte signifie la fin ; sinon `hasMore` ou `searchHasMore`. PostgREST plafonne à 1 000 lignes (`Range: 0-999`, `Prefer: count=exact`). | S 2235, 2268, 2389-2395, T, E, F | conf. |
| Erreurs | Corps `{ error: string }` ou `{ message }`, parfois `{ code }`. Codes vus : `human_verification_required`, `bid_too_low` (+ `min`), `pro_required`, `automation_limit` (401/403, O), Postgres `42501` (RLS) et `23505` (doublon). E normalise `error` en MAJUSCULES_SNAKE (`NO_PACKS`, `BUSY`). Les messages sont en **français** et les outils tiers les matchent (`/bot\|humain\|human\|v[ée]rif/i`, « minimum N wikibidous », « already/déjà/not pending »). | T, E 77, 208, R, F, O | conf. |
| Limitation de débit | 429 avec `Retry-After` ; 5xx et 52x Cloudflare sous charge. | T, R, F, O | conf. |
| Session invalide | 401/403 : session expirée ou restreinte. | T | conf. |
| En-têtes spéciaux | `x-wiki-calendar-tz: <IANA tz>` (Intl) envoyé pour les échanges et le paquet Pro du jour. `x-vercel-id` (`cdg1::iad1::…-<epoch13ms>-…`) et l'en-tête `Date` servent d'horloge serveur aux snipers. | E 46-57, 355, 386-394, 705-708, S 1523-1543 | conf. |

### 3.1 Paquets

| Méthode | Chemin | Params | Body | Réponse | Notes | Sources | Conf. |
|---|---|---|---|---|---|---|---|
| POST | `/api/packs/open` | aucun | aucun (E ignore `{count:1}`) | **200** `{ cards: CardInPack[5], packs_remaining: int, packs_last_regen_at?: ISO, owned_copies?: … }`. `CardInPack` regroupe les variantes : `id` (carte catalogue) **ou** `card_id`, `user_card_id?`, `card?: {id, wikipedia_title, rarity, is_shiny?}` (forme imbriquée), `wikipedia_title`, `rarity` C/PC/R/SR/UR/L, `snapshot_rarity?`, `is_shiny?`, `image_url`, `wikipedia_url`, `category`, `summary` ou `description?`, `atk?`, `def?`, `hide_image?`, `nsfw_image?`. ⚠ `owned_copies` vaut `Record<card_id, number>` selon E et `[{card_id, is_shiny,…}]` selon F (réponse réelle du 27/09) : accepter les deux. **Erreurs** : stock vide → 403 `{packs_remaining:0, next_regen_at: ISO, error/message:'Plus de paquets disponibles'}` (R) ⚠ ou 200 `{cards:[], packs_remaining:0}` (T). Anti-bot → 403 `{code:'human_verification_required'}`, `human_verification_required:true` ou `{error:'Vérification anti-bot requise pour continuer à ouvrir des paquets.'}`. Limite courte → `rate_limited:true` + `retry_after: ISO`. Limite quotidienne → `rate_limit_daily:true` (« Limite quotidienne de paquets atteinte »). Blocage → `activity_blocked_until` ou `packs_blocked_until: ISO`. Le statut 429 existe aussi. | La meilleure carte est révélée en dernier (F). Le nombre 5 n'est pas une constante du client, mais tous les consommateurs l'exigent (T). Turnstile requis au préalable. | S 10653-10662, 11333-11380 ; T `H:packs.ts:15-24,349-381`, `network.ts:92-118` ; E 16, 210-227 ; R (ludomrn69 1346-1349, 2660-2698 ; AndyB31 `packs-logic.ts:12-55`) ; F (ThePommespanzer `content.js:565-583`, LeKenT1 2444-2452) ; O 10821-10829 | conf. |
| POST | `/api/human-check` | — | `{ token: string }` (jeton Cloudflare Turnstile, sitekey `0x4AAAAAAEW_2IAWonrk_N5i`, `render=explicit`, `theme=dark`) | `{ ok: boolean }` (200 / 400) | Débloque `/api/packs/open`. La page hôte officielle est `/pulls`. | E `humanCheck.ts:86`, `extension/turnstile.js:9-16` | conf. |
| GET | `/api/packs/pro-daily` | — | — | `{ eligible: bool, claimed_today: bool, size?: int }` (taille 15 par défaut côté UI : « 15 cartes, aucune commune ») | Paquet bonus quotidien Pro/VIP. | E 705-706, `Booster.tsx:285-319` ; F (ThePommespanzer `inject.js:11`) | prob. |
| POST | `/api/packs/pro-daily` | — | aucun ; en-tête `x-wiki-calendar-tz` | `{ cards: [...] }` (même forme que `open`), cartes versées dans la collection | Le jour est calculé dans le fuseau horaire du joueur. | E 707-708, F | prob. |
| GET | `/api/packs/special` | — | — | `{ packs: [{id, name?/title?, description?}], available: bool }` | Paquets spéciaux ou d'événement. | E 709-710 | prob. |
| POST | `/api/packs/special` | — | `{ packId: string }` (E) ; inconnu selon F | `{ cards, packs_remaining? }` | — | E 711-712, F | prob. |
| POST | `/api/packs/grace` | — | inconnu | `{ cards }` | Paquet « grâce » (compensation ? bienvenue ?), sémantique inconnue. | F (ThePommespanzer `inject.js:11`) | inc. |
| POST | `rest/v1/rpc/sync_profile_packs` | — | `{ user_id: uuid }` | Ligne ou `[ligne]` : `{ username, avatar_url?, is_pro?, is_vip?, pack_cap? (défaut 10), packs_remaining, packs_last_regen_at: ISO\|null, wikibidous_balance }` | Appelé par `/pulls` à chaque visite. Le serveur **régénère les paquets de façon paresseuse** à la lecture. Réessai une fois sur 401/403 avec un cookie rafraîchi. | E 83-98 ; R (ludomrn69 1457-1463) | conf. |
| POST | `rest/v1/rpc/get_my_profile` | — | — | `{id, …}` ou `[{id,…}]` (colonnes du profil courant) | — | T `network.ts:73-82` | conf. |

### 3.2 Portefeuille

| Méthode | Chemin | Params | Body | Réponse | Notes | Sources | Conf. |
|---|---|---|---|---|---|---|---|
| GET | `/api/wikibidous` | — | — | `{ balance: int }` (les clés `amount`/`wikibidous` sont sondées en repli) | Aucun champ « gained » n'est renvoyé : les clients comparent le solde avant et après (défausse, succès). Un delta positif pendant une enchère signifie un remboursement après surenchère. | S 1690-1712 ; E 582, 698, 732 ; R ; F ; O 1758-1765 | conf. |

### 3.3 Collection, étiquettes, liste de souhaits, défausse

| Méthode | Chemin | Params | Body | Réponse | Notes | Sources | Conf. |
|---|---|---|---|---|---|---|---|
| GET | `/api/my-collection` | `page` (0-based), `limit` (50 ; au-delà, peu fiable), `sort` ⚠ (`rarity`, `obtained_at`, `added`, `name` : l'union des valeurs vues), `stats=0/1`, `q` ou `search`, `rarity`, `tag_id`, `untagged`, `wishlisted_by`, `owned_by=<userId>` (collection d'un pair), `pending=1` (inclut les copies engagées dans un échange en attente) | — | `{ collection: Item[], total: int, pendingTradeCardIds?: uuid[] }`. `Item = { id: uuid (= user_card_id), user_id, card_id, card: {id, wikipedia_title, rarity, category?, atk?, def?, image_url?, hide_image?, wikipedia_url?, description?}, snapshot_rarity?, is_shiny, starred, count?: int (≥1, 1 par défaut), tags: [{id, name, color?}] (ou {tag:{…}}, + cardCount?), obtained_at: ISO }` | Tri par `obtained_at` DESC. L'ordre est **instable** d'une page à l'autre (F). `pendingTradeCardIds` n'apparaît que sur certaines pages : faire l'union. 504 sur les grandes pages en `sort=rarity`. `total` parfois 0 ou absent pendant les incidents. | S 2183-2311, 4653, 4702 ; T `page-adapters.ts:16`, `H:collection.ts:257-267` ; R (ludomrn69 793-818, 1389-1417) ; F (qkerman `bridge/core.js:41-65`, MaistoGame, TendersTroll `trade.js:58-66`) ; O 2252-2275 | conf. |
| GET | `/api/my-collection/stats` | mêmes filtres (`sort`, `q`, `rarity`, `tag_id`, `untagged`, `wishlisted_by`) | — | `{ total: int, rarities?: [{rarity/name/key, count/total/value}] }` ⚠ (union des formes T/R et F) | Instable sous charge (500). | T `H:network.ts:166-174` ; R ; F (qkerman `collection.js:60`, EnzoBncll `sync.ts:81`) | prob. |
| GET | `/api/profile/{username}/collection` | `page` (0-based), `stats=0/1`, `q` | — | `{ collection: [{id, card, count?, is_shiny?}], total?, rarityCounts?: {C..L: int} }` | Collection d'un autre joueur. `stats=1` donne les comptes par rareté (cartes uniques). Le format du segment (uuid ou pseudo) n'était pas clair pour T ; E utilise le **pseudo**. | E 399-414, 484 ; T `network.ts:176-181` | prob. |
| POST | `/api/user-cards/{userCardId}/discard` | — | aucun | `{ balance: int }` (nouveau solde) | +1 WB, irréversible. 403 + `42501` si la copie n'est plus possédée. 429 « Le site demande de ralentir ». | R (ludomrn69 1350-1357, 1446-1447) ; F (ThePommespanzer `collection.js:593-597`, EnzoBncll `discard.ts:66-75`) ; T (fixtures) | conf. |
| POST | `/api/user-cards/bulk-discard` | — | `{ card_ids: uuid[] }` (ids **user_card**, uniques, **1 à 50**) | `{ discarded_count: int, failed?: (string \| {error?, reason?})[] }` | Utilisé par la multi-sélection native. E découpe en lots de 500 (200 dans l'UI) : la limite serveur de 50 (R, F) fait foi. | T `H:collection-actions.ts:477-485` ; E 729-736 ; R (Lypningeuh `api.js:289-297`) ; F | conf. |
| GET | `rest/v1/user_cards` | `select=id,card_id,count,starred,is_shiny,obtained_at,snapshot_title,snapshot_rarity,snapshot_category,user_card_tags(tag_id),card:cards(<cols>)&user_id=eq.<me>&order=obtained_at.desc` ; `Range: 0-999` ; variante S : `card_id=eq.&user_id=eq.&select=id,created_at,user_card_tags(tag_id)` | — | lignes `user_cards` | Lecture directe sous RLS. ⚠ S voit `created_at` là où les autres voient `obtained_at` (alias côté API, ou renommage). | E 167-202 ; R (AndyB31 `api.ts:388-405`) ; F ; S 5450-5526, 6302 | conf. |
| PATCH | `rest/v1/user_cards?id=in.(…)` | — | `{ starred: bool }` + `Prefer: return=minimal` | 204 | Le propriétaire modifie lui-même `starred` (RLS). T voit aussi des écritures POST/PATCH/DELETE sur `user_cards`. | E 725-726 ; T `H:network.ts:67-79` | conf. |
| GET | `rest/v1/tags` | `select=id,name,color&user_id=eq.<me>&order=name.asc` ; `user_id=eq.&name=eq.<n>&select=id&limit=1` | — | `[{id, user_id, name, color\|null}]` | — | S 6026-6096 ; E 144-151 ; R ; F (EnzoBncll `siteTags.ts:15-48`) ; O | conf. |
| POST | `rest/v1/tags` | — | `{ user_id, name (≤ 48), color: '#rrggbb'\|null }` + `Prefer: return=representation`, `Content-Profile: public` | 201 `[{id,…}]` | Étiquettes **par utilisateur**. Le « # » est affiché, pas stocké. Normalisation de la casse et des accents côté client. | S 6111-6155 ; E 656-660 ; R ; O | conf. |
| PATCH | `rest/v1/tags?id=eq.` | — | `{name?, color?}` | — | Renommer ou recolorer une étiquette. | F (EnzoBncll) | prob. |
| DELETE | `rest/v1/tags?id=eq.{tagId}` | — | — | lignes supprimées (`return=representation`) | **Cascade** vers `user_card_tags`. Les grosses cascades tombent en timeout (500). | S 10900-11030 ; O 11371-11374 | conf. |
| POST | `rest/v1/user_card_tags?on_conflict=user_card_id,tag_id` | — | `{user_card_id, tag_id}` ou **tableau** (lots de 100) ; `Prefer: resolution=ignore-duplicates,count=exact,return=minimal` | 201 ; 409 + `23505` si doublon | Les gros lots envoyés par le site tombent en timeout. Les étiquettes sont posées **par copie** (`user_card`). | S 6244-6277 ; E 153-159 ; R ; F ; O 6376-6392 | conf. |
| DELETE | `rest/v1/user_card_tags?tag_id=eq.&user_card_id=in.(…)` | — | — | — | — | S 11206-11209 ; E ; R | conf. |
| GET / POST / DELETE | `rest/v1/wishlist_items` | GET `select=card_id&user_id=eq.<me>&order=created_at.desc` ; DELETE `user_id=eq.&card_id=eq.` | POST `{ user_id, card_id }` ou tableau ; `Prefer: resolution=ignore-duplicates` | 2xx | Liste de souhaits personnelle (« Ma liste »). D'après le clone, l'entrée disparaîtrait quand la carte est obtenue (inc.). | S 11134-11156, 11203 ; E 617-625 ; F (EnzoBncll `site-wishlist.ts:12-28`) ; O 11368 | conf. |

### 3.4 Catalogue

| Méthode | Chemin | Params | Body | Réponse | Notes | Sources | Conf. |
|---|---|---|---|---|---|---|---|
| GET | `/api/cards` | `page` (0-based), `sort=rarity`, `q` (≥ 2 caractères selon E, ≥ 3 selon F ⚠ : retenir 2 côté serveur), `rarity` (répétable), `wishlist=1` | — | `{ cards: Card[], total: int\|null, searchHasMore?: bool, rarityCounts?: {C..L:int}, friendOwners?: {[cardId]: [{username}\|{id}\|string]}, ownedCardIds: uuid[], wishlistCardIds?: uuid[] }` | Alimente `/global-collection`, la vue liste de souhaits et le mode « pas encore à moi ». 50 par page. `rarityCounts` donne la taille de chaque rareté dans le pool. | T `prices.ts:524-546`, H tests ; E 590-604 ; R (qkerman `theme-tracker.js:518-539`) ; F (EnzoBncll `site-wishlist.ts:59-108`) | conf. |
| GET | `rest/v1/cards` | `select=id,atk,def,lang,rarity,q_score,category,image_url,pageviews,hide_image,nsfw_image,wikipedia_url,wikipedia_title,summary,pageviews_refreshed_at,qscore_refreshed_at` ; `id=in.(…≤150)`, `id=eq.`, `wikipedia_title=eq./in.(…)` | — | `Card[]` | L'anon key a le droit de lire `cards`. **Le site lui-même** fait `cards?select=summary&id=eq.` (modale de la carte, avant une mise en vente). | S 6585-6591, 6776-6780, 5628-5641 ; E 11, 119-126 ; R ; F (qkerman `families.js:11,71-80`, `core.js:200-230`) ; O 6905-6912 | conf. |

### 3.5 Marché (enchères)

| Méthode | Chemin | Params | Body | Réponse | Notes | Sources | Conf. |
|---|---|---|---|---|---|---|---|
| GET | `/api/marketplace` | `page` (**1-based**), `limit` (50), `sort` ∈ {`ending_soon`, `recent`, `price_asc`, `price_desc`}, `q` (titre, catégorie, `snapshot_search_document` ; descriptions depuis le 2026-10-07 ; correspondance par préfixe assez large), `rarity` (répétable), `mine=1`, `card_id=<uuid>` (**filtre peu fiable** : renvoie aussi d'autres cartes) | — | `{ auctions: Auction[], hasMore: bool, total?: int }` (`total` vu par S et O en août, `hasMore` vu par T, E et F) | Avec `sort=ending_soon`, la liste commence par les enchères **terminées mais pas encore réglées** (statut toujours `active`) : il faut les filtrer. La liste ne contient pas de description. | S 2379-2423, 5162-5183 ; T `H:market-store.ts:153-191` ; E 298-306 ; R (ludomrn69 2885-3005) ; F (LeKenT1 357-375) ; O 2447-2455 | conf. |
| GET | `/api/marketplace?mine=1` | `page=1&limit=50&sort=recent&mine=1` | — | ⚠ `{ mine:true, selling: Auction[], history: Auction[] }` (T) ; `{ selling, bidding, won, history }` (E) ; anciennement `+ maxConcurrentAuctions` (R). Renvoyer **l'union** : `selling`, `bidding`, `won`, `history`. | Onglets Mes ventes, Mes enchères, Gagnées, Historique. Les lignes `settled_sold` donnent les ventes conclues. | T ; E 288-293, 307-310 ; R | conf. |
| GET | `/api/marketplace/mine` | — | — | `{ sellingCount: int, maxConcurrentAuctions: int }` (variantes snake_case `selling_count`/`max_concurrent_auctions` et enveloppe `{data:{…}}` sondées). ⚠ F (AndyB31 `market-sell.ts:40`) voit `{ auctions: [{id, card_id(user_card)}] }`. Avant août : `{ selling[], won[] (fenêtre glissante), history[] }`, où `won` porte `final_price`, `settled_at`, `snapshot_rarity`, `listing_base_amount`, `seller{username}`. | Rate-limité (429). Peut revenir sans ses champs en cas de surcharge. **Recommandation** : renvoyer `sellingCount`, `maxConcurrentAuctions` et `auctions` ensemble. | S 292-299, 4783-4866 ; E 312 ; R (ludomrn69 1428-1444) ; F ; O 307 | conf. |
| POST | `/api/marketplace` | — | `{ card_id: uuid, base_amount: int ≥ 1, duration_minutes: 10/30/60/180/360/720 (+1440 historique) }`. ⚠ **CONFLIT sur `card_id`** : en août, S et O envoient l'id **catalogue** (le serveur prend la copie la plus **ancienne** et ignore les étiquettes). E, R (AndyB31, ludomrn69) et F (LeKenT1) envoient l'id **`user_cards.id`**, et le formulaire natif porte `props.userCardId` (T). **Résolution probable** : depuis le 2026-08-19, `card_id` attend l'id de la copie, ce qui explique le rejet « Vous ne possédez pas cette carte » subi par les bots qui envoyaient l'id catalogue. **Pour la reconstruction** : accepter un id de copie, ou un id catalogue en repli (copie la plus ancienne non engagée). | `{ auction_id: uuid }` (201/200 ; E type `{id, end_at}`). Erreurs `{error}` : **409** « Limite de 10 enchères actives atteinte » (ou « limite de N atteinte »), **409** carte « déjà engagée dans un échange en attente », « Vous ne possédez pas cette carte ». | Après la création, l'UI navigue vers `/marketplace/{auction_id}`. La copie mise en vente **quitte la collection** (séquestre). Plusieurs mises en vente rapprochées déclenchent l'anti-bot (les bots attendent 45 s). | S 5228-5240, 5504-5515, 5647-5652 ; T `H:native-market.ts:178-208` ; E 316-320 ; R (AndyB31 `market-sell.ts:1-90`, ludomrn69 45-46, 1452-1455) ; F ; O 5358-5372 | conf. (forme) / prob. (sémantique) |
| GET | `/api/marketplace/{auctionId}` | — | — | `{ auction: Auction, bids?: [{amount, placed_at?/created_at?, bidder?: {username}}] }` ou l'objet nu (gérer les deux) ; 404 après retrait | Page `/marketplace/{uuid}`. Les bots l'interrogent en boucle (jusqu'à toutes les 150 ms). | S 4230-4239, 4884-4905 ; T `network.ts:120-136` ; E 324-327 ; R ; F ; O 4357-4366 | conf. |
| POST | `/api/marketplace/{auctionId}/bid` | — | `{ amount: int }` | 200 `{ current_bid: int, bidder_balance: int }` (R) ou `{ current_bid, end_at, balance? }` (E) : renvoyer les quatre champs. **409** `{ code:'bid_too_low', min: int }` (« Mise trop basse », message « … minimum N wikibidous »). **403** `human_verification_required`. | Environ 10 mises rapprochées verrouillent le marché du compte (mises, mises en vente **et** paquets) derrière une vérification humaine. On ne peut pas enchérir sur sa propre vente. | S 2926-2940, 1627-1638 ; E 330, 672-676 ; R (ludomrn69 95-99, 3125-3155) ; F (AndyB31 `bid-watch.ts:38-52,180-205`) ; O 3008-3020 | conf. |
| DELETE | `/api/marketplace/{auctionId}` | — | aucun | 2xx ; sinon erreur texte/JSON (« une enchère en cours ne peut pas être retirée ») | Annulation, possible **uniquement sans mise**. La carte revient comme **nouvelle ligne `user_cards` sans ses étiquettes**. | S 4986-5020, 5714-5731 ; E 333 ; O 5122-5130 | conf. |
| POST | `/api/marketplace/{auctionId}/settle` | — | aucun | — | Bouton « Finaliser la vente » destiné au vendeur ou au meilleur enchérisseur une fois l'enchère terminée. ⚠ Coexiste avec un règlement asynchrone côté serveur (§5.5). | E 331 ; `Market.tsx:212-216` | prob. |
| POST | `/api/marketplace/{auctionId}/reprice` | — | `{ new_base_amount: int }` | — | « Baisser le prix » : une seule fois, vendeur seulement, sans mise, après 50 % de la durée, nouveau prix ≤ floor(listing_base_amount / 2). | E 332 ; `Market.tsx:121-126,219-225` | prob. |
| GET | `/api/marketplace/cards/{cardId}/sales?scope=summary` | `cardId` = id **catalogue** | — | `{ summary: { C?: {average: number\|string\|null, count?: int}, PC?, R?, SR?, UR?, L? } }` ; 404 « Carte introuvable » | Prix moyen par rareté, sans distinction des brillantes. Affiché dans la boîte de vente sous la forme « Marché · <rareté> » (moyenne des **200** dernières ventes réglées selon F/AndyB31). ⚠ **Gratuit** selon T, « fonction Pro » selon R. Résolution : le résumé est gratuit, l'historique détaillé est Pro. | T `price-store.ts:236-249`, `price-model.ts:6-22` ; R (ludomrn69 821-827) ; F (AndyB31 `catalog.ts:205,279`) | conf. |
| GET | `/api/marketplace/cards/{cardId}/sales` | — | — | 200 `{ sales: [{id, rarity, final_price: int, settled_at: ISO, …}], recent?: [...] (plus récent d'abord) }` ; **non Pro → 403 `{code:'pro_required'}`** ; 401/403/404 possibles | « Vue du marché PRO » (onglet « Marché » marqué PRO dans la modale). T suppose ≤ 2 000 lignes sur 30 jours. S y accédait sans erreur, peut-être depuis un compte Pro. | T (commit 943a9b0 `price-store.ts:436-450`) ; S 703-733 ; F ; O 757-785 ; X (badge PRO) | conf. |
| GET | `rest/v1/auctions` | `select=id,card_id,seller_id,base_amount,listing_base_amount,current_bid,current_bidder_id,final_price,status,end_at,settled_at,winner_id,created_at,snapshot_rarity,is_shiny,card:cards(wikipedia_title,rarity,image_url)` ; filtres `seller_id=eq.`, `winner_id=eq./not.is.null`, `status=eq.active/eq.settled_sold/in.(…)`, `card_id=eq.`, `end_at=gt./gte.`, `id=in.(…)` ; `order=end_at.asc/settled_at.desc` | — | `AuctionRow[]` | La RLS permet à **tout utilisateur authentifié de lire toutes les enchères**. | S 6446-6656 ; R (AndyB31 `api.ts:170-345`) ; F ; O 6574-6585 | conf. |
| GET | `rest/v1/auction_bids` | `select=auction_id,amount,placed_at&bidder_id=eq.<me>&order=placed_at.desc` | — | `[{auction_id, bidder_id, amount, placed_at}]` | — | R/F (AndyB31 `api.ts:221`, BidRow) | conf. |

**Objet `Auction` fusionné** (union des champs, toutes sources) : `id` uuid · `card_id` (catalogue) · `user_card_id` · `seller_id` · `seller {id?, username}` · `buyer_id` ou `winner_id` · `current_bidder_id` · `current_bidder {username}|null` · `card {id, wikipedia_title, rarity, category, wikipedia_url, image_url, hide_image, atk?, def?}` · `snapshot_rarity` · `snapshot_atk` · `snapshot_def` · `snapshot_search_document` · `is_shiny` · `owned` (calculé pour l'observateur) · `base_amount` · `listing_base_amount` · `base_repriced_at` · `current_bid|null` (null = aucune mise) · `effective_bid` · `bids_count` ou `bid_count` · `final_price|null` · `status` · `end_at` · `created_at` · `settled_at|null`. Sources : S 6446-6454, T `market-model.ts:20-35`, E 239-258, R (AndyB31 `api.ts:160-185`, ludomrn69 2149-2167), F, O.

### 3.6 Échanges

| Méthode | Chemin | Params | Body | Réponse | Notes | Sources | Conf. |
|---|---|---|---|---|---|---|---|
| GET | `/api/trades` | `active=1` (facultatif) ; `count=1` vu dans une fixture (inc.) | — | `{ trades: Trade[] }` (liste unique, sans pagination) | Le client sépare actives (pending) et historique. | T `page-adapters.ts:30-43`, `H:collection-actions.ts:132-185` ; E 339-353, 380-385 ; R (AndyB31 `trades.ts:36-66`) ; F (TendersTroll `trade.js:71-75`) | conf. |
| GET | `/api/trades/{tradeId}` | — | — | `{ trade: {…} }`, `{data:…}` ou l'objet nu : `status`/`state`, `accepted_at?`, `completed_at?`, `closed_at?` | Forme exacte non confirmée. | S 11050-11067 ; R ; O 11214-11236 | prob. |
| POST | `/api/trades` | — | `{ recipient_id: uuid, items: [{user_card_id, card_id, offered_by}], initiator_wikibidous: int, recipient_wikibidous: int, parent_trade_id?: uuid }` + en-tête `x-wiki-calendar-tz` | `{ id }` (ou le JSON de l'échange) | Une contre-offre est un **nouvel** échange qui porte `parent_trade_id`. **Rien n'est séquestré** : la possession est revérifiée à l'acceptation. Un bot découpe par lots de 100 éléments. | E 386-392 ; F (TendersTroll `trade.js:107-112`) | prob. |
| PATCH | `/api/trades/{tradeId}` | — | `{ action: 'accept' / 'decline' / 'cancel' }` + `x-wiki-calendar-tz` | `{ status }` ; 4xx dont le texte contient already/déjà/accepted/not pending/invalid state ; **500** sur les gros échanges (> ~30 cartes, timeout de requête). Le rollback est complet selon S, mais l'opération est **peut-être commitée** selon R. | Acceptation **atomique** : toutes les cartes et tous les WB bougent dans une seule transaction. ⚠ Les fixtures montrent aussi `POST /api/trades/accept` (T) et `POST /api/trades/{id}/accept` (R, test) : c'est **PATCH** qui est réellement utilisé. | S 11080-11095, 11290-11305 ; E 393-394 ; R ; O 11240-11270 | conf. |
| POST/PATCH/DELETE | `rest/v1/trades` | filtres PostgREST | inconnu | inconnu | Écritures directes vues par T. Peut-être des lectures. | T `H:network.ts:67-79` | inc. |

**Objet `Trade` fusionné** : `id` · `status` · `initiator_id` · `recipient_id` · `initiator {id, username}` · `recipient {id, username}` · `initiator_wikibidous` int · `recipient_wikibidous` int · `parent_trade_id|null` · `created_at` · `updated_at?` · `accepted_at?` / `completed_at?` / `closed_at?` · `items: [{offered_by: uuid, card_id, user_card_id, snapshot_rarity?, is_shiny?, card?: {id, wikipedia_title, image_url, rarity}}]`. **Aucun champ message** sur wiki-masters (E le force à null). Sources : T, E 340-353, R, F.

### 3.7 Social : amis, profil, vitrine, messages, notifications, signalements

| Méthode | Chemin | Params | Body | Réponse | Notes | Sources | Conf. |
|---|---|---|---|---|---|---|---|
| GET | `/api/friends` | — | — | `{ friendships: [{id, status:'pending'/'accepted', requester_id, addressee_id, requester:{id,username,avatar_url}, addressee:{…}, created_at}] }` | Pas de présence en ligne dans ce payload. | E 421-449 ; F (TendersTroll `trade.js:13-19`) | conf. |
| GET | `/api/friends/search` | `q` (≥ 2 caractères) | — | `{ users: [{id, username, avatar_url?}] }` | — | E 395-398 ; F (`trade.js:24`) | conf. |
| POST | `/api/friends` | — | `{ addressee_id: uuid }` | amitié `pending` | Erreurs possibles : `ALREADY_FRIENDS`, `REQUEST_PENDING`, `FRIEND_LIMIT` (origine incertaine). | E 450-456 ; F (`trade.js:32`) ; `Social.tsx:17-21` | conf. |
| POST | `/api/friends/accept-all` | — | — | — | Bouton « Tout accepter ». | E 457 | prob. |
| PATCH | `/api/friends/{friendshipId}` | — | `{ action: 'accept' / 'decline' }` | — | — | E 458-465 | prob. |
| DELETE | `/api/friends/{friendshipId}` | — | — | — | Retirer sa demande ou supprimer un ami. | E 463, 466-471 | prob. |
| GET | `/api/profile/{username}` | — | — | `{ profile: {id, username, avatar_url?, is_public, created_at, bio?}, isOwn, isFriend, lastSeenAt? }` | Un profil privé est masqué, sauf pour soi-même et les amis. | E 474-508 | prob. |
| PATCH | `/api/profile/{username}` | — | `{ is_public?, bio? (≤ 280), avatar_user_card_id? }` | — | L'avatar est l'image d'une carte possédée, qui doit avoir une image et ne pas être en `hide_image`. | E 525-534 ; `Profile.tsx:132` | prob. |
| GET | `/api/profile/{username}/showcase` | — | — | `{ showcase: [{position: 0..3, user_card_id?, user_card: {id, card, is_shiny?}}] }` | — | E 431, 483, 500-506 | prob. |
| GET | `/api/showcase` | — | — | `{ showcase: [...], galleries: [] }` (fonction « galleries » inconnue) | 4 emplacements (`SHOWCASE_SLOTS=4`). | E 509-512, 427 | prob. |
| PUT | `/api/showcase` | — | `{ position, user_card_id }` | — | — | E 520 | prob. |
| DELETE | `/api/showcase` | — | `{ position }` (corps JSON sur un DELETE) | — | — | E 521 | prob. |
| GET | `/api/chat` | — | — | `{ conversations: [{peer_id, peer_username, peer_avatar_url, last_message, last_message_at, unread_count}] }` | — | E 537-540 | prob. |
| GET | `/api/chat/{peerId}` | — | — | `{ messages: [{id, sender_id, recipient_id, content, read: bool, created_at}] }` | — | E 541-545 | prob. |
| POST | `/api/chat/{peerId}` | — | `{ content }` (≤ 2 000 côté UI) | `{ message? }` | Erreur `FORBIDDEN` hors amitié (« Vous devez être amis… »). | E 550-553 | prob. |
| PATCH | `rest/v1/chat_messages?sender_id=eq.<peer>&recipient_id=eq.<me>&read=eq.false` | — | `{ read: true }` | — | Marque un fil comme lu (écriture directe). | E 546-548 | prob. |
| GET | `/api/notifications` | — | — | `{ notifications: [{id, type, data?: {title?, message?, card_title?, wikipedia_title?, auction_id?, trade_id?, battle_id?, guild_id?, guild_name?}, read?, created_at}] }` | Seul type confirmé : `auction_outbid`, données en snake_case. Les invitations de guilde sont des notifications `type ~ /guild/` portant `data.guild_id`. | E 557-560, 641 ; R/F (maximus49000 spec:43) | prob. |
| PATCH | `/api/notifications` | — | `{ ids: string[] }` ou `{}` (= tout marquer lu) | — | — | E 561 | prob. |
| GET | `/api/reports` | `reportedUserId` | — | `{ report: {reason?, details?} \| null }` | Un seul signalement par couple (auteur, cible), modifiable. | E 634 ; `Profile.tsx:722-731` | prob. |
| POST | `/api/reports` | — | `{ reportedUserId, reason: 'cheating'/'inappropriate_content'/'spam', details (≤ 500) }` | — | Libellés UI : Triche, Contenu inapproprié, Spam. | E 635 ; `Profile.tsx:737` | prob. |

### 3.8 Progression : succès et classement

| Méthode | Chemin | Body | Réponse | Notes | Sources | Conf. |
|---|---|---|---|---|---|---|
| POST | `/api/achievements/check` | `{ event: 'achievements_sync' }` | — | Réévaluation côté serveur, lente. Le client limite à 1 appel toutes les 5 min. | E 566-570 | prob. |
| POST | `/api/achievements/claim` | `{ achievement_id }` | `{ ok: true }` ; récompense créditée en WB | — | E 580-586 | prob. |
| GET | `rest/v1/achievements?select=*` et `rest/v1/user_achievements?select=achievement_id,claimed_at&user_id=eq.<me>` | — | `achievements: [{id, title, description, wikibidous_reward?, sort_order?}]` ; `user_achievements: [{achievement_id, claimed_at\|null}]` (ligne présente = débloqué ; `claimed_at` null = réclamable) | — | E 433, 563-579 | prob. |
| ? | classement des joueurs | — | — | **Aucune API connue.** E affiche « Le classement de wiki-masters est en maintenance ». | E 587 | inc. |

### 3.9 Batailles (source unique : E)

| Méthode | Chemin | Body | Réponse | Conf. |
|---|---|---|---|---|
| GET | `/api/battles` | — | `{ battles: Battle[], challenge_quota: {used, limit (3), resets_at} }` ; `Battle = {id, challenger_id, opponent_id, winner_id\|null, status, created_at, updated_at?, challenger:{id,username}, opponent:{id,username}, game_state?: GameState\|null}` | prob. |
| POST | `/api/battles` | `{ opponent_id }` | `{ battle: {id} }` ou `{ id }` | prob. |
| GET | `/api/battles/{id}` | — | `{ battle, decks?: [{user_id, card_ids: uuid[3]}] }` ; `GameState = {phase?: 'attack'/'quiz'/'over', players: {[userId]: {cardIds, usedCardIds?, currentHp, maxHp}}, currentTurnUserId?, turnNumber?, pendingAttack?: {attackerUserId?, defenderId?, attackCardId, attackCardName?, questions: [{id, prompt, options:[{id,text}]}], answered?: string[]}\|null, turnHistory: [{turnNumber?, attackerUserId?, defenderId?, attackCardId?, allCorrect, damageDealt, wrong?, total?}], winnerId?}` | prob. |
| PATCH | `/api/battles/{id}` | `{action:'accept'/'decline'/'withdraw_invite'/'forfeit'}` ou `{action:'submit_deck', card_ids:[3]}` ou `{action:'submit_attack', attack_card_id}` ou `{action:'submit_single_answer', questionId, answerId}` | `AnswerResult {correct?, correct_answer_id?, last_turn?, status?}` | prob. |

Pas de push : le client interroge toutes les 3 s dans l'arène et toutes les 15 s dans la liste (E `src/lib/battles.ts:7-47`, `Battle.tsx`).

### 3.10 Guildes (source unique : E, `src/native/Guild.tsx`)

| Méthode | Chemin | Body / params | Réponse | Conf. |
|---|---|---|---|---|
| GET | `/api/guilds` | — | `{ guild: {id, name, description?, leader_id?}\|null, membership: {guild_id, user_id, role:'leader'/…}\|null, member_count }` | prob. |
| POST | `/api/guilds` | `{ name (≤ 40), description? (≤ 280) }` | — | prob. |
| POST | `/api/guilds/join` | `{ guild_id }` | — | prob. |
| DELETE | `/api/guilds/invites/{guildId}` | — | refuser une invitation | prob. |
| GET | `/api/guilds/home` | — | `{ my_wishlist?: Wish\|null, wishlists?: Wish[], weekly_karma_donors?: [{user_id, username?, karma?, karma_this_week?, donations_this_week?}], received_donation_today?: bool }` ; `Wish = {id, user_id, card, can_donate?, recipient_received_today?, user?, recipient?}` | prob. |
| PUT / DELETE | `/api/guilds/wishlist` | PUT `{ card_id }` | une seule carte demandée à la fois | prob. |
| POST | `/api/guilds/wishlist/donate` | `{ wishlist_id, user_card_id }` | le receveur reçoit au plus 1 don par jour ; le donateur gagne du karma | prob. |
| GET | `/api/guilds/members` | `limit=50&offset=` | `{ members: [{user_id/id, username/profile.username/user.username, role?, joined_at?}], hasMore? }` | prob. |
| POST | `/api/guilds/invite`, `/kick`, `/transfer-leadership` | `{ user_id }` | invitation réservée aux amis ; kick et transfert réservés au chef | prob. |
| POST | `/api/guilds/leave` | — | le chef doit transmettre son rôle avant de partir s'il reste des membres | prob. |
| GET | `/api/guilds/chat` | — | `{ messages: [{id, user_id, content, created_at, username?/user?/profile?}] }` | prob. |
| POST | `/api/guilds/chat` | `{ content }` (≤ 1 000) | `{ message? }` | prob. |
| GET | `/api/guilds/leaderboard` | — | `{ entries: [{rank, guild_id, guild_name, member_count, score_battles, score_wb, total_score}], week_start, week_end, reset_in_ms, user_guild_id\|null }` | prob. |

### 3.11 Authentification (Supabase GoTrue)

| Méthode | Chemin | Body | Réponse | Notes | Sources | Conf. |
|---|---|---|---|---|---|---|
| POST | `https://<ref>.supabase.co/auth/v1/token?grant_type=password` | `{ email, password }` | session GoTrue | Connexion par e-mail et mot de passe uniquement. | T `network.ts:253-264` | conf. |
| POST | `…/auth/v1/token?grant_type=refresh_token` | `{ refresh_token }` | `{ access_token (JWT : sub, exp, email, user_metadata.username), refresh_token, expires_at, expires_in }` | **Un refresh token réutilisé révoque la session.** `user_metadata.username` reste souvent périmé après un renommage. | R (ludomrn69 1164-1211, 3417), S 2030-2066 | conf. |
| POST | `…/auth/v1/logout` | — | — | — | T `network.ts:55-61` | conf. |
| (signup) | GoTrue signup + OTP e-mail (6 à 12 chiffres), lien de vérification, reset | — | — | Turnstile. Aucun OAuth Google, Discord ou Twitch. | F, X | conf. |

### 3.12 Dépendances externes et assets

| Ressource | Usage | Sources | Conf. |
|---|---|---|---|
| `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/fr.wikipedia/all-access/user/{Titre_avec_underscores}/monthly/{YYYYMM0100}/{YYYYMM0100}` | Vues mensuelles servant à calculer la rareté. Le début et la fin doivent différer (sinon 400). Un 404 vaut 0 vue. | S 6730-6773, O 6886 | conf. |
| `https://fr.wikipedia.org/w/api.php?action=query&prop=pageprops&ppprop=wikibase_item\|page_image_free&redirects=1&titles=…` (≤ 50 titres) | L'image de la carte est l'**image principale** de l'article (pageimages). Le titre de la carte est le titre exact (parenthèses d'homonymie comprises). | X `frwiki-query.ts`, `PLAN.md:706` | conf. |
| `https://{lang}.wikipedia.org/api/rest_v1/page/summary/{Titre}` | Extrait (`extract`) affiché dans la modale. | E 229-235 | conf. |
| Description Wikidata (FR) | Texte court sous le titre (par ex. « commune italienne »), parfois absent. | X `PLAN.md:14-17` | conf. |
| `upload.wikimedia.org` (miniatures 330/500/960 px ; URLs `Special:FilePath` réécrites via un chemin md5 ; parfois relatives au protocole `//upload…`) | Images des cartes. | E, X, F, S 1430-1456 | conf. |
| `/_next/image?url=%2F<asset>.png&w={32…3840}&q=75&dpl=dpl_DNPLBnVgErVfS7KiJCmbWQk7i5uR` | Optimiseur next/image (protection contre le décalage de déploiement Vercel `dpl`). `sizes="(max-width: 768px) 160px, 288px"` ; `144px` pour le logo de remplacement. | X `DOM_NOTES.md:51` | conf. |
| Assets statiques | `/logo.png`, `/commun.png`, `/peu_commun.png`, `/super_rare.png`, `/ultra_rare.png`, `/legendaire.png` (observés), `/rare.png` (déduit) ; sons `/audio/pack-rip.mp3`, `/audio/card-flip.mp3`, `/audio/legendary-reveal.mp3`. ⚠ F devine `/common.png`, `/uncommon.png`… : les noms **observés** par X font foi. | X, F | conf. / prob. |
| `challenges.cloudflare.com` | Turnstile. | E | conf. |
| Stripe (web), Apple/Google IAP (CGU), FCM/Apple/Mozilla Web Push | Paiements et notifications push. | /privacy (R, F, O) | conf. |

---
## 4. Modèle de données inféré (ce que la migration doit préserver)

> Le backend d'origine est **Supabase Postgres** (ref `cyrxjeppjqsxxjayfrur`). Les noms de tables vus dans PostgREST sont certains. Les autres sont déduits des routes `/api/*`.
> **Recommandation** : reprendre **les mêmes noms de tables et de colonnes et les mêmes UUID**. Une restauration `pg_dump` devient alors directe et les outils tiers continuent de fonctionner.

### 4.1 Énumérations

| Enum | Valeurs | Sources | Conf. |
|---|---|---|---|
| `rarity` | `C` < `PC` < `R` < `SR` < `UR` < `L`. Libellés : Commune, Peu commune, Rare, Super rare, Ultra rare, Légendaire (⚠ la modale observée affiche « Commun » et « Ultra Rare » ; la capitalisation varie selon l'écran). Classes CSS en minuscules (`glow-c` … `glow-l`). Ordre des filtres : L, UR, SR, R, PC, C. | toutes ; X `rarity.ts`, fixtures ; E `rarity.ts:20-28` | conf. |
| `auction_status` | `active` (y compris après `end_at` tant que l'enchère n'est pas réglée), `settled_sold`, `settled_unsold`, `cancelled`. `expired` est toléré par un bot (inc.). | T `H:market-panel.ts:270-279`, R, F, O 6683-6705 | conf. |
| `auction_duration_minutes` | `10, 30, 60, 180, 360, 720`. ⚠ `1440` (24 h) existait en août (S 46, O) mais n'apparaît plus dans les UI de fin septembre à octobre (T, E, R, F). | voir §5.5 | conf. (6 valeurs) |
| `trade_status` | `pending`, `accepted`, `declined`, `cancelled`, `expired`, `countered`. Pastilles UI : EN ATTENTE, ACCEPTÉ, REFUSÉ, ANNULÉ, EXPIRÉ, CONTRE-OFFRE. Seuls Accepté et Refusé ont été vus dans le DOM réel. | E 340-353, `Trades.tsx` ; X `trades-list.html` | prob. |
| `trade_action` | `accept`, `decline`, `cancel` | E 393, S 11080 | prob. |
| `friendship_status` | `pending`, `accepted` (un refus supprime la ligne ou la passe à `declined` : inconnu) | E, F | prob. |
| `battle_status` | `pending`, `deck_selection`, `generating_quizzes`, `active`, `completed`, `cancelled` ; `phase` ∈ `attack`, `quiz`, `over` | E `src/lib/battles.ts:7-35` | prob. |
| `battle_action` | `accept`, `decline`, `withdraw_invite`, `forfeit`, `submit_deck`, `submit_attack`, `submit_single_answer` | E `Battle.tsx` | prob. |
| `guild_role` | `leader`, `member` (officier : inconnu) | E | prob. |
| `report_reason` | `cheating`, `inappropriate_content`, `spam` | E `Profile.tsx:712-745` | prob. |
| `notification_type` | Confirmé : `auction_outbid`. Probables : `auction_bid`, `auction_won`, `auction_sold`, `auction_unsold`, `trade_received`, `trade_countered`, `trade_accepted`, `trade_declined`, `trade_cancelled`, `friend_request`, `friend_accepted`, `guild_invite`, `guild_kicked`, `guild_donation`, `battle_invite`, `battle_accepted`, `battle_declined`, `battle_started`, `battle_attacked`, `battle_won`, `battle_lost`. Autres types évoqués : carte de la liste de souhaits mise en vente, message privé, succès, réserve de paquets pleine. | E `Shell.tsx:24-81` (inc. pour la casse), F (FCYPBA) | prob./inc. |
| `marketplace_sort` | `ending_soon`, `recent`, `price_asc`, `price_desc` | S, T, E, R, F | conf. |
| `collection_sort` | `rarity`, `obtained_at`, `added`, `name` (côté API) ; l'UI propose aussi ATK, DEF et favoris | S, T, F, X | prob. |

### 4.2 Entités et colonnes

#### `auth.users` (Supabase Auth)
| Champ | Type | Notes | Sources | Conf. |
|---|---|---|---|---|
| `id` | uuid | = `sub` du JWT, = `profiles.id`, = `user_id` partout | S 6000-6001, T, E | conf. |
| `email` | text | « courriel durable » exigé | R (/terms) | conf. |
| `encrypted_password` | bcrypt | **à importer tel quel** pour que les mots de passe restent valables | R, O | prob. |
| `email_confirmed_at` | timestamptz | vérification par OTP et lien | F | conf. |
| `raw_user_meta_data.username` | text | souvent périmé après un renommage, donc la source de vérité est `profiles.username` | S 2030-2066, R 3417 | conf. |
| identités | email seulement | aucun OAuth vu | F | prob. |

#### `profiles`
| Champ | Type | Notes | Sources | Conf. |
|---|---|---|---|---|
| `id` | uuid PK → `auth.users.id` | — | T, E | conf. |
| `username` | text, **unique** | 3 à 24 caractères, comparaison insensible à la casse ; s'affiche publiquement (vendeur, enchérisseur) | F (TendersTroll 596-605), S | conf. |
| `avatar_url` | text\|null | — | E | prob. |
| `avatar_user_card_id` | uuid → `user_cards` | l'avatar est l'image d'une carte possédée | E 525-534 | prob. |
| `bio` | text ≤ 280 | — | E | prob. |
| `is_public` | bool | profil public ou réservé aux amis | E | prob. |
| `created_at`, `last_seen_at` | timestamptz | « depuis <mois année> », `lastSeenAt` | E | prob. |
| `is_pro`, `is_vip` | bool | différence inconnue | E 86-97, R | prob. |
| `pack_cap` | int, défaut 10 | colonne par profil | E 92 | conf. |
| `packs_remaining` | int | stock de paquets | E, R, T | conf. |
| `packs_last_regen_at` | timestamptz\|null | base de la régénération paresseuse | E, F | conf. |
| `wikibidous_balance` | int | solde (le stockage exact, colonne ou grand livre, n'est pas confirmé) | E 86-97 | prob. |
| `activity_blocked_until`, `packs_blocked_until` | timestamptz | blocages anti-abus | F (LeKenT1 2444-2452) | prob. |
| état de vérification humaine | ? | dernière validation Turnstile (validité 12 h jusqu'au 2026-10-01) | F | inc. |
| préférences, notifications, filtre sensible, `tier`, `role`, `hide_sensitive`, `username_change_available_at`, `lang` | ? | ces champs viennent peut-être de l'ancien serveur de l'auteur d'E | E `account.ts`, F (privacy) | inc. |
| références Stripe (customer, subscription) | ? | emplacement inconnu | O, R | inc. |

#### `cards` (catalogue : une ligne par article, environ 2,77 M)
| Champ | Type | Notes | Sources | Conf. |
|---|---|---|---|---|
| `id` | uuid | **stable même quand la rareté change** | S CHANGELOG 148-150 | conf. |
| `wikipedia_title` | text | titre exact de fr.wikipedia, clé de résolution (unique par langue) | toutes | conf. |
| `wikipedia_url` | text | `https://fr.wikipedia.org/wiki/<titre encodé>` | S, E, X | conf. |
| `lang` | text, défaut `'fr'` | — | E 11 | prob. |
| `rarity` | rarity | **rareté courante, modifiable** : recalculée en différé à partir des vues | S 6716-6728, R, O | conf. (⚠ E affirme que les cartes ne changent jamais) |
| `atk`, `def` | int | ATK dérivée de la longueur de l'article, DEF de sa qualité. Plafond normal 10 000 | F (landing), X fixtures | conf. |
| `q_score` | numeric (2 décimales) | « Q-Score » affiché (14,17 ; 40,35 ; 51,24) | S, E, X | conf. |
| `pageviews` | int | vues mensuelles affichées (« Vues (30j) : 6 974 ») | S, E, X | conf. |
| `pageviews_refreshed_at`, `qscore_refreshed_at` | timestamptz | date du dernier recalcul | S 6776-6780, O | conf. |
| `category` | text\|null | sous-titre (description Wikidata FR, par ex. « animatrice de télévision française ») | toutes | conf. |
| `summary` | text | extrait de l'article (intro sur plusieurs paragraphes) | S 5641, F, O | conf. |
| `description` | text? | recherchée par le marché depuis le 2026-10-07 (peut-être = `category` ou `summary`) | F | inc. |
| `image_url` | text\|null | miniature 330 px de upload.wikimedia.org, parfois relative au protocole. Absente sur environ 17 % des cartes du marché (7/41) et 24 % des L (12/50) | S, X `PLAN.md` | conf. |
| `image_position` | CSS object-position ? | par ex. `center 28%`, point focal par carte | X | inc. |
| `hide_image` | bool | image sensible masquée (un emblème la remplace) | S, T, E, F, O | conf. |
| `nsfw_image` | bool | — | F (Lypningeuh) | prob. |
| `is_shiny` | bool? | présent dans certains payloads catalogue (probablement par copie seulement) | T `cards.ts`, R | inc. |
| `created_at` | timestamptz | — | R | prob. |
| *(colonnes de stats)* | — | compte par rareté affiché en jeu | X | conf. |

#### `user_cards` (copies possédées)
| Champ | Type | Notes | Sources | Conf. |
|---|---|---|---|---|
| `id` | uuid | = `user_card_id` = `item.id` de `my-collection` = clé React des tuiles | S, T, E | conf. |
| `user_id` | uuid → profiles | — | T, E, F | conf. |
| `card_id` | uuid → cards | — | toutes | conf. |
| `count` | int ≥ 1 | ⚠ **CONFLIT** : S et O disent que les doublons sont des lignes séparées ; E dit que les doublons s'empilent dans `count`, une ligne par (user, carte, brillant) ; F dit « généralement 1 par ligne ». L'UI affiche « Exemplaires : 1 » et « xN ». **Migration : copier `count` tel quel et ne jamais dédoublonner ni éclater les lignes.** | S CHANGELOG 750-756, E 167-200, F | conf. (colonne) |
| `starred` | bool | favori (étoile) | T, E, R, F, X | conf. |
| `is_shiny` | bool | variante brillante, **propre à la copie** | T, E, R, F | conf. |
| `snapshot_title`, `snapshot_rarity`, `snapshot_category` | text / rarity | figés **au tirage** | R/F (AndyB31 `api.ts:375-386`) | conf. |
| `snapshot_atk`, `snapshot_def` | int | figés au tirage | R (maximus49000 spec:49) | prob. |
| `obtained_at` (alias `created_at`) | timestamptz | trie la collection et sert aux bots pour leur reprise incrémentale | S 2183-2205, E | conf. |
| relation `user_card_tags(tag_id)` | — | — | S, E | conf. |

Une mise en vente puis une annulation ou une invendue **recrée une nouvelle ligne** (nouvel `id`, sans étiquettes) (S 5728-5731, 7121-7124).

#### `tags` et `user_card_tags`
| Table | Champs | Contraintes | Sources | Conf. |
|---|---|---|---|---|
| `tags` | `id` uuid, `user_id` uuid, `name` text ≤ 48 (`maxlength=48`), `color` `#rrggbb`\|null (le DOM montre `rgba(45,212,191,0.22)` en fond et `0.5` en bordure) | unique (user_id, name) dans les faits ; suppression → cascade | S 31-32, 6026-6155 ; E 139-151 ; X ; R ; F | conf. |
| `user_card_tags` | `user_card_id` → user_cards, `tag_id` → tags | **PK ou UNIQUE (user_card_id, tag_id)** (doublon → 409/23505) | S 6248-6258, R, F | conf. |

**À préserver** : l'étiquette spéciale `[LOCKED]` (couleur `#fb7185`) que l'extension Enhanced utilise comme verrou, et toutes les étiquettes commençant par `[` (masquées dans son UI). Elles vivent dans les vraies données (E 128-189).

#### `wishlist_items`
`user_id`, `card_id` (catalogue), `created_at` ; unique (user_id, card_id). Sources : S 11134-11156, E 617-625, F. conf. La liste de souhaits de guilde est une table distincte (§ guildes).

#### `auctions`
| Champ | Type | Notes | Sources | Conf. |
|---|---|---|---|---|
| `id` | uuid | DOM `#marketplace-auction-<uuid>` | toutes | conf. |
| `seller_id` | uuid | — | S, T, R, F, O | conf. |
| `card_id` | uuid → cards | jointure PostgREST possible | S, R, F | conf. |
| `user_card_id` | uuid | copie mise en vente (séquestre) | T, R | prob. |
| `snapshot_rarity` | rarity | **rareté figée à la mise en vente, c'est celle qui est affichée** | S CHANGELOG 286-295, T, R, F, O | conf. |
| `snapshot_atk`, `snapshot_def`, `snapshot_search_document` | int, int, text | recherche plein texte | R (maximus49000 spec:48) | prob. |
| `is_shiny` | bool | — | T, E, R, F | conf. |
| `base_amount` | int | prix de départ **courant** (peut être baissé) ; 0 dans certains payloads | S, T | conf. |
| `listing_base_amount` | int | prix de départ **d'origine** | S, E, O | conf. |
| `base_repriced_at` | timestamptz\|null | une seule baisse autorisée | E | prob. |
| `current_bid` | int\|null | null = aucune mise | toutes | conf. |
| `current_bidder_id` | uuid\|null | — | S, R, F, O | conf. |
| `effective_bid` | int | prochain minimum ? valeur effective ? sémantique à confirmer | E, R | inc. |
| `bids_count` / `bid_count` | int | — | E | prob. |
| `end_at` | timestamptz | **prolongeable** (anti-snipe) | toutes | conf. |
| `status` | auction_status | — | voir enum | conf. |
| `winner_id` | uuid\|null | aussi `buyer_id` (privé) | S, T, R, F | conf. |
| `final_price` | int\|null | > 0 si vendue | S, T, R, F | conf. |
| `settled_at` | timestamptz\|null | — | S, R, F | conf. |
| `created_at` | timestamptz | — | S, E, R | conf. |

#### `auction_bids`
`auction_id`, `bidder_id`, `amount` int, `placed_at` timestamptz (+ `id` probable). Sources : R/F (AndyB31 `api.ts:155-159,221`), E (`bids[]` du détail). conf.

#### Portefeuille et grand livre (wikibidous)
Solde exposé par `GET /api/wikibidous` et par `profiles.wikibidous_balance` (E). Les mouvements connus sont : défausse +1, succès +N, mise réservée (débit) puis remboursement en cas de surenchère, produit d'une vente, WB inclus dans un échange (des deux côtés), achat Stripe (2 500 WB), récompenses de bataille (+50/+10, inc.), donations ? **Aucun grand livre n'a été observé** (inc.). La reconstruction doit en créer un (voir §9).

#### `trades` et `trade_items`
| Table | Champs | Sources | Conf. |
|---|---|---|---|
| `trades` | `id`, `status` trade_status, `initiator_id`, `recipient_id`, `initiator_wikibidous` int, `recipient_wikibidous` int, `parent_trade_id` uuid\|null (chaîne de contre-offres), `created_at`, `updated_at`, `accepted_at`/`completed_at`/`closed_at` (probables), `expires_at` (probable, délai inconnu) | E 340-353, T, R, F, S 11032-11100 | prob. |
| `trade_items` | `trade_id`, `offered_by` uuid (côté qui offre), `user_card_id`, `card_id`, `snapshot_rarity`, `is_shiny` | E, F (TendersTroll 107-112), T | prob. |

#### Social
| Table | Champs | Sources | Conf. |
|---|---|---|---|
| `friendships` | `id`, `requester_id`, `addressee_id`, `status`, `created_at` | E 421, F (TendersTroll 13-45) | prob. |
| `chat_messages` (messages privés) | `id`, `sender_id`, `recipient_id`, `content` (≤ 2 000), `read` bool, `created_at` | E 544-547 (nom de table vu dans PostgREST) | conf. |
| `notifications` | `id`, `user_id`, `type`, `data` jsonb, `read` bool (ou `read_at`), `created_at` | E 557-561 | prob. |
| `push_subscriptions` | `user_id`, `endpoint`, clés (p256dh/auth), appareil, préférences partagées | F (/privacy) | prob. |
| vitrine (`showcase`) | `user_id`, `position` 0..3, `user_card_id` ; « galleries » inconnu | E 427, 509-524 | prob. |
| `reports` | `reporter_id`, `reported_user_id`, `reason`, `details` (≤ 500), unique (reporter, reported) | E | prob. |
| signalement d'image | `user_id`, `card_id` (bouton « Signaler l'image », `aria-pressed`, parfois désactivé) | X | prob. |

#### Progression
| Table | Champs | Sources | Conf. |
|---|---|---|---|
| `achievements` | `id`, `title`, `description`, `wikibidous_reward`, `sort_order` (+ `category`, `threshold` probables) | E 433, 563-579 | conf. (nom de table) |
| `user_achievements` | `user_id`, `achievement_id`, `claimed_at`\|null | E | conf. (nom de table) |
| batailles | `battles` : `id`, `challenger_id`, `opponent_id`, `winner_id`, `status`, `game_state` jsonb, `created_at`, `updated_at` ; decks : `user_id`, `card_ids` uuid[3] ; quota quotidien : `used`, `limit`, `resets_at` | E `battles.ts` | prob. |
| guildes | `guilds` : `id`, `name` ≤ 40, `description` ≤ 280, `leader_id`, `created_at` ; `guild_members` : `guild_id`, `user_id`, `role`, `joined_at` ; invitations (envoyées par notification) ; liste de souhaits de guilde : `id`, `user_id`, `card_id` (1 par membre) ; dons : `wishlist_id`, donateur, `user_card_id`, date → karma ; chat : `id`, `guild_id`, `user_id`, `content` ≤ 1 000, `created_at` ; scores hebdomadaires : `score_battles`, `score_wb`, `total_score`, saison (« S38 », « S39 »), meilleur score et meilleur rang | E `Guild.tsx`, R/F (jvflux) | prob. |
| paquets spéciaux / Pro du jour / grâce | définitions des paquets spéciaux ; réclamation quotidienne (user, date dans le fuseau du joueur) | E, F | inc. |

#### Paiements et modération
| Entité | Champs | Sources | Conf. |
|---|---|---|---|
| paiements et abonnements | identifiants Stripe (paiement, commande, customer, subscription) ; produits : Pro mensuel (9,99 CAD), 2 500 WB (4,99 CAD), recharges de paquets ; reçus IAP Apple/Google (aucun pour l'instant). Aucun numéro de carte stocké. | /privacy, /terms (R, F, O) | prob. |
| sanctions | avertissement, contenu masqué, actions restreintes, suspension, bannissement définitif, rollback de progression, retrait d'objets | /rules, /terms | conf. (règles) / inc. (schéma) |
| parrainage (`parrainage`) | mentionné dans les règles anti-manipulation | O | inc. |
| concours | « concours réguliers » | F, O | inc. |

### 4.3 Relations principales

```
auth.users 1─1 profiles
profiles 1─N user_cards N─1 cards
user_cards 1─N user_card_tags N─1 tags N─1 profiles
profiles 1─N wishlist_items N─1 cards
profiles(seller) 1─N auctions N─1 cards ; auctions ─1 user_cards (copie en séquestre) ; auctions 1─N auction_bids N─1 profiles(bidder)
trades N─1 profiles(initiator), N─1 profiles(recipient) ; trades 1─N trade_items ─1 user_cards ; trades ─0..1 trades(parent_trade_id)
friendships (requester, addressee) ; chat_messages (sender, recipient) ; notifications N─1 profiles
showcase (user, position) ─1 user_cards ; profiles.avatar_user_card_id ─1 user_cards
achievements 1─N user_achievements N─1 profiles
battles (challenger, opponent, winner) ; decks ─3 cards/user_cards
guilds 1─N guild_members N─1 profiles ; guild wishlists, donations, chat, weekly scores
```

### 4.4 Colonnes « sacrées » pour la non-régression
Les éléments suivants ne doivent **jamais** être recalculés pendant la migration :
- tous les **UUID** (cartes, copies, enchères, échanges, utilisateurs) ;
- `user_cards.snapshot_*`, `is_shiny`, `count`, `starred`, `obtained_at` ;
- `auctions.snapshot_rarity`, `listing_base_amount`, `end_at`, `current_bid`/`current_bidder_id` ;
- les soldes de WB **et** les montants réservés ;
- `packs_remaining` et `packs_last_regen_at` ;
- `user_achievements.claimed_at` (sinon les récompenses peuvent être réclamées deux fois) ;
- les liaisons entre étiquettes et copies ;
- `profiles.username`.

---

## 5. Règles du jeu et constantes

### 5.1 Paquets

| Règle / constante | Valeur | Conf. | Sources / conflits |
|---|---|---|---|
| Taille d'un paquet | **5 cartes** | conf. | S 1915-1930, T `network.ts:115-117`, E, X, R, F, O, presse |
| Régénération gratuite | 1 paquet toutes les **600 s (10 min)**, aussi hors ligne | conf. | presse (next.ink, clubic, outilstice), S 8252, E `account.ts:56-57`, F (ThePommespanzer `common.js:38-46`), X (comptes à rebours < 10:00) |
| Régénération Pro/VIP | **180 s (3 min)** | prob. | S, E, F, O, Echoes of Geeks. Aucune constante serveur lue directement. |
| Réserve maximale | **10** (`pack_cap`, colonne par profil, défaut 10 ; UI « n / 10 ») | conf. | E 92, X, R (Astata) ; Pro 15 = clone (inc.) |
| Calcul | `prochain = packs_last_regen_at + période`, appliqué paresseusement à la lecture (`sync_profile_packs`) | conf. | E 91-97, R |
| Premier paquet | disponible dès l'inscription ; « 10 paquets de départ » vient seulement du clone | prob. / inc. | O (outilstice), F |
| Révélation | une carte à la fois (« Carte n / 5 »), **meilleure carte en dernier**. Paliers d'animation SR, UR et L, cinématique dédiée pour L avec un son. Badge « Nouvelle » sur une première copie. Doublons possibles dans un même paquet. « Encore N cartes » reste bloquant tant que tout n'a pas été vu. | prob. | F (Lypningeuh), T `pulls-model.ts:177`, X |
| Limite courte | `rate_limited` + `retry_after` (valeur inconnue). Le toolbox attendait jusqu'à 120 s. Des ouvertures à quelques secondes d'intervalle déclenchent la vérification humaine (les bots espacent de 12 s ; délai humain 1,2 à 3 s chez S). | conf. (mécanisme) | T, R, S |
| Limite quotidienne | `rate_limit_daily` (« Limite quotidienne de paquets atteinte »), valeur inconnue | conf. (mécanisme) | T `H:packs.ts:362-381` |
| Vérification humaine | Turnstile obligatoire avant d'ouvrir (403 sinon), redemandée toutes les 12 h jusqu'au 2026-10-01 | conf. | T, E, F |
| Paquet Pro du jour | 1 par jour calendaire dans le fuseau du joueur, **15 cartes, aucune commune** (texte de l'UI d'E) | prob. / inc. (taille) | E `Booster.tsx:285-327`, F |
| Paquets spéciaux et « grâce » | réclamés par `packId` ; sémantique inconnue | inc. | E, F |
| Cotes de rareté | **Non publiées** par wiki-masters.com. E affiche « C 55 %, PC 25 %, R 12 %, SR 5,5 %, UR 2 %, L 0,5 % » (peut-être hérité de l'ancien serveur de l'auteur : inc.). Taux « observés » L ≈ 0,0635 % et UR ≈ 0,446 % (O). **Ces taux sont exactement la part de L et d'UR dans le catalogue** (1 760 / 2,77 M et 12 374 / 2,77 M), ce qui suggère un **tirage uniforme sur le catalogue** (hypothèse à valider). Pro améliore les cotes, d'une ampleur inconnue (presse). | inc. | E `Booster.tsx:25,237`, O, wikicollector |
| Brillante (shiny) | Drapeau `is_shiny` par copie, indépendant de la rareté (T : libellé « Brillante »). ⚠ **CONFLIT sur le taux** : E affiche « 1 brillante sur 100 » sur la bannière du booster (par carte ?) ; la presse dit « 1 % des Légendaires tirées d'un paquet », avec une teinte **noire** à la place de l'or et des stats fixes de 10 001 à 15 000 (ce dernier point vient du clone, inc.). Aucune brillante n'apparaît dans les fixtures de X. | conf. (drapeau) / inc. (taux) | T `cards.ts:34`, E, R, F, X |

### 5.2 Rareté et statistiques des cartes

| Règle | Valeur | Conf. | Sources / conflits |
|---|---|---|---|
| Seuils (vues humaines mensuelles de l'article fr.wikipedia) | **C < 50 · PC ≥ 50 · R ≥ 250 · SR ≥ 1 000 · UR ≥ 5 000 · L ≥ 20 000** | conf. | Lus dans la modale « Comment ça marche ? » du jeu le 2026-09-21 (X `PLAN.md:612`) ; S 6716-6728 ; R (MaKSiiMe `rarity.py`) ; F ; O ; presse. ⚠ Les bandes d'E (L ≥ 250 k, UR 80–250 k…) et l'échelle de WikiCollector (L = 100 k) sont **contredites**. |
| Fenêtre de calcul | « Vues (30j) » dans la modale (X) et mois civil précédent via l'API Wikimedia (S). **Non tranché** (30 jours glissants ou mois précédent). Le jeu est en retard sur Wikimedia (« Chat » : 22 227 affichées contre 25 724 sur 30 j). | inc. | X, S, R |
| Recalcul | `cards.rarity` est **recalculée en différé** (`pageviews_refreshed_at`), donc une carte peut changer de palier (par ex. UR → L). Chaque copie, enchère et élément d'échange garde **`snapshot_rarity`**, si bien qu'on peut posséder la même carte dans deux raretés. Les ventes sont regroupées par rareté. | conf. | S CHANGELOG 314-356, T, R, F, O. ⚠ E affirme « données de carte immuables » : contredit. |
| Variante d'une carte | La clé est (`card_id`, `rarity`, `is_shiny`) | conf. | T `cards.ts:38-42`, F |
| ATK / DEF | **ATK vient de la longueur de l'article, DEF de sa qualité (`q_score`).** Formule non publiée. Valeurs observées : C 1 619–1 673 / 3 082–3 096 ; PC 3 483 / 5 534 ; UR 8 663 / 6 694 ; L 7 727–10 000 / 3 645–9 234. Plafond normal **10 000** (une carte 10 000/10 000 a été signalée). Brillante 10 001–15 000 (inc.). Le clone dit « la meilleure stat est dans la fourchette de sa rareté et l'autre vaut au moins 50 % » : inc. | conf. (principe) / inc. (formule) | F (landing), X fixtures, R (manette-actu), O |
| Q-Score | flottant à 2 décimales (14,17 pour une C ; 51,24 pour une UR) ; sémantique exacte inconnue (WikiRank ?) | conf. (affichage) | X |
| Affichage des nombres | fr-FR avec espace fine comme séparateur de milliers (« 6 031 », « 1 234 wikibidous ») | conf. | X, F, O |
| Contenu de la carte | Titre = titre exact de l'article. Image = image principale de l'article, sinon le logo (`/logo.png`, `opacity-70`). Texte court = description Wikidata FR. Modale = extrait d'introduction. Licence : « Texte de l'article : CC BY-SA 4.0 — crédits sur la page Wikipédia. » | conf. | X `PLAN.md:14-17,706` |

### 5.3 Économie (wikibidous)

| Règle | Valeur | Conf. | Sources |
|---|---|---|---|
| Défausse | **+1 WB par copie, quelle que soit la rareté**, irréversible. Unitaire ou en masse (≤ 50 par requête). Pas de limite de taille de collection. | conf. | X (bouton « +1 »), R, F, E, presse (clubic, numerama) |
| Succès | Récompense en WB réclamée **à la main**, une seule fois. **51 succès** (43 chez le clone). | prob. | R, F (rotek), E |
| Batailles | Gagnant +50 WB, perdant +10 WB | inc. | R, F (forum jvc p.198) |
| Ventes aux enchères | Le vendeur reçoit `final_price`. **Aucune commission ni frais d'annonce documentés.** | inc. (frais) | S, R, F, O |
| Réservation des mises | Le montant est réservé, puis remboursé en cas de surenchère. Il faut un solde suffisant. | prob. | S 1695-1712, R (`bidder_balance`), F (Lypningeuh « les 10 WB ont été remboursés »), E |
| Achats | **2 500 WB = 4,99 CAD** (Morandini : 3 €) ; « recharges de paquets ». Paiement Stripe (carte). | prob. | next.ink, blick, /privacy |
| Valeur | Les biens virtuels n'ont **aucune valeur monétaire** et sont non échangeables contre de l'argent. Un achat est définitif et non remboursable une fois crédité. Le RMT est interdit (sites tiers wiki-market.com, wikitroc.com). | conf. | /terms, /rules |
| Prix suggéré | La boîte de vente propose 10 WB par défaut. La référence « Marché · rareté » est la moyenne des 200 dernières ventes de cette carte dans cette rareté. | prob. | F (Lypningeuh, AndyB31 `catalog.ts`) |

### 5.4 Abonnement Pro

| Élément | Valeur | Conf. | Sources |
|---|---|---|---|
| Prix | **9,99 CAD/mois** (≈ 6,50 € ; la presse française dit environ 7 €/mois) ; Stripe sur le web ; IAP prévus dans les CGU | prob. | next.ink, clubic, morandini, /terms |
| Drapeaux | `profiles.is_pro`, `is_vip` (différence inconnue) | prob. | E, R |
| Avantages | Paquets toutes les 3 min (prob.) ; paquet Pro du jour (prob.) ; **meilleures cotes de rareté** (presse) ; **plus de batailles et d'enchères par jour** (presse) ; **10 ventes simultanées au lieu de 5** (prob.) ; « Vue du marché PRO », c'est-à-dire l'historique des ventes par carte, avec 403 `pro_required` sinon (conf.) ; onglet « Marché » de la modale marqué PRO (conf.) ; statistiques de rareté supplémentaires ; boutique de cosmétiques Pro annoncée ; cadre de profil doré (clone, inc.). Réserve agrandie : inconnu. | voir colonne | T, X, E, F, R, O |

### 5.5 Enchères

| Règle | Valeur | Conf. | Sources / conflits |
|---|---|---|---|
| Création | Sur une **copie précise** que l'on possède, ni déjà en vente ni engagée dans un échange en attente (409). La copie quitte la collection pendant la vente. Si l'API reçoit un id catalogue, le serveur prend la copie la plus **ancienne** (comportement d'août). | conf. | S, T, E, R, F, O |
| Prix de départ (« Mise de départ ») | entier ≥ 1 WB | conf. | S 5196, T `H:market-model.ts:119-125`, E, R |
| Durées | **10 min, 30 min, 1 h, 3 h, 6 h, 12 h** (défaut UI 1 h). ⚠ **CONFLIT** : S et O (août, lignée Sephiroth) ont aussi un bouton « 24 h » (1440). T, E, R (AndyB31 `duration.ts:3-11`) et F (fin sept. à oct.) s'arrêtent à 12 h. **Résolution** : 24 h a été retiré ; garder 1440 comme valeur acceptée pour les données migrées, sans le proposer dans l'UI. | conf. (6 valeurs) | S 46, O 5327 contre T, E, R, F |
| Ventes simultanées | `maxConcurrentAuctions` côté serveur, 409 au-delà (« Limite de N enchères actives atteinte »). ⚠ **CONFLIT** : 10 observé (S, août) ; 5 observé (R ; F fixture « Mes ventes (2/5) » du 2026-10-03) ; le README du bot dit **5 gratuit / 10 abonné** (le clone dit 10/20 : inc.). **Résolution** : 5 en gratuit et 10 en Pro, piloté par le serveur. | prob. | S CHANGELOG 484-494, R, F, O |
| Première mise | ≥ `base_amount` | conf. | S, E, F, R |
| Mise suivante minimale | ⚠ **CONFLIT de formule** : `ceil(cur × 1,1)` (S, O) ; `max(ceil(cur × 1,1), cur + 1)` (E 260, F Lypningeuh) ; `cur + floor(cur / 10) + 1` (R ludomrn69 : 5→6, 27→30, **100→111**). Les deux premières donnent 110 pour 100, la troisième 111. **Résolution** : le serveur fait foi et renvoie `min` dans l'erreur 409 `bid_too_low`. Retenir `max(ceil(cur × 1,1), cur + 1)` (la formule la plus partagée) et **exposer `min_next_bid`** dans la réponse, puis valider sur un cas réel à 100. | prob. | S 1627-1638, E, R 1052-1062, F |
| Anti-snipe | Une mise placée à **moins de 10 s de la fin** repousse `end_at` d'**1 min**, de façon répétable | prob. | S 2481-2485, 4330-4336 ; E `snipe.ts:3-4` ; R ; F. ⚠ O pensait que `end_at` était fixe. |
| Auto-enchère | Interdite (snipe et bots d'auto-enchère interdits par les règles) ; on ne peut pas surenchérir utilement sur soi-même | conf. | /rules, S |
| Annulation | Par le vendeur, **seulement sans mise**. Statut `cancelled`. La carte revient comme nouvelle copie **sans étiquettes**. | conf. | S, E, O |
| Baisse de prix | Une fois, après 50 % de la durée, sans mise, nouveau prix ≤ floor(listing_base_amount / 2) | prob. | E `Market.tsx:121-126` |
| Règlement | La meilleure mise à `end_at` l'emporte. **Règlement asynchrone** : le statut reste `active` après `end_at`, puis passe à `settled_sold` (`winner_id`, `final_price`, `settled_at`) ou `settled_unsold` (la carte retourne au vendeur). La carte arrive chez le gagnant environ 1 à 2 min après la fin. « En tête » puis « Remportée » une fois confirmé. ⚠ E ajoute `POST /settle` (« Finaliser la vente ») pour le vendeur ou le meneur, ce qui suggère un règlement paresseux plus un job. **Reconstruction** : job planifié **et** règlement à la demande, idempotents. | conf. (statuts) / prob. (mécanisme) | S CHANGELOG 695-700, R (ludomrn69 104-108), F (AndyB31 `bidStatus`), E |
| Historique public | Ventes par carte (`final_price`, `settled_at`) ; le résumé par rareté est gratuit, le détail est Pro | conf. | T, S |
| Anti-bot du marché | Environ 10 mises rapprochées, des mises en vente enchaînées ou des ouvertures rapprochées renvoient 403 `human_verification_required`, ce qui verrouille **ensemble** mises, mises en vente et paquets (pas la défausse) | conf. | R (ludomrn69 64-94) |
| Onglets | Parcourir · Mes ventes (n/5) · Mes enchères (en tête, surenchéri, gagnée, perdue, annulée) · Gagnées · Historique | conf. | F, E |

### 5.6 Échanges

| Règle | Valeur | Conf. | Sources |
|---|---|---|---|
| Qui | **Entre amis uniquement** (amitié acceptée) | prob. | /privacy, F, R, O |
| Contenu | Des copies précises **et** des WB de chaque côté. Au moins 1 élément. Au plus **100 cartes et 10 000 WB par côté** (E `lib/trades.ts`, recoupé par le bot TendersTroll qui découpe par 100). Champs WB limités à 5 chiffres dans l'UI. Des échanges 1↔1 et 1↔4 ont été vus. | prob. | E, F, X |
| Contre-offre | Nouvel échange portant `parent_trade_id`, statut `countered` | prob. | E, R, F |
| Actions | Le destinataire accepte ou refuse, l'initiateur peut annuler. Statut `expired` (délai inconnu ; 48 h vient du clone). | prob. | E, X |
| Verrous | Les copies d'un échange en attente ne peuvent être **ni vendues ni défaussées**. Le verrou s'applique au niveau `card_id` : toutes les copies d'un `card_id` offert sont protégées. **Pas de séquestre** : la possession est revérifiée à l'acceptation. | prob. | T `H:collection-actions.ts:132-185`, E, S 409 |
| Atomicité | L'acceptation est une seule transaction. Au-delà d'environ 30 cartes, timeout et 500 ; le commit est possible selon R. | conf. | S, O, R |
| Limites quotidiennes | inconnues (50/100 offres par jour : clone) | inc. | — |
| Message | Aucun champ message côté officiel. Un bouton « Message à <pseudo> » mène aux messages privés. | conf. | E, X |

### 5.7 Batailles (quiz)

| Règle | Valeur | Conf. | Sources |
|---|---|---|---|
| Lancement | On défie un **ami**. Le défi doit être accepté sous 24 h (sinon il expire). Un joueur inactif depuis 2 jours perd. | prob. | E `Battle.tsx:33`, F |
| Deck | 3 cartes distinctes par joueur. **PV = somme des DEF.** | conf. | E (règles de l'UI), presse (echoesofgeeks), R, F |
| Tour | On attaque avec une carte pas encore utilisée. Le défenseur répond à un QCM **généré à partir de l'article de cette carte** (3 questions selon la plupart des sources, 4 dans un exemple), une réponse à la fois (`submit_single_answer` → `correct_answer_id`). **Dégâts = ATK × mauvaises réponses / nombre de questions** (0 si tout est juste). Les cartes connues ou rares ont de meilleures stats mais des questions plus faciles. | conf. (formule) / prob. (nombre de questions) | E `Battle.tsx:19-38`, R, F |
| Victoire | KO à 0 PV. Sinon, meilleur ratio PV restants / PV max, puis PV bruts, puis **le défenseur du dernier tour** gagne. | conf. | E, R, F |
| Quiz | Générés côté serveur (statut `generating_quizzes`) ; méthode inconnue (LLM ?) | prob. | E |
| Quota | **3 défis par jour** en gratuit (`challenge_quota`), plus en Pro | prob. | E, R, F, presse |
| Récompenses | +50 WB au gagnant, +10 WB au perdant ; +500 points pour la guilde du gagnant | inc. / prob. | R, F |

### 5.8 Guildes, social, progression

| Règle | Valeur | Conf. | Sources |
|---|---|---|---|
| Adhésion | Par invitation d'un membre, qui doit d'abord être ami (on donne son pseudo, on devient amis, on reçoit l'invitation) | conf. | E, R, F |
| Gouvernance | Le chef exclut et transfère son rôle ; il doit transférer avant de partir s'il reste des membres | prob. | E |
| Limites de texte | nom ≤ 40, description ≤ 280, chat ≤ 1 000 | prob. | E |
| Entraide | Chaque membre demande une carte à la fois. Les autres donnent une copie non verrouillée. Le receveur obtient au plus 1 don par jour. Le donateur gagne du karma (classement « Entraide de la semaine »). | prob. | E |
| Classement des guildes | Hebdomadaire, **remis à zéro le lundi à 00:00 UTC**. **500 pts par bataille gagnée et 1 pt par WB gagné aux enchères** (membres éligibles). Saisons « S38 » et « S39 » (semaines ISO, prob.). Plus grosse guilde vue : 184 membres ; plafond inconnu. | prob. | R, F, E (`score_battles`, `score_wb`) |
| Classement général | Visible connecté uniquement, alimenté par les batailles ; formule inconnue. Tableaux d'E (`score`, `legendary`, `packs`, `sales`) : inc. | prob. / inc. | F, E |
| Succès | 51 succès. Exemples : « Légendaire ! » (première L) +75 ; « Collectionneur » (250 cartes) +25 ; « Combattant » (5 victoires) +50 ; « Exposition » ou « Sélection personnelle » (remplir la vitrine de 4) +25 ; Débutant (50 cartes) +10 ; Amateur (100) +15 ; première SR +10 ; première UR +25 ; Stratège (10 victoires) +100 ; Vétéran (25) +200 ; Champion (50) +500 ; Invincible (100) +750. Catégories : Cartes et rareté, Collection, Combat, Échanges, Enchères. | prob. | R, F (rotek, Lypningeuh +25 confirmé) |
| Vitrine | **4 emplacements** (E `SHOWCASE_SLOTS=4`). Une 2e rangée à 5 000 cartes selon un forum (inc.) ; 5 emplacements selon le clone (inc.). | conf. (4) | E, R, F |
| Profil | Public ou réservé aux amis ; avatar = image d'une carte possédée ; bio ≤ 280 | prob. | E |
| Amis | Demande par recherche de pseudo (≥ 2 caractères), acceptation requise ; peut-être une limite (`FRIEND_LIMIT`) | conf. | E, F |
| Messages privés | Entre amis uniquement, ≤ 2 000 caractères | prob. | E |
| Signalement | Un signalement par (auteur, cible), modifiable ; motifs triche, contenu inapproprié, spam ; détails ≤ 500 ; plus le signalement d'image sur la carte | prob. | E, X |
| Outils de collection | Étiquettes (≤ 48, couleur, par copie, **perdues quand la copie sort puis revient**), favoris, liste de souhaits (filtre de `/global-collection`, pas de `/collection`), recherche, filtres rareté et étiquette, tri, 50 par page, multi-sélection, cartes manquantes, « ami possède » | conf. | S, X, F |
| Notifications | Panneau avec cloche, non-lus, tout marquer lu ; Web Push optionnel avec consentement | conf. | X, F, /privacy |
| Compte | Pseudo de 3 à 24 caractères, e-mail, mot de passe, 18 ans et plus, **un compte par personne**, vérification de l'e-mail | conf. | F, /terms |

### 5.9 Conventions techniques de jeu

| Règle | Valeur | Sources |
|---|---|---|
| Horloge | Les comptes à rebours se basent sur `end_at` absolu côté serveur ; synchronisation via l'en-tête `Date` ou `x-vercel-id`. | S 1507-1543, E 46-57 |
| Fuseau | Les bornes quotidiennes (paquet Pro, échanges, quotas ?) suivent `x-wiki-calendar-tz`. | E |
| Temps réel | Les clients tiers font du **polling** : marché toutes les 10 à 45 s, enchère jusqu'à 150 ms, échanges toutes les 20 s, batailles 3 à 15 s, badges toutes les 30 s. ⚠ F évoque un WebSocket du site (Realtime ?), non confirmé. | S, E, F |

---
## 6. UI et branding

### 6.1 Thème et jetons de design

| Jeton | Valeur | Conf. | Sources |
|---|---|---|---|
| Thème | **Sombre** : fond quasi noir (~`#0d0d0d`, « graphite »), panneaux `card-frame` légèrement plus clairs. ⚠ F signale aussi une variante claire, alors que T et X n'ont observé que le sombre. | conf. (sombre) / prob. (clair) | T `toolbox.css:3`, X, F |
| `--color-accent` | Vert émeraude **`#34d399`** (texte accent `#6ee7b7`, texte sur bouton `#062b1e`). Repli d'extension : `#2dd4a7`. | prob. | F, X |
| Autres jetons | `--color-accent-light` (survol), `--color-accent-foreground`, `--color-foreground` (~`#f2f4f3`), `--color-surface`, `--color-surface-light`, `--color-border`, `--font-heading`, `--color-rarity-{c,pc,r,sr,ur,l}` (parfois en style inline `--color-rarity`) | conf. (noms) | X, F, T |
| Classe de panneau | `card-frame` (classe sémantique du site : rayon ~16 px, bordure 1 px discrète) | conf. | X, T |

**Couleurs de rareté du site.** Deux sources indépendantes concordent : E `src/lib/rarity.ts` (couleurs « de wiki-masters ») et F ThePommespanzer `extension/common.js:3-7` (« lues sur le site »). **conf.**

| Rareté | Libellé | Couleur principale | Teinte foncée (E) | Aspect |
|---|---|---|---|---|
| C | Commune | `#b8f2d5` | `#2b7d58` | menthe |
| PC | Peu commune | `#b1cff2` | `#2c5c99` | bleu pâle |
| R | Rare | `#c6a7f2` | `#6439b8` | lavande |
| SR | Super rare | `#ed6fa3` | `#a8235b` | rose (fond à rayures diagonales) |
| UR | Ultra rare | `#fa9931` | `#9a4f05` | orange (fond à motif ondulé) |
| L | Légendaire | `#ffe144` | accent `#fa9931` | or, avec voile `legendary-shimmer-sheen` |

⚠ Les palettes des bots ne sont **pas** celles du site : S/O (`#FFD700`, `#FF8C00`, `#FF69B4`, `#A855F7`, `#3B82F6`, `#22C55E`), R/MaKSiiMe (C `#b7c1ce`…) et les dégradés de T (L `#fff19a`/`#d9a30d`…). Ces derniers « imitent » plausiblement le site mais restent des approximations.

### 6.2 Typographie et logo

| Élément | Valeur | Conf. | Sources |
|---|---|---|---|
| Titres | `var(--font-heading)` : sans-serif géométrique, grasse, d'affichage. **Rubik** probable (logo en Rubik Black d'après WikiRemastered `DESIGN.md` ; faces de carte d'E en Rubik 700/800). | prob. | X, F, E |
| Corps | Sans neutre type Inter (X), ou **Source Sans 3** 500 pour les descriptions de carte (E) | inc. | X, E |
| Visuel du paquet | Crimson Pro / Rubik / Source Sans 3 sur l'art du pack d'E (art 3D propre à l'extension : inc.) | inc. | E |
| Logo | `<a href="/pulls"><h1 class="text-2xl font-bold" style="font-family:var(--font-heading)"><span accent>Wiki</span><span foreground>Masters</span></h1></a>` ; fichier image `/logo.png` (aussi utilisé comme visuel de remplacement des cartes) | conf. | X `site-header.html`, F |
| Pack | Blanc nacré, pièces de puzzle pastel, logo noir « WM » en forme de pièce de puzzle, halo orange | conf. | X `pull-idle.html` |
| Polices des bots (Rajdhani, Noto Sans, Outfit) | Elles appartiennent aux overlays des extensions, **pas au site** | — | S 7576, E |

### 6.3 Gabarit de l'application (shell)

Relevé en DOM réel (X `site-header.html`, F `site-nav.html`) :
- `body > div.flex.h-dvh` contient d'abord `nav`, puis `main.min-h-0.flex-1.overflow-y-auto` (c'est `main` qui défile).
- Nav desktop : `nav.hidden.w-64.shrink-0.flex-col.gap-2.overflow-y-auto.border-r.border-[var(--color-border)].bg-[var(--color-surface)].p-6.md:flex`.
- Liens : `a.flex.items-center.gap-3.px-4.py-3.rounded-xl.text-sm.font-medium`. Le lien actif reçoit `bg-[var(--color-accent)]/10 text-[var(--color-accent)]` et un point accent de 1,5 px.
- Nav mobile : `nav.md:hidden.order-last.z-50.bg-[var(--color-surface)]/95.backdrop-blur-md.border-t.pb-[calc(6px+env(safe-area-inset-bottom,0px))]`.
- Conteneur de page : `div.flex-1.p-4.md:p-6.space-y-6`.
- En-tête de page : `div.flex.items-start.justify-between.gap-4.animate-fade-in-up > h1.text-2xl.md:text-3xl.font-bold.inline-flex.items-center.gap-2`, avec une icône lucide size-6 en accent.
- Chargement : `div.flex-1.flex.items-center.justify-center > div.w-8.h-8.border-2.border-[var(--color-accent)].border-t-transparent.rounded-full.animate-spin`.
- Les modales sont des portails `div.fixed.inset-0`, **sans `role=dialog`** (R).

### 6.4 Composant carte (identique partout sauf sur la landing)

Source principale : X (fixtures `card-*.html`, `DOM_NOTES.md:31-51`), recoupé par T, F et E. **conf.**

- **Racine** : `div.{taille}.glow-{c|pc|r|sr|ur|l}.relative.rounded-2xl.overflow-hidden.cursor-pointer.hover:z-10.transition-all.duration-300.hover:scale-105`. `glow-*` est un double halo `box-shadow` coloré, valeurs exactes inconnues. Sur le marché, la carte est enveloppée dans `a.card-frame.block.p-3`.
- **Tailles** : grande `w-72 h-[420px]` (révélation, modale) ; grille `w-[clamp(8.4rem,43vw,10rem)] h-[clamp(11.8rem,60vw,14rem)]`. Ratio d'environ 5:7. La spec d'E dessine en 640×896 ; elle se dit fidèle au site (prob.).
- **Enfants, dans l'ordre** :
  1. `img[alt=""]` : fond de rareté (`object-cover scale-[1.8]`), fichiers `commun.png`, `peu_commun.png`, `super_rare.png`, `ultra_rare.png`, `legendaire.png` (et `rare.png`, déduit).
  2. `div.absolute.inset-0.bg-gradient-to-b.from-black/10.via-transparent.to-transparent.pointer-events-none.z-10`.
  3. **Zone image** `div.absolute.top-0.left-0.right-0.h-[45%].z-20.bg-black/20 > div.relative.h-full.w-full.min-h-0 > img[alt=<titre>][crossorigin=anonymous].object-cover` (`.object-center` ou `style="object-position:center 28%"`), puis `div.absolute.bottom-0.h-12.bg-gradient-to-t.from-black/50`. Sans image : `div.relative.flex…items-center.justify-center.p-1.5 > div.relative.aspect-[4/3].w-[52%].min-w-[4rem].max-w-[9rem] > img[alt="WikiMasters"].object-contain.opacity-70` (logo). `hide_image` remplace l'image par un emblème.
  4. **Badge de rareté** `div.absolute.top-2.left-2.px-2.py-0.5.rounded-md.text-xs.font-bold.z-30`, `style="background-color: var(--color-rarity-x); color: rgb(13,17,23); box-shadow: 0 0 10px var(--color-rarity-x)99"`.
  5. **Favori** (copies possédées seulement) : `div.absolute.top-2.right-2.z-30.flex.flex-col.items-end.gap-1 > button[aria-label="Ajouter aux favoris"|"Retirer des favoris"]`. Étoile `text-amber-200/65` en contour, `text-amber-200` pleine, taille `size-[1.375rem]` (`size-7` dans la modale).
  6. **Zone texte** `div.absolute.top-[45%].left-0.right-0.bottom-0.flex.min-h-0.flex-col.p-3.z-20` :
     - `h3.shrink-0.font-bold.leading-tight.line-clamp-2.text-black[style=font-family:var(--font-heading)]` (`text-base` en grand, `text-xs` en grille) ;
     - `p` description : grand `text-[11px] line-clamp-3 text-neutral-900/90`, grille `text-[9px]`, modale `text-[10px] line-clamp-[10] text-neutral-800/88` avec l'extrait ;
     - `div.mt-auto` : pastille facultative « ami possède », puis la ligne de stats `div.flex.w-full.items-center.justify-between.border-t.border-black/20.pt-1.py-1`, soit `svg.lucide-swords.text-red-800` + `span.font-bold.text-black/90` (ATK) et `svg.lucide-shield.text-blue-800` + DEF (`text-sm` en grand, `text-[10px]` en grille).
  7. **L uniquement** : `div.absolute.inset-0.z-40.overflow-hidden.pointer-events-none > div.legendary-shimmer-sheen[aria-hidden]`.
- **Brillante** : marqueur ✨ sur les tuiles du marché (F), libellé « Brillante » à la révélation (T), teinte noire pour une L brillante (presse). Les rayures arc-en-ciel d'E (`#ff6ed8 #50dcff #ffeb5a #78ffaa`) et sa bordure dorée UR/L sont des choix de l'extension : inc.
- **Sélecteur de détection** utilisé par les extensions : `div[class*="glow-"]` contenant un `h3`. La clé React d'une tuile est l'id `user_card`.

### 6.5 Modale de carte

`div.fixed.inset-0.z-50.flex.items-center.justify-center.p-4.bg-black/70.backdrop-blur-sm > div.card-frame.relative.w-full.animate-fade-in-up.p-6.pt-14.sm:pt-6.max-w-2xl.max-h-[90vh].overflow-y-auto` (X, conf.) :
- bouton de fermeture `aria-label="Fermer"` ;
- `div.flex.flex-col.md:flex-row.gap-6` : à gauche la grande carte (`div.flex-shrink-0.flex.justify-center`), à droite les infos (`div.flex-1.flex.flex-col.min-w-0.md:pr-2.gap-4`) ;
- infos : `h2.text-xl` (font-heading), libellé de rareté, `[role=tablist][aria-label="Vue de la carte"]` avec « Détails » (actif = fond accent) et « Marché » + pastille **PRO** (`bg-violet-500/20 text-violet-300`, icône sparkles), description `p.text-sm/70`, section « ÉTIQUETTES » (combobox `placeholder="Ajouter une étiquette…"` → `[role=listbox] li[role=option] button`, puces « #nom » dans la couleur de l'étiquette, retrait `aria-label="Retirer l'étiquette X"`), grille de 2 `card-frame` ATK (`text-red-700`) / DEF (`text-blue-700`), bloc méta `text-xs/30` : « Q-Score : 51.24 », « Exemplaires : 1 », « Vues (30j) : 6 974 », lien « Voir l'article sur Wikipédia → », ligne de licence CC BY-SA 4.0, puis `border-t` et « Signaler l'image » (`aria-pressed`) ;
- pied : « Mettre aux enchères » (`bg accent/10`, texte accent, lucide-gavel, `disabled:opacity-45`) et « Défausser » (icône pièce W + « +1 », bordé ; SVG du W `M7.5 8.5 9.5 15.5 12 10 14.5 15.5 16.5 8.5`) ;
- F mentionne aussi le prix moyen récent de vente et le bouton Favori ;
- **Boîte de vente** : conteneur `.card-frame`, `input[aria-label="Mise de départ"]`, boutons « 10 min », « 30 min », « 1 h », « 3 h », « 6 h », « 12 h », panneau « Marché · <rareté> », bouton « Lancer l'enchère », toast « <Nom> a bien été mise aux enchères pour 1 234 wikibidous » (S, T, O, R).

### 6.6 Animations et sons

`animate-fade-in-up` (sections), `animate-card-flip` (révélation), `hover:scale-105 transition-all duration-300` (cartes), `legendary-shimmer-sheen` (L), `animate-spin` (chargement), halos `glow-*`, paliers de révélation SR, UR et L avec une cinématique pour L. Sons `/audio/pack-rip.mp3`, `/audio/card-flip.mp3`, `/audio/legendary-reveal.mp3`. Barre de stock en 10 segments. Variantes `motion-safe` à prévoir. **Keyframes et valeurs de box-shadow inconnues** : les feuilles de style n'ont pas été sauvegardées (X). Sources : X, F, R.

### 6.7 Textes de l'UI (français)

Ton familier (« tu ») dans les règles et l'aide, « vous » dans les pages légales. Le terme québécois « courriel » est employé. La devise s'écrit « wikibidous » (W/WB). Libellés relevés : « Ouvrir » / « Ouvrir un paquet », « paquets disponibles », « Prochain dans », « Carte n / 5 », « Encore 4 cartes », « Continuer », « Comment ça marche ? », « Nouvelle », « Brillante », « Collection », « Rechercher par titre ou catégorie... », « Toutes les étiquettes », « Sélectionner », « Précédent / Suivant », « Collection Globale », « Toutes les cartes existantes dans le jeu », « Recherche active : pas de décompte par rareté ni de total exact », « Liste de souhaits », « Trier les cartes », « Marché », « Parcourir », « Mes ventes », « Mes enchères », « Gagnées », « Historique », « Mise de départ », « Mise actuelle », « Durée », « Vendu par X », « Charger la suite », « Miser », « Retour au marché », « Mettre aux enchères », « Lancer l'enchère », « Défausser », « Reçues / Envoyées », « De <pseudo> », « <pseudo> offre », « En échange de », « Accepté / Refusé », « Voir le détail de l'échange », « Message à <pseudo> », « Vue de la carte », « Détails », « Signaler l'image », « Voir l'article sur Wikipédia → ». Messages d'erreur : « Vérification anti-bot requise », « Plus de paquets disponibles », « Mise trop basse », « Carte introuvable », « Limite de 10 enchères actives atteinte », « Vous ne possédez pas cette carte », « Limite quotidienne de paquets atteinte », « Le site demande de ralentir ». Sources : X, T, F, R, S, O.

### 6.8 Sélecteurs DOM notables (contrat implicite avec les extensions tierces)

`#marketplace-auction-<uuid>` · `a.card-frame[href^="/marketplace/"]` · `div[class*="glow-"]` + `h3` · `.card-frame` · `input[placeholder="Rechercher par titre ou catégorie..."]` · `input[aria-label="Mise de départ"]` · `[role=tablist][aria-label="Vue de la carte"]` · `button[aria-label="Ajouter aux favoris"]` / `"Retirer des favoris"` · `aria-label="Retirer l'étiquette X"` · `placeholder="Ajouter une étiquette…"` · `button[aria-label="Voir le détail de l'échange"]` · `aria-label="Trier les cartes"` · `aria-label="Fermer"` · `aria-label="Notifications"` · `span[title=<titre>]` (puces d'échange « R · … ») · `time[datetime]` · `p.truncate` (« Vendu par ») · `#signup-form`, `#username`, `#password`, `#signup-otp-code`, `#email`, `#friend-list-search` · `[style*="--color-rarity"]` · texte « Carte N / 5 » · tuile `div[class*=rounded-2xl][class*=overflow-hidden][class*=cursor-pointer]`, avec `h3`, `div.mt-auto` et `top-[N%]` (T) · `.wm-belt-card` (landing). Sources : X, T, F, R, S.

---

## 7. Indices techniques, anti-bot, légal et modération

### 7.1 Pile technique d'origine

| Couche | Constat | Conf. | Sources / conflits |
|---|---|---|---|
| Framework | **Next.js App Router** (build Turbopack), `/_next/static/chunks`, route handlers `/api/*`, navigation SPA côté client | conf. | E `background.js:49`, X `PLAN.md:11-19`, F, O |
| React | **19.x** (format useId `_r_4_`, `_R_96lubscnpbH1_`). Les inputs contrôlés exigent le setter natif + l'évènement `input`. | conf. | X, S 5200-5205 |
| CSS | **Tailwind v4** (valeurs arbitraires, variables CSS), lucide-react, `next/image` (`fill`, `data-nimg="fill"`) | conf. | X, T, F |
| Hébergement | **Vercel** : la politique de confidentialité le dit (« Vercel (site + API) »), l'en-tête `x-vercel-id` et le paramètre `dpl=dpl_…` le confirment. ⚠ F évoquait un « serveur loué » (rumeur) : contredit. | conf. | O (/privacy), E, X |
| Bord | **Cloudflare** devant le site : 52x, interstitiel « Un instant… », Turnstile | conf. | R, F |
| BDD et auth | **Supabase**, projet `cyrxjeppjqsxxjayfrur` (`https://cyrxjeppjqsxxjayfrur.supabase.co`). Clé anon : iat 2026-03-19, exp 2036-03-18. Auth `@supabase/ssr` par e-mail et mot de passe + OTP. Le navigateur écrit directement sous RLS dans `tags`, `user_card_tags`, `wishlist_items`, `user_cards.starred` et `chat_messages.read`, et lit `cards`, `user_cards`, `auctions`, `auction_bids` et `achievements`. RPC `sync_profile_packs` et `get_my_profile`. Codes Postgres exposés au client. | conf. | S, T, E, R, F, O |
| Temps réel | Aucun observé (tous les clients tiers font du polling). F évoque un WebSocket, peut-être Supabase Realtime (inc.). | prob. (absent) | S, E, F |
| Paiements | Stripe sur le web, en CAD ; achats intégrés Apple et Google prévus dans les CGU ; aucune app publiée | conf. | /privacy, /terms |
| Push | Web Push via FCM, Apple et Mozilla, avec consentement explicite | conf. | /privacy |
| Mobile | Capacitor présent dans le code ; PWA (manifest `lang fr`) | prob. | X |
| En-têtes de sécurité | Pages publiques **sans CSP, sans X-Frame-Options, sans COEP** | prob. | X `DOM_NOTES.md:53` |
| Transferts de données | Hors EEE (US) sous clauses contractuelles types (SCC) ; RGPD et CNIL ; contact via les Paramètres | conf. | /privacy |
| Charge | Sous charge : statement timeouts, 504, saturation du pool de connexions (12–16 oct.), 429. Politique prudente des clients tiers : 650 ms entre requêtes, timeout 12 s, 200 req/h, pause de 30 s après un 5xx, de 60 à 300 s après un 429. | conf. | T, O, S |

### 7.2 Anti-bot et anti-abus

| Mécanisme | Détail | Conf. | Sources |
|---|---|---|---|
| Cloudflare Turnstile | sitekey `0x4AAAAAAEW_2IAWonrk_N5i`, `render=explicit`, `theme=dark`. Jeton envoyé à `POST /api/human-check {token}`. Présent sur `/pulls`/`/pull`, l'inscription, la connexion et certaines mises. Panneau de l'extension E : `role=dialog`, « Vérification rapide ». | conf. | E, T, X, F |
| `human_verification_required` | 403, qui verrouille **ensemble** mises, mises en vente et paquets (pas la défausse). Levé par une ouverture native réussie après la vérification. | conf. | T, R, F |
| Limites de débit | 429 avec `Retry-After` ; jeton `automation_limit` sur 401/403 (maxime-lalo README) ; `rate_limited`/`retry_after` ; `rate_limit_daily` ; `activity_blocked_until`/`packs_blocked_until` | conf. | T, R, F, O |
| Historique | En août (S), le code ne contient ni captcha ni Turnstile. Le seul signal est un 403 sur `packs/open` (pause de 60 s). **Turnstile a donc été ajouté entre fin août et fin septembre.** | conf. | S |
| Rejet « hors UI » (2026-08-19) | `POST /api/marketplace` répond « Vous ne possédez pas cette carte » aux bots. Explication probable : passage de `card_id` (catalogue) à l'id de copie (§3.5). Un GET précurseur `cards?select=summary` a été observé. | prob. | S CHANGELOG |
| Modération humaine | Les volumes de paquets élevés attirent l'attention de l'équipe | prob. | S `README:254-256` |
| Faille connue | Ouverture de paquets d'autrui, d'où l'obligation de vérifier systématiquement la propriété côté serveur | conf. | O |
| Écosystème tiers | Plus de 20 extensions et bots (WikiMasters+, Extended, WikiRemastered, Toolbox, Wiki-Traders, Collection+, QoL, Prix moyen, bots de snipe et d'auto-ouverture), un cache de prix partagé (wikimasters-cache.eplp.fr), des importeurs de collection (wikilord.fr, Lexicodex, qui lit `/api/my-collection`) et des sites de RMT (wiki-market.com, wikitroc.com) | conf. | R, F, O |

### 7.3 Légal et modération

| Sujet | Règle | Conf. | Sources |
|---|---|---|---|
| Âge | **18 ans et plus**, capacité à contracter. Les comptes de mineurs sont supprimés. Motif donné : contenu historique, politique, violent ou sexuel. | conf. | /terms, /privacy, /signup |
| Comptes | Un compte par personne. Fermes de comptes, vente et achat de comptes interdits. | conf. | /rules §4, /terms |
| Automatisation | Interdits : bots, scripts, macros, émulateurs automatisés « visant à jouer, ouvrir des paquets, échanger ou interagir à votre place », interception ou modification du trafic, rétro-ingénierie pour obtenir un avantage, exploitation de bugs (à signaler). | conf. | /rules §3, /terms §6 |
| Manipulation | Collusion, manipulation des enchères, classements, concours et parrainages, RMT hors canaux officiels, arnaques | conf. | /rules §6, /terms |
| Sanctions | Avertissement, contenu masqué, restriction, suspension, bannissement définitif, rollback de progression, retrait d'objets. **Sans préavis et sans remboursement.** | conf. | /rules §9, /terms |
| Contenu | Discours de haine, insultes, promotion d'idéologies extrémistes, harcèlement, menaces, spam ciblé et doxxing interdits. Le contenu Wikipédia sensible peut apparaître à titre informatif (« c'est l'usage qui est encadré »). Outils de signalement intégrés. | conf. | /rules |
| Drapeaux de cartes | `hide_image`, `nsfw_image` ; suppression de cartes par le staff ; bouton « Signaler l'image » | conf. | S, F, X |
| Licences | Texte en CC BY-SA 4.0 (« Texte de l'article : CC BY-SA 4.0 — crédits sur la page Wikipédia. »). **Images affichées sans auteur ni licence** (critique de Next) : il faut récupérer auteur et licence Commons. Projet indépendant de Wikimedia. La promesse de 10 % des revenus reversés à Wikimedia vient peut-être seulement du clone (inc.). | conf. / inc. | X, O, F |
| Biens virtuels | Aucune valeur monétaire, achats définitifs et non remboursables, sauf loi impérative | conf. | /terms |
| Points juridiques à revoir | Droit de rétractation UE pour le contenu numérique (renonciation expresse nécessaire). Statut des loot boxes en France (PEGI 16 à partir d'octobre 2026, ANJ). | inc. | O |
| Propriété intellectuelle | Le nom « WikiMasters », le logo, les visuels (fonds de rareté, pack) et les textes appartiennent à l'exploitant (Naïm Ouellet). Une reproduction « à l'identique » et une migration de ses clients supposent **son accord** (voir §9.0). | — | — |

---

## 8. Conventions du dépôt xbz-web (style maison à suivre)

Source : C (index Graphify de XBZ-E-Sport/xbz-web @794dab5, v1.5.0, privé). Le MCP GitHub a refusé l'accès (session limitée à `ilan9903/wikimaster`) : tout vient de l'index.

### 8.1 Pile et versions
- **next 16.3.6** et `eslint-config-next 16.3.6` **épinglés exactement** ; **react / react-dom 19.3.0** épinglés ; TypeScript ^5 (strict), `@types/node ^20`, `@types/react ^19`.
- Dépendances : `@supabase/ssr ^0.12.7`, `@supabase/supabase-js ^2.110.2`, `@vercel/analytics ^2.0.1`, `next-intl ^4.14.7`, `server-only`, `sharp ^0.35.5`, `sonner ^2.0.8`, `stripe ^22.6.2`, `country-flag-icons`.
- Dev : `tailwindcss ^4` + `@tailwindcss/postcss ^4`, `vitest ^4.1.10`, `@vitejs/plugin-react`, `jsdom`, `@testing-library/react` et `/dom`, `@playwright/test ^1.63.0`, `eslint ^9` (flat config `core-web-vitals` + `typescript`).
- **Non utilisés** : shadcn/Radix, **zod** (validation écrite à la main), Prisma/Drizzle (query builder supabase-js seulement), Prettier, NextAuth, CSS-in-JS.
- `overrides` : postcss ^8.5.10 et sharp ; un bloc `allowScripts` coupe les scripts d'installation de @parcel/watcher, @swc/core et unrs-resolver.
- Scripts : `dev`, `build`, `start`, `lint`, `typecheck` = `next typegen && tsc --noEmit` (imposé par un test), `test` = `vitest run`, `test:e2e` = `playwright test`.
- tsconfig : ES2017, strict, `moduleResolution bundler`, `jsx react-jsx`, alias `@/*` → `./src/*`.

### 8.2 Arborescence
- `src/app/[locale]/` contient toutes les pages, **le layout racine** (pas d'`app/layout.tsx`), `globals.css`, `error.tsx`, `not-found.tsx`, un catch-all `[...rest]` et un `opengraph-image.tsx` par page.
- `src/app/global-error.tsx`. Les route handlers vivent dans `src/app/api/**` et `src/app/auth/callback`, **sans locale**.
- `src/proxy.ts` (convention « proxy » de Next 16, ex-middleware) chaîne next-intl (les 307 deviennent des 308) puis le rafraîchissement de session Supabase `updateSession`. Le matcher exclut api, auth, `_next` et les fichiers statiques.
- `src/components/` : composants PascalCase à plat, avec leur `*.test.tsx` à côté.
- `src/lib/` : modules de domaine en kebab ou minuscules (`cache.ts`, `ratelimit.ts`, `apierror.ts`, `adminguard.ts`, `admin-action.ts`, `admin-result.ts`, `cron-auth.ts`, `mailer.ts`, `stripe.ts`, `og.tsx`, `limits.ts`…). `src/lib/supabase/{server,client,middleware,public,admin}.ts`.
- `src/i18n/{routing,navigation,client-messages}.ts`, `messages/{fr,en}.json`.
- `supabase/*.sql` : migrations SQL à plat (par ex. `migration_retractation_05102026.sql`), **sans dossier CLI `supabase/migrations`**.
- `e2e/*.spec.ts` (Playwright), `test/` (helpers : `css.ts`, `intl.tsx`).
- Chaque section d'admin est colocalisée : `page.tsx` + `actions.ts` (`'use server'`) + `<Thing>Form.tsx` côté client.

### 8.3 Supabase
- 5 fabriques : `server.ts` (`createServerClient` + `cookies()` getAll/setAll, avec un `setAll` en try/catch) ; `client.ts` (navigateur) ; `middleware.ts` (`updateSession` → `auth.getUser()` sans rien entre les deux) ; `public.ts` (`persistSession:false`, pour `unstable_cache`) ; `admin.ts` (`SUPABASE_SECRET_KEY`, sans session ni auto-refresh, pour toutes les écritures et lectures d'admin).
- **Nouveaux noms de clés** : `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` et `SUPABASE_SECRET_KEY` (pas « anon » ni « service_role »).
- **RLS sur toutes les tables**, vérifiée par `src/app/rls.test.ts`, qui grep les `.from("table")` et exige un `alter table X enable row level security`. Les tables sensibles (PII, staff) n'ont **aucune policy** : accès par clé secrète uniquement.
- `auth.getUser()` toujours, **jamais `getSession()`**.
- Pas de types générés : types TS locaux, casts et listes de colonnes explicites dans les `select`.

### 8.4 Actions serveur, cache, route handlers
- Forme : `export async function createX(fd: FormData): Promise<AdminResult> { return adminAction(async () => { await assertStaff(); …; if (error) throw dbError(error,'msg'); revalidateX(); }) }`. `adminAction` appelle `unstable_rethrow`, convertit une `AdminError` en `{error}` et tout le reste en `ADMIN_GENERIC_ERROR` + `console.error`. Helpers `field()` et `intField()` dupliqués dans chaque fichier ; checkbox lue avec `=== 'on'`. Côté client, `AdminForm` : `useTransition` + `toast.promise` (sonner), garde anti double soumission et contrôle de `UPLOAD_MAX_BYTES`. `serverActions.bodySizeLimit = '4.5mb'`.
- Cache : `CACHE_TAGS` dans `src/lib/cache.ts`. Chargeurs publics de la forme `cache(unstable_cache(async () => createPublicClient().from(t).select(COLS)…, keys, {tags}))`, qui **loggent et renvoient `[]` ou `null`** au lieu de lever une exception. Écritures : `revalidateTag(tag,'max')` + `revalidateLocalizedPath`. Pages en ISR ou `force-static`, avec `setRequestLocale` et `getTranslations({locale, namespace})`.
- Route handlers, dans cet ordre : parse JSON en try/catch → `checkFormRateLimit(getClientIp(req), route)` (table `rate_limit_hits`, conscient d'IPv6 /64 et /48, **fail-closed** par défaut) → honeypot + délai minimal (bot = `ok:true` silencieux) → consentement RGPD (`consent_at`) → validation manuelle (`textField`, `findTooLong`, `FIELD_MAX`) → insert via le client admin → notification dans `after()` avec `AbortSignal.timeout`.
- Erreurs : `apiError(status, code, messageFR, {params, headers})`, codes dans la liste fermée `API_ERROR_CODES`, traduits côté client par `translateApiError`.
- Cron : `isCronAuthorized` (`Bearer CRON_SECRET`, sha256 + `timingSafeEqual`). `vercel.json` déclare `crons: [{path:'/api/cron/purge', schedule:'0 3 * * *'}]`. Les tâches fréquentes passent par **GitHub Actions** (`match-notifs.yml` lance curl sur `/api/cron/matchs?job=…`).
- Webhook Stripe : corps brut + `constructEventAsync`, idempotent, renvoie 500 pour que Stripe réessaie.

### 8.5 i18n, SEO, config
- next-intl v4 : `locales ['fr','en']`, `defaultLocale 'fr'`, **`localePrefix 'always'`**, `localeDetection false`, cookie `XBZ_LOCALE`. Plugin en messages précompilés. `pickMessages` côté client. Colonnes bilingues suffixées `_en`.
- SEO : `pageMetadata()` (canonical, hreflang, OG, Twitter), JSON-LD inline, `opengraph-image.tsx` par route.
- `next.config` : `poweredByHeader:false`, **CSP stricte** et en-têtes de sécurité, `images.minimumCacheTTL` d'1 an, `remotePatterns` limités à l'hôte Supabase, `outputFileTracingIncludes` (libvips), `OG_BUILD_VERSION` = `VERCEL_GIT_COMMIT_SHA`, redirections permanentes.
- Variables d'environnement toutes documentées dans `.env.example` ; `src/lib/env.test.ts` échoue si un `process.env.X` y manque.
- CI `.github/workflows/xbz-web-ci.yml` (Node 22) : `npm ci` → lint → typecheck → build → test, puis un job e2e (Playwright chromium). Actions `checkout@v7` et `setup-node@v7`.

### 8.6 Style de code
Commentaires **en français** qui expliquent le **pourquoi** (incidents, CVE cités). Server Components asynchrones qui `await params`. Erreurs attendues → message FR utilisateur ; inattendues → log `[scope]` + message générique. Unions dérivées de tableaux `as const`. Exports nommés, sauf `default` pour les pages et composants. Accessibilité poussée : skip-link, `aria-labelledby`, `sr-only`, `motion-safe:`, **tests de contraste**. **Aucune PII dans les logs** (ids seulement, jamais d'e-mail).

Branding xbz (non transposable, à titre de modèle) : thème sombre seul, jetons Tailwind v4 `--color-*` dans `globals.css`, `next/font/google` exposé en variables CSS, test de palette et de contraste.

### 8.7 Adaptations nécessaires pour WikiMaster (points de friction)

| Convention xbz | Contrainte WikiMasters | Décision proposée |
|---|---|---|
| `localePrefix 'always'` (`/fr/...`) | Les URL d'origine n'ont **pas** de préfixe (`/collection`, `/marketplace/{uuid}`, `/profile/{pseudo}`). Les liens profonds, le SEO et les extensions en dépendent. Le site est en français seulement. | Pas de préfixe : `localePrefix:'never'` ou next-intl sans routage. Garder les catalogues `messages/fr.json` pour préparer l'anglais. |
| Auth Discord OAuth réservée au staff | Joueurs en e-mail + mot de passe + OTP, Turnstile | Supabase Auth par e-mail et mot de passe. Discord OAuth au mieux pour l'admin. |
| `/api` hors locale, `apiError` en liste fermée | Il faut préserver les **chemins, les formes JSON et les messages FR** de l'ancienne API (outils tiers, §9) | Garder `apiError`, mais avec des codes et messages alignés sur l'existant (`human_verification_required`, `bid_too_low`, `pro_required`…). |
| Crons via `vercel.json` (quotidien) et GitHub Actions (horaire) | Le règlement des enchères doit tourner à la minute ; la régénération des paquets est paresseuse | **pg_cron** dans Supabase (ou cron Vercel par minute en offre Pro) + règlement à la demande idempotent. |
| Pas de types générés, pas de zod | Contrat volumineux (~70 routes) | Respecter la maison (validation manuelle aux frontières), avec des helpers de validation partagés pour l'API publique. |
| `next 16.3.6` épinglé | La demande est « la version la plus récente sécurisée et stable » | Épingler exactement le dernier patch 16.x stable au moment du build, après vérification des avis de sécurité. |
| Images : `remotePatterns` limités à Supabase | 2,77 M d'images hébergées sur upload.wikimedia.org | Ajouter `upload.wikimedia.org`. Éviter l'optimiseur Vercel sur des millions d'images (coût) : `unoptimized` ou miniatures Wikimedia directes. |

---
## 9. Risques de régression et points de vigilance pour la migration

### 9.0 Prérequis bloquant : la coopération de l'exploitant

Une migration « sans perte de données ni de clients » n'est **techniquement et légalement possible qu'avec l'accord et les accès de l'exploitant actuel** (Naïm Ouellet). Il faut :
1. un export complet du projet Supabase `cyrxjeppjqsxxjayfrur` (`pg_dump` des schémas `public` **et** `auth`, empreintes bcrypt comprises), ou mieux, le **transfert du projet** vers notre organisation ;
2. le contrôle du **domaine** `wiki-masters.com` (DNS) ;
3. l'accès au **compte Stripe** (clients, abonnements, prix, webhooks) ;
4. les **clés VAPID** du Web Push et le secret Turnstile (ou un nouveau sitekey) ;
5. l'accès au projet Vercel et aux variables d'environnement (secrets JWT et SMTP).

Sans cela, la seule voie serait un import manuel par chaque joueur (export de sa collection via `/api/my-collection` avec sa propre session). Cette voie **ne peut transporter ni les mots de passe, ni les soldes, ni l'historique de façon fiable**. Un scraping massif par les sessions des joueurs serait incomplet, contraire aux /rules §3 et /terms §6, au RGPD, et **non légitime**. De même, reprendre à l'identique le nom, le logo et les visuels suppose l'autorisation du titulaire. Sources : S, T, X, R, F, O (questions ouvertes).

### 9.1 Stratégie recommandée (par ordre de préférence)

| Option | Effet sur la non-régression | Commentaire |
|---|---|---|
| **A. Garder le même projet Supabase** (transfert d'organisation) et brancher la nouvelle app Next.js dessus | **Zéro migration de données**. Cookies `sb-cyrxjeppjqsxxjayfrur-auth-token`, secret JWT, clé anon et RLS inchangés : **personne n'est déconnecté** et les outils tiers continuent de fonctionner. | Le schéma évolue ensuite par migrations additives. C'est la meilleure option. |
| **B. Nouveau projet Supabase + restauration `pg_dump`** (public + auth) en conservant tous les UUID | Données intactes, mais le **nom du cookie change** (il contient la ref) et le **secret JWT change** : toutes les sessions sont invalidées et chacun doit se reconnecter (le mot de passe reste valable grâce au bcrypt importé). Les refresh tokens sont perdus. La clé anon change, ce qui casse les outils tiers qui l'avaient en dur. | Prévoir une page « reconnectez-vous » et une communication. Vérifier si l'on peut reprendre le secret JWT d'origine (point ouvert). |
| C. Import par joueur (opt-in) | Pertes certaines : mots de passe, WB, enchères, échanges, succès, historique. | À éviter, sauf en dernier recours. |

### 9.2 Risques par domaine de données

| Domaine | Risque de perte ou de régression | Mesures |
|---|---|---|
| **Comptes et auth** | Mots de passe perdus si `auth.users.encrypted_password` n'est pas importé ; e-mails non confirmés bloqués ; collisions de pseudos (unicité insensible à la casse) ; `user_metadata.username` périmé ; un refresh token réutilisé révoque la session | Importer `auth.users` et les identités tels quels ; garder `email_confirmed_at` ; source de vérité = `profiles.username` avec un index unique `lower(username)` ; reprendre la configuration des e-mails d'auth (expéditeur, SPF/DKIM, modèles FR : OTP, vérification, reset). |
| **Wikibidous** | Écarts entre le solde affiché et les mises réservées ; double crédit en rejouant des succès, des défausses ou des règlements ; pas de grand livre d'origine | Geler les écritures pendant la bascule. Calculer l'**invariant** `Σ solde + Σ mises en tête réservées + Σ WB des échanges en attente` avant et après, à l'unité près. Créer un grand livre avec une écriture d'ouverture par joueur. Rendre toutes les opérations monétaires idempotentes (clé d'idempotence) et transactionnelles. |
| **Cartes possédées** | Perte de `snapshot_*`, `is_shiny`, `count`, `starred`, `obtained_at` ou des liens d'étiquettes ; « dédoublonnage » erroné ; changement d'UUID qui casse vitrine, avatar, échanges, enchères et outils tiers | Copie 1:1 de `user_cards`, `user_card_tags`, `tags` et `wishlist_items` avec les mêmes id. Ne jamais éclater ni fusionner les `count`. Contrôles : nombre de lignes et Σ `count` par utilisateur et par (rareté, brillant). Préserver les étiquettes `[LOCKED]` et `[…]` des utilisateurs d'Enhanced. |
| **Catalogue `cards`** (2,77 M) | Le régénérer (nouveaux id, nouvelle rareté ou nouvelles stats) casserait **tout** | Importer le catalogue tel quel. Le job de recalcul de rareté (pageviews) ne touche que `cards.rarity`, jamais les `snapshot_*`. Geler le job pendant la bascule. |
| **Enchères en cours** | Mises réservées perdues ; enchères terminées mais non réglées (statut `active` après `end_at`) oubliées ; un `end_at` qui expire pendant l'indisponibilité donne un gagnant sans que les autres aient pu réagir ; durée de 24 h héritée | Avant la bascule, **régler toutes les enchères échues**. Pour les actives : migrer avec `end_at += durée de l'indisponibilité` (ou annuler et rembourser, à décider et annoncer). Conserver `current_bid`, `current_bidder_id`, `auction_bids`, `snapshot_rarity`, `listing_base_amount` et `base_repriced_at`. Accepter `duration_minutes = 1440` pour les données héritées. Règlement idempotent (job + `/settle`). |
| **Échanges en attente** | Perte des verrous, ce qui permettrait de vendre ou défausser une carte offerte ; perte des WB proposés ; acceptation partielle sur un gros échange | Migrer `trades` et `trade_items` tels quels, avec les verrous dérivés (copies en échange en attente). Revérifier la possession à l'acceptation. Transaction unique, mais traitement par lots ou réglage du `statement_timeout` pour éviter le 500 au-delà de ~30 cartes. Définir et documenter l'expiration. |
| **Abonnements Pro et paiements** | Abonnés facturés deux fois ou plus du tout ; perte du statut Pro ; webhooks Stripe perdus pendant la bascule ; achats de WB non crédités | **Même compte Stripe** : réutiliser customers, subscriptions et prix ; repointer l'URL du webhook au moment de la bascule ; rejouer les événements manqués (Stripe garde 30 jours d'événements) ; dériver `is_pro` de l'abonnement. **Nouveau compte Stripe** : migration des données de carte via le support Stripe. Pas d'IAP Apple/Google pour l'instant (aucune app publiée), mais à surveiller. |
| **Paquets** | Stock remis à zéro ou réserve dépassée ; régénération non créditée pendant l'arrêt ; paquet Pro du jour réclamé deux fois | Conserver `packs_remaining`, `packs_last_regen_at` et `pack_cap` : la régénération paresseuse rattrape alors l'arrêt automatiquement. Conserver l'historique de réclamation du paquet Pro du jour, dans le bon fuseau. |
| **Succès** | Double réclamation si `claimed_at` est perdu ; succès non débloqués | Migrer `user_achievements` avec `claimed_at`, et `achievements` avec les mêmes id et récompenses. |
| **Batailles** | Parties en cours bloquées ; quota du jour remis à zéro ; quiz déjà générés perdus | Migrer `battles` (`game_state` jsonb, decks) ou annuler sans pénalité et en l'annonçant. Garder le quota du jour. |
| **Guildes** | Score hebdomadaire faussé si la bascule a lieu en milieu de semaine ; chef ou membres perdus | **Basculer juste après le reset du lundi 00:00 UTC.** Migrer guildes, membres, rôles, chat, listes de souhaits, dons, karma, scores et historique des saisons. |
| **Social** | Amitiés, messages privés, notifications, vitrine, signalements, préférences | Copie 1:1 ; `read` et `read_at` conservés. |
| **Web Push** | Abonnements perdus si les **clés VAPID** changent | Réutiliser les clés VAPID d'origine, sinon prévoir un réabonnement opt-in. |
| **Modération et sanctions** | Un banni qui revient (table de sanctions inconnue) ; drapeaux `hide_image` et `nsfw_image` perdus ; cartes supprimées qui réapparaissent | Exporter **toutes** les sanctions (bans, restrictions, `*_blocked_until`) et les listes de suppression ; vérifier qu'aucun compte banni ne peut se connecter après la bascule. |
| **Contrat d'API** (~70 routes) | Les outils tiers et les importeurs (Lexicodex, wikilord) cassent : formes JSON, base de pagination (0 ou 1), noms de champs, messages FR matchés par regex, en-têtes | Implémenter les **mêmes chemins et formes** (§3). Garder les deux bases de pagination. Renvoyer les unions de champs (`hasMore` + `total`, `sellingCount` + `maxConcurrentAuctions` + `auctions`). Garder les messages d'erreur FR existants. Décider **délibérément** quels comportements de bot casser (sniping, rejet « hors UI »). Tests de contrat générés à partir de ce document. |
| **URL et DOM** | Liens profonds cassés (`/marketplace/{uuid}`, `/profile/{pseudo}`, `/trades`, `/pulls`) ; SEO ; extensions qui s'appuient sur les sélecteurs du §6.8 | Garder **toutes les routes sans préfixe de locale**, et les ids et aria-labels clés. Redirections 308 pour tout changement. |
| **Performance** | Reproduire les incidents (statement timeouts, 504, saturation des connexions, ~20 s pour la collection) | Index : `user_cards(user_id, obtained_at desc)`, `(user_id, card_id)`, `(user_id, snapshot_rarity)` ; `auctions(status, end_at)`, `(seller_id, status)` ; `auction_bids(bidder_id, placed_at desc)` ; trigram ou plein texte sur `cards.wikipedia_title` et `auctions.snapshot_search_document`. Pagination par curseur. Agrégats précalculés (stats, compteurs par rareté). Pooling Supavisor en mode transaction. Cache du catalogue. **Supabase Realtime** au lieu du polling. Rate limits par route. |
| **Sécurité** | Faille « paquets d'autrui » ; confiance accordée au `card_id` du client ; écritures PostgREST directes trop larges | Vérifier la propriété côté serveur dans chaque handler ; RLS minimale (lecture et écriture de ses propres lignes, pas d'UPDATE sur `wikibidous_balance` ni sur `count` côté client) ; `rls.test.ts` ; Turnstile vérifié côté serveur ; anti-abus du marché (verrou commun mises/annonces/paquets). |
| **Temps et fuseaux** | Bornes quotidiennes décalées | Respecter `x-wiki-calendar-tz` (paquet Pro, échanges, quotas) et l'heure serveur pour les comptes à rebours. |
| **Images et licences** | Coût de l'optimiseur Vercel sur des millions d'images ; licences d'images absentes | Miniatures Wikimedia directes ; métadonnées auteur et licence Commons stockées et affichées. |
| **Juridique** | Reprise de la marque et du contenu sans droit ; RGPD (transfert de responsable de traitement) ; CGU et confidentialité à jour (nouveaux sous-traitants) ; mineurs | Accord écrit avec l'exploitant ; information des utilisateurs avant le transfert de données ; mise à jour de /terms, /privacy et /rules ; garder la case 18+. |

### 9.3 Procédure de bascule (squelette)

1. Annonce J-7 (Discord, bannière) ; choisir une fenêtre **lundi juste après 00:00 UTC**.
2. Mode maintenance : gel des écritures (paquets, marché, échanges, batailles, défausse), job de rareté arrêté, Stripe en file d'attente.
3. Règlement de toutes les enchères échues ; décision sur les actives (prolongation ou annulation et remboursement).
4. Dump final (`public` + `auth`) ou transfert du projet ; restauration ; **rapprochement** : nombre de lignes par table, Σ WB + réservations, Σ `count` par utilisateur, nombre d'enchères actives et d'échanges en attente, contrôles d'échantillons (100 comptes au hasard, avec les 10 plus grosses collections).
5. Bascule DNS et webhook Stripe ; smoke tests (connexion, ouverture de paquet, mise, échange, défausse, paiement en mode test).
6. Levée du gel ; surveillance renforcée (erreurs, latence, soldes) ; **plan de retour arrière** : DNS vers l'ancien stack, ancien projet intact jusqu'à J+14.

### 9.4 Récapitulatif des conflits (et résolution retenue)

| # | Sujet | Positions | Résolution proposée |
|---|---|---|---|
| 1 | Durées d'enchère | 6 valeurs (T, E, R, F) contre +24 h (S, O, en août) | 6 valeurs dans l'UI, 1440 accepté pour les données héritées |
| 2 | Mise minimale suivante | `ceil(1,1x)` / `max(ceil(1,1x), x+1)` / `x + floor(x/10) + 1` | `max(ceil(1,1x), x+1)` + `min` exposé ; à valider sur un cas à 100 |
| 3 | Ventes simultanées | 10 (S) / 5 (F, R) / 5-10 (README) / 10-20 (clone) | 5 gratuit, 10 Pro, piloté par le serveur |
| 4 | Seuils de rareté | 50/250/1k/5k/20k (6 sources) contre les bandes d'E et WikiCollector | 50/250/1 000/5 000/20 000 |
| 5 | `card_id` au POST du marché | id catalogue (S, O, août) contre id de copie (E, R, F, T) | id de copie, repli sur l'id catalogue (copie la plus ancienne) |
| 6 | `/api/marketplace/mine` | compteurs (S, E, R, O) contre `{auctions}` (F) | renvoyer les deux |
| 7 | `?mine=1` | `{mine, selling, history}` (T) contre `{selling, bidding, won, history}` (E) | union |
| 8 | Ventes par carte en Pro | résumé gratuit (T) contre résumé Pro (R) | résumé gratuit, détail Pro (`pro_required`) |
| 9 | Stock vide à l'ouverture | 403 + `next_regen_at` (R) contre 200 `cards:[]` (T) | 403 + `next_regen_at` + `packs_remaining:0` (les clients gèrent les deux) |
| 10 | `owned_copies` | objet (E) contre tableau (F) | à confirmer ; tableau d'après la réponse réelle du 27/09 |
| 11 | Doublons | lignes séparées (S, O) contre `count` (E, F) | colonne `count` conservée telle quelle |
| 12 | Rareté modifiable | oui (S, R, O, T) contre immuable (E) | modifiable + `snapshot_rarity` |
| 13 | Taux de brillantes | 1/100 cartes (E) contre 1 % des L (presse) | à confirmer ; drapeau par copie dans tous les cas |
| 14 | Acceptation d'échange | PATCH (S, E, R, O) contre POST `/accept` (fixtures) | PATCH `{action}` |
| 15 | Règlement des enchères | asynchrone serveur (R, F) contre `/settle` manuel (E) | job + `/settle`, idempotents |
| 16 | Hébergement | Vercel (/privacy, x-vercel-id, dpl) contre « serveur loué » (rumeur) | Vercel |
| 17 | Recherche du catalogue | ≥ 2 car. (E) contre ≥ 3 (F) | 2 côté serveur |
| 18 | Vitrine | 4 (E) contre 5 (clone) et 2e rangée à 5 000 cartes (forum) | 4 |
| 19 | Thème clair | existe (F) contre sombre seul observé (T, X) | sombre par défaut, clair à confirmer |
| 20 | Date du changement de `/mine` | 08-10 (O) contre ~08-17 (S) | sans impact |

---

## 10. Questions ouvertes et points non vérifiés

> Cause principale : **wiki-masters.com est bloqué par le réseau du bac à sable** (WebFetch `ENOTFOUND` sur wiki-masters.com, wikicollector.com, jvflux.fr, next.ink et wikimasters.fr). Le budget WebSearch était épuisé pour une partie des requêtes (O : pesesurstart, RTBF, texte intégral de Next, HuffPost, Numerama « 5 astuces »). Le MCP GitHub refusait xbz-web.

### 10.1 Bloquant (exige l'exploitant)
1. **Accès et accord de l'exploitant** : dump ou transfert du projet Supabase `cyrxjeppjqsxxjayfrur` (avec `auth.users` et les bcrypt), domaine, Stripe, Vercel, VAPID, Turnstile. Sans eux, aucune migration sans perte n'est possible (§9.0).
2. **Peut-on garder le même projet Supabase** (option A) ou, à défaut, reprendre le secret JWT pour ne pas déconnecter les joueurs ?
3. **Schéma réel complet** : stockage du portefeuille (colonne ou grand livre, mécanisme de réservation), table des sanctions, abonnements Stripe (où sont stockés les ids ?), `is_pro` contre `is_vip`, tables des guildes, des batailles, des notifications et du push.

### 10.2 Règles du jeu non confirmées
4. Cotes de tirage par rareté (gratuit et Pro), minimum garanti éventuel, **taux de brillantes** (1/100 cartes ou 1 % des L ?), stats des brillantes.
5. Formules ATK/DEF (longueur, `q_score`), origine et sens du Q-Score, fenêtre de vues (30 j glissants ou mois précédent) et fréquence de recalcul de la rareté.
6. Formule exacte de la mise minimale (cas 100 → 110 ou 111 ?), présence de **frais ou commission**, mécanisme du règlement (job, `/settle` ou les deux).
7. Valeurs réelles de `maxConcurrentAuctions` (gratuit et Pro), du plafond quotidien de paquets, de la fenêtre de rate limit, de la réserve Pro (10 ou 15 ?), de la taille du paquet Pro du jour.
8. Échanges : délai d'expiration, quota quotidien, plafonds (100 cartes et 10 000 WB par côté ?), sort du statut `countered`.
9. Batailles : nombre de questions (3 ou 4), minuteur, générateur de quiz (LLM ?), quotas Pro, récompenses (+50/+10 ?), points de classement.
10. Guildes : nombre maximal de membres, coût de création, rôles, formule du karma, sens des saisons S38/S39.
11. Liste complète des **51 succès** (seuils, récompenses, catégories).
12. Sens de `/api/packs/special` et `/api/packs/grace` ; dotation de départ d'un nouveau compte.
13. Classement général : endpoint et métrique ; système de concours ; parrainage.

### 10.3 Technique et UI non capturés
14. **CSS réelle** : valeurs hexadécimales exactes de `--color-accent` et `--color-*`, police `--font-heading`, `box-shadow` de `glow-*`, keyframes (`legendary-shimmer-sheen`, `animate-card-flip`), nom du fond R (`rare.png` ?), rendu des brillantes.
15. Pages **jamais capturées** : `/profile`, `/guild`, `/friends`, `/dms`, `/battle`, `/achievements`, `/leaderboard`, `/settings`, `/marketplace/{uuid}`, détail d'un échange, panneau de notifications, boutique et paiement Pro (Stripe), achat de WB, contenu de la modale « Comment ça marche ? ».
16. Liste complète des types de notification et de leurs clés `data` ; canaux Realtime éventuels.
17. Format du segment `/api/profile/{x}` (pseudo ou uuid) ; existence de `/api/profile/{x}/stats` ; fonction « galleries » de la vitrine.
18. Cause exacte du rejet « hors UI » du 2026-08-19 (changement de sémantique de `card_id`, ou jeton ou nonce caché ?).
19. Existence éventuelle d'OAuth (Google, Discord, Twitch) derrière `/callback` ; fournisseur des e-mails d'auth.
20. Version anglaise et multi-langue (colonne `lang`) ; app native (Capacitor) ; contenu sponsorisé (sets Transavia) et son modèle de données.

### 10.4 Juridique
21. Statut des loot boxes payantes en France (ANJ, PEGI 16) et droit de rétractation UE pour le contenu numérique.
22. Licences des images Commons (auteur et licence à afficher) ; la promesse de 10 % à Wikimedia appartient-elle à l'original ?
23. Cadre du transfert RGPD (changement de responsable de traitement) et propriété de la marque WikiMasters.

### 10.5 Pistes pour la suite de la rétro-ingénierie
- Lancer REA sur les clones `ext/` et `ext2/` non encore analysés : ludomrn69, AndyB31/Wiki-Traders, Lypningeuh/WikiRemastered, LeKenT1, TendersTroll, qkerman/WikiMastersTools-kzfamily (« Mes ventes » : nombre de mises et prix de départ par annonce), maxime-lalo/better-wiki-master, FCYPBA.
- Obtenir une capture HAR et le bundle CSS depuis un réseau non bloqué, ou mieux, l'accès au dépôt d'origine.

---

## 11. Critique de complétude

> Relecture critique du présent document et de `recon-raw.json` (2026-10-16), avec un seul critère : **zéro régression fonctionnelle et migration sans perte**. Chaque point dit ce qui manque et quelle preuve le tranche.
> **Couverture** : tous les endpoints de `recon-raw.json` figurent dans ce récap, sauf l'appel SPARQL Wikidata de X (outil de l'extension) et deux routes xbz hors périmètre. En revanche, les §3.7 à §3.10 et §5.7 à §5.8 (social, progression, batailles, guildes) reposent sur **une seule source, E**. E est un client tiers dont l'auteur a eu son propre serveur (`account.ts`). Ses valeurs restent des **hypothèses** tant qu'une seconde source ne les confirme pas.

**Codes de preuve**
- **DUMP-S** : `pg_dump --schema-only` du projet `cyrxjeppjqsxxjayfrur`, schémas `public`, `auth`, `storage` et `cron`, avec fonctions, triggers, policies RLS, enums et contraintes CHECK. C'est la preuve la plus rentable : elle tranche à elle seule environ la moitié des points ci-dessous.
- **DUMP-D** : export des données, ou à défaut des requêtes d'agrégat sans PII exécutées par l'exploitant.
- **SRC** : accès au dépôt source d'origine (route handlers, constantes, jobs).
- **CFG** : configuration des services : Supabase Auth (OTP, SMTP, modèles, secret JWT), Vercel (variables, crons), Stripe (produits, prix, webhooks), Cloudflare (Turnstile, WAF, rate limits).
- **CAP(page)** : capture REA (HAR, DOM, bundle CSS et chunks JS) d'une page de wiki-masters.com depuis un réseau non bloqué, avec un compte gratuit **et** un compte Pro. L'accord de l'exploitant est souhaitable (/rules §3).
- **Q** : question à l'exploitant (choix produit, valeur non observable).

### 11.1 Contradictions non résolues, y compris dans ce document

| # | Contradiction | Pourquoi ça compte | Preuve |
|---|---|---|---|
| 1 | **Invariant WB du §9.2** : il ajoute « Σ WB des échanges en attente », alors que les §3.6 et §5.6 disent que **rien n'est séquestré** dans un échange. Si les WB proposés ne sont pas débités, l'invariant les compte deux fois. | Le rapprochement de bascule donnerait un faux écart, ou en masquerait un vrai. | DUMP-S (fonction de création d'échange) ; à défaut, retirer ce terme. |
| 2 | **`count` empilé ou lignes séparées** (§4.2, conflit n° 11), en contradiction avec « une annulation recrée une **nouvelle ligne** » (§4.2). Dans un modèle empilé, le retour incrémenterait `count`. Plusieurs sémantiques restent inconnues : défausser une ligne `count = 3` (décrément ou suppression ? +1 WB par ligne ou par exemplaire ?), mettre en vente ou échanger un exemplaire d'une pile. | Bloquant pour défausse, séquestre, échanges et rapprochement Σ `count`. | DUMP-D : `select count, count(*) from user_cards group by 1` ; SRC handlers `discard` et `marketplace` ; CAP(/collection) sur une carte « xN ». |
| 3 | **Rareté affichée en collection** : `card.rarity` (courante) ou `snapshot_rarity` ? On ne sait pas non plus quelle rareté entre dans la clé de variante (`card_id`, rareté, `is_shiny`), dans le badge « Nouvelle » et dans les filtres de rareté de `/collection`. | Régression visible (halo, filtres, compteurs) dès qu'une carte change de palier. | CAP(/collection) avec une carte dont la rareté a changé ; SRC. |
| 4 | **Granularité du verrou d'échange** : `card_id` (T) ou `user_card_id` dans les éléments (E) ? `pendingTradeCardIds` contient-il des id catalogue ou des id de copies ? | Verrou trop large (gêne) ou trop étroit (vente d'une carte promise). | CAP(`GET /api/my-collection?pending=1`) ; DUMP-S. |
| 5 | **Anti-snipe** : fenêtre de 10 s et +1 min (E, S, R, F), alors que O croit `end_at` fixe. Jamais mesuré sur le site. | Équité des enchères ; contrat des snipers. | SRC, ou CAP(/marketplace/{id}) avec une mise dans les 10 dernières secondes (compte test). |
| 6 | **Baisse de prix « après 50 % de la durée »** (E), alors que `end_at` est prolongeable et qu'aucune colonne de durée d'origine n'existe au §4.2. | Règle impossible à appliquer aux enchères migrées. | DUMP-S (`duration_minutes` ?). |
| 7 | **Marché** : environ 40 tuiles par lot (X), alors que l'API prend `limit=50`. | Pagination de l'UI et de l'API différente ? | CAP(/marketplace) HAR. |
| 8 | **Tris de la collection** : l'UI propose ATK, DEF et favoris, l'API ne connaît que `rarity`, `obtained_at`, `added` et `name`. Avec une pagination serveur, ces tris sont forcément faits côté serveur, mais leurs paramètres sont inconnus. | Tri cassé, ou faux tri par page. | CAP(/collection) HAR en changeant de tri. |
| 9 | **`wishlisted_by` sur `/api/my-collection`** contre « la liste de souhaits filtre `/global-collection`, pas `/collection` » (§5.8). Sémantique probable : mes copies souhaitées par un ami. | Fonction de troc mal reproduite. | CAP ; SRC. |
| 10 | **Turnstile** : « toutes les 12 h jusqu'au 2026-10-01 », mais le régime actuel est inconnu (validité, actions couvertes : connexion, inscription, paquets, mises). | Friction ou faille anti-bot. | CAP(/pulls, /login) ; CFG Cloudflare. |
| 11 | **Brillantes** : stats de 10 001 à 15 000 (clone) contre un plafond de 10 000 ; taux de 1/100 cartes (E) contre 1 % des L (presse) ; teinte noire. Aucune capture. | Tirage et rendu faux. | DUMP-D : `select snapshot_rarity, count(*), max(atk) … where is_shiny group by 1` ; Q. |
| 12 | `obtained_at` contre `created_at` sur `user_cards` (S) | Mapping de colonne à la restauration. | DUMP-S. |
| 13 | Libellés de rareté : « Commune » ou « Commun », « Ultra rare » ou « Ultra Rare » selon l'écran | Textes de l'UI (cohérence). | CAP (modale, filtres, « Comment ça marche ? »). |
| 14 | Route `/pull` contre `/pulls` | Liens profonds et garde Turnstile. | SRC (arbre `app/`) ; CAP. |
| 15 | Formes **courantes** de `/api/marketplace/mine`, `?mine=1` et `/api/my-collection/stats` : l'union résout le cas des clients, mais la forme réelle d'aujourd'hui est inconnue | Tests de contrat. | CAP HAR. |

### 11.2 Entités : champs manquants pour une migration sans perte

| Entité | Manquant ou non vérifié | Risque | Preuve |
|---|---|---|---|
| `profiles` | Fin de période Pro (`pro_until` ou statut d'abonnement) ; ids Stripe (customer, subscription) ; différence `is_pro`/`is_vip` ; rôle staff (admin, modérateur) ; préférences (notifications, filtre sensible `hide_sensitive`, sons ?) ; **compteurs de stats** (« paquets ouverts », cartes, succès : cités par F dans `recon-raw.json`, absents du §4.2) ; `username_change_available_at` ; dernière vérification humaine ; `last_seen_at` | Pro perdu ou facturé deux fois ; staff sans droits ; succès et classement faussés si les compteurs ne sont pas recalculables. | DUMP-S ; CFG Stripe. |
| `auth` | Utilisateurs non confirmés, `banned_until`, `auth.identities` (OAuth éventuel), facteurs MFA ; configuration (longueur de l'OTP : « 6 à 12 chiffres » est suspect ; modèles FR ; SMTP ; URL de redirection ; secret JWT) | Joueurs bloqués ou déconnectés ; bannis qui reviennent. | DUMP-S/D `auth` ; CFG. |
| `user_cards` | État pendant une enchère (ligne supprimée, déplacée ou marquée ?) ; `snapshot_atk`/`snapshot_def` (prob.) ; provenance (paquet, échange, enchère, don) ? | Copies en séquestre perdues ou dupliquées à la migration. | DUMP-S. |
| `auctions` | `duration_minutes` ; `user_card_id` (prob.) ; `snapshot_title`, `snapshot_category` et `obtained_at` de la copie (pour la reconstituer au retour) ; sens de `effective_bid` ; `buyer_id` contre `winner_id` ; marqueurs de règlement et de remboursement | Copie invendue rendue incomplète ; double règlement. | DUMP-S. |
| `auction_bids` | `id` ; lien avec la réservation ; marqueur de remboursement | Remboursements rejoués ou perdus. | DUMP-S. |
| Portefeuille | Grand livre ou colonne seule ? Réservation par débit immédiat ou par blocage (`hold`) ? Idempotence des achats Stripe (ids d'événements traités) ? | Invariant WB invérifiable ; achats crédités deux fois. | DUMP-S ; SRC. |
| `trades` / `trade_items` | `expires_at` et son délai ; horodatages ; snapshots dans les éléments ; table de **quota quotidien** (l'en-tête `x-wiki-calendar-tz` envoyé sur les échanges suppose une borne journalière) | Échanges expirés réactivés ; quota remis à zéro. | DUMP-S. |
| `notifications` | `read` ou `read_at` ; liste réelle des `type` et des clés `data` | Panneau vide ou cassé après bascule. | DUMP-D : `select type, jsonb_object_keys(data), count(*) … group by 1,2`. |
| `push_subscriptions` | Schéma ; clés VAPID | Abonnements push perdus. | DUMP-S ; CFG. |
| Batailles | Table des decks ; quotas ; **questions et bonnes réponses** (où, et sont-elles secrètes ?) ; échéances (24 h, 2 j) ; historique des victoires (alimente les succès « Combattant… » et le classement) | Parties bloquées ; succès de combat non débloqués. | DUMP-S. |
| Guildes | Invitations ; liste de souhaits de guilde ; dons ; karma ; scores hebdomadaires et **historique des saisons** (meilleur score, meilleur rang) ; plafond de membres | Classement de guilde faussé ; historique perdu. | DUMP-S. |
| `achievements` | Critères (en données ou en code ?), seuils, catégories, **les 51 lignes** (12 seulement connues) | Succès non débloqués ou débloqués à tort. | DUMP-D (table complète) ; SRC. |
| Paquets | Réclamations du paquet Pro du jour (clé jour + fuseau) ; définitions et réclamations des paquets spéciaux et « grâce » ; achats de recharges | Paquet du jour ou spécial réclamé deux fois. | DUMP-S. |
| Paiements | Commandes, historique d'achats, abonnements, remboursements et litiges | Support client impossible ; Pro mal dérivé. | DUMP-S ; export Stripe. |
| Modération | Sanctions ; `reports` ; table des **signalements d'image** ; liste des cartes supprimées ou exclues (pour qu'elles ne reviennent pas au recalcul) | Bannis de retour ; cartes retirées qui réapparaissent. | DUMP-S. |
| `cards` | Auteur et licence de l'image (absents partout) ; `image_position` ; `description` ; **sets ou collections sponsorisées** (Transavia, 2026-10-11) ; exclusion des tirages ou `deleted_at` ; origine des 2,77 M (pré-générées ou créées à la volée ?) | Sets perdus ; obligation de licence non tenue. | DUMP-S ; Q. |
| Tables techniques | Rate limits, état de vérification humaine, jobs `pg_cron`, buckets `storage`, edge functions, webhooks de base | Jobs oubliés (règlement des enchères, recalcul de rareté, expirations). | DUMP-S (`cron.job`, `storage.buckets`, `supabase_functions`). |
| Sécurité RLS | Policies réelles : T voit des écritures directes POST/PATCH/DELETE sur `user_cards` et `trades` ; `owned_by=<userId>` respecte-t-il `is_public` ? | Reproduire une faille, ou casser un outil tiers légitime. | DUMP-S (`pg_policies`). |

### 11.3 Endpoints dont la réponse est inconnue ou partielle

- **Aucune route connue** pour des fonctions pourtant visibles : classement des joueurs (`/leaderboard` est dans la nav) ; boutique et checkout Stripe, webhook, portail d'abonnement ; achat de WB et de recharges ; inscription et désinscription Web Push ; préférences de notification ; **Paramètres** (changer de pseudo, d'e-mail ou de mot de passe, supprimer le compte, export RGPD, contact) ; « Signaler l'image » ; concours ; parrainage ; back-office de modération. → SRC, sinon CAP de chaque écran.
- **Requête ou réponse inconnue** : `POST /api/packs/grace` (corps et sémantique) ; `POST /api/packs/special` (corps inconnu selon F) ; `POST …/settle` ; `POST …/reprice` ; `GET /api/trades/{id}` (forme exacte) ; `POST /api/trades` (`{id}` ou l'échange complet ?) ; écritures `rest/v1/trades` ; `POST /api/achievements/check` ; toutes les écritures de guilde (`/api/guilds`, `join`, `invite`, `kick`, `transfer-leadership`, `leave`, `wishlist`, `wishlist/donate`) ; `POST /api/friends/accept-all` ; `PATCH`/`DELETE /api/friends/{id}` ; `PUT`/`DELETE /api/showcase` ; `PATCH /api/notifications` ; `GET`/`POST /api/reports` ; réponses de `PATCH /api/battles/{id}` hors `submit_single_answer` ; erreur « quota atteint » de `POST /api/battles` ; existence de `/api/profile/{x}/stats` ; colonnes complètes de `rpc/get_my_profile`.
- **Messages d'erreur FR réels** : on les connaît pour paquets, marché et défausse. Pour le social, les guildes et les batailles, on n'a que les codes **normalisés par E** (`FORBIDDEN`, `FRIEND_LIMIT`…), pas les textes que les outils tiers matchent.
- **Pagination et limites** non vues : `/api/trades` (sans pagination, quid des gros comptes ?), `/api/chat/{peer}`, `/api/notifications`, `/api/friends`, `/api/guilds/chat`.
- Preuve : SRC ; à défaut, CAP HAR de `/friends`, `/dms`, `/guild`, `/battle`, `/achievements`, `/leaderboard`, `/settings`, `/profile/{pseudo}`, `/trades/{id}`, de la boutique et du panneau de notifications.

### 11.4 Fonctionnalités citées mais non spécifiées

| Fonctionnalité | Ce qui manque | Preuve |
|---|---|---|
| Classement général | Métrique, périodes, endpoint, UI | CAP(/leaderboard) ; Q |
| Boutique et Pro | Écrans ; produits (Pro mensuel, 2 500 WB, recharges : quantité, prix, effet sur `pack_cap`) ; résiliation ; avantages exacts ; offres pour les non-Pro (paquet du jour verrouillé ?) | CFG Stripe (products, prices) ; CAP(boutique) |
| Paramètres | Écran entier (onglets, champs, actions) | CAP(/settings) |
| Pages jamais capturées (§10.3 n° 15) | DOM et textes : régression d'UI certaine sans capture | CAP de chaque page |
| Création d'échange | Point d'entrée (« Échanger » depuis Amis ou Profil), choix des cartes adverses (via `owned_by` ?), vue détail, UI de contre-offre | CAP(/trades/{id}, /friends) |
| Alerte de liste de souhaits | Déclencheur quand une carte souhaitée est mise en vente, diffusion à N abonnés, préférence associée | SRC ; DUMP-D (notifications) |
| Concours, parrainage | Existent-ils dans l'app ou seulement sur Discord ? | Q |
| Collections sponsorisées et sets | Modèle de données, UI, règle « collectionner 10 » (Transavia) | CAP ; Q |
| Modération et admin | Back-office, traitement des signalements, masquage d'image, suppression de carte, sanctions | Q ; SRC |
| E-mails transactionnels | Expéditeur, fournisseur, modèles FR (OTP, vérification, reset), autres e-mails éventuels | CFG |
| Contenus statiques | Modales « Comment ça marche ? » (paquets, batailles), landing complète, 404, page de maintenance, titres et métadonnées SEO/OG | CAP |
| `/global-collection` | Paramètre serveur du mode « cartes manquantes » (« pas encore à moi ») ; seuil de recherche (2 ou 3 caractères) | CAP HAR |
| Divers Pro et profil | « Statistiques de rareté supplémentaires », « galleries » de la vitrine, 2e rangée de vitrine, stats affichées sur le profil | CAP(/profile) avec un compte Pro |
| Préférences d'UI | Réglage des sons (muet ?), thème clair, manifest PWA et icônes | CAP |
| RGPD | Suppression de compte, export des données, durées de conservation (/privacy renvoie aux Paramètres) | Q ; texte intégral de /privacy |

### 11.5 Constantes de jeu non fixées

| Constante | État | Preuve |
|---|---|---|
| Cotes de tirage gratuit et Pro ; minimum garanti ; exclusion des cartes `hide_image`, `nsfw_image` ou supprimées | inc. (l'hypothèse d'un tirage uniforme sur le catalogue reste à valider) | SRC ; DUMP-D (raretés des copies tirées en paquet sur 30 j, à comparer à la part de chaque rareté dans le catalogue) |
| Taux et stats des brillantes | inc. | SRC ; DUMP-D |
| Régénération Pro 180 s ; réserve Pro ; plafond quotidien de paquets ; fenêtre de `rate_limited` | prob. ou inconnu | SRC ; DUMP-S (`sync_profile_packs`) |
| Paquet Pro du jour : 15 cartes « sans commune » (E seul) | inc. | SRC ; CAP compte Pro |
| Dotation de départ (paquets, WB) | inconnu | DUMP-S (défauts de colonnes, trigger d'inscription) |
| ATK, DEF, Q-Score ; fenêtre de vues ; fréquence du recalcul ; le recalcul touche-t-il ATK et DEF ? | inc. | SRC (job de recalcul) ; `cron.job` |
| Mise minimale (100 → 110 ou 111) ; anti-snipe ; commission (aucune ?) ; ventes simultanées 5/10 ; baisse de prix ; prix suggéré 10 ; moyenne sur « 200 dernières ventes » | prob. ou inc. | SRC ; CAP(mise à 100) |
| Seuils anti-bot (~10 mises, 45 s entre annonces) | estimations de bots | SRC ; CFG |
| Échanges : 100 cartes et 10 000 WB par côté (E), expiration, quota quotidien | inc. | DUMP-S (CHECK) ; SRC |
| Batailles : 3 ou 4 questions, minuteur, quota Pro, expirations 24 h et 2 j, récompenses +50/+10, points de classement | inc. | SRC ; DUMP-S |
| Guildes : 500 pts par victoire et 1 pt par WB, plafond de membres, coût de création, karma, 1 don par jour, reset lundi 00:00 UTC | prob. ou inc. | SRC ; DUMP-S |
| Limites sociales : `FRIEND_LIMIT`, DM 2 000, chat de guilde 1 000, bio 280, signalement 500 (E seul) | inc. | DUMP-S (CHECK) ; CAP |
| Pseudo : caractères autorisés, noms réservés, délai de renommage | inconnu | DUMP-S (CHECK, trigger) ; CAP(/signup, /settings) |
| Les 51 succès | 12 connus | DUMP-D (`achievements`) |

### 11.6 Plan de preuve, par ordre de rentabilité

1. **Q, en premier** : accord de l'exploitant, accès au dépôt source (SRC) et `pg_dump --schema-only` (DUMP-S). Ces deux preuves tranchent les points n° 1, 2, 4, 6 et 12 du §11.1, l'essentiel du §11.2 et la majorité des constantes du §11.5.
2. **Agrégats DUMP-D sans PII** : distribution de `count`, brillantes par rareté, raretés tirées en paquet, types de notifications, nombre de lignes par table (la base du rapprochement du §9.3).
3. **CFG** : Supabase Auth et SMTP, Stripe (produits, prix, endpoints de webhook, événements écoutés), Vercel (variables, crons), Cloudflare (Turnstile, WAF).
4. **À défaut de SRC** : campagne CAP depuis un réseau non bloqué, avec un compte gratuit et un compte Pro, sur toutes les pages du §10.3 n° 15. Elle inclut les chunks `/_next/static/chunks/*.js`, qui contiennent les appels du client et souvent les constantes de l'UI (durées, limites, libellés). Le catalogue `cards` est lisible avec la clé anon, mais l'aspirer (environ 2 800 requêtes de 1 000 lignes) suppose l'accord de l'exploitant : ce n'est pas une preuve légitime sans lui.
5. **Questions produit (Q)** : cotes, brillantes, concours et parrainage, sets sponsorisés, politique de modération, outils tiers dont il faut garder la compatibilité.
