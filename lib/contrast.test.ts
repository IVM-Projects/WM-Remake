import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
const theme = css.match(/@theme[^{]*\{([^}]*)\}/)?.[1] ?? ''

function resolve(token: string): string {
  if (token.startsWith('#')) return token
  const m = theme.match(new RegExp(`(?:^|\\s)${token}:\\s*(#[0-9a-f]{6})\\s*;`))
  if (!m) throw new Error(`${token} absent du bloc @theme (ou pas en hex à 6 chiffres)`)
  return m[1]
}

// WCAG 2.2, luminance relative et rapport de contraste.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const RARITIES = ['c', 'pc', 'r', 'sr', 'ur', 'l']
const pairs: [fg: string, bg: string, min: number][] = [
  ['--color-foreground', '--color-background', 4.5],
  ['--color-foreground', '--color-surface', 4.5],
  ['--color-accent', '--color-background', 4.5],
  ['--color-accent-foreground', '--color-accent', 4.5],
  ...RARITIES.map(r => ['#0d1117', `--color-rarity-${r}`, 4.5] as [string, string, number]), // texte du badge, R§6.4
  // Règle des teintes foncées (docs/DESIGN.md) : texte blanc dessus, sauf L (orange clair) qui prend l'encre noire.
  ...RARITIES.slice(0, 5).map(r => ['#ffffff', `--color-rarity-${r}-dark`, 4.5] as [string, string, number]),
  ['#0d1117', '--color-rarity-l-dark', 4.5],
]

// Fusion d'un texte à opacité `a` sur un fond opaque, comme le navigateur (sRGB).
function over(fg: string, a: number, bg: string): string {
  const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16)
  return '#' + [1, 3, 5].map(i => Math.round(a * ch(fg, i) + (1 - a) * ch(bg, i)).toString(16).padStart(2, '0')).join('')
}

// Fonds recréés (D§8.5) : le texte noir de la carte (Card.tsx) doit tenir sur chacun.
const bgRules = css.slice(css.indexOf('.rarity-bg-c,'), css.indexOf('.legendary-shimmer-sheen {'))
const cardInk: [label: string, fg: string, a: number][] = [
  ['titre et stats, text-black', '#000000', 1],
  ['stats, text-black/90', '#000000', 0.9],
  // neutral-900 de Tailwind 4 : oklch(20.5% 0 0). Sert aussi à l'extrait de la modale : le neutral-800/88 d'origine fait 4,45:1 sur SR.
  ['description et extrait, text-neutral-900/90', '#171717', 0.9],
]

describe('fonds de rareté recréés', () => {
  it('ne posent que des voiles blancs : leur point le plus sombre est la couleur de rareté', () => {
    for (const r of RARITIES) expect(bgRules).toContain(`.rarity-bg-${r}`)
    expect(bgRules).toContain('rgb(255 255 255 /')
    expect(bgRules.match(/rgb\((?!255 255 255 )[^)]*\)/g)).toBeNull()
    expect(bgRules.match(/stroke='(?!white')[^']*'/g)).toBeNull()
    expect(bgRules).not.toMatch(/#[0-9a-f]{3,6}\b|black/i)
  })
  // Pire cas : la couleur de rareté sous le dégradé from-black/10 de la carte (il ne vaut plus que 1 % au bord de la zone texte).
  it.each(RARITIES.flatMap(r => cardInk.map(([label, fg, a]) => [r, label, fg, a] as const)))(
    'rarity-bg-%s : %s ≥ 4,5:1', (r, _label, fg, a) => {
      const bg = over('#000000', 0.1, resolve(`--color-rarity-${r}`))
      expect(contrast(over(fg, a, bg), bg)).toBeGreaterThanOrEqual(4.5)
    })
})

// Textes colorés de la modale de carte, sur le panneau card-frame.
const modalPairs: [fg: string, bg: string, min: number][] = [
  ...RARITIES.map(r => [`--color-rarity-${r}`, '--color-surface', 4.5] as [string, string, number]), // libellé de rareté
  ['#ff6467', '--color-surface', 4.5], // ATK, red-400 de Tailwind 4 (le red-700 d'origine fait 2,7:1)
  ['#51a2ff', '--color-surface', 4.5], // DEF, blue-400 (le blue-700 d'origine fait 2,6:1)
  ['#c4b4ff', over('#8e51ff', 0.2, resolve('--color-surface-light')), 4.5], // PRO : violet-300 sur violet-500/20
  ['#c4b4ff', '--color-accent-foreground', 4.5], // PRO, onglet Marché actif
  ['--color-accent', over(resolve('--color-accent'), 0.1, resolve('--color-surface')), 4.5], // « Ajouter à ma liste de souhaits », accent doux
  ['--color-accent-light', over(resolve('--color-accent'), 0.15, resolve('--color-surface-light')), 4.5], // option active de la liste d'étiquettes
  // Contours seuls repères (WCAG 1.4.11) : champ d'étiquette et bouton « Défausser », blanc cassé à 40 %.
  [over(resolve('--color-foreground'), 0.4, resolve('--color-surface-light')), '--color-surface-light', 3],
  [over(resolve('--color-foreground'), 0.4, resolve('--color-surface')), '--color-surface', 3],
]

describe('modale de carte', () => {
  it.each(modalPairs)('%s sur %s ≥ %s:1', (fg, bg, min) =>
    expect(contrast(resolve(fg), resolve(bg))).toBeGreaterThanOrEqual(min))
})

describe('jetons de design', () => {
  it('le calcul de contraste suit WCAG', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
  })
  it.each(pairs)('%s sur %s ≥ %s:1', (fg, bg, min) =>
    expect(contrast(resolve(fg), resolve(bg))).toBeGreaterThanOrEqual(min))
  it('valeurs imposées par le recap §6.1', () => {
    expect(resolve('--color-background')).toBe('#0d0d0d')
    expect(resolve('--color-accent')).toBe('#34d399')
    expect(RARITIES.map(r => resolve(`--color-rarity-${r}`)))
      .toEqual(['#b8f2d5', '#b1cff2', '#c6a7f2', '#ed6fa3', '#fa9931', '#ffe144'])
    expect(RARITIES.map(r => resolve(`--color-rarity-${r}-dark`)))
      .toEqual(['#2b7d58', '#2c5c99', '#6439b8', '#a8235b', '#9a4f05', '#fa9931'])
  })
})

// /pulls (PackStock, PackOpening, ProDailyBlock) : textes et repères sur la page (graphite) ou le panneau.
const fg = (a: number, bg: string) => over(resolve('--color-foreground'), a, resolve(bg))
const pullsPairs: [label: string, fg: string, bg: string, min: number][] = [
  ['compteur « Carte » et libellés, /70 sur la page', fg(0.7, '--color-background'), '--color-background', 4.5],
  ['« paquets disponibles », /70 sur le panneau', fg(0.7, '--color-surface'), '--color-surface', 4.5],
  ['bouton désactivé (Ouvrir, Encore N cartes), /60 sur surface claire', fg(0.6, '--color-surface-light'), '--color-surface-light', 4.5],
  ['« Nouvelle », émeraude clair sur émeraude à 15 %', '--color-accent-light', over(resolve('--color-accent'), 0.15, resolve('--color-background')), 4.5],
  ['« Brillante », amber-200 sur amber-300 à 15 %', '#fee685', over('#ffd236', 0.15, resolve('--color-background')), 4.5],
  ['« Réservé aux membres Pro », violet-300 sur le panneau', '#c4b4ff', '--color-surface', 4.5],
  ['« Récupérer », violet-200 sur violet-500 à 20 %', '#ddd6ff', over('#8e51ff', 0.2, resolve('--color-surface')), 4.5],
  ['erreur, red-400 sur la page', '#ff6467', '--color-background', 4.5],
  // Bouton en cours (aria-disabled:opacity-80) : texte et fond fondus ensemble sur la page ou le panneau.
  ['« Ouverture… », opacité 80 %', over(resolve('--color-accent-foreground'), 0.8, resolve('--color-background')), over(resolve('--color-accent'), 0.8, resolve('--color-background')), 4.5],
  ['« Récupération… », opacité 80 %', over('#ddd6ff', 0.8, resolve('--color-surface')), over(over('#8e51ff', 0.2, resolve('--color-surface')), 0.8, resolve('--color-surface')), 4.5],
  // Repères non textuels (WCAG 1.4.11) : contour des boutons ronds et points des cartes vues.
  ['contour des boutons ronds, /40', fg(0.4, '--color-background'), '--color-background', 3],
  ['point d\'une carte vue, /40', fg(0.4, '--color-background'), '--color-background', 3],
]

describe('page des paquets', () => {
  it.each(pullsPairs)('%s', (_label, a, b, min) => expect(contrast(resolve(a), resolve(b))).toBeGreaterThanOrEqual(min))
})

// /collection : pastilles de rareté (fond inline inerte, donc le graphite dessous), pleines ou atténuées dès qu'un filtre est posé.
// L'opacity-50 d'origine ferait 2,5:1 pour SR : 80 % est le plus bas qui tienne 4,5:1 pour les six raretés.
describe('page de la collection', () => {
  it.each(RARITIES.flatMap(r => [1, 0.8].map(a => [r, a] as const)))('pastille %s à l\'opacité %s ≥ 4,5:1', (r, a) => {
    const bg = resolve('--color-background')
    expect(contrast(over(resolve(`--color-rarity-${r}`), a, bg), bg)).toBeGreaterThanOrEqual(4.5)
  })
  it.each(RARITIES)('pastille %s pressée, sur sa teinte à 20 % ≥ 4,5:1', (r) => {
    const c = resolve(`--color-rarity-${r}`)
    expect(contrast(c, over(c, 0.2, resolve('--color-background')))).toBeGreaterThanOrEqual(4.5)
  })
  it('l\'opacity-50 d\'origine échouerait (SR)', () => {
    const bg = resolve('--color-background')
    expect(contrast(over(resolve('--color-rarity-sr'), 0.5, bg), bg)).toBeLessThan(4.5)
  })
  it('bouton désactivé (pagination, sélection vide), /60 sur la page et sur le panneau', () => {
    expect(contrast(fg(0.6, '--color-background'), resolve('--color-background'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(fg(0.6, '--color-surface'), resolve('--color-surface'))).toBeGreaterThanOrEqual(4.5)
  })
  it('contour d\'une pastille pressée (sa couleur) ≥ 3:1 sur le graphite', () => {
    for (const r of RARITIES) expect(contrast(resolve(`--color-rarity-${r}`), resolve('--color-background'))).toBeGreaterThanOrEqual(3)
  })
})
