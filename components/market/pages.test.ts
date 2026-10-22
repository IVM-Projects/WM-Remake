import { expect, test } from 'vitest'
import { appendPage, mergeReread, type List } from './pages'
import type { Auction } from './types'

// Seul l'id compte pour la fusion ; le reste de l'objet passe tel quel.
const a = (id: string, current_bid: number | null = null) => ({ id, current_bid }) as Auction
const ids = (l: List | null) => l?.items.map((x) => x.id)

test('relecture de n pages : toutes les pages dans l\'ordre, more de la dernière', () => {
  const l = mergeReread(null, 2, [{ items: [a('1'), a('2')], more: true }, { items: [a('3')], more: false }])
  expect(l).toEqual({ pages: 2, items: [a('1'), a('2'), a('3')], more: false })
})

test('une enchère passée de la page 1 à la page 2 entre deux lectures n\'est gardée qu\'une fois, avec sa valeur la plus fraîche', () => {
  const l = mergeReread(null, 2, [{ items: [a('1'), a('2', 10)], more: true }, { items: [a('2', 20), a('3')], more: false }])
  expect(ids(l)).toEqual(['1', '2', '3'])
  expect(l?.items[1].current_bid).toBe(20)
})

test('une enchère disparue d\'une page (réglée, retirée) n\'est plus dans la liste relue', () => {
  const before: List = { pages: 1, items: [a('1'), a('2'), a('3')], more: false }
  expect(ids(mergeReread(before, 1, [{ items: [a('1'), a('3')], more: false }]))).toEqual(['1', '3'])
})

test('relecture partie avant un « Charger la suite » rendu entre-temps : ignorée, la liste plus complète reste', () => {
  const loaded = appendPage({ pages: 1, items: [a('1'), a('2')], more: true }, 1, { items: [a('2'), a('3')], more: false })
  expect(loaded).toEqual({ pages: 2, items: [a('1'), a('2'), a('3')], more: false })
  expect(mergeReread(loaded, 1, [{ items: [a('1')], more: true }])).toBe(loaded)
})

test('« Charger la suite » parti sur une autre liste (pages changées) : ignoré', () => {
  const now: List = { pages: 2, items: [a('1'), a('2')], more: true }
  expect(appendPage(now, 1, { items: [a('9')], more: false })).toBe(now)
  expect(appendPage(null, 1, { items: [a('9')], more: false })).toBeNull()
})
