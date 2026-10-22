import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { CardModal, type CatalogCard, type OwnedItem } from './CardModal'
import { ImageCredit } from './ImageCredit'

// Sans DOM (R18) : balisage initial seulement ; Échap, défausse et retrait d'étiquette sont couverts en e2e (Task 14).
vi.mock('@/lib/prefs', () => ({ usePrefs: () => ({ sounds: true, hideSensitive: true, ready: true }) }))
// Onglet de départ : sans DOM, aucun clic ; « market » rend l'onglet Marché (seul useState('details') est touché).
const start = vi.hoisted(() => ({ tab: 'details' }))
vi.mock('react', async (orig) => {
  const react = await orig<typeof import('react')>()
  return { ...react, useState: ((init: unknown) => react.useState(init === 'details' ? start.tab : init)) as typeof react.useState }
})

const catalogue: CatalogCard = {
  id: 'c-1', wikipedia_title: 'Chat', rarity: 'L', category: 'Espèce de mammifère carnivore', atk: 8663, def: 6694,
  image_url: null, wikipedia_url: 'https://fr.wikipedia.org/wiki/Chat', summary: 'Le Chat domestique est un mammifère.',
  q_score: 51.24, pageviews: 6974,
}
// La copie a été tirée en UR (snapshot) avant que la carte passe L : la modale montre l'UR (C11).
const owned: OwnedItem = {
  id: 'uc-1', card_id: 'c-1', card: catalogue, snapshot_title: 'Chat', snapshot_rarity: 'UR', snapshot_atk: 8663, snapshot_def: 6694,
  is_shiny: false, starred: false, count: 2, tags: [{ id: 't-1', name: 'test', color: '#34d399' }, { id: 't-2', name: 'nuit', color: '#1e3a8a' }],
}
const html = (el: React.ReactElement) => renderToStaticMarkup(el).replaceAll('&#x27;', "'").replaceAll('&amp;', '&')
// Pas \s : il avalerait l'espace fine U+202F de formatInt.
const textOf = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/[ \t\n]+/g, ' ')
const tag = (h: string, attr: string) => h.match(new RegExp(`<[a-z0-9]+ [^>]*${attr}[^>]*>`))?.[0] ?? ''
const noop = () => {}

describe('CardModal (R§6.5)', () => {
  const h = html(<CardModal item={owned} onClose={noop} />)
  const text = textOf(h)

  test('portail div.fixed.inset-0 > div.card-frame, en role="dialog" aria-modal, avec « Fermer »', () => {
    expect(h).toMatch(/^<div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black\/70 backdrop-blur-sm[^"]*">/)
    const dialog = tag(h, 'role="dialog"')
    expect(dialog).toContain('aria-modal="true"')
    expect(dialog).toContain('class="card-frame relative w-full animate-fade-in-up p-6 pt-14 sm:pt-6 max-w-2xl max-h-[90vh] overflow-y-auto')
    expect(dialog).toMatch(/aria-labelledby="([^"]+)"/)
    const id = dialog.match(/aria-labelledby="([^"]+)"/)![1]
    expect(h).toContain(`<h2 id="${id}"`)
    expect(h).toContain('aria-label="Fermer"')
  })

  test('grande carte à gauche (rareté du snapshot), infos à droite', () => {
    expect(h).toContain('<div class="flex flex-col md:flex-row gap-6">')
    expect(h).toContain('<div class="flex-shrink-0 flex justify-center">')
    expect(h).toContain('glow-ur')
    expect(h).toContain('flex-1 flex flex-col min-w-0 md:pr-2 gap-4')
    expect(text).toContain('Ultra rare')
    // Le p de la grande carte porte l'extrait dans la modale (neutral-900/90 et non le neutral-800/88 d'origine : contraste sur SR).
    expect(h).toMatch(/<p class="[^"]*text-\[10px\] line-clamp-\[10\] text-neutral-900\/90[^"]*">Le Chat domestique est un mammifère.<\/p>/)
  })

  test('tablist « Vue de la carte » : Détails (actif) et Marché avec la pastille PRO', () => {
    expect(tag(h, 'role="tablist"')).toContain('aria-label="Vue de la carte"')
    expect(h).toMatch(/role="tab" aria-selected="true"[^>]*>Détails</)
    expect(h).toMatch(/role="tab" aria-selected="false"[^>]*>Marché.*?bg-violet-500\/20 text-violet-300[^>]*>.*?PRO/)
  })

  test('ÉTIQUETTES : combobox « Ajouter une étiquette… », puces « #nom » colorées et boutons de retrait', () => {
    expect(text).toContain('ÉTIQUETTES')
    const box = tag(h, 'placeholder="Ajouter une étiquette…"')
    expect(box).toContain('role="combobox"')
    expect(box).toContain('maxLength="48"')
    expect(text).toContain('#test')
    expect(h).toContain('aria-label="Retirer l\'étiquette test"')
    expect(h).toContain('aria-label="Retirer l\'étiquette nuit"')
    // Encre noire ou blanche selon la couleur : toujours ≥ 4,5:1.
    expect(h).toMatch(/background-color:#34d399;color:black">(<[^>]+>)*#test</)
    expect(h).toMatch(/background-color:#1e3a8a;color:white">(<[^>]+>)*#nuit</)
  })

  test('ATK et DEF en formatInt, méta Q-Score (deux décimales, point : R19), Exemplaires, Vues (30j)', () => {
    expect(text).toMatch(/ATK 8 663/)
    expect(text).toMatch(/DEF 6 694/)
    expect(text).toContain('Q-Score : 51.24')
    expect(text).toContain('Exemplaires : 2')
    expect(text).toContain('Vues (30j) : 6 974')
  })

  test('lien Wikipédia et ligne de licence', () => {
    expect(h).toMatch(/<a href="https:\/\/fr.wikipedia.org\/wiki\/Chat" target="_blank" rel="noopener noreferrer"[^>]*>Voir l'article sur Wikipédia →<\/a>/)
    expect(text).toContain('Texte de l\'article : CC BY-SA 4.0 — crédits sur la page Wikipédia.')
  })

  test('pied : « Mettre aux enchères » (accent doux, replié), puis « Défausser », la pièce W et « +1 »', () => {
    const sell = h.match(/<button [^>]*>(?:(?!<\/button>).)*Mettre aux enchères<\/button>/)?.[0] ?? ''
    expect(sell).toContain('aria-expanded="false"')
    expect(sell).toContain('bg-[var(--color-accent)]/10 text-[var(--color-accent)]')
    expect(h).toMatch(/Mettre aux enchères<\/button><button type="button"[^>]*>Défausser.*?M7.5 8.5 9.5 15.5 12 10 14.5 15.5 16.5 8.5.*?\+1<\/button>/)
    // Boîte de vente fermée tant que le bouton n'est pas pressé.
    expect(h).not.toContain('Mise de départ')
  })

  test('onglet « Marché » : le panneau du marché, plus « Arrive bientôt »', () => {
    start.tab = 'market'
    try {
      for (const item of [owned, catalogue]) {
        const t = textOf(html(<CardModal item={item} onClose={noop} />))
        expect(t).toContain('VENTES RÉCENTES')
        expect(t).not.toContain('Arrive bientôt')
      }
    } finally {
      start.tab = 'details'
    }
  })

  test('carte du catalogue : liste de souhaits à la place des étiquettes et de la défausse', () => {
    const c = html(<CardModal item={catalogue} onClose={noop} />)
    const t = textOf(c)
    expect(t).toContain('Ajouter à ma liste de souhaits')
    expect(t).not.toContain('ÉTIQUETTES')
    expect(t).not.toContain('Défausser')
    expect(t).not.toContain('Mettre aux enchères')
    expect(t).not.toContain('Exemplaires')
    expect(c).toContain('glow-l')
    expect(t).toContain('Q-Score : 51.24')
  })
})

describe('ImageCredit (M2-16)', () => {
  const credit = { file: 'Test.jpg', image_author: 'Jean Dupont', image_license: 'CC BY-SA 4.0', license_url: 'https://creativecommons.org/licenses/by-sa/4.0' }
  const a = (href: string, text: string) =>
    `<a href="${href}" target="_blank" rel="noopener noreferrer" class="font-medium text-accent underline hover:text-accent-light">${text}</a>`
  const commons = 'https://commons.wikimedia.org/wiki/File:'

  test('auteur en lien vers la page du fichier sur Commons, puis la licence en lien vers son texte, dans un nouvel onglet', () => {
    expect(html(<ImageCredit credit={credit} />)).toBe(
      `<p class="wrap-anywhere">Image : ${a(`${commons}Test.jpg`, 'Jean Dupont')}, ${a('https://creativecommons.org/licenses/by-sa/4.0', 'CC BY-SA 4.0')}</p>`,
    )
  })

  test('sans URL, la licence en texte simple ; sans auteur, « voir la page du fichier »', () => {
    expect(html(<ImageCredit credit={{ ...credit, license_url: null }} />)).toBe(
      `<p class="wrap-anywhere">Image : ${a(`${commons}Test.jpg`, 'Jean Dupont')}, CC BY-SA 4.0</p>`,
    )
    expect(html(<ImageCredit credit={{ ...credit, image_author: null, license_url: null }} />)).toBe(
      `<p class="wrap-anywhere">Image : ${a(`${commons}Test.jpg`, 'voir la page du fichier')}, CC BY-SA 4.0</p>`,
    )
  })

  // Nom stocké tel que Commons le donne (soulignés, catalog/fixtures/expected/media.csv) ; MediaWiki lit les noms en %.
  test('nom du fichier encodé : espaces, accents, apostrophe et parenthèses', () => {
    const href = (file: string) => html(<ImageCredit credit={{ ...credit, file }} />).match(/href="([^"]+)"/)![1]
    expect(href("219_Château_du_Marhallac'h.jpg")).toBe(`${commons}219_Ch%C3%A2teau_du_Marhallac'h.jpg`)
    expect(href('Tour Eiffel (1889).jpg')).toBe(`${commons}Tour%20Eiffel%20(1889).jpg`)
    expect(href('A&B?#.jpg')).toBe(`${commons}A%26B%3F%23.jpg`)
  })
})
