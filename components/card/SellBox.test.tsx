import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { CatalogCard, OwnedItem } from './CardModal'
import { SellBox } from './SellBox'

// useRouter lève hors du routeur de l'app (comme app/api/cron/revalidate/route.test.ts:4 pour next/cache).
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const card: CatalogCard = {
  id: 'c-1', wikipedia_title: 'Chat', rarity: 'L', category: null, atk: 1, def: 1, image_url: null, wikipedia_url: 'https://fr.wikipedia.org/wiki/Chat',
}
const copy: OwnedItem = { id: 'uc-1', card_id: 'c-1', card, snapshot_rarity: 'R', is_shiny: false, starred: false, tags: [] }

// Sans DOM (R18) : balisage initial seulement ; la vente, l'anti-bot et le résumé sont couverts en e2e (marketplace.spec.ts).
describe('SellBox (M3-24)', () => {
  const h = renderToStaticMarkup(<SellBox copy={copy} onListed={() => {}} />).replaceAll('&#x27;', "'")

  test('card-frame, « Mise de départ » à 10 (nombre, min 1)', () => {
    expect(h).toMatch(/^<[a-z]+ class="card-frame[ "]/)
    const input = h.match(/<input [^>]*aria-label="Mise de départ"[^>]*>/)?.[0] ?? ''
    expect(input).toContain('type="number"')
    expect(input).toContain('min="1"')
    expect(input).toContain('value="10"')
  })

  test('six durées dans l\'ordre, seul « 1 h » pressé ; « Lancer l\'enchère »', () => {
    const pressed = [...h.matchAll(/<button [^>]*aria-pressed="(true|false)"[^>]*>([^<]+)<\/button>/g)].map((m) => `${m[2]}:${m[1]}`)
    expect(pressed).toEqual(['10 min:false', '30 min:false', '1 h:true', '3 h:false', '6 h:false', '12 h:false'])
    expect(h).toMatch(/<button type="submit"[^>]*>Lancer l'enchère<\/button>/)
  })
})
