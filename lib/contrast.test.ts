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
]

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
