import { afterEach, expect, test, vi } from 'vitest'
import { cirrusListing } from './cirrus.ts'
import { imageInfoUrls, missingFiles } from './commons.ts'
import { extractsUrls } from './extracts.ts'
import { USER_AGENT } from './http.ts'
import { entitiesUrls } from './wikidata.ts'

const COMMONS = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&maxlag=5&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=330&iiextmetadatafilter=Artist|Attribution|LicenseShortName|LicenseUrl&iiextmetadatalanguage=fr&titles='

test('entitiesUrls : qids dédoublonnés, triés par valeur numérique, lots de 50', () => {
  expect(entitiesUrls(['Q42', 'Q1', 'Q42'])).toEqual([
    'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&formatversion=2&maxlag=5&props=descriptions&languages=fr&ids=Q1%7CQ42',
  ])
  const urls = entitiesUrls(Array.from({ length: 120 }, (_, i) => `Q${120 - i}`))
  expect(urls).toHaveLength(3)
  expect(urls[0]).toMatch(/&ids=Q1%7CQ2%7CQ3%7C/)
  expect(urls[0].split('%7C')).toHaveLength(50)
  expect(urls[1]).toMatch(/&ids=Q51%7C/)
  expect(urls[2]).toMatch(/%7CQ120$/)
  expect(entitiesUrls([])).toEqual([])
  expect(entitiesUrls(['Q42', 'q7', 'Q1a', '', 'P31', 'Q 5', 'Q1'])).toEqual([
    'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&formatversion=2&maxlag=5&props=descriptions&languages=fr&ids=Q1%7CQ42',
  ])
})

test('extractsUrls : page_id croissants, lots de 20', () => {
  const urls = extractsUrls(Array.from({ length: 45 }, (_, i) => 45 - i))
  expect(urls).toHaveLength(3)
  expect(urls[0]).toBe(
    `https://fr.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&maxlag=5&prop=extracts&exintro=1&explaintext=1&exlimit=20&pageids=${Array.from({ length: 20 }, (_, i) => i + 1).join('%7C')}`,
  )
  expect(urls[2]).toMatch(/&pageids=41%7C42%7C43%7C44%7C45$/)
})

test('imageInfoUrls : titres File: encodés, ordre des unités de code, hôte au choix', () => {
  expect(imageInfoUrls(['b.jpg', 'Arc_de_Triomphe_-_Août_2026.jpg', 'B.jpg', 'b.jpg'], 'commons.wikimedia.org')).toEqual([
    `${COMMONS}File%3AArc_de_Triomphe_-_Ao%C3%BBt_2026.jpg%7CFile%3AB.jpg%7CFile%3Ab.jpg`,
  ])
  expect(imageInfoUrls(['X.png'], 'fr.wikipedia.org')).toEqual([
    `${COMMONS.replace('commons.wikimedia.org', 'fr.wikipedia.org')}File%3AX.png`,
  ])
  expect(imageInfoUrls(Array.from({ length: 51 }, (_, i) => `F${i}.jpg`), 'commons.wikimedia.org')).toHaveLength(2)
})

test('imageInfoUrls : 50 noms de 200 caractères cyrilliques → plusieurs URL de 7 000 caractères au plus', () => {
  const files = Array.from({ length: 50 }, (_, i) => `${'Ж'.repeat(196)}${String(i).padStart(2, '0')}.jpg`)
  const urls = imageInfoUrls(files, 'commons.wikimedia.org')
  expect(urls.length).toBeGreaterThan(1)
  for (const url of urls) expect(url.length).toBeLessThanOrEqual(7000)
  // Aucun nom perdu ni répété, dans l'ordre.
  const back = urls.flatMap((url) => decodeURIComponent(url.slice(COMMONS.length)).split('|'))
  expect(back).toEqual(files.toSorted().map((f) => `File:${f}`))
})

test('missingFiles : pages missing ou invalid, noms ramenés à la forme demandée', () => {
  const body = {
    batchcomplete: true,
    query: {
      normalized: [
        { fromencoded: false, from: 'File:A_b.jpg', to: 'File:A b.jpg' },
        { fromencoded: false, from: 'File:Ok_1.jpg', to: 'File:Ok 1.jpg' },
      ],
      pages: [
        { ns: 6, title: 'File:A b.jpg', missing: true, known: false, imagerepository: '' },
        { pageid: 7, ns: 6, title: 'File:Ok 1.jpg', imagerepository: 'local', imageinfo: [{ url: 'https://upload.wikimedia.org/x' }] },
        { ns: 6, title: 'File:Plain.png', missing: true, imagerepository: '' },
        { title: 'File:Bad<name>.png', invalidreason: 'Le titre contient des caractères non valides.', invalid: true },
      ],
    },
  }
  expect(missingFiles(body)).toEqual(['A_b.jpg', 'Plain.png', 'Bad<name>.png'])

  // frwiki : `File:` devient `Fichier:` ; un fichier partagé (Commons) a son imageinfo et n'est pas manquant.
  const fr = {
    query: {
      normalized: [
        { fromencoded: false, from: 'File:Local_x.png', to: 'Fichier:Local x.png' },
        { fromencoded: false, from: 'File:Shared.jpg', to: 'Fichier:Shared.jpg' },
      ],
      pages: [
        { ns: 6, title: 'Fichier:Local x.png', missing: true, imagerepository: '' },
        { ns: 6, title: 'Fichier:Shared.jpg', missing: true, known: true, imagerepository: 'shared', imageinfo: [{ url: 'https://upload.wikimedia.org/y' }] },
      ],
    },
  }
  expect(missingFiles(fr)).toEqual(['Local_x.png'])
  expect(missingFiles({ batchcomplete: true })).toEqual([])
})

const ROOT = 'https://dumps.wikimedia.org/other/cirrus_search_index/'
const PARTS = (date: string) => Array.from({ length: 21 }, (_, i) => `frwiki_content-${date}-${String(i).padStart(5, '0')}.json.bz2`)
const index = (title: string, names: string[]) =>
  `<html>\n<head><title>Index of ${title}</title></head>\n<body>\n<h1>Index of ${title}</h1><hr><pre><a href="../">../</a>\n${names
    .map((n) => `<a href="${n}">${n}</a>                                  18-Oct-2026 12:00     622000000`)
    .join('\n')}\n</pre><hr></body>\n</html>\n`

const pages: Record<string, string> = {
  [ROOT]: index('/other/cirrus_search_index/', ['20261004/', '20261018/', '20261011/', 'README.txt']),
  [`${ROOT}20261018/index_name%3Dfrwiki_content/`]: index('/x/', PARTS('20261018').slice(0, 7)),
  [`${ROOT}20261011/index_name%3Dfrwiki_content/`]: index('/x/', ['_SUCCESS', ...PARTS('20261011').toReversed()]),
  [`${ROOT}20261004/index_name%3Dfrwiki_content/`]: index('/x/', ['_SUCCESS', ...PARTS('20261004')]),
}

test('cirrusListing : le plus récent instantané avec _SUCCESS, 21 parts triées', async () => {
  const seen: string[] = []
  const listing = await cirrusListing(async (url) => {
    seen.push(url)
    if (!(url in pages)) throw new Error(`page inattendue : ${url}`)
    return pages[url]
  })
  expect(listing).toEqual({ date: '20261011', parts: PARTS('20261011') })
  expect(seen).toEqual([ROOT, `${ROOT}20261018/index_name%3Dfrwiki_content/`, `${ROOT}20261011/index_name%3Dfrwiki_content/`])

  await expect(cirrusListing(async (url) => (url === ROOT ? pages[ROOT] : index('/x/', [])))).rejects.toThrow(
    'Cirrus : aucun instantané complet de frwiki_content',
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('cirrusListing par défaut : User-Agent et délai, 3 essais à 5 s sur réseau ou 5xx, dossier en 404 sauté', async () => {
  vi.useFakeTimers({ now: 0 })
  let rootCalls = 0
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('user-agent')).toBe(USER_AGENT)
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    if (url === ROOT && ++rootCalls === 1) throw new TypeError('fetch failed')
    if (url === ROOT && rootCalls === 2) return new Response('busy', { status: 503 })
    if (url.includes('20261018')) return new Response('Not Found', { status: 404 })
    return new Response(pages[url] ?? '', { status: url in pages ? 200 : 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  const listing = cirrusListing()
  await vi.runAllTimersAsync()
  expect(await listing).toEqual({ date: '20261011', parts: PARTS('20261011') })
  expect(rootCalls).toBe(3)
  expect(Date.now()).toBe(10_000)

  const failing = vi.fn(async () => new Response('oops', { status: 500 }))
  vi.stubGlobal('fetch', failing)
  const down = cirrusListing().catch((err: Error) => err)
  await vi.runAllTimersAsync()
  expect(await down).toEqual(new Error(`Cirrus : HTTP 500 sur ${ROOT} après 3 essais`))
  expect(failing).toHaveBeenCalledTimes(3)

  vi.stubGlobal('fetch', vi.fn(async () => new Response('Not Found', { status: 404 })))
  await expect(cirrusListing()).rejects.toThrow(`Cirrus : listing des dumps introuvable sur ${ROOT}`)
})
