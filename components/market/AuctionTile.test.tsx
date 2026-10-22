import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { AuctionTile } from './AuctionTile'
import type { Auction } from './types'

// Sans DOM (R18) : on lit le HTML rendu, préférences simulées comme Card.test.tsx.
const prefs = vi.hoisted(() => ({ sounds: true, hideSensitive: true, ready: true }))
vi.mock('@/lib/prefs', () => ({ usePrefs: () => prefs }))

const ID = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e'
const END = '2026-10-21T12:00:00.000Z'
const base: Auction = {
  id: ID, seller_id: 'a1', card_id: 'c1', user_card_id: 'k1', snapshot_rarity: 'UR', snapshot_atk: 12, snapshot_def: 34,
  snapshot_search_document: 'Chat', is_shiny: false, base_amount: 10, listing_base_amount: 10, base_repriced_at: null, current_bid: null,
  current_bidder_id: null, bids_count: 0, final_price: null, status: 'active', end_at: END, created_at: END, settled_at: null, winner_id: null,
  seller: { id: 'a1', username: 'Alice' }, current_bidder: null,
  card: {
    id: 'c1', wikipedia_title: 'Chat', wikipedia_url: 'https://fr.wikipedia.org/wiki/Chat', rarity: 'C', category: 'Félin', image_url: null,
    hide_image: false, nsfw_image: false, atk: 1, def: 2, q_score: null, pageviews: 0,
  },
  effective_bid: 10, bid_count: 0, buyer_id: null, min_next_bid: 10,
}
const html = (a: Partial<Auction> = {}) => renderToStaticMarkup(<AuctionTile auction={{ ...base, ...a }} />)
const linkOf = (h: string) => h.match(new RegExp(`^<div id="marketplace-auction-${ID}"><a ([^>]*)>(.*)</a></div>$`))

describe('AuctionTile (DOM du contrat, R§6.8)', () => {
  test('div#marketplace-auction-<id>, premier enfant a.card-frame.block.p-3 vers /marketplace/<id>', () => {
    const [, attrs] = linkOf(html()) ?? []
    expect(attrs).toMatch(/\bclass="card-frame block p-3 /)
    expect(attrs).toContain(`href="/marketplace/${ID}"`)
  })

  test('« Mise de départ » sans mise ; « Mise actuelle » et 1 234 (espace fine) avec mise', () => {
    expect(html()).toContain('Mise de départ')
    expect(html()).not.toContain('Mise actuelle')
    const bid = html({ current_bid: 1234 })
    expect(bid).toContain('Mise actuelle')
    expect(bid).toContain('1\u202f234')
    expect(bid).not.toContain('Mise de départ')
  })

  test('compte à rebours en time[datetime] text-amber-600 tabular-nums ; « Vendu par » en p.truncate', () => {
    const h = html()
    expect(h).toContain('Durée')
    expect(h.toLowerCase()).toContain(`<time datetime="${END.toLowerCase()}" class="text-amber-600 tabular-nums">`)
    expect(h).toContain('<p class="truncate">Vendu par Alice</p>')
  })

  test('enchère qui n\'est plus active (retirée, end_at encore futur) : « Terminée », jamais un compte à rebours', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()
    expect(html({ status: 'cancelled', end_at: future })).toMatch(/<time [^>]*>Terminée<\/time>/)
    expect(html({ end_at: future })).toMatch(/<time [^>]*><\/time>/)
  })

  test('face figée (P30) : rareté du snapshot (UR), pas celle du catalogue (C)', () => {
    const h = html()
    expect(h).toMatch(/class="[^"]*\bglow-ur\b/)
    expect(h).not.toContain('glow-c')
    expect(h).toMatch(/text-xs font-bold z-30"[^>]*>UR<\/div>/)
  })

  test('✨ seulement si is_shiny ; « Possédée » seulement si owned ; aucun bouton dans le lien, owned compris', () => {
    expect(html()).not.toContain('✨')
    expect(html({ is_shiny: true })).toContain('✨')
    expect(html()).not.toContain('Possédée')
    const owned = html({ owned: true, is_shiny: true })
    expect(owned).toContain('Possédée')
    expect(linkOf(owned)?.[2]).not.toContain('<button')
  })

  test('« Mes enchères » : l\'état de la tuile (P21)', () => {
    expect(html({ my_state: 'leading' })).toContain('En tête')
    expect(html({ my_state: 'outbid' })).toContain('Surenchéri')
    expect(html({ my_state: 'won' })).toContain('Gagnée')
    expect(html({ my_state: 'lost' })).toContain('Perdue')
    expect(html()).not.toMatch(/En tête|Surenchéri|Gagnée|Perdue/)
  })
})
