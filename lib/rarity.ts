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
