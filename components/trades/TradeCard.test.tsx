import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { TradeCard } from './TradeCard'
import type { Trade, TradeItem, TradeStatus } from './types'

// Sans DOM (R18) : on lit le HTML rendu.
const A = 'a1a1a1a1-0000-4000-8000-000000000001'
const B = 'b2b2b2b2-0000-4000-8000-000000000002'
const AT = '2026-09-20T12:00:00Z'
const item = (offered_by: string, title: string, rarity: TradeItem['snapshot_rarity']): TradeItem => ({
  offered_by, card_id: `c-${title}`, user_card_id: `u-${title}`, snapshot_rarity: rarity, is_shiny: false,
  card: { id: `c-${title}`, wikipedia_title: title, image_url: null, rarity },
})
const base: Trade = {
  id: '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e', status: 'pending', initiator_id: A, recipient_id: B, initiator_wikibidous: 300,
  recipient_wikibidous: 0, parent_trade_id: null, created_at: AT, updated_at: AT, accepted_at: null, completed_at: null, closed_at: null,
  expires_at: '2026-09-27T12:00:00Z', initiator: { id: A, username: 'Alice' }, recipient: { id: B, username: 'Bob' },
  items: [item(A, 'Théorème de Pythagore', 'SR'), item(B, 'Électricité statique', 'C')], counter_trade_id: null,
}
const html = (t: Partial<Trade> = {}) => renderToStaticMarkup(<TradeCard trade={{ ...base, ...t }} onOpen={() => {}} />)

describe('TradeCard (DOM du contrat, R§6.8)', () => {
  test('racine div.card-frame.p-4, premier enfant button[aria-label="Voir le détail de l\'échange"]', () => {
    expect(html()).toMatch(/^<div class="card-frame p-4[ "][^>]*><button [^>]*\baria-label="Voir le détail de l&#x27;échange"/)
  })

  test('« De Alice » et le statut (P17) dans son élément coloré', () => {
    expect(html()).toContain('De Alice')
    const cases: [TradeStatus, string, string][] = [
      ['accepted', 'Accepté', 'text-green-400'], ['declined', 'Refusé', 'text-red-400'], ['countered', 'Contre-offre', 'text-sky-400'],
      ['pending', 'En attente', 'text-amber-600'], ['cancelled', 'Annulé', 'text-[var(--color-foreground)]/60'],
      ['expired', 'Expiré', 'text-[var(--color-foreground)]/60'],
    ]
    for (const [status, text, cls] of cases) {
      const classes = html({ status }).match(new RegExp(`<[a-z]+ class="([^"]*)">· ${text}<`))?.[1].split(' ')
      expect(classes, status).toContain(cls)
    }
  })

  test('aria-describedby vers un span.sr-only « De Alice · En attente · 20 sept. » ; aucun « Message » (M4-1)', () => {
    const h = html()
    const id = h.match(/<button [^>]*aria-describedby="([^"]+)"/)?.[1]
    expect(id).toBeTruthy()
    expect(h).toContain(`<span id="${id}" class="sr-only">De Alice · En attente · 20 sept.</span>`)
    expect(h).not.toContain('Message')
  })

  test('date courte en time[datetime]', () => {
    // React rend « dateTime » ; un nom d'attribut HTML ne tient pas compte de la casse (le navigateur lit datetime).
    expect(html().replace('<time dateTime=', '<time datetime=')).toContain(`<time datetime="${AT}">20 sept.</time>`)
  })

  test('colonnes « Alice offre » et « En échange de », séparées par svg.lucide-arrow-left-right', () => {
    const h = html()
    expect(h).toContain('Alice offre')
    expect(h).toContain('En échange de')
    expect(h).toMatch(/<svg [^>]*class="[^"]*\blucide-arrow-left-right\b/)
    expect(h.indexOf('Alice offre')).toBeLessThan(h.indexOf('lucide-arrow-left-right'))
    expect(h.indexOf('lucide-arrow-left-right')).toBeLessThan(h.indexOf('En échange de'))
  })

  test('puces (P15) : span[title] au fond var(--color-rarity-<r>)22, titre tronqué à 20 caractères', () => {
    const h = html()
    expect(h).toMatch(/<span title="Théorème de Pythagore" style="background-color:var\(--color-rarity-sr\)22"[^>]*>SR · Théorème de Pythagor…<\/span>/)
    // 20 caractères tout juste : sans « … ».
    expect(h).toMatch(/<span title="Électricité statique" style="background-color:var\(--color-rarity-c\)22"[^>]*>C · Électricité statique<\/span>/)
  })

  test('wikibidous dans la colonne de leur côté, seulement au-dessus de 0', () => {
    const [mine, theirs] = html().split('En échange de')
    expect(mine).toContain('300 wikibidous')
    expect(theirs).not.toContain('wikibidou')
    const both = html({ initiator_wikibidous: 0, recipient_wikibidous: 1234 }).split('En échange de')
    expect(both[0]).not.toContain('wikibidou')
    expect(both[1]).toContain('1 234 wikibidous')
  })
})
