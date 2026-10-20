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
- **Pastille « ami possède »** : `bg-sky-300/65`, encre noire, icône `users`, dans `div.mt-auto` au-dessus des stats.

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
- **Stock** : `card-frame` « n / 10 » (n en émeraude, « / 10 » à `/60`), « paquets disponibles », une barre de 10 segments de 8 px (émeraude pleine ou surface claire, cachée aux lecteurs d'écran : le nombre la dit déjà), puis « Prochain dans » et `span.font-mono` en émeraude, ou « Réserve pleine ». Le compte à rebours suit l'horloge du serveur (`lib/clock.ts`) et ne dépasse jamais la période.
- **Paquet PRO du jour** : `card-frame` titré (icône `sparkles` violette), « 15 cartes, aucune commune » ; « Réservé aux membres Pro » (violet 300 et cadenas), « Récupérer » (violet à 20 %, texte violet 200) ou « Déjà récupéré aujourd'hui, reviens demain à 09:22 ».
- **Révélation** : compteur « Carte **n** / N » (n en émeraude, `text-lg`) et, sur la même ligne, les pastilles « Nouvelle » (émeraude à 15 %, texte émeraude clair) et « Brillante » (ambre à 15 %, texte ambre 200). La grande carte pivote (`animate-card-flip`) ; elle se balaie au pointeur (seuil 80 px, elle suit le doigt et s'incline avec mouvement), aux flèches ← → et aux boutons ronds de 48 px (contour blanc cassé à 40 %, `disabled:opacity-20`). Les points font 12 px (actif en émeraude, `scale-125` ; vus `/40` ; cachés `/15`, désactivés) avec une cible de 44 px par `::after`. « Encore N cartes » reste désactivé (style de « Ouvrir » désactivé) jusqu'à la dernière carte, puis devient « Continuer », plein émeraude. Un bouton qui se désactive sous le focus le passe au suivant logique : « Carte suivante » → « Continuer », « Carte précédente » → « Carte suivante ».
- **Paliers SR, UR, L** : la carte rayonne sa couleur derrière elle (`reveal-glow-{sr|ur|l}`, ellipse de plus en plus large et dense), sous tout le contenu de la révélation. Dès UR, deux faisceaux doux et flous la balaient lentement (16 s par tour), jamais une gloire de rayons. **Cinématique L** (`data-cinematic`, avec mouvement seulement) : un éclair doré unique sur tout l'écran (1,6 s), la carte attend 0,35 s avant de pivoter, et l'arpège de `playLegendary`. Sans mouvement : la lumière apparaît en fondu, sans faisceaux ni éclair.
- **Récapitulatif** : `h2` « Récapitulatif » (focalisé), les cartes en grille avec leurs pastilles dessous, puis « Retour aux paquets » ; le focus revient ensuite sur « Ouvrir ».
- **Sons** (`lib/sounds.ts`) : les nôtres, synthétisés en WebAudio (déchirure en souffle filtré, retournement bref, arpège do-mi-sol-do) ; muets si le joueur les a coupés ou tant que ses préférences ne sont pas lues.

### Collection (/collection, R§2.2)
- **En-tête** : le titre à gauche, le **solde** à droite (pièce W et `formatInt`, pastille sur la surface), lu par `GET /api/wikibidous` et mis à jour par chaque défausse ; une lecture échouée affiche « — » (« Solde indisponible » pour les lecteurs d'écran), relu à la défausse suivante.
- **Barre d'outils** (sur le graphite, jamais dans un panneau) : recherche `input[placeholder="Rechercher par titre ou catégorie..."]` qui prend le focus au chargement, puis deux listes natives de 44 px (« Toutes les étiquettes » avec le nombre de copies de chacune, tri « Trier les cartes », « Rareté » par défaut) et « Sélectionner », bordé, plein émeraude quand le mode est actif. Contours blanc cassé à 40 % (≥ 3:1).
- **Pastilles de rareté** (`RarityChips`) : codes L…C dans leur couleur, avec le style inline d'origine `background-color: var(--color-rarity-x)30; color: var(--color-rarity-x)` (inerte, comme la lueur du badge). Au repos, un contour `--color-border` ; pressée, un contour dans sa couleur et une teinte de 20 % de sa couleur. Un filtre posé, les autres passent à 80 % d'opacité et non à l'`opacity-50` d'origine : le rose SR y tomberait à 2,5:1, alors que 80 % est le plus bas qui garde les six raretés au-dessus de 4,5:1 (règle du plancher, `lib/contrast.test.ts`).
- **Grille** `div.flex.flex-wrap.justify-center.gap-3`, chaque carte dans `div.relative.isolate.group`. En mode sélection, toute la tuile coche sa case (case native émeraude sur une plaque noire à 65 %, en haut au centre) et une carte retenue prend un anneau émeraude.
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
- **Onglet** « Général » (texte émeraude, filet `border-b-2` émeraude), puis trois sections `card-frame` `p-6` de 42 rem au plus : **Profil**, **Préférences**, **Compte**.
- **Profil** : champ « Pseudo » (vérifié au départ du champ, sauf pour un simple changement de casse du sien), aide `/70`, « Enregistrer le pseudo » en bouton principal, inactif tant que rien ne change (surface claire, texte `/60`). Succès en émeraude clair avec la date du prochain changement possible ; refus sous le champ, en `red-300`.
- **Préférences** : trois cases natives émeraude (« Sons », « Masquer les images sensibles », « Profil public »), chacune sur une ligne de 44 px avec son aide `/70` dessous. Enregistrement immédiat de la seule case touchée ; un refus la remet comme avant et le dit.
- **Compte** : « Nouveau mot de passe » et sa confirmation, « Changer le mot de passe » ; sous un filet, « Se déconnecter » bordé (icône `log-out`).
- **États** : chaque section lit ses données seule, avec son spinner et son erreur (« Réessayer » ramène le focus sur le titre de la section) ; une section en échec ne bloque pas les autres. Aucun bouton n'est `disabled` sous le focus : `aria-disabled` et une garde.

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
