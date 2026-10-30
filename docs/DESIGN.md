---
name: WikiCartes
description: Jeu de cartes à collectionner tirées de Wikipédia ; vitrine sombre où seules les cartes éclairent.
colors:
  graphite: "#0d0d0d"
  surface: "#151917"
  surface-light: "#1e2421"
  border: "#2b322e"
  foreground: "#f2f4f3"
  accent: "#34d399"
  accent-light: "#6ee7b7"
  accent-foreground: "#062b1e"
  badge-ink: "#0d1117"
  rarity-c: "#b8f2d5"
  rarity-pc: "#b1cff2"
  rarity-r: "#c6a7f2"
  rarity-sr: "#ed6fa3"
  rarity-ur: "#fa9931"
  rarity-l: "#ffe144"
  rarity-c-dark: "#2b7d58"
  rarity-pc-dark: "#2c5c99"
  rarity-r-dark: "#6439b8"
  rarity-sr-dark: "#a8235b"
  rarity-ur-dark: "#9a4f05"
  rarity-l-dark: "#fa9931"
typography:
  logo:
    fontFamily: "Rubik, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
  page-title:
    fontFamily: "Rubik, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.25
  modal-title:
    fontFamily: "Rubik, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.4
  card-title:
    fontFamily: "Rubik, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.25
  card-title-grid:
    fontFamily: "Rubik, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: 1.25
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
  card-text:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
  card-text-grid:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "9px"
    fontWeight: 400
  badge:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 700
rounded:
  badge: "6px"
  control: "12px"
  panel: "16px"
  full: "9999px"
spacing:
  page-mobile: "16px"
  page-desktop: "24px"
  section: "24px"
  card-inner: "12px"
components:
  card-frame:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
  button-primary-hover:
    backgroundColor: "{colors.accent-light}"
  button-accent-soft:
    backgroundColor: "rgb(52 211 153 / 0.1)"
    textColor: "{colors.accent}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
  nav-link:
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
  nav-link-active:
    backgroundColor: "rgb(52 211 153 / 0.1)"
    textColor: "{colors.accent}"
  rarity-badge:
    textColor: "{colors.badge-ink}"
    typography: "{typography.badge}"
    rounded: "{rounded.badge}"
    padding: "2px 8px"
  card-large:
    rounded: "{rounded.panel}"
    width: "288px"
    height: "420px"
  card-grid:
    rounded: "{rounded.panel}"
    width: "clamp(8.4rem, 43vw, 10rem)"
    height: "clamp(11.8rem, 60vw, 14rem)"
---

# Design System: WikiCartes

> Source de vérité des jetons : le bloc `@theme` de `app/globals.css` (vérifié par `lib/contrast.test.ts`). Ce document l'explique. Références : recap §6.1 à §6.6 et §6.8 (« R§ »), design §8.5 et §8.6 (« D§ »). Le nom affiché vient de `NEXT_PUBLIC_BRAND_NAME` (`lib/brand.ts`) : « WikiCartes » n'est que la valeur par défaut.

## Overview

**Creative North Star : « La vitrine nocturne »**

Une vitrine de collectionneur éteinte : le graphite (`#0d0d0d`) recule, les panneaux à peine plus clairs portent l'interface, et la seule vraie lumière vient des cartes. Chaque rareté a sa couleur, son halo et son fond ; plus la carte est rare, plus elle éclaire autour d'elle. L'émeraude de l'accent sert à agir et à se situer (lien actif, bouton principal, focus), jamais à décorer.

C'est une interface d'usage (Operate) : le joueur ouvre des paquets, trie, vend et échange, souvent et vite. La précision passe avant l'effet ; la personnalité vit dans la carte et dans un seul moment fort, la révélation. Le DOM de la carte et du shell reprend celui de l'original (R§6.3, R§6.4), car des extensions tierces s'en servent comme contrat : les noms de classes sont une API.

Le thème est sombre et rien d'autre (D§2.2) : pas de variante claire, pas de `prefers-color-scheme`. `<html class="dark">` et `color-scheme: dark` alignent les contrôles natifs et les barres de défilement.

**Key Characteristics:**
- Fond graphite, trois plans tonals (fond, surface, surface claire), bordures discrètes.
- Couleur réservée aux cartes (raretés) et à l'action (accent émeraude).
- Titres en Rubik gras, texte courant en Inter.
- Rayons généreux et constants : 16 px pour les cartes et panneaux, 12 px pour les contrôles.
- Mouvement sobre : fondu montant à l'entrée, survol des cartes, balayage des légendaires ; un simple fondu si le système demande moins de mouvement.

## Colors

Une palette quasi monochrome froide (graphite teinté de vert), un accent émeraude, et six couleurs de rareté pastel qui sont les seules zones claires de l'écran.

### Primary
- **Émeraude** (`--color-accent`) : lien actif de la navigation, bouton principal, anneau de focus, icône des en-têtes de page, contour du spinner. 10,1:1 sur le graphite.
- **Émeraude clair** (`--color-accent-light`) : survol du bouton principal ; c'est aussi le « texte accent » relevé sur l'original.
- **Encre d'émeraude** (`--color-accent-foreground`) : texte posé sur un fond émeraude (8:1 sur l'accent, 10:1 sur l'accent clair).

### Secondary : les raretés
Couleurs du site d'origine (R§6.1, deux sources concordantes), à ne pas modifier :
- **Menthe** (`--color-rarity-c`), Commune.
- **Bleu pâle** (`--color-rarity-pc`), Peu commune.
- **Lavande** (`--color-rarity-r`), Rare.
- **Rose** (`--color-rarity-sr`), Super rare : fond à rayures diagonales.
- **Orange** (`--color-rarity-ur`), Ultra rare : fond à ondes.
- **Or** (`--color-rarity-l`), Légendaire : fond scintillant et voile `legendary-shimmer-sheen`.

Chaque rareté a une **teinte foncée** (`--color-rarity-{x}-dark`, celle de L est l'orange UR, comme dans l'original). Le texte du badge est l'**encre de badge** `rgb(13, 17, 23)` (≥ 6,6:1 sur toutes les raretés).

### Neutral
- **Graphite** (`--color-background`) : fond de page, sous le shell.
- **Surface** (`--color-surface`) : barre latérale, barre basse, panneaux `card-frame`, modales.
- **Surface claire** (`--color-surface-light`) : un cran au-dessus de la surface (champ, ligne survolée, bloc dans un panneau).
- **Bordure** (`--color-border`) : séparateurs et contour des panneaux ; purement décorative (1,2 à 1,5:1).
- **Blanc cassé** (`--color-foreground`) : texte courant (17,6:1 sur le graphite, 14,3:1 sur la surface claire).

### Named Rules
**La règle de la seule lumière.** La couleur saturée appartient aux cartes et à l'action. Le chrome (navigation, panneaux, en-têtes) reste graphite et blanc cassé ; une rareté n'en sort que pour qualifier une carte (badge, libellé, halo).

**La règle du plancher à 60 %.** Le texte secondaire s'obtient par opacité du blanc cassé, jamais en dessous de `/60` (≥ 6:1 sur les trois plans). L'original utilisait `/30` pour le bloc méta de la modale (2,5:1) : on le remonte à `/60` (D§8.6). Même logique pour deux autres couleurs relevées dans la modale d'origine : les valeurs ATK et DEF passent de `text-red-700` / `text-blue-700` (2,7 et 2,6:1 sur le panneau) à `text-red-400` / `text-blue-400` (6,1 et 6,7:1), et l'extrait de la grande carte passe de `text-neutral-800/88` (4,45:1 sur le rose SR) au `text-neutral-900/90` de la description (≥ 4,6:1 sur les six fonds).

**La règle de l'encre automatique.** Une étiquette a la couleur choisie par le joueur (`#rrggbb` quelconque) : sa puce prend en texte le noir ou le blanc, celui qui contraste le plus (`inkOn`, `TagPicker.tsx`). Le meilleur des deux dépasse toujours 4,58:1, quelle que soit la couleur. Une étiquette sans couleur prend la surface claire et le blanc cassé.

**La règle des teintes foncées.** Les teintes foncées de C, PC, R, SR et UR ne servent jamais de texte sur le graphite (2,6 à 3,9:1) ni de fond sous un texte noir (2,5 à 3,8:1). Elles servent de trait, de remplissage décoratif, ou de fond sous un texte blanc (5,0 à 7,5:1). **Exception L :** sa teinte foncée est l'orange UR (`#fa9931`), une couleur claire. Le texte blanc y échoue (2,2:1) : elle prend l'encre de badge (8,7:1) ou aucun texte. Ces couples sont vérifiés par `lib/contrast.test.ts`.

## Typography

**Police des titres :** Rubik variable 300–900 (`--font-heading`, repli Arial ajusté)
**Police du texte :** Inter variable 100–900 (`--font-body`, repli Arial ajusté)

**Character :** Rubik apporte des formes rondes et gourmandes, côté jeu ; Inter tient la lecture dense des descriptions et des chiffres. Les deux sont auto-hébergées (`app/fonts/`, sous-ensembles latin et latin-ext de @fontsource-variable 5.3.0, licence OFL) et chargées par `next/font/local` sur `<html>`. `h1`, `h2` et `h3` prennent Rubik par défaut ; le `h3` de la carte garde en plus son `style="font-family:var(--font-heading)"` d'origine.

### Hierarchy
- **Logo** (700, 1,5 rem) : préfixe « Wiki » en accent, le reste en blanc cassé, dans un `h1` lien vers `/pulls`.
- **Titre de page** (700, 1,5 rem puis 1,875 rem dès `md`) : `h1` de `PageHeader`, avec une icône lucide de 24 px en accent.
- **Titre de modale** (700, 1,25 rem) : `h2` de la modale de carte.
- **Titre de carte** (700, 1 rem en grand, 0,75 rem en grille, `leading-tight`, 2 lignes max) : noir sur le fond de rareté.
- **Texte** (400, 0,875 rem, 1,43) : panneaux et modales, 65 à 75 caractères par ligne au plus.
- **Libellé** (500, 0,875 rem) : liens de navigation, boutons.
- **Texte de carte** (400 ; 11 px en grand, 9 px en grille, 10 px dans la modale) : extrait tronqué, la version longue vit dans la modale.
- **Badge** (700, 0,75 rem) : code de rareté.

### Named Rules
**La règle des chiffres français.** Les nombres suivent fr-FR avec une espace fine insécable comme séparateur (« 6 974 », « 1 234 wikibidous »), via `Intl.NumberFormat('fr-FR')`. Ni Rubik ni Inter n'ont ce glyphe (U+202F) : le navigateur le prend dans la police de repli, et comme c'est une espace, seule sa largeur change.

## Layout

Le shell suit R§6.3 : `body > div.flex.h-dvh`, la barre latérale `nav.w-64` (padding 24 px) visible dès `md` (768 px), puis une colonne qui porte l'en-tête (logo et cloche, hors de la `nav` et de `main` ; seul écart au relevé, où `main` est enfant direct) et `main.min-h-0.flex-1.overflow-y-auto` : c'est `main` qui défile, jamais `body`. Sous `md`, la navigation passe en barre basse (`order-last`, surface à 95 % avec flou d'arrière-plan, marge `env(safe-area-inset-bottom)`).

Le conteneur de page est `div.flex-1.p-4.md:p-6.space-y-6` : 16 px de marge sur mobile, 24 px dès `md`, 24 px entre sections. L'en-tête de page est une ligne `justify-between` (titre à gauche, actions à droite). Les grilles de cartes s'appuient sur la taille `clamp()` de la carte de grille : deux colonnes sur un téléphone de 390 px, puis autant que la largeur le permet. Cibles tactiles d'au moins 44 px (D§8.6).

## Elevation & Depth

La profondeur vient d'abord des plans tonals : graphite, surface, surface claire. Les ombres neutres sont absentes du chrome. La seule lumière portée est celle des cartes : le halo `glow-{rareté}`, double, combine un filet net de 1 px et une lueur décalée vers le bas, dont l'intensité croît avec la rareté (30 % pour C et PC, 35 % pour R, 45 % pour SR, 50 % pour UR, 60 % pour L). Les modales s'isolent par un voile noir à 70 % flouté (`backdrop-blur-sm`), pas par une ombre.

### Shadow Vocabulary
- **Halo de rareté** (`box-shadow: 0 0 0 1px <rareté 60 %>, 0 8px 28px -6px <rareté 30 à 60 %>`) : racine de la carte, classes `glow-c` à `glow-l`.
- **Lueur du badge** (`box-shadow: 0 0 10px var(--color-rarity-x)99`) : chaîne d'origine (R§6.4), gardée telle quelle pour le contrat. Elle est **inerte**, sur l'original comme ici : une fois `var()` substitué, `#ffe14499` ne se reforme pas (deux jetons, `#ffe144` puis `99`), la déclaration devient invalide et le badge n'a pas de lueur.

### Named Rules
**La règle de la lumière méritée.** Seule une carte émet de la lumière. Un panneau, un bouton ou une modale n'a jamais de halo coloré.

## Shapes

Des coins généreux et constants, sans biseau ni découpe. Rayon panneau (16 px, `rounded-2xl`) pour les cartes, `card-frame` et les modales ; rayon contrôle (12 px, `rounded-xl`) pour les liens de navigation et les boutons ; rayon badge (6 px, `rounded-md`) pour le badge de rareté ; rond pour le spinner, les points de pagination et les pastilles. Les bordures font 1 px.

Les **fonds de rareté** sont dessinés en CSS, sans image d'origine (D§8.5), et n'utilisent que des voiles blancs, ce qui ne peut qu'augmenter le contraste du texte noir :
- **C, PC, R** (`rarity-bg-c`, `-pc`, `-r`) : couleur pleine, éclairée par le haut.
- **SR** (`rarity-bg-sr`) : rayures diagonales à 135°, 6 px de blanc à 28 % tous les 14 px.
- **UR** (`rarity-bg-ur`) : ondes SVG inline, 40 × 16 px, trait blanc à 35 %.
- **L** (`rarity-bg-l`) : deux trames de points scintillants (22 px et 31 px) et deux reflets diagonaux.

## Components

### Carte (composant signature, R§6.4 et D§8.5)
Le DOM est un contrat. Il est repris tel quel, sauf le premier enfant, qui devient le fond CSS.
- **Racine** : `div.{taille}.glow-{c|pc|r|sr|ur|l}.relative.rounded-2xl.overflow-hidden.cursor-pointer.hover:z-10.transition-all.duration-300.hover:scale-105`. Sur le marché, elle est enveloppée dans `a.card-frame.block.p-3`.
- **Tailles** : grande `w-72 h-[420px]` (révélation, modale) ; grille `w-[clamp(8.4rem,43vw,10rem)] h-[clamp(11.8rem,60vw,14rem)]`.
- **Enfants, dans l'ordre** :
  1. fond `div.absolute.inset-0.rarity-bg-{x}[aria-hidden]`, à la place de l'`img` d'origine ;
  2. dégradé `from-black/10` vers transparent, en `z-10` ;
  3. zone image `top-0 h-[45%] z-20 bg-black/20` : `img[alt=<titre>][loading=lazy][decoding=async]` en `object-cover`, miniature de 330 px d'upload.wikimedia.org ; sans image, l'emblème de **notre** marque à 70 % d'opacité ;
  4. badge `div.absolute.top-2.left-2.px-2.py-0.5.rounded-md.text-xs.font-bold.z-30`, avec `style="background-color: var(--color-rarity-x); color: rgb(13,17,23); box-shadow: 0 0 10px var(--color-rarity-x)99"` ;
  5. favori (copies possédées) : `button[aria-label="Ajouter aux favoris"|"Retirer des favoris"]`, étoile `text-amber-200` ;
  6. zone texte `top-[45%] … p-3 z-20` : `h3` (Rubik, noir), `p` de description, `div.mt-auto` avec la ligne de stats (épées `text-red-800`, bouclier `text-blue-800`) ;
  7. L seulement : `div.absolute.inset-0.z-40.overflow-hidden.pointer-events-none > div.legendary-shimmer-sheen[aria-hidden]`.
- **Sélecteurs à préserver** (R§6.8) : `div[class*="glow-"]` contenant un `h3`, `[style*="--color-rarity"]`, `div.mt-auto`, `top-[N%]`, `.card-frame`.
- **Clavier** : une carte cliquable reçoit dans son `h3`, après le titre, un `button[aria-label=<titre>]` sans texte, étendu sur la zone texte (`h3.textContent` reste le titre). Son focus dessine l'anneau émeraude autour de toute la carte, sans fondu (règle hors calque de `globals.css`). Une carte non cliquable (modale, révélation) garde ses classes mais perd l'invitation au clic : curseur normal, pas d'agrandissement au survol.
- **Coin haut droit** (`flex flex-col items-end gap-1`) : favori, puis `xN` si la copie est en plusieurs exemplaires (encre blanche sur noir à 65 %), puis ✨ « Brillante ». Le favori garde son étoile de 22 px (28 px en grand) mais offre une cible d'au moins 44 px : un `::after` l'agrandit vers l'intérieur de la carte, que `overflow-hidden` ne coupe pas ; son anneau de focus est intérieur pour la même raison.
- **Emblème** (sans image, image masquée, sensible masquée, ou miniature introuvable) : plaque 4:3 blanche à 45 % au filet noir, mot-marque Rubik 800 (préfixe « Wiki » en encre d'émeraude), le tout à 70 % d'opacité ; `role="img"` et le nom de la marque. Une miniature en erreur bascule sur l'emblème plutôt que sur l'icône d'image cassée.
- **Pastille « ami possède »** : `bg-sky-300/65`, encre noire, icône `users`, le pseudo du premier ami tronqué, dans `div.mt-auto` au-dessus des stats ; enveloppée dans un lien de 44 × 44 px vers son profil (voir « Profil, messages et notifications push »).

### Panneaux (`card-frame`)
- **Coins** : rayon panneau (16 px).
- **Fond** : surface ; **bordure** : 1 px, couleur bordure.
- **Padding** : fixé par l'appelant (`p-3` sur le marché, `p-6` dans la modale).

### Boutons
- **Forme** : rayon contrôle (12 px), au moins 44 px de haut (`py-3` avec `text-sm`).
- **Principal** : fond émeraude, texte encre d'émeraude, graisse 600 ; survol en émeraude clair.
- **Accent doux** : fond émeraude à 10 %, texte émeraude (« Mettre aux enchères ») ; désactivé à 45 % d'opacité.
- **Focus** : anneau émeraude de 2 px, décalé de 2 px, sur tout élément focalisable (`:focus-visible` global).

### Navigation
- **Lien** : `a.flex.items-center.gap-3.px-4.py-3.rounded-xl.text-sm.font-medium`, icône lucide puis libellé.
- **Actif** : `bg-[var(--color-accent)]/10 text-[var(--color-accent)]`, un point accent de 1,5 px, `aria-current="page"`.
- **Mobile** : quatre entrées et « Plus » (icône au-dessus d'un libellé de 11 px, cibles de 56 px), qui ouvre une feuille basse : `<dialog>` natif modal, Échap ou un lien la ferment et le focus revient au bouton.

### Modale de carte (R§6.5)
Voile `fixed inset-0 z-50 bg-black/70 backdrop-blur-sm`, puis `div.card-frame.relative.w-full.animate-fade-in-up.p-6.pt-14.sm:pt-6.max-w-2xl.max-h-[90vh].overflow-y-auto`. Contrairement à l'original : `role="dialog"`, piège de focus, fermeture par Échap ou clic sur le voile, focus rendu à l'élément d'origine, bouton `aria-label="Fermer"` (D§8.6). Primitive : `components/ui/Modal.tsx` ; elle écoute Échap et Tab sur `document` (un enfant garde Échap par `preventDefault`) et ramène le focus dans le panneau s'il tombe sur `body`. Un bouton d'action en cours n'est jamais `disabled` (le navigateur poserait le focus sur `body`) : `aria-disabled` et une garde.
- **Titre** `h2` (Rubik, 1,25 rem) et libellé de rareté dans la couleur de la rareté (≥ 6,2:1 sur le panneau), suivi de « · Brillante » si besoin.
- **Onglets** `[role=tablist][aria-label="Vue de la carte"]` : contrôle segmenté sur la surface claire ; l'onglet actif est plein émeraude (encre d'émeraude). Flèches, Début et Fin changent d'onglet. Pastille PRO `bg-violet-500/20 text-violet-300` ; sur l'onglet Marché actif, son fond devient l'encre d'émeraude (le violet sur émeraude ferait 1,2:1).
- **Étiquettes** : titre de section « ÉTIQUETTES » (`text-xs`, `/60`, espacé), puces « #nom » de 32 px (règle de l'encre automatique, tronquées à la largeur de la colonne) dont la croix de retrait est une cible de 44 px (`::after`, lignes espacées de 12 px pour que les cibles ne se chevauchent pas), puis le champ `combobox` de 44 px au contour blanc cassé à 40 % (≥ 3:1). Sa liste s'ouvre à la frappe, aux flèches ou au clic, jamais sur un simple focus ; elle se pose sous le champ, sur la surface claire, avec des options de 44 px hors tabulation (le clavier passe par `aria-activedescendant`), et l'option active prend l'émeraude à 15 % et le texte émeraude clair.
- **Stats** : deux `card-frame` `p-3`, libellé `/60` puis la valeur en `text-2xl` gras, `text-red-400` et `text-blue-400`.
- **Méta** `text-xs /60` : « Q-Score : 51.24 » (deux décimales et un point, comme l'original, R19), « Exemplaires : N » (copie possédée), « Vues (30j) : 6 974 », le lien Wikipédia en émeraude clair, puis la ligne de licence.
- **Actions** : « Défausser » bordé (contour blanc cassé à 40 %), pièce W et « +1 », dans un pied séparé par un filet. Carte du catalogue : « Ajouter à ma liste de souhaits » en accent doux, puis « Retirer de ma liste de souhaits » bordé, avec l'icône `bookmark-check` en émeraude.

### Paquet et révélation (/pulls, R§2.2 et D§8.5)
- **Paquet** (`PackStock.tsx`, notre visuel : jamais l'art d'origine) : une feuille nacrée de 176 × 256 px (`pack-foil`, dégradé blanc teinté des raretés PC, R, C et L), deux sertissages striés (`pack-crimp`), le mot-marque Rubik 800 de la marque configurée (préfixe « Wiki » en encre d'émeraude, taille selon la longueur du nom pour tenir sur une ligne) entre deux bandes des six raretés (`pack-band`), « 5 CARTES » espacé, et une lueur nacrée lavande et bleu pâle dessous (`pack-halo`). Au survol, un reflet traverse la feuille ; pendant l'ouverture, le paquet tremble (`animate-pack-shake`) ; le tout seulement avec mouvement. Stock vide : paquet en niveaux de gris à 50 %.
- **« Ouvrir »** : bouton principal de 48 px de haut. Désactivé (stock vide) : surface claire et texte `/60`, toujours lisible. Pendant la requête : `aria-disabled`, jamais `disabled` (le focus resterait sur le bouton).
- **Stock** : une seule ligne `role="status"` dit « Ouverture du paquet… » pendant la requête et « Plus de paquets disponibles » quand le stock est vide (visible alors, `sr-only` sinon) ; un 403 de stock vide sous le focus passe le focus à la zone du paquet. `card-frame` « n / 10 » (n en émeraude, « / 10 » à `/60`), « paquets disponibles », une barre de 10 segments de 8 px (émeraude pleine ou surface claire, cachée aux lecteurs d'écran : le nombre la dit déjà), puis « Prochain dans » et `span.font-mono` en émeraude, ou « Réserve pleine ». Le compte à rebours suit l'horloge du serveur (`lib/clock.ts`) et ne dépasse jamais la période.
- **Paquet PRO du jour** : `card-frame` titré (icône `sparkles` violette), « 15 cartes, aucune commune » ; « Réservé aux membres Pro » (violet 300 et cadenas), « Récupérer » (violet à 20 %, texte violet 200) ou « Déjà récupéré aujourd'hui, reviens demain à 09:22 ».
- **Révélation** : compteur « Carte **n** / N » (n en émeraude, `text-lg`) et, sur la même ligne, les pastilles « Nouvelle » (émeraude à 15 %, texte émeraude clair) et « Brillante » (ambre à 15 %, texte ambre 200). La grande carte pivote (`animate-card-flip`) ; elle se balaie au pointeur (seuil 80 px, elle suit le doigt et s'incline avec mouvement), aux flèches ← → et aux boutons ronds de 48 px (contour blanc cassé à 40 %, `disabled:opacity-20`). Les points font 12 px (actif en émeraude, `scale-125` ; vus `/40` ; cachés `/15`, désactivés) avec une cible de 44 px par `::after`. « Encore N cartes » reste désactivé (style de « Ouvrir » désactivé) jusqu'à la dernière carte, puis devient « Continuer », plein émeraude. Un bouton qui se désactive sous le focus le passe au suivant logique : « Carte suivante » → « Continuer », « Carte précédente » → « Carte suivante ».
- **Paliers SR, UR, L** : la carte rayonne sa couleur derrière elle (`reveal-glow-{sr|ur|l}`, ellipse de plus en plus large et dense), sous tout le contenu de la révélation. Dès UR, deux faisceaux doux et flous la balaient lentement (16 s par tour), jamais une gloire de rayons. **Cinématique L** (`data-cinematic`, avec mouvement seulement) : un éclair doré unique sur tout l'écran (1,6 s), la carte attend 0,35 s avant de pivoter, et l'arpège de `playLegendary`. Sans mouvement : la lumière apparaît en fondu, sans faisceaux ni éclair.
- **Récapitulatif** : `h2` « Récapitulatif » (focalisé), les cartes en grille avec leurs pastilles dessous, puis « Retour aux paquets » ; le focus revient ensuite sur « Ouvrir ».
- **Sons** (`lib/sounds.ts`) : les nôtres, synthétisés en WebAudio (déchirure en souffle filtré, retournement bref, arpège do-mi-sol-do) ; muets si le joueur les a coupés ou tant que ses préférences ne sont pas lues.

### Collection (/collection, R§2.2)
- **En-tête** : rendu hors du `Suspense` de la page (dans le HTML statique), il n'anime son entrée qu'une fois ; le titre à gauche, le **solde** à droite (pièce W et `formatInt`, pastille sur la surface), lu par `GET /api/wikibidous` et mis à jour par chaque défausse ; une lecture échouée affiche « — » (« Solde indisponible » pour les lecteurs d'écran), relu à la défausse suivante.
- **Barre d'outils** (sur le graphite, jamais dans un panneau) : recherche `input[placeholder="Rechercher par titre ou catégorie..."]` qui prend le focus au chargement, puis deux listes natives de 44 px (« Toutes les étiquettes » avec le nombre de copies de chacune, tri « Trier les cartes », « Rareté » par défaut) et « Sélectionner », bordé, plein émeraude quand le mode est actif. Contours blanc cassé à 40 % (≥ 3:1).
- **Pastilles de rareté** (`RarityChips`) : codes L…C dans leur couleur, avec le style inline d'origine `background-color: var(--color-rarity-x)30; color: var(--color-rarity-x)` (inerte, comme la lueur du badge). Au repos, un contour `--color-border` ; pressée, un contour dans sa couleur et une teinte de 20 % de sa couleur. Un filtre posé, les autres passent à 80 % d'opacité et non à l'`opacity-50` d'origine : le rose SR y tomberait à 2,5:1, alors que 80 % est le plus bas qui garde les six raretés au-dessus de 4,5:1 (règle du plancher, `lib/contrast.test.ts`).
- **Grille** `div.flex.flex-wrap.justify-center.gap-3`, chaque carte dans `div.relative.isolate.group`. Pendant une relecture, le favori d'une tuile est `aria-disabled` (focalisable, sans effet) comme les cases : la relecture en vol écraserait l'étoile posée. En mode sélection, toute la tuile coche sa case (case native émeraude sur une plaque noire à 65 %, en haut au centre) et une carte retenue prend un anneau émeraude.
- **Barre de sélection** : un `card-frame` avec le nombre de cartes retenues (annoncé poliment), « Tout sélectionner », « Appliquer une étiquette », « Retirer l'étiquette » et « Défausser » ; sans sélection, ces trois actions sont `aria-disabled` (texte `/60`, contour décoratif), comme les quatre pendant une relecture de la grille. La sélection survit aux pages, pas aux filtres, au tri ni à la recherche. Chaque action passe par une modale (« Défausser N cartes ? Tu gagneras N wikibidous. Action irréversible. ») ; la confirmation de défausse est un bouton plein `red-700` à texte blanc (`red-800` au survol), distinct d'« Annuler ».
- **Pagination** (`Pagination`) : « ← Précédent », « Page n / m », « Suivant → », boutons bordés de 44 px, bornes en `aria-disabled` (le bouton pressé garde le focus).
- **États** : chargement au spinner du shell ; collection vide (« Ta collection est vide » et « Ouvrir des paquets » en bouton principal) ; aucun résultat (« Aucune carte ne correspond à ces filtres. » et « Effacer les filtres ») ; erreur avec « Réessayer », et « Effacer les filtres » si un filtre est posé ; une valeur d'adresse que l'API refuserait est ignorée. Une tuile retirée sous le focus (défausse, étiquette filtrée) passe le focus à la suivante, ou à l'état vide.

### Catalogue (/global-collection, R§2.2)
- **En-tête** : h1 « Collection Globale », puis « Toutes les cartes existantes dans le jeu » à `/70`.
- **Barre d'outils** (sur le graphite) : champ « Rechercher une carte… » et « Rechercher » bordé, `aria-disabled` tant que le champ est vide (une recherche d'un caractère est refusée sur place : « La recherche demande au moins 2 caractères ») ; vider le champ revient au catalogue entier. Liste « Trier les cartes » à une option, « Rareté » (seul tri de l'API) ; bascule « Liste de souhaits » (`bookmark`, `aria-pressed`, pleine émeraude quand active) ; pastilles de rareté de la collection.
- **Bandeau** `card-frame` : le nombre de cartes de chaque rareté dans sa couleur, puis « 2 000 cartes au total » ; en liste de souhaits, « N cartes dans ta liste de souhaits » ; pendant une recherche, « Recherche active : pas de décompte par rareté ni de total exact ».
- **Grille** `flex flex-wrap justify-center gap-3 sm:gap-[22px] md:gap-[26px]`, cartes posées directement (sans wrapper ni marqueur de possession). Pagination de la collection ; pendant une recherche, le total est inconnu : « Page n » seul, « Suivant » selon `searchHasMore`.
- **États** : chargement au spinner ; erreur « Les cartes n'ont pas pu être chargées. » avec « Réessayer » (et « Effacer les filtres » si un filtre est posé) ; aucun résultat ; liste de souhaits vide (icône `bookmark`, « Voir tout le catalogue »). Une carte retirée de la liste sous le focus passe le focus à la suivante, ou à l'état vide.

### Paramètres (/settings, R§2.2, jamais capturée)
- **Onglet** « Général » (texte émeraude, filet `border-b-2` émeraude), puis quatre sections `card-frame` `p-6` de 42 rem au plus : **Profil**, **Préférences**, **Notifications** (voir « Profil, messages et notifications push »), **Compte**.
- **Profil** : champ « Pseudo » (vérifié au départ du champ, sauf pour un simple changement de casse du sien), aide `/70`, « Enregistrer le pseudo » en bouton principal, inactif tant que rien ne change (surface claire, texte `/60`). Succès en émeraude clair avec la date du prochain changement possible ; refus sous le champ, en `red-300`.
- **Préférences** : trois cases natives émeraude (« Sons », « Masquer les images sensibles », « Profil public »), chacune sur une ligne de 44 px avec son aide `/70` dessous. Enregistrement immédiat de la seule case touchée ; un refus la remet comme avant et le dit ; pour chacune des trois, une issue inconnue (réseau, ≥ 500, 2xx illisible) dit « L'action n'a pas été confirmée : elle a peut-être eu lieu. » et relit la case, comme « Profil public » sur `/profile`.
- **Compte** : « Nouveau mot de passe » et sa confirmation, « Changer le mot de passe » ; sous un filet, « Se déconnecter » bordé (icône `log-out`).
- **États** : chaque section lit ses données seule, avec son spinner et son erreur (« Réessayer » ramène le focus sur le titre de la section) ; une section en échec ne bloque pas les autres. Aucun bouton n'est `disabled` sous le focus : `aria-disabled` et une garde.

### Marché (/marketplace, R§2.2)
- **En-tête** : h1 « Marché », puis « Enchérissez sur des cartes ou vendez les vôtres contre des wikis. » à `/70`.
- **Onglets** `[role=tablist][aria-label="Vues du marché"]` : « Parcourir », « Mes ventes (n/max) », « Mes enchères (n) », « Gagnées », « Historique (n) ». Soulignés, et non le contrôle segmenté émeraude de la modale : l'actif en `border-b-2 border-amber-500 text-amber-600` (≥ 4,5:1 sur la page), les autres en `/70` sur un filet transparent, 44 px de haut. Flèches, Début et Fin ; une seule ligne, qui défile dans son propre conteneur au téléphone (anneau de focus intérieur), jamais la page. Un seul onglet monté à la fois (M3-2).
- **Barre d'outils** (« Parcourir », sur le graphite) : « Rechercher une enchère… » envoyé sur Entrée (un caractère est refusé sur place, comme au catalogue), liste « Trier » (« Récentes », « Prix croissant », « Prix décroissant », « Fin proche »), pastilles de rareté de la collection.
- **Tuile** (`AuctionTile`, DOM du contrat) : `div#marketplace-auction-<uuid> > a.card-frame.block.p-3`, survol sur la surface claire, aucun contrôle dans le lien. La carte en taille grille, face figée à la mise en vente (P30), puis, à la largeur de la carte : une ligne d'états en `text-xs` gras (« Possédée », « En tête », « Gagnée » en émeraude clair ; « Surenchéri » en `red-300` ; « Perdue », « Invendue », « Retirée » à `/70` ; « Vendue pour N wikibidous » en blanc cassé), « Mise de départ » ou « Mise actuelle » (libellé `/70`, montant gras `tabular-nums` et pièce W), « Durée » et son compte à rebours, « Vendu par X » tronqué (`p.truncate`). Couleurs vérifiées sur la surface et la surface claire (`lib/contrast.test.ts`).
- **Compte à rebours** (`Countdown`) : `time[datetime]` en `text-amber-600 tabular-nums`, « 3m 18s », « 1h 02m 05s », « 45s », sur l'horloge du serveur (`lib/clock.ts`) ; « Terminée » une fois échue, ou dès que la vente n'est plus active (une retirée garde son `end_at`).
- **Liste** : lots de 50 et « Charger la suite » bordé, qui ajoute au DOM ; relue toutes les 15 s, onglet visible seulement (`lib/poll.ts`). États vides dans un `card-frame` centré ; erreur avec « Réessayer ». Une tuile ou « Charger la suite » retirés sous le focus par une relecture passent le focus à la tuile de même rang, à la dernière, ou à l'état vide.
- **Détail** (`/marketplace/[id]`, aucun `id` d'élément) : « Retour au marché » en émeraude clair, la carte, puis l'en-tête de page, dont le titre passe à la ligne n'importe où (`wrap-anywhere`) : un long mot ne fait jamais défiler la page à 360 px. À droite, deux boutons ronds de 44 px bordés `/40` : « Liste de souhaits » (bouton bascule à libellé fixe, `aria-pressed`, `bookmark-check` émeraude quand la carte y est) et « Analyse du marché » (`chart-line`, ouvre la modale de `MarketPanel`). Puis « Vendu par X », l'issue en gras (« En tête », « Remportée » en émeraude clair ; « Vendue pour N wikibidous » ; « Invendue » à `/70`), le panneau du prix (`card-frame` `p-4`, « Mise de départ / actuelle », « Durée ») et l'« Historique des mises » (`ol` dans un panneau à filets, « pseudo · N wikibidous · date »).
- **Miser** (`BidBox`) : champ « Montant de la mise » de 44 px, prérempli avec le minimum suivant et qui le suit tant qu'on ne l'a pas touché, puis « Miser » en bouton principal. Un refus s'affiche en `red-400` sous le formulaire et tombe quand une autre mise (ou une baisse) change le minimum qu'il décrivait.
- **Actions du vendeur** : « Retirer » et « Baisser le prix » bordés, tant qu'aucune mise n'est arrivée (la baisse après la moitié de la durée, une fois) ; « Nouveau prix » et « Valider » ; « Finaliser la vente » en bouton principal à l'échéance. Tous en `aria-disabled` pendant leur requête. Un contrôle qui disparaît sous le focus (refus relu, relecture, règlement) passe le focus à l'issue, sinon au panneau du prix.
- **Boîte de vente** (`SellBox`, modale de carte) : « Mettre aux enchères » en accent doux (`aria-expanded`) ouvre un `card-frame` `p-4` : « Mise de départ » (44 px, 10 par défaut, focalisée à l'ouverture), « Durée » en six boutons de 44 px sur trois colonnes (`aria-pressed`, le choisi plein émeraude), « Marché · <rareté> : N wikibidous » (ou « aucune vente récente ») sur la surface claire, puis « Lancer l'enchère » en bouton principal sur toute la largeur.
- **Analyse du marché** (`MarketPanel` : modale du détail, onglet « Marché » de la modale de carte) : une ligne par rareté vendue, « Marché · Rare : N wikibidous (n ventes) », puis « VENTES RÉCENTES » (Pro) ou « Fonction réservée aux membres Pro » à `/70`.
- **Montants** : `formatInt` (espace fine) puis `wikibidous(n)` (`lib/format.ts`) : « 0 wikibidou », « 1 wikibidou », « 2 wikibidous » ; les messages d'erreur du SQL gardent leur pluriel.

### Amis et échanges (/friends, /trades, R§2.2 et M4-15)
- **Amis** (`/friends`) : h1 « Amis » ; un seul champ `input#friend-list-search` (`type="search"`, « Rechercher un joueur »), envoyé sur Entrée, refusé sur place sous 2 caractères avec le texte du serveur ; résultats en liste dans un `card-frame` à filets, chacun avec « Ajouter ». Trois sections à h2 : « Demandes reçues » (« Accepter », « Refuser », et « Tout accepter » dès une demande), « Demandes envoyées » (« Retirer », sans confirmation), « Amis » (« Message » vers `/dms?with=<id>`, « Échanger » vers `/trades/new?with=<id>`, et « Retirer » qui ouvre une modale : « Retirer {pseudo} de tes amis ? Les échanges en attente entre vous seront annulés. »). Le pseudo décrit chaque bouton (`aria-describedby`) ; les longs pseudos passent à la ligne n'importe où.
- **Onglets des échanges** `[role=tablist][aria-label="Vues des échanges"]` : « Reçues », « Envoyées », « Historique », soulignés comme au marché (actif `border-b-2` accent, les autres à `/70`), 44 px, flèches, Début et Fin (`tabKey`), un seul panneau monté. « Historique » garde l'ordre de la réponse ; une offre échue sans passage du cron y apparaît en « · Expiré ».
- **Carte d'offre** (`TradeCard`, DOM du contrat) : `div.card-frame.p-4 > button[aria-label="Voir le détail de l'échange"]`, survol sur la surface claire. Dans le bouton : « De {pseudo} », le statut coloré (« · En attente » `amber-600`, « · Accepté » `green-400`, « · Refusé » `red-400`, « · Contre-offre » `sky-400`, « · Annulé » et « · Expiré » à `/60`) et la date courte `fr-FR` dans un `time` ; puis deux colonnes « {pseudo} offre » et « En échange de » séparées par `arrow-left-right`, avec les puces et le montant (`formatInt` + `wikibidous(n)`) s'il est non nul. Une description `sr-only` « De {pseudo} · {statut} · {date} » distingue les offres sans toucher au nom figé du contrat.
- **Puces** (`ItemChips`) : `span[title=<titre complet>]` « SR · <20 premiers caractères>… » sur fond `var(--color-rarity-<r>)22`, comme les pastilles de rareté.
- **Détail** (`/trades/[id]`) : h1 « Détail de l'échange », « De {pseudo} à {pseudo} », le lien « Message à {pseudo} » vers le fil de l'autre participant, le statut sans « · » dans un `p` focalisable (cible du focus quand les boutons disparaissent), « Expire dans » + `Countdown`, les deux colonnes de la carte. Destinataire d'une offre en attente : « Accepter », « Refuser », lien « Contre-offre » ; initiateur : « Annuler ». Liens « Voir l'offre d'origine » et « Voir la contre-offre ». Un refus s'affiche en alerte jusqu'à l'action suivante ; une issue incertaine dit « L'action n'a pas été confirmée : elle a peut-être eu lieu. L'échange se met à jour. » et tombe quand le statut affiché change. 404 : « Échange introuvable » et « Retour aux échanges ».
- **Composer** (`/trades/new?with=<id>`, `&parent=<id>` pour une contre-offre préremplie à l'inverse) : h1 « Nouvel échange » ou « Contre-offre », « Échange avec {pseudo} », deux panneaux `card-frame` `p-4` côte à côte dès `md` : « Tu offres (n/100) » et « Tu demandes (n/100) », chacun avec son filtre (« Filtrer mes cartes », « Filtrer ses cartes »), « Charger la suite » par lots de 50, une quantité par pile (`input type="number"`, « Quantité de {titre} »), la marque « Déjà dans un échange » (copie toujours offrable) et la liste « Tes choix » (titre, quantité, « Retirer »). « Wikibidous offerts » et « Wikibidous demandés » : 5 chiffres, collage nettoyé. « Proposer l'échange » ou « Envoyer la contre-offre » en bouton principal, `aria-disabled` sans carte ; le formulaire est figé pendant l'envoi.
- **Cloche** : bouton `relative p-2 rounded-xl` de 44 px au nom figé « Notifications », badge rouge à côté du bouton (« 9+ » dès 10, rien à 0, `aria-hidden`), compte lu par `aria-describedby` (« Aucune notification non lue », « 1 notification non lue »…). Un seul poller partagé de 30 s, onglet visible. Le panneau (`Modal` « Notifications ») liste les 50 dernières, non lues en gras, avec leur date, un lien par type, « Marquer comme lu » et « Tout marquer comme lu ».
- **Relecture** : `/trades` et le détail toutes les 20 s, onglet visible ; `/friends` relit après chaque action et à chaque lecture appliquée du store partagé de la cloche (sa version, pas son compte plafonné à « 9+ »), donc toutes les 30 s onglet visible, et après un marquage comme lu. Une offre ou une ligne retirée sous le focus passe le focus à la suivante de même rôle, sinon à l'état vide.

### Profil, messages et notifications push (/profile, /profile/[username], /dms, /settings, R§2.2)
Écrans jamais capturés (M4b-24) : aucun sélecteur du contrat ne les vise ; règles de la maison (`PageHeader`, aucun id fixe hors ceux des sections de `/settings` (`settings-notifications` s'y ajoute), sinon des ids de `useId()`, `Card` pour toute copie, cibles de 44 px, `aria-disabled` et une garde, `data-ready`).
- **Profil public** (`/profile/[username]`, titre de document « Profil ») : h1 au pseudo, et à droite la rangée d'actions : « Modifier mon profil » bordé sur le sien ; pour un ami, « Message » en bouton principal et « Proposer un échange » bordé ; pour un non-ami, « Ajouter en ami » (principal), « Accepter sa demande » (principal) s'il a demandé, ou le texte « Demande envoyée » ; « Signaler » bordé pour tout autre que soi. Puis un `card-frame` `p-6` : l'avatar de 96 px, « Membre depuis {mois année} » à `/70`, la bio (retours à la ligne gardés, coupure n'importe où) et, quand la vue est permise, le nombre de cartes de chaque rareté dans sa couleur (`ul[aria-label="Cartes par rareté"]`, libellé complet pour les lecteurs d'écran), comme au catalogue.
- **Vitrine et collection** (soi, un ami ou un profil public) : onglets `[role=tablist][aria-label="Vues du profil"]` « Vitrine » et « Collection », soulignés comme aux échanges (actif `border-b-2` émeraude, les autres à `/70`), 44 px, flèches, Début et Fin (`tabKey`), un seul panneau monté ; l'onglet n'entre pas dans l'adresse. Vitrine : les cartes posées en taille grille, dans l'ordre des emplacements, sans case pour un emplacement vide ; une carte ouvre la modale de carte, qui porte la licence et le crédit de l'image ; vide, « Aucune carte en vitrine. » dans un `card-frame`. Collection : champ « Rechercher dans sa collection » (`type="search"`, envoyé sur Entrée, vidé → toute la collection), grille du catalogue par pages de 50 et `Pagination` ; vide, « Sa collection est vide. », ou « Aucune carte ne correspond à ces filtres. » pendant une recherche.
- **Profil privé vu d'un non-ami** : pseudo, avatar et « Membre depuis » seulement, sans bio ni décompte, puis « Ce profil est réservé aux amis. » dans un `card-frame` à la place des onglets ; les actions d'amitié et « Signaler » restent. Un profil passé privé pendant la lecture (403 de la vitrine ou de la collection) prend le même état pour le décompte et les onglets (« Ce profil est réservé aux amis. ») ; la bio déjà lue reste affichée jusqu'à la relecture suivante du profil.
- **États du profil** : « Chargement du profil », puis « Chargement de la vitrine » et « Chargement de la collection » ; un pseudo inconnu donne un `card-frame` centré au h1 « Joueur introuvable » (focalisable) et « Retour aux amis » ; un échec, « Impossible de charger cette page. » et « Réessayer » (`LoadError`), pour le profil comme pour chaque panneau. Aucun polling : relu à chaque affichage (Activity compris), après chaque action et sur « Réessayer ». Une action d'amitié donne son toast (« Demande envoyée à {pseudo}. », « {pseudo} fait maintenant partie de tes amis. »), ou « L'action n'a pas été confirmée : elle a peut-être eu lieu. », puis relit le profil.
- **Signaler** : modale « Signaler {pseudo} » de 28 rem, « Chargement du signalement », puis le formulaire prérempli par le signalement déjà fait : l'aide « Un seul signalement par joueur : tu peux le modifier. », un `fieldset` « Motif » de radios natives de 44 px (« Triche », « Contenu inapproprié », « Spam »), « Détails (facultatif) » (500 caractères, compteur « {n} / 500 » à droite), puis « Envoyer le signalement » ou « Modifier le signalement » (principal, `aria-disabled` sans motif) et « Annuler » bordé. Formulaire figé pendant l'envoi (`readOnly`, ni Échap, ni voile, ni « Annuler ») ; un refus ou une issue incertaine s'affiche en alerte `red-400` sous les détails et tombe dès que le motif ou les détails changent ; un succès donne le toast « Signalement envoyé. » ou « Signalement modifié. », et le focus revient à « Signaler ».
- **Éditeur** (`/profile`) : h1 « Profil » et « Voir comme les autres » bordé (vers son profil public, pseudo encodé). Quatre sections `card-frame` `p-6` de 48 rem au plus, chacune avec son chargement, son échec (« Ton profil n'a pas pu être chargé. », ou « Impossible de charger cette page. » pour la vitrine, et « Réessayer ») et sa garde :
  - « Avatar » : l'avatar de 96 px, « Changer l'avatar » et, s'il y en a un, « Retirer l'avatar », bordés ; toasts « Avatar changé. » et « Avatar retiré. » ;
  - « À propos » : zone de texte de 280 caractères (compteur « {n} / 280 », plus strict que le serveur), « Enregistrer » en bouton principal, `aria-disabled` tant que rien ne change, puis « Profil enregistré. » en émeraude clair (`role="status"`) ;
  - « Visibilité » : case « Profil public » de 44 px et son aide « Décochée, seuls tes amis voient ta bio, ta vitrine et ta collection. », la même que dans `/settings` ; enregistrée tout de suite, elle revient comme avant sur un refus, et prend la valeur relue sur une issue incertaine ;
  - « Vitrine ({n}/4) » : quatre emplacements en taille grille ; occupé, la carte puis « Changer » et « Retirer » (bordés, décrits par le titre de la carte) ; vide, une case pointillée de la taille d'une carte, icône `plus` émeraude et « Ajouter une carte à l'emplacement {n} » ; toasts « Vitrine mise à jour. » et « Carte retirée de la vitrine. ».
  Un refus ou une issue incertaine (« L'action n'a pas été confirmée : elle a peut-être eu lieu. ») s'affiche en alerte `red-400` dans sa section, et tombe dès que l'état affiché de la section change.
- **Choix d'une carte** (`CardPicker`) : modale « Choisir ton avatar » ou « Choisir une carte pour la vitrine » de 48 rem, « Annuler » en tête, champ « Filtrer mes cartes » envoyé sur Entrée, ses copies par pages de 50 et « Charger la suite » bordé. Pour l'avatar, une copie sans image utilisable reste visible, sans clic, légendée « Sans image ». Un choix à la fois : cartes en `aria-disabled`, ni Échap, ni voile, ni « Annuler » pendant la requête ; un refus reste affiché en alerte dans la modale, qui reste ouverte ; l'alerte tombe au filtre suivant, à « Réessayer », à « Charger la suite » et au choix suivant. « Charger la suite » en échec garde les cartes déjà listées et le dit en alerte (« Impossible de charger cette page. ») ; une première page en échec donne « Impossible de charger cette page. » et « Réessayer » à la place de la grille. Sans copie : « Aucune carte. ». Les copies s'y montrent sans crédit d'image, comme les emplacements de l'éditeur (écart D§3.4, reporté au M7).
- **Avatar** (`components/ui/Avatar.tsx`) : la miniature Commons en lien direct (sans l'optimiseur de Next), ronde, `object-cover`, `alt=""` puisqu'elle est à côté du pseudo (D:753) ; sans avatar, l'initiale du pseudo en émeraude gras sur un disque de surface claire, `aria-hidden`. 96 px sur `/profile` et `/profile/[username]` (initiale en `text-4xl`), 40 px dans la liste de `/dms`. Ni auteur ni licence (écart D§3.4, M7).
- **Conversations** (`/dms`) : h1 « Messages ». Deux colonnes dès `md` (la liste sur 20 rem au plus, puis le fil) ; dessous, la liste seule ou le fil seul. Liste « Conversations » dans un `card-frame` à filets : chaque entrée est un lien d'au moins 44 px vers `/dms?with=<id>`, avec l'avatar de 40 px, le pseudo, la date courte à `/70` et le dernier message sur une ligne (à `/70` une fois lu) ; une conversation non lue passe en gras avec une pastille émeraude de son nombre (« 1 message non lu », « {n} messages non lus » pour les lecteurs d'écran) ; celle qui est ouverte prend la surface claire et `aria-current="page"`. Vide : « Aucune conversation. » et « Écris à un ami depuis la page Amis. » (« Amis » en lien). Sans fil ouvert, la colonne de droite dit « Choisis une conversation. ». La liste se relit à chaque affichage, à chaque lecture appliquée de la cloche et après chaque envoi, sans poll propre ; « Chargement des conversations », ou « Impossible de charger cette page. » et « Réessayer ».
- **Fil** (`/dms?with=<id>`) : sous `md`, « ← Conversations » en tête ; un `h2` focalisable au pseudo, en lien vers son profil ; puis `div[role="log"]` « Messages avec {pseudo} » : les bulles du joueur à droite sur émeraude à 15 %, celles du pair à gauche sur la surface claire, le texte avec ses retours à la ligne, l'heure à `/70` dessous, et la date longue centrée à chaque nouveau jour ; « Toi : » ou « {pseudo} : » pour les lecteurs d'écran. Vide : « Aucun message pour l'instant. ». C'est `main` qui défile, jamais le fil : à l'ouverture jusqu'au dernier message, puis vers chaque message neuf si le joueur était en bas (défilement doux, d'un coup sans mouvement). La saisie reste collée en bas (`sticky`, filet au-dessus) : « Ton message » (2 000 caractères), « Entrée pour envoyer, Maj+Entrée pour aller à la ligne. », le compteur « {n} / 2 000 » et « Envoyer » en bouton principal, `aria-disabled` à vide ou pendant l'envoi (champ en `readOnly`). Entrée envoie, Maj+Entrée va à la ligne ; une composition IME (et le `keyCode` 229 de Safari) n'envoie rien, une touche tenue n'envoie qu'une fois. Poll de 5 s tant que la page est visible ; les messages reçus sont marqués lus par le `PATCH` direct, ce qui éteint aussi la notification de la cloche.
- **États du fil** : « Chargement des messages » ; un échec donne « Réessayer », et un poll en échec laisse le fil affiché, brouillon compris ; un pair inconnu ou une adresse invalide, un `card-frame` « Joueur introuvable » (`h2` focalisable) et « Retour aux messages » ; s'ils ne sont plus amis, l'historique reste lisible et la saisie laisse place à « Vous devez être amis pour vous écrire » (focalisable) et au lien « Profil de {pseudo} ». Un refus garde le texte dans le champ et reste en alerte jusqu'à l'envoi suivant ; une issue incertaine dit « Le message n'a pas été confirmé : il a peut-être été envoyé. La conversation se met à jour. » jusqu'au premier message neuf lu, et le même texte renvoyé rejoue la réponse stockée au lieu d'écrire deux fois.
- **Boutons « Message »** : « Message » bordé sur chaque ami de `/friends`, « Message » principal sur le profil d'un ami, et le lien « Message à {pseudo} » (émeraude clair, icône `message-circle`) sous « De {pseudo} à {pseudo} » au détail `/trades/[id]`, le bouton d'offre du contrat restant seul dans sa carte. Tous mènent à `/dms?with=<id>`, comme le lien de la cloche pour « {u} t'a écrit » et le clic sur un push de message.
- **Pastille « ami possède »** (`Card`) : un lien vers `/profile/<pseudo>` (pseudo encodé), au nom « Profil de {pseudo} », peint au-dessus du bouton du `h3` ; sa boîte fait au moins 44 × 44 px et monte de 28 px sur la description (`min-h-11 min-w-11 -mt-7`), la pastille restant à sa place en bas. Son clic n'ouvre pas la modale de la carte.
- **Notifications** (`/settings`, section « Notifications », entre « Préférences » et « Compte ») : quatre cases de famille de 44 px, « Messages », « Échanges », « Amis » et « Marché », chacune enregistrée tout de suite pour tous ses types (un refus la remet comme avant, une issue inconnue prend la valeur relue), puis l'aide « Ces choix valent pour tous tes appareils. ». Une ligne `role="status"` (jamais une alerte) dit l'état de l'appareil : « Notifications activées sur cet appareil. », « Les notifications sont bloquées pour ce site : autorise-les dans les réglages de ton navigateur. », « Ton navigateur ne gère pas les notifications push. », ou « Les notifications push ne sont pas disponibles pour l'instant. » quand le serveur n'a pas de clés. Un seul bouton bordé, « Activer sur cet appareil » ou « Désactiver sur cet appareil », présent seulement quand l'appareil peut s'abonner ; tant qu'aucune famille n'est cochée, « Activer » est `aria-disabled` et décrit par « Coche d'abord au moins une famille. ». « Bloquer » à l'invite du navigateur mène à l'état bloqué, sans bouton ni alerte. Un échec connu de l'activation dit « L'activation a échoué, réessaie. », celui d'une case le texte du serveur, à défaut « L'action n'a pas abouti. » ; celui de « Désactiver » toujours « L'action n'a pas abouti. » ; et une issue inconnue « L'action n'a pas été confirmée : elle a peut-être eu lieu. », en alerte `red-400` qui tombe quand l'état affiché change. Chaque affichage renvoie l'abonnement présent de l'appareil, et « activées » n'est dit qu'après la réponse du serveur. « Désactiver » et « Se déconnecter » désabonnent d'abord le navigateur, puis retirent la ligne du serveur ; « Se déconnecter » retire la ligne même si le désabonnement du navigateur échoue, et ni l'un ni l'autre ne bloque la déconnexion. États : « Chargement des notifications push » ; « Tes notifications n'ont pas pu être chargées. » et « Réessayer ».
- **Notification système** (`public/sw.js`, sans gestionnaire `fetch`) : le titre est le nom de la marque configurée, arrivé dans la charge ; le texte est celui de la cloche (« {u} t'a écrit », jamais le contenu d'un message), avec l'icône du site ; une charge vide, illisible ou sans titre prend le titre neutre « Nouvelle notification ». Le clic met au premier plan l'onglet déjà sur l'adresse, sinon en ouvre un ; une adresse malformée ou d'une autre origine devient `/`.
- **Focus** : jamais sur `body`. Quand le contrôle focalisé disparaît, un effet après rendu le place, seulement si le focus est tombé sur `body` (ou sur la modale, dans le choix d'une carte) ; « Réessayer » d'un panneau de `/profile/[username]`, d'une section de `/profile` ou de `/settings`, celui du choix d'une carte, et « Bloquer » le posent d'emblée, dès le clic, sur leur titre (le h1 pour un panneau du profil) :
  - `/profile/[username]` : après une action d'amitié, le premier contrôle de la rangée d'actions ; après « Réessayer », le h1, « Joueur introuvable » ou le « Réessayer » revenu ; « Réessayer » d'un panneau passe le focus au h1 ; une page de collection changée le met sur son « Réessayer » si elle échoue, sinon sur sa première carte ou sur le texte vide ; la modale de signalement fermée le rend à « Signaler » ;
  - `/profile` : « Retirer l'avatar » → « Changer l'avatar » ; un emplacement rempli ou vidé → son premier bouton ; « Réessayer » d'une section → le titre de la section ; le choix d'une carte fermé rend le focus au bouton qui l'a ouvert ; dans le choix, « Charger la suite » → la première carte arrivée (sinon le titre de la modale), et son « Réessayer » → le titre ;
  - `/dms` : « ← Conversations » → l'entrée du pair dans la liste, sinon le h1 « Messages » ; « Réessayer » de la liste → la première conversation, sinon le h1, seulement si « Réessayer » tenait le focus ; une relecture qui réordonne la liste rend le focus au lien qu'il quittait ; l'ouverture d'un fil → son titre, sans défilement ; la saisie remplacée quand l'amitié tombe → « Vous devez être amis pour vous écrire » ;
  - `/settings` : un seul bouton renommé, donc « Activer sur cet appareil » ↔ « Désactiver sur cet appareil » garde le focus, et un échec le laisse sur le même bouton ; « Bloquer » à l'invite, qui retire le bouton → le titre « Notifications » ; « Réessayer » de la section → son titre.

### Batailles (/battle, /battle/[id], D§7.7 et R§3.9)
Écrans jamais capturés (R:736) : aucun sélecteur du contrat ne les vise ; règles de la maison (`PageHeader` à l'icône `swords` de l'entrée « Bataille », aucun id fixe hors ceux de `useId()`, `Card` pour toute carte affichée, cibles de 44 px, `aria-disabled` et une garde, jamais `disabled`, `data-ready`, nombres par `formatInt`).
- **Lobby** (`/battle`) : h1 « Bataille » et, à droite, « Comment ça marche ? » (`HelpDialog`, la `Modal` de `/pulls` au h2 « Comment ça marche ? » et au bouton « Fermer l'aide »), dont chaque valeur vient de `wm.config` (clé `rules` de `GET /api/battles`, M5a-16) et qui n'annonce aucun point de guilde (M5a-2). Puis un `card-frame` du quota : « {n} / {limite} défis aujourd'hui » en gras et, quota atteint, « Nouveaux défis à {heure} » à `/70`, lu dans le fuseau du navigateur.
- **« Défier un ami »** (`Section`, titre focalisable) : la liste des amis à filets, chaque pseudo en lien vers son profil (encodé) et, à droite, « Défier » en bouton principal, ou le lien « Voir la bataille » quand une bataille est ouverte avec lui ; chaque contrôle est décrit par le pseudo. Quota atteint : « Tu as utilisé tes {limite} défis du jour. » à `/70`, et « Défier » en `aria-disabled`, décrit aussi par ce texte. Un défi abouti mène à l'arène, seulement si la page est encore affichée, avec le toast « Défi envoyé à {pseudo}. » ou « Une bataille est déjà en cours avec {pseudo}. ». Un refus (429 compris) ou une issue incertaine s'affiche en alerte `red-400` sous la liste. Sans ami : « Aucun ami à défier. » et « Ajoute des amis depuis la page Amis. » (« Amis » en lien). Échec : « Tes amis n'ont pas pu être chargés. » et « Réessayer ».
- **Onglets** `[role=tablist][aria-label="Vues des batailles"]` : « En cours » et « Terminées », soulignés comme aux échanges (actif `border-b-2` accent, les autres à `/70`), 44 px, flèches, Début et Fin (`tabKey`), sur une ligne qui défile dans son conteneur au téléphone, un seul panneau monté. Chaque bataille est un lien `card-frame` vers l'arène : « Contre {pseudo} », la date courte dans un `time`, et à droite la ligne d'état. Couleurs des statuts reprises des échanges : « Victoire » `green-400`, « Défaite » `red-400`, « Annulée » à `/60` ; les autres (« Défi reçu : à toi de répondre », « En attente de {pseudo} », « Choix des cartes », « À toi d'attaquer », « À toi de répondre », « Tour de {pseudo} ») dans la couleur du texte. Vides : « Aucune bataille en cours. », « Aucune bataille terminée. ». Échec : « Tes batailles n'ont pas pu être chargées. » et « Réessayer » ; « Chargement des batailles », « Chargement des amis ».
- **Arène** (`/battle/[id]`) : h1 « Bataille » avec le lien « Retour aux batailles » à droite, puis un h2 focalisable « {moi} contre {adversaire} », puis un `card-frame` qui porte l'écran du moment :
  - défi reçu : « {pseudo} te défie. », « Expire dans » + `Countdown`, « Accepter » (principal) et « Refuser » (bordé) ; défi envoyé : « En attente de la réponse de {pseudo}. » et « Retirer le défi » (bordé) ;
  - choix des cartes (`DeckSlots`) : h3 « Choisis tes 3 cartes », trois emplacements comme la vitrine de `/profile` (occupé : la carte, « Changer » et « Retirer » bordés ; vide : la case pointillée de la taille d'une carte, icône `plus` et « Ajouter une carte à l'emplacement {n} »), remplis par `CardPicker` en mode deck (« Choisir une carte pour ton deck ») ; « Il te faut 3 cartes différentes de ta collection. » et le lien « Ouvrir des paquets » ; « PV de ton deck : {n} » (somme des DEF) ; « Choisis 3 cartes différentes. » en `red-400` sur un doublon ; « Valider mon deck » (principal), `aria-disabled` et décrit par sa raison tant que le deck n'est pas prêt ; deck validé : « Deck validé. En attente du deck de {pseudo}. » ;
  - partie : « À toi d'attaquer : choisis une carte. » ou « {pseudo} choisit sa carte d'attaque. » ; pendant le quiz de l'autre, « {pseudo} répond aux questions : {k} / {n} » ;
  - quiz (`QuizForm`), une question à la fois, sans minuteur : h3 « Question {k} / {n} », l'énoncé en `legend` d'un `fieldset`, quatre radios natives de 44 px au même `name` (un arrêt de tabulation, les flèches pour choisir), « Valider ma réponse » (principal, `aria-disabled` sans choix) ; après la réponse, la question reste figée sur le choix, et le retour `role="status"` dit « Bonne réponse ! » en `green-400` ou « Mauvaise réponse. La bonne réponse était : {texte} » en `red-400`, avec « Continuer ». Dessous, en `text-xs` à `/70` : « Questions tirées de l'article Wikipédia « {titre} », texte sous licence CC BY-SA 4.0. », titre et licence en liens (C21). Aucune modale de carte pendant le quiz (M5a-10) ;
  - fin : h2 « Victoire ! » en `green-400` ou « Défaite » en `red-400`, la récompense « +{n} » suivie de `wikibidous(n)`, « Retour aux batailles » (lien) et « Nouveau défi » (principal) ; annulée : « Bataille annulée ».
  Sous l'écran : un refus ou une issue incertaine (« L'action n'a pas été confirmée : elle a peut-être eu lieu. La bataille se met à jour. ») en alerte `red-400`, attachée à l'écran qu'elle décrit ; quand c'est au joueur de jouer, « Sans action de ta part avant le {date}, la bataille sera annulée » ou « …, tu perds la partie » à `/70` ; et « Abandonner » (bordé), qui ouvre la modale « Abandonner la bataille ? » (« La bataille sera annulée. » en choix des cartes, « Tu perdras la partie. » en partie ; « Abandonner » en rouge plein, « Annuler » bordé). La modale fige la phase annoncée et se ferme si elle change ; un abandon dont la phase a changé entre-temps reçoit « La bataille a changé : relis-la avant d'abandonner. ».
- **Panneaux de PV** (dès que le deck d'un joueur est posé ; celui de l'adversaire à partir de la partie, M5a-11) : deux `section` `card-frame` côte à côte dès `lg`, le joueur puis l'adversaire : le pseudo, « PV {n} / {max} » en chiffres tabulaires, une barre de `h-2` (`aria-hidden`) remplie en accent, puis les trois cartes en taille grille, faces figées au deck (sans catégorie, C4) ; sous chacune, « Déjà utilisée » à `/70`, ou « Attaquer » (principal, décrit par le titre) quand c'est au joueur d'attaquer.
- **Journal** : `div[role="log"]` « Déroulé de la bataille », une ligne par tour dans un `card-frame` : « Tour {n} : {pseudo} attaque avec {titre}. » puis « Aucune erreur : aucun dégât. » ou « {k} mauvaise réponse » / « {k} mauvaises réponses » « sur {n} : {d} dégâts. » (pluriel accordé).
- **Relecture** : l'arène toutes les 3 s tant que la bataille est ouverte (en pause pendant une action), le lobby toutes les 15 s, onglet visible, et toutes deux à chaque affichage. États de l'arène : « Chargement de la bataille », `LoadError` et « Réessayer », et un `card-frame` centré au h1 « Bataille introuvable » avec « Retour aux batailles » (404, ou une bataille d'autres joueurs).
- **« Défier » sur le profil** (`/profile/[username]`, entre amis, M5a-15) : bouton bordé dans la rangée d'actions, même suite que le lobby ; en échec, l'alerte sous les actions et le focus reste sur « Défier ».
- **Focus** : jamais sur `body` (Global Constraints du plan) : « Réessayer » des batailles → l'onglet sélectionné, sinon le h1 ; une bataille sortie de l'onglet → celle de même rang, sinon l'état vide ; « Accepter », « Refuser » et « Retirer le défi » → le h2 ; un emplacement rempli → son « Changer », « Retirer » → « Ajouter une carte à l'emplacement {n} » ; « Valider mon deck » → la ligne d'état, ou, si ce deck lance la partie, le premier contrôle utile (« Attaquer » chez le challenger), sinon le h2 ; « Attaquer » → la ligne d'état ; « Valider ma réponse » → le retour ; « Continuer » → la question suivante, sinon la ligne d'état, sinon « Victoire ! » ou « Défaite » ; un écran changé par le poll → son premier contrôle utile, sinon le h2.

### Message bref (toast)
`components/ui/toast.ts` : un panneau `card-frame` (`px-4 py-3`, `text-sm` 500) dans une région `role="status"` fixée en bas de l'écran, au-dessus de la barre basse sur mobile ; il entre en `motion-safe:animate-fade-in-up` et disparaît après 4 s. Il vit hors de React pour survivre à la modale qui l'émet (« Carte défaussée : +1 wikibidou »).

### Chargement
Spinner `w-8 h-8 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin`, centré dans `flex-1`.

### Mouvement (transversal)
- **`animate-fade-in-up`** : 450 ms, `--ease-out-expo` (`cubic-bezier(0.16, 1, 0.3, 1)`), montée de 0,5 rem et fondu. Sert aux en-têtes de page et à la modale ; `motion-safe:animate-fade-in-up` est disponible.
- **Survol de carte** : `hover:scale-105` en 300 ms.
- **`legendary-shimmer-sheen`** : bande blanche à 35 % qui balaie la carte en 3,6 s, en boucle.
- **`animate-card-flip`** : 600 ms, `--ease-out-expo`, la carte pivote depuis la tranche (`rotateY(90deg)` sous une perspective de 60 rem) en apparaissant. Sert à la révélation, avec ses paliers SR, UR et L et la cinématique L (voir « Paquet et révélation ») : c'est le seul moment fort de l'interface.
- **`animate-reveal-glow`** : 900 ms, la lumière d'un palier naît à 55 % de sa taille et s'étend ; sans mouvement, un fondu.
- **`prefers-reduced-motion: reduce`** : `fade-in-up`, `card-flip` et `reveal-glow` deviennent un simple fondu (`--fade-in-up-shift: 0`, `--card-flip-turn: 0deg`, `--reveal-glow-from: 1`) ; ni faisceaux, ni éclair L, ni tremblement du paquet ; la carte ne grandit plus au survol (`motion-reduce:hover:scale-100`) ; le balayage des L ne joue pas et la bande reste hors de la carte, pour que rien de statique ne voile le texte.

### Actions réseau, focus et session (transversal)
- **Messages** (`lib/api.ts`) : `userMessage(e, repli)` donne le texte français de nos routes pour un 4xx à corps JSON, et le repli pour une erreur réseau, un ≥ 500 ou un corps non JSON (jamais « Erreur 504 »). Quand `unsure(e)` (aucun verdict du serveur), une action d'argent ou d'inventaire dit qu'elle a peut-être eu lieu et relit le solde, le stock ou la grille.
- **Idempotency-Key** : `apiOnce(keys, intention, …)` garde une clé par intention (la copie pour une défausse, le temps d'une ouverture de la modale ; le chemin sur `/pulls` ; les ids de chaque lot d'une défausse en masse). La clé survit à un échec sans verdict, pour que la relance rejoue la réponse stockée, et disparaît dès qu'une réponse du serveur est lue (2xx au corps lisible, ou 4xx). Les clés des lots ne valent que pour le reste que la dernière défausse a laissé sélectionné ; toute autre sélection repart de clés neuves. Sur `/pulls`, un stock vide oublie la clé d'ouverture.
- **Boutons d'envoi** (`components/auth/Submit.tsx`, vague A) : `disabled` natif seulement avant l'hydratation (le HTML statique ne peut pas envoyer le formulaire), puis `aria-disabled` et une garde au début du `submit`.
- **Modale** : l'élément d'origine est retenu une fois par montage (`opener.current ??= document.activeElement`) ; une modale réaffichée par Activity rend donc le focus à la tuile, pas au lien de navigation cliqué entre-temps.
- **Après un changement d'auth** (connexion, code d'inscription ou de vérification, réinitialisation, déconnexion) : navigation de document (`window.location.replace`), jamais `router.replace`, pour que les pages gardées par Activity et les caches de module (préférences) ne survivent pas à la session.

## Do's and Don'ts

### Do:
- **Do** prendre les couleurs dans les jetons (`var(--color-…)` ou les utilitaires `bg-surface`, `text-accent`…), jamais en hex dans un composant ; seul `app/icon.tsx` les écrit en dur, car Satori ne lit pas le CSS.
- **Do** garder le texte secondaire à `/60` au moins, et vérifier tout nouveau couple de couleurs de texte dans `lib/contrast.test.ts`.
- **Do** donner un contour d'au moins 3:1 aux champs et aux contrôles dont la bordure est le seul repère (WCAG 1.4.11) : `--color-border` est décoratif.
- **Do** reproduire à l'identique les classes et attributs de R§6.4 et R§6.8 ; une classe utilitaire en plus est permise, un renommage jamais.
- **Do** écrire chaque nouvelle animation pour `prefers-reduced-motion` : un fondu, ou rien.

### Don't:
- **Don't** renommer ni supprimer `card-frame`, `glow-*`, `legendary-shimmer-sheen`, `animate-fade-in-up`, les `aria-label` et les `placeholder` du contrat.
- **Don't** copier les images de l'original (fonds `*.png`, `/logo.png`) ni sa marque : les fonds sont en CSS, l'emblème est le nôtre.
- **Don't** ajouter de thème clair ni de variante `prefers-color-scheme`.
- **Don't** poser un halo coloré ou une ombre portée sur le chrome : la lumière appartient aux cartes.
- **Don't** foncer un fond de rareté (voile noir, teinte foncée) sous le texte noir de la carte.
