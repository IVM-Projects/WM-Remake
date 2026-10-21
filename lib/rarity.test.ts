import { expect, test } from 'vitest'
import { MIN_VIEWS, rarityForViews } from './rarity'

test('rarityForViews : le seuil appartient à la rareté supérieure (R§5.2)', () => {
  const cases = [
    [0, 'C'], [49, 'C'], [50, 'PC'], [249, 'PC'], [250, 'R'], [999, 'R'],
    [1000, 'SR'], [4999, 'SR'], [5000, 'UR'], [19_999, 'UR'], [20_000, 'L'],
  ] as const
  expect(cases.map(([views]) => [views, rarityForViews(views)])).toEqual(cases)
  expect(MIN_VIEWS).toEqual({ L: 20_000, UR: 5_000, SR: 1_000, R: 250, PC: 50 })
})
