import { it, expect } from 'vitest'
import { isGameRoute } from '@/lib/routes'

it('routes de jeu', () => {
  expect(isGameRoute('/pulls')).toBe(true); expect(isGameRoute('/marketplace/abc')).toBe(true)
  expect(isGameRoute('/pullsx')).toBe(false); expect(isGameRoute('/login')).toBe(false); expect(isGameRoute('/')).toBe(false)
})
