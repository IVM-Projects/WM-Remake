import { expect, test } from 'vitest'
import { formatCountdown, formatInt } from './format'

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
