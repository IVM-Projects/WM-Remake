// Ordre d'affichage L…C ; `css` suffixe glow-*, rarity-bg-* et --color-rarity-* (app/globals.css).
export const RARITY = [
  { code: 'L', label: 'Légendaire', css: 'l' },
  { code: 'UR', label: 'Ultra rare', css: 'ur' },
  { code: 'SR', label: 'Super rare', css: 'sr' },
  { code: 'R', label: 'Rare', css: 'r' },
  { code: 'PC', label: 'Peu commune', css: 'pc' },
  { code: 'C', label: 'Commune', css: 'c' },
] as const

export type RarityCode = (typeof RARITY)[number]['code']

export const rarityOf = (code: RarityCode) => RARITY.find((r) => r.code === code) ?? RARITY[5]

// Vues humaines mensuelles de l'article fr.wikipedia (R§5.2). Partagé par le pipeline catalog/ (lancé
// par Node sans alias), « Comment ça marche ? » et /credits : ce fichier reste sans import.
export const MIN_VIEWS = { L: 20_000, UR: 5_000, SR: 1_000, R: 250, PC: 50 } as const

// Seuil inclus dans la rareté supérieure : 250 vues → R.
export const rarityForViews = (views: number): RarityCode =>
  RARITY.find((r) => r.code !== 'C' && views >= MIN_VIEWS[r.code])?.code ?? 'C'
