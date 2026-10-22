import { describe, expect, test } from 'vitest'
import { buildBody, invertTrade, sideCount } from './compose'
import type { Trade, TradeItem } from './types'

const ME = 'a1a1a1a1-0000-4000-8000-000000000001'
const FRIEND = 'b2b2b2b2-0000-4000-8000-000000000002'
const cardOf = { a: 'card-a', b: 'card-b', c: 'card-c', z: 'card-z' }

describe('buildBody', () => {
  test('une unité par élément, les miens puis ceux de l\'ami, triés par user_card_id ; quantité nulle retirée ; pas de parent_trade_id', () => {
    const body = buildBody({ recipientId: FRIEND, me: ME, offer: { b: 2, a: 1, z: 0 }, ask: { c: 1 }, cardOf, wbOffer: 10, wbAsk: 0 })
    expect(body).toEqual({
      recipient_id: FRIEND,
      items: [
        { user_card_id: 'a', card_id: 'card-a', offered_by: ME },
        { user_card_id: 'b', card_id: 'card-b', offered_by: ME },
        { user_card_id: 'b', card_id: 'card-b', offered_by: ME },
        { user_card_id: 'c', card_id: 'card-c', offered_by: FRIEND },
      ],
      initiator_wikibidous: 10,
      recipient_wikibidous: 0,
    })
    expect(body).not.toHaveProperty('parent_trade_id')
  })

  test('parent_trade_id seulement s\'il est donné', () => {
    expect(buildBody({ recipientId: FRIEND, me: ME, offer: { a: 1 }, ask: {}, cardOf, wbOffer: 0, wbAsk: 0, parentId: 'p' }).parent_trade_id).toBe('p')
  })
})

const item = (offered_by: string, user_card_id: string): TradeItem => ({
  offered_by, card_id: `card-${user_card_id}`, user_card_id, snapshot_rarity: 'C', is_shiny: false,
  card: { id: `card-${user_card_id}`, wikipedia_title: user_card_id, image_url: null, rarity: 'C' },
})

test('invertTrade : vu par le destinataire, j\'offre ce que le parent me demandait et demande ce qu\'il m\'offrait, WB inversés', () => {
  const AT = '2026-09-20T12:00:00Z'
  const parent: Trade = {
    id: 't1', status: 'pending', initiator_id: FRIEND, recipient_id: ME, initiator_wikibidous: 300, recipient_wikibidous: 0,
    parent_trade_id: null, created_at: AT, updated_at: AT, accepted_at: null, completed_at: null, closed_at: null, expires_at: AT,
    initiator: { id: FRIEND, username: 'Alice' }, recipient: { id: ME, username: 'Bob' },
    items: [item(FRIEND, 'a1'), item(FRIEND, 'a2'), item(FRIEND, 'a2'), item(ME, 'b1')], counter_trade_id: null,
  }
  expect(invertTrade(parent, ME)).toEqual({
    withId: FRIEND,
    offer: { b1: 1 },
    ask: { a1: 1, a2: 2 },
    cardOf: { a1: 'card-a1', a2: 'card-a2', b1: 'card-b1' },
    wbOffer: 0,
    wbAsk: 300,
  })
})

test('sideCount compte les unités', () => {
  expect(sideCount({ a: 2, b: 1 })).toBe(3)
})
