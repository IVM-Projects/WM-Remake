import { expect, test } from 'vitest'
import { formatCountdown, formatInt, formatRemaining } from './format'

test('formatInt : fr-FR, espace fine insécable U+202F entre les milliers', () => {
  expect(formatInt(6974)).toBe('6 974')
  expect(formatInt(1234567)).toBe('1 234 567')
  expect(formatInt(42)).toBe('42')
})

test('formatCountdown : m:ss, arrondi à la seconde supérieure, jamais négatif', () => {
  expect(formatCountdown(507000)).toBe('8:27')
  expect(formatCountdown(600000)).toBe('10:00')
  expect(formatCountdown(59_001)).toBe('1:00')
  expect(formatCountdown(0)).toBe('0:00')
  expect(formatCountdown(-3000)).toBe('0:00')
})

test('formatRemaining : « 3m 18s » (R§2.2), minutes et secondes sur deux chiffres sous une unité plus grande, arrondi au-dessus', () => {
  expect(formatRemaining(198_000)).toBe('3m 18s')
  expect(formatRemaining(185_000)).toBe('3m 05s')
  expect(formatRemaining(45_000)).toBe('45s')
  expect(formatRemaining(3_725_000)).toBe('1h 02m 05s')
  expect(formatRemaining(1)).toBe('1s')
  expect(formatRemaining(0)).toBe('0s')
})
