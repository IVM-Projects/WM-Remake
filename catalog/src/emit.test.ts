import { expect, test } from 'vitest'
import { csvField, wikipediaUrl } from './emit.ts'

test('csvField : null vide non guillemeté, chaîne vide guillemetée, guillemets doublés, séparateurs guillemetés', () => {
  expect(csvField(null)).toBe('')
  expect(csvField('')).toBe('""')
  expect(csvField('a"b')).toBe('"a""b"')
  expect(csvField(3)).toBe('3')
  expect(csvField('x,y\nz')).toBe('"x,y\nz"')
  expect(csvField('a\rb')).toBe('"a\rb"')
  expect(csvField('Paris')).toBe('Paris')
})

test('wikipediaUrl : titre encodé, espaces en _, comme seed.sql', () => {
  expect(wikipediaUrl("Arc de triomphe de l'Étoile")).toBe("https://fr.wikipedia.org/wiki/Arc_de_triomphe_de_l'%C3%89toile")
})
