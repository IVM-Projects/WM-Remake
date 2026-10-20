import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { brand } from '@/lib/brand'
import { Card, type CardFace } from './Card'

// Sans DOM (R18) : on lit le HTML rendu. Les préférences sont pilotées par le test.
const prefs = vi.hoisted(() => ({ sounds: true, hideSensitive: true, ready: true }))
vi.mock('@/lib/prefs', () => ({ usePrefs: () => prefs }))
beforeEach(() => { prefs.hideSensitive = true })

const THUMB = 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b6/Felis_catus.jpg/330px-Felis_catus.jpg'
const chat: CardFace = {
  wikipedia_title: 'Chat', rarity: 'L', category: 'Espèce de mammifère carnivore', atk: 9876, def: 6974, image_url: THUMB,
}
const html = (el: React.ReactElement) => renderToStaticMarkup(el).replaceAll('&#x27;', "'").replaceAll('&amp;', '&')
const rootClasses = (h: string) => h.match(/^<div class="([^"]*)"/)?.[1].split(' ') ?? []
const textOf = (h: string) => h.replace(/<[^>]+>/g, '')
const h3Text = (h: string) => textOf(h.match(/<h3[^>]*>(.*?)<\/h3>/)?.[1] ?? '')

describe('Card (DOM de R§6.4)', () => {
  test('racine glow-{x} avec ses classes ; voile legendary-shimmer-sheen pour une L seulement', () => {
    const l = html(<Card card={chat} />)
    expect(rootClasses(l)).toEqual(expect.arrayContaining([
      'w-72', 'h-[420px]', 'glow-l', 'relative', 'rounded-2xl', 'overflow-hidden', 'cursor-pointer', 'hover:z-10',
      'transition-all', 'duration-300', 'hover:scale-105',
    ]))
    expect(l).toContain('<div class="absolute inset-0 z-40 overflow-hidden pointer-events-none"><div class="legendary-shimmer-sheen" aria-hidden="true"></div></div>')
    const c = html(<Card card={{ ...chat, rarity: 'C' }} size="grid" />)
    expect(rootClasses(c)).toEqual(expect.arrayContaining(['w-[clamp(8.4rem,43vw,10rem)]', 'h-[clamp(11.8rem,60vw,14rem)]', 'glow-c']))
    expect(c).not.toContain('legendary-shimmer-sheen')
  })

  test('enfants dans l\'ordre : fond, dégradé, zone image 45 %, badge, zone texte, voile', () => {
    const l = html(<Card card={chat} owned />)
    const at = [
      'rarity-bg-l', 'bg-gradient-to-b from-black/10 via-transparent to-transparent pointer-events-none z-10',
      'absolute top-0 left-0 right-0 h-[45%] z-20 bg-black/20', 'absolute top-2 left-2 px-2 py-0.5 rounded-md text-xs font-bold z-30',
      'absolute top-2 right-2 z-30 flex flex-col items-end gap-1', 'absolute top-[45%] left-0 right-0 bottom-0 flex min-h-0 flex-col p-3 z-20',
      'legendary-shimmer-sheen',
    ].map((s) => l.indexOf(s))
    expect(at.every((i) => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  test('badge de rareté : couleur, encre et lueur d\'origine', () => {
    expect(html(<Card card={chat} />)).toContain(
      'style="background-color:var(--color-rarity-l);color:rgb(13,17,23);box-shadow:0 0 10px var(--color-rarity-l)99">L</div>')
  })

  test('image Wikimedia : <img loading=lazy decoding=async alt=titre crossorigin=anonymous>', () => {
    const img = html(<Card card={{ ...chat, rarity: 'UR' }} />).match(/<img [^>]*>/)?.[0] ?? ''
    for (const attr of [`src="${THUMB}"`, 'alt="Chat"', 'crossorigin="anonymous"', 'loading="lazy"', 'decoding="async"', 'object-cover'])
      expect(img).toContain(attr)
  })

  test('hide_image → emblème de notre marque, aucune image Wikimedia', () => {
    const h = html(<Card card={{ ...chat, hide_image: true }} />)
    expect(h).toContain(`role="img" aria-label="${brand.name}"`)
    expect(h).not.toContain('upload.wikimedia.org')
    expect(h).not.toContain('<img')
  })

  test('sans image_url → emblème', () => {
    expect(html(<Card card={{ ...chat, image_url: null }} />)).toContain(`aria-label="${brand.name}"`)
  })

  test('nsfw_image : emblème si hideSensitive, image sinon', () => {
    const nsfw = { ...chat, nsfw_image: true }
    expect(html(<Card card={nsfw} />)).not.toContain('upload.wikimedia.org')
    prefs.hideSensitive = false
    expect(html(<Card card={nsfw} />)).toContain(`src="${THUMB}"`)
  })

  test('favori (copies possédées) : « Ajouter aux favoris », puis « Retirer des favoris » une fois coché', () => {
    expect(html(<Card card={chat} />)).not.toContain('favoris')
    expect(html(<Card card={chat} owned onToggleStar={() => {}} />)).toContain('<button type="button" aria-label="Ajouter aux favoris"')
    expect(html(<Card card={chat} owned starred onToggleStar={() => {}} />)).toContain('<button type="button" aria-label="Retirer des favoris"')
  })

  test('stats : épées et bouclier, nombres en formatInt', () => {
    const h = html(<Card card={chat} />)
    expect(h).toContain('class="flex w-full items-center justify-between border-t border-black/20 pt-1 py-1')
    expect(h).toMatch(/lucide-swords[^"]*text-red-800[\s\S]*?<span class="font-bold text-black\/90[^"]*">9 876<\/span>/)
    expect(h).toMatch(/lucide-shield[^"]*text-blue-800[\s\S]*?<span class="font-bold text-black\/90[^"]*">6 974<\/span>/)
  })

  test('sélecteur d\'extension div[class*="glow-"] h3 : le titre, en police des titres', () => {
    for (const el of [<Card key="a" card={chat} />, <Card key="b" card={chat} onClick={() => {}} />]) {
      const h = html(el)
      expect(rootClasses(h).some((c) => c.includes('glow-'))).toBe(true)
      expect(h3Text(h)).toBe('Chat')
      expect(h).toMatch(/<h3 class="[^"]*line-clamp-2 text-black[^"]*" style="font-family:var\(--font-heading\)">/)
    }
  })

  test('p de description et div.mt-auto ; count > 1 affiche « x3 » ; ami possède', () => {
    const h = html(<Card card={chat} owned count={3} friendOwner="alice" />)
    expect(h).toContain('>Espèce de mammifère carnivore</p>')
    expect(h).toMatch(/<div class="mt-auto[^"]*">[\s\S]*alice/)
    expect(textOf(h)).toContain('x3')
    expect(textOf(html(<Card card={chat} owned count={1} />))).not.toContain('x1')
  })
})
