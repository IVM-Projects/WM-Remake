import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, test } from 'vitest'
import { commonsCommand, imageInfoUrls, parseImageInfo, stripHtml, thumbUrl } from './commons.ts'
import { selectCommand } from './compute.ts'
import { batchValues } from './http.ts'
import type { Client } from './http.ts'
import { pageviewsCommand } from './pageviews.ts'
import { dumpsCommand, openLines } from './sqldump.ts'
import { readTsv, writeTsv } from './tsv.ts'

const RAW = fileURLToPath(new URL('../fixtures/raw/', import.meta.url))
const bodies = JSON.parse(await readFile(join(RAW, 'commons.json'), 'utf8')) as Record<string, unknown>
const repoOf = (url: string) => (url.startsWith('https://fr.wikipedia.org/') ? 'fr' : 'commons')

// catalog.tsv des tranches : dumps, vues, puis select au taux 1 (toutes les pages selected).
const base = await mkdtemp(join(tmpdir(), 'wm-commons-'))
afterAll(() => rm(base, { recursive: true, force: true }))
await dumpsCommand({ page: join(RAW, 'page.sql'), props: join(RAW, 'page_props.sql'), dir: base })
await pageviewsCommand({ input: openLines(join(RAW, 'pageviews.txt')), dir: base, minLines: 0 })
await selectCommand({ dir: base, mode: 'sample', rate: 1 })
const images = new Set(
  (await Array.fromAsync(readTsv(join(base, 'catalog.tsv')))).flatMap((f) => (f[8] === '1' && f[5] !== null ? [f[5]] : [])),
)

async function work(name: string): Promise<string> {
  const dir = join(base, name)
  await mkdir(dir)
  await copyFile(join(base, 'catalog.tsv'), join(dir, 'catalog.tsv'))
  return dir
}

// Client simulé : des corps par URL exacte ; une URL inconnue fait échouer la commande.
function fixtureClient(served: Record<string, unknown> = bodies, onGet = () => {}) {
  const urls: string[] = []
  const client: Client = {
    async get(url) {
      urls.push(url)
      onGet()
      if (!Object.hasOwn(served, url)) throw new Error(`URL inconnue : ${url}`)
      return served[url]
    },
  }
  return { client, urls }
}

const mediaTsv = async (dir: string) => Array.fromAsync(readTsv(join(dir, 'media.tsv')))

test('stripHtml : balises retirées, entités décodées, blancs réduits', () => {
  expect(stripHtml('<a href="//commons.wikimedia.org/wiki/User:NuclearVacuum" title="User:NuclearVacuum">NuclearVacuum</a>')).toBe('NuclearVacuum')
  expect(stripHtml('<span class="int-own-work" lang="fr">Travail personnel</span>')).toBe('Travail personnel')
  expect(stripHtml('<a>A</a>, <a>B</a>')).toBe('A, B')
  expect(stripHtml('Jean &amp; Marie&nbsp;Curie')).toBe('Jean & Marie Curie')
  expect(stripHtml('&#233;t&#xE9;')).toBe('été')
  expect(stripHtml('<b>x</b>\n  <i>y</i>')).toBe('x y')
  expect(stripHtml('&lt;b&gt; &quot;c&quot; &#39;d&#39; &inconnu; &#99999999;')).toBe('<b> "c" \'d\' &inconnu; &#99999999;')
  // Vu dans la tranche : texte masqué du modèle {{Unknown|author}}, blocs collés.
  expect(stripHtml('<div class="fn value">\nAuteur inconnu<span style="display: none;">Unknown author</span></div>')).toBe('Auteur inconnu')
  expect(stripHtml('<p>A</p><p>B</p>A<br>B<br />C')).toBe('A B A B C')
})

test('thumbUrl : miniature 330 px, original pour une petite image matricielle, nom long abrégé', () => {
  const svg = 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9d/EU-Austria.svg/330px-EU-Austria.svg.png'
  expect(thumbUrl('EU-Austria.svg', { repo: 'commons', mime: 'image/svg+xml', width: 512 })).toBe(svg)
  expect(thumbUrl('EU-Austria.svg', { repo: 'commons', mime: 'image/svg+xml', width: 100 })).toBe(svg)
  const jpeg = { repo: 'commons', mime: 'image/jpeg' } as const
  expect(thumbUrl('Arc_de_Triomphe_-_Août_2026.jpg', { ...jpeg, width: 4000 })).toBe(
    'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Arc_de_Triomphe_-_Ao%C3%BBt_2026.jpg/330px-Arc_de_Triomphe_-_Ao%C3%BBt_2026.jpg',
  )
  expect(thumbUrl('Arc_de_Triomphe_-_Août_2026.jpg', { ...jpeg, width: 330 })).toBe(
    'https://upload.wikimedia.org/wikipedia/commons/1/1a/Arc_de_Triomphe_-_Ao%C3%BBt_2026.jpg',
  )
  for (const mime of ['image/png', 'image/gif', 'image/webp']) {
    expect(thumbUrl('X.png', { repo: 'commons', mime, width: 331 })).toMatch(/\/thumb\/.+\/330px-X\.png$/)
    expect(thumbUrl('X.png', { repo: 'commons', mime, width: 200 })).not.toContain('/thumb/')
  }

  const long = `${'é'.repeat(83)}.JPG` // 170 octets
  expect(Buffer.byteLength(long)).toBe(170)
  expect(thumbUrl(long, { ...jpeg, width: 4000 })).toMatch(new RegExp(`/${encodeURIComponent(long)}/330px-thumbnail\\.jpg$`))
  const longSvg = `${'a'.repeat(166)}.svg`
  expect(thumbUrl(longSvg, { repo: 'commons', mime: 'image/svg+xml', width: 512 })).toMatch(/\/a{166}\.svg\/330px-thumbnail\.svg\.png$/)
  const atLimit = `${'a'.repeat(156)}.jpg` // 160 octets : pas abrégé
  expect(thumbUrl(atLimit, { ...jpeg, width: 4000 })).toMatch(/\/330px-a{156}\.jpg$/)

  expect(thumbUrl('EU-Austria.svg', { repo: 'fr', mime: 'image/svg+xml', width: 512 })).toBe(svg.replace('/commons/', '/fr/'))
  expect(thumbUrl('Arc de Triomphe - Août 2026.jpg', { ...jpeg, width: 4000 })).toBe(thumbUrl('Arc_de_Triomphe_-_Août_2026.jpg', { ...jpeg, width: 4000 }))
  expect(thumbUrl('Carte.tif', { repo: 'commons', mime: 'image/tiff', width: 4000 })).toBeNull()
  expect(thumbUrl('Livre.pdf', { repo: 'commons', mime: 'application/pdf', width: 4000 })).toBeNull()
})

test('parseImageInfo : Attribution avant Artist, license_url http(s) seulement, noms demandés, dépôt de chaque fichier', () => {
  const info = (extmetadata: object, url = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Ignored.jpg?utm_source=x') => [
    { size: 1, width: 4000, height: 3000, url, mime: 'image/jpeg', extmetadata },
  ]
  const body = {
    batchcomplete: true,
    query: {
      normalized: [
        { fromencoded: false, from: 'File:Avec_attribution.jpg', to: 'File:Avec attribution.jpg' },
        { fromencoded: false, from: 'File:Lien_douteux.jpg', to: 'File:Lien douteux.jpg' },
        { fromencoded: false, from: 'File:Ancien_nom.jpg', to: 'File:Ancien nom.jpg' },
      ],
      pages: [
        {
          pageid: 1, ns: 6, title: 'File:Avec attribution.jpg', imagerepository: 'local',
          imageinfo: info({
            Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:X">X</a>' },
            Attribution: { value: '<b>Y</b> / Wikimedia Commons' },
            LicenseShortName: { value: 'CC BY-SA 4.0' },
            LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
          }, 'https://upload.wikimedia.org/wikipedia/commons/x/xy/Avec_attribution.jpg'),
        },
        {
          pageid: 2, ns: 6, title: 'File:Lien douteux.jpg', imagerepository: 'local',
          imageinfo: info({ Artist: { value: '<p>\n</p>' }, LicenseShortName: { value: 'CC0' }, LicenseUrl: { value: 'javascript:alert(1)' } },
            'https://upload.wikimedia.org/wikipedia/commons/x/xy/Lien_douteux.jpg'),
        },
        // Redirection de fichier : imageinfo de la cible, dont `url` donne le nom à hacher.
        {
          pageid: 3, ns: 6, title: 'File:Ancien nom.jpg', imagerepository: 'local',
          imageinfo: info(
            { Attribution: { value: '  ' }, Artist: { value: 'Z' } },
            'https://upload.wikimedia.org/wikipedia/commons/2/2f/Nouveau_nom.jpg?utm_source=x',
          ),
        },
        { ns: 6, title: 'File:Absent.jpg', missing: true, imagerepository: '' },
      ],
    },
  }
  const big = (file: string) => thumbUrl(file, { repo: 'commons', mime: 'image/jpeg', width: 4000 })
  expect(parseImageInfo(body, 'commons')).toEqual({
    media: [
      {
        file: 'Avec_attribution.jpg', author: 'Y / Wikimedia Commons', license: 'CC BY-SA 4.0',
        license_url: 'https://creativecommons.org/licenses/by-sa/4.0',
        image_url: big('Avec_attribution.jpg'),
      },
      { file: 'Lien_douteux.jpg', author: null, license: 'CC0', license_url: null, image_url: big('Lien_douteux.jpg') },
      { file: 'Ancien_nom.jpg', author: 'Z', license: null, license_url: null, image_url: big('Nouveau_nom.jpg') },
    ],
    missing: ['Absent.jpg'],
  })

  // frwiki : un fichier local va au dépôt fr, un fichier partagé reste sur Commons.
  const fr = {
    query: {
      normalized: [
        { fromencoded: false, from: 'File:Logo_local.png', to: 'Fichier:Logo local.png' },
        { fromencoded: false, from: 'File:Partagé.jpg', to: 'Fichier:Partagé.jpg' },
      ],
      pages: [
        {
          pageid: 4, ns: 6, title: 'Fichier:Logo local.png', imagerepository: 'local',
          imageinfo: [{ width: 800, mime: 'image/png', url: 'https://upload.wikimedia.org/wikipedia/fr/f/fb/Logo_local.png' }],
        },
        {
          ns: 6, title: 'Fichier:Partagé.jpg', missing: true, known: true, imagerepository: 'shared',
          imageinfo: [{ width: 800, mime: 'image/jpeg', url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Partag%C3%A9.jpg' }],
        },
      ],
    },
  }
  const { media, missing } = parseImageInfo(fr, 'fr')
  expect(missing).toEqual([])
  expect(media.map((m) => [m.file, m.image_url])).toEqual([
    ['Logo_local.png', thumbUrl('Logo_local.png', { repo: 'fr', mime: 'image/png', width: 800 })],
    ['Partagé.jpg', thumbUrl('Partagé.jpg', { repo: 'commons', mime: 'image/jpeg', width: 800 })],
  ])
  expect(parseImageInfo({ batchcomplete: true }, 'commons')).toEqual({ media: [], missing: [] })
})

const slice = Object.entries(bodies).map(([url, body]) => ({ url, body, ...parseImageInfo(body, repoOf(url)) }))
const media = slice.flatMap((s) => s.media)

test('parseImageInfo sur raw/commons.json : texte brut, licences, miniatures, noms demandés', () => {
  expect(media.length).toBeGreaterThan(150)
  for (const m of media) expect(m.author ?? '', m.file).not.toContain('<')
  expect(media.filter((m) => m.license).length / media.length).toBeGreaterThanOrEqual(0.9)
  const svgs = media.filter((m) => /\.svg$/i.test(m.file))
  expect(svgs.length).toBeGreaterThanOrEqual(3)
  for (const m of svgs) expect(m.image_url, m.file).toMatch(/\.svg\.png$/)
  for (const m of media) {
    if (m.image_url !== null) expect(m.image_url).toMatch(/^https:\/\/upload\.wikimedia\.org\/wikipedia\/(commons|fr)\/(thumb\/)?[0-9a-f]\/[0-9a-f]{2}\//)
  }
  expect(new Set(media.map((m) => m.file))).toEqual(images)
  expect(media).toHaveLength(images.size)
})

test('thumbUrl rejoint la miniature que l’API rend pour chaque fichier de la tranche (à l’hôte près)', () => {
  type Pages = { query: { pages: { imageinfo?: { thumburl: string }[] }[] } }
  for (const s of slice) {
    const pages = (s.body as Pages).query.pages.filter((p) => p.imageinfo)
    expect(s.media).toHaveLength(pages.length)
    pages.forEach((p, i) => {
      const api = p.imageinfo![0].thumburl.split('?')[0].replace('https://thumb.wikimedia.org/', 'https://upload.wikimedia.org/')
      expect(decodeURIComponent(s.media[i].image_url!)).toBe(decodeURIComponent(api))
    })
  }
})

test('commonsCommand : Commons puis frwiki sur les tranches, sans URL inconnue ; second run tout sauté', async () => {
  const dir = await work('full')
  const { client, urls } = fixtureClient()
  expect(await commonsCommand({ dir, client })).toEqual({ done: 5, skipped: 0, finished: true })
  expect(urls.toSorted()).toEqual(Object.keys(bodies).toSorted())
  const rows = await mediaTsv(dir)
  expect(rows.map((f) => f[0]).toSorted()).toEqual([...images].toSorted())
  const byFile = new Map(media.map((m) => [m.file, [m.file, m.author, m.license, m.license_url, m.image_url]]))
  for (const row of rows) expect(row).toEqual(byFile.get(row[0]!))

  const again = fixtureClient()
  expect(await commonsCommand({ dir, client: again.client })).toEqual({ done: 0, skipped: 4, finished: true })
  expect(again.urls).toEqual([])
  expect(await mediaTsv(dir)).toEqual(rows)
})

test('commonsCommand : un lot dont chaque fichier est dans media.tsv est sauté', async () => {
  const dir = await work('resume')
  const commonsUrls = imageInfoUrls([...images], 'commons.wikimedia.org')
  const last = commonsUrls.at(-1)!
  await writeTsv(join(dir, 'media.tsv'), batchValues(last).map((v) => [v.slice('File:'.length), 'déjà là', 'CC0', null, null]))
  const { client, urls } = fixtureClient()
  expect(await commonsCommand({ dir, client })).toEqual({ done: 4, skipped: 1, finished: true })
  expect(urls).not.toContain(last)
  const rows = await mediaTsv(dir)
  expect(rows).toHaveLength(images.size)
  expect(rows.filter((f) => f[1] === 'déjà là')).toHaveLength(batchValues(last).length)
})

test('commonsCommand : délai dépassé après le premier lot → finished: false ; la reprise redemande le lot au fichier en attente', async () => {
  const dir = await work('deadline')
  let t = 0
  const { client, urls } = fixtureClient(bodies, () => (t = 31 * 60_000))
  expect(await commonsCommand({ dir, client, deadlineMin: 30, now: () => t })).toEqual({ done: 1, skipped: 0, finished: false })
  expect(urls).toHaveLength(1)
  // Le premier lot a un fichier absent de Commons, en attente de frwiki : pas de ligne pour lui.
  const first = await mediaTsv(dir)
  expect(first).toHaveLength(batchValues(urls[0]).length - 1)
  expect(first.every((f) => f[4] !== null)).toBe(true)

  const next = fixtureClient()
  expect(await commonsCommand({ dir, client: next.client, deadlineMin: 30, now: () => 0 })).toEqual({ done: 5, skipped: 0, finished: true })
  const rows = await mediaTsv(dir)
  expect(new Set(rows.map((f) => f[0])).size).toBe(rows.length)
  expect(rows).toHaveLength(images.size)
})

test('commonsCommand : pages selected seulement ; introuvable partout → ligne vide, plus redemandée', async () => {
  const dir = join(base, 'gone')
  await mkdir(dir)
  // catalog.tsv : page_id, title, len, views, rarity, image|\N, qid|\N, badge, selected.
  await writeTsv(join(dir, 'catalog.tsv'), [
    [1, 'Ici', 100, 10, 'C', 'Ici.jpg', 'Q1', 0, 1],
    [2, 'Disparu', 100, 10, 'C', 'Disparu.png', 'Q2', 0, 1],
    [3, 'Ailleurs', 100, 10, 'C', 'Ailleurs.jpg', 'Q3', 0, 0],
    [4, 'Sans image', 100, 10, 'C', null, 'Q4', 0, 1],
  ])
  const [commons] = imageInfoUrls(['Ici.jpg', 'Disparu.png'], 'commons.wikimedia.org')
  const [fr] = imageInfoUrls(['Disparu.png'], 'fr.wikipedia.org')
  const served = {
    [commons]: {
      query: {
        pages: [
          { ns: 6, title: 'File:Disparu.png', missing: true, imagerepository: '' },
          {
            pageid: 9, ns: 6, title: 'File:Ici.jpg', imagerepository: 'local',
            imageinfo: [{
              width: 100, mime: 'image/jpeg', url: 'https://upload.wikimedia.org/wikipedia/commons/0/0a/Ici.jpg',
              extmetadata: { Artist: { value: 'Moi' }, LicenseShortName: { value: 'CC0' } },
            }],
          },
        ],
      },
    },
    [fr]: {
      query: {
        normalized: [{ from: 'File:Disparu.png', to: 'Fichier:Disparu.png' }],
        pages: [{ ns: 6, title: 'Fichier:Disparu.png', missing: true, imagerepository: '' }],
      },
    },
  }
  const { client, urls } = fixtureClient(served)
  expect(await commonsCommand({ dir, client })).toEqual({ done: 2, skipped: 0, finished: true })
  expect(urls).toEqual([commons, fr])
  expect(await mediaTsv(dir)).toEqual([
    ['Ici.jpg', 'Moi', 'CC0', null, thumbUrl('Ici.jpg', { repo: 'commons', mime: 'image/jpeg', width: 100 })],
    ['Disparu.png', null, null, null, null],
  ])
  const again = fixtureClient(served)
  expect(await commonsCommand({ dir, client: again.client })).toEqual({ done: 0, skipped: 1, finished: true })
  expect(again.urls).toEqual([])
})
