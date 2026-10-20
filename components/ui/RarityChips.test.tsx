import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Pagination } from './Pagination'
import { RarityChips } from './RarityChips'

const noop = () => {}
const buttons = (h: string) => [...h.matchAll(/<button [^>]*>.*?<\/button>/g)].map((m) => m[0])

test('RarityChips : ordre L…C, style inline d\'origine, pressée cerclée, les autres à 80 % dès qu\'un filtre est posé', () => {
  const all = buttons(renderToStaticMarkup(<RarityChips value={[]} onChange={noop} />))
  expect(all.map((b) => b.match(/>([A-Z]+)<\/button>$/)?.[1])).toEqual(['L', 'UR', 'SR', 'R', 'PC', 'C'])
  expect(all[0]).toContain('style="background-color:var(--color-rarity-l)30;color:var(--color-rarity-l)"')
  expect(all[3]).toContain('title="Rare"')
  // Aucun filtre : rien de pressé, rien d'atténué.
  for (const b of all) expect(b).toMatch(/aria-pressed="false"(?![^>]*opacity-80)/)

  const [l, ur] = buttons(renderToStaticMarkup(<RarityChips value={['L']} onChange={noop} />))
  expect(l).toContain('aria-pressed="true"')
  expect(l).toContain('border-current')
  expect(l).not.toContain('opacity-80')
  expect(ur).toContain('aria-pressed="false"')
  expect(ur).toContain('opacity-80')
})

test('Pagination : « ← Précédent », « Page n / m », « Suivant → », bornes en aria-disabled ; rien sous deux pages', () => {
  const h = renderToStaticMarkup(<Pagination page={0} totalPages={47} onPage={noop} />)
  expect(h.replace(/<[^>]+>/g, '')).toBe('← PrécédentPage 1 / 47Suivant →')
  const [prev, next] = buttons(h)
  expect(prev).toContain('aria-disabled="true"')
  expect(next).toContain('aria-disabled="false"')
  expect(buttons(renderToStaticMarkup(<Pagination page={46} totalPages={47} onPage={noop} />))[1]).toContain('aria-disabled="true"')
  expect(renderToStaticMarkup(<Pagination page={0} totalPages={1} onPage={noop} />)).toBe('')
})

test('Pagination à total inconnu (recherche) : « Page n » seul, « Suivant » selon more', () => {
  const h = renderToStaticMarkup(<Pagination page={1} totalPages={null} more onPage={noop} />)
  expect(h.replace(/<[^>]+>/g, '')).toBe('← PrécédentPage 2Suivant →')
  expect(buttons(h)[1]).toContain('aria-disabled="false"')
  expect(buttons(renderToStaticMarkup(<Pagination page={1} totalPages={null} more={false} onPage={noop} />))[1]).toContain('aria-disabled="true"')
  expect(renderToStaticMarkup(<Pagination page={0} totalPages={null} more={false} onPage={noop} />)).toBe('')
})
