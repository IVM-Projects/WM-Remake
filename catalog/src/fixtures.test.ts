import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterAll, expect, test } from 'vitest'
import { MIN_VIEWS, rarityForViews } from '../../lib/rarity.ts'
import { imageInfoUrls } from './commons.ts'
import { joinCatalog } from './compute.ts'
import type { CatalogRow } from './compute.ts'
import { extractsUrls } from './extracts.ts'
import {
  fetchCommand, fixturesReadme, pickFixtureIds, readmeCommand, sliceCirrus, sliceCirrusCommand, slicePageviews,
  slicePageviewsCommand, sliceSql,
} from './fixtures.ts'
import { dump, PAGE_CREATE, PAGE_TUPLES, PROPS_CREATE, PROPS_TUPLES } from './sqldump.sample.ts'
import { dumpsCommand, sqlTuples } from './sqldump.ts'
import { writeTsv } from './tsv.ts'
import { entitiesUrls } from './wikidata.ts'

const dir = await mkdtemp(join(tmpdir(), 'wm-fixtures-'))
afterAll(() => rm(dir, { recursive: true, force: true }))

async function* lines(text: string) {
  yield* text.split('\n')
}

test('pickFixtureIds : 250 par hachage, puis chaque rareté L à R, AdQ, BA et SVG ; stable', () => {
  // 3 000 pages : 15 de chaque rareté L, UR, SR et R, 5 AdQ, 5 BA, 5 SVG, le reste en C.
  const views = [MIN_VIEWS.L, MIN_VIEWS.UR, MIN_VIEWS.SR, MIN_VIEWS.R]
  const rows: CatalogRow[] = Array.from({ length: 3000 }, (_, i) => {
    const id = i + 1
    const v = views[id % 200] ?? 0
    return {
      page_id: id, title: `P${id}`, len: 100, views: v, rarity: rarityForViews(v),
      image: id % 700 === 7 ? `Carte_${id}.svg` : `Photo_${id}.jpg`, qid: `Q${id}`,
      badge: id % 700 === 5 ? 1 : id % 700 === 6 ? 0.6 : 0, selected: false,
    }
  })
  const picked = pickFixtureIds(rows)
  const chosen = rows.filter((r) => picked.has(r.page_id))
  expect(picked.size).toBeLessThanOrEqual(310)
  expect([...picked.values()].filter((r) => r === 'hash')).toHaveLength(250)
  for (const code of ['L', 'UR', 'SR', 'R']) expect(chosen.filter((r) => r.rarity === code).length).toBeGreaterThanOrEqual(10)
  expect(chosen.filter((r) => r.badge === 1).length).toBeGreaterThanOrEqual(3)
  expect(chosen.filter((r) => r.badge === 0.6).length).toBeGreaterThanOrEqual(3)
  expect(chosen.filter((r) => r.image?.endsWith('.svg')).length).toBeGreaterThanOrEqual(3)
  expect(new Set(picked.values())).toEqual(new Set(['hash', 'L', 'UR', 'SR', 'R', 'AdQ', 'BA', 'svg']))
  expect([...pickFixtureIds([...rows].reverse())]).toEqual([...picked])
})

test('sliceSql : tuples gardés relus à l’identique, en-tête CREATE TABLE intact', async () => {
  const text = dump('page', PAGE_CREATE, PAGE_TUPLES)
  const all = await Array.fromAsync(sqlTuples(lines(text), 'page'))
  const slice = await sliceSql(lines(text), 'page', new Set([16, 40]))
  expect(slice.ids).toEqual(new Set([16, 40]))
  expect(slice.text.startsWith(text.slice(0, text.indexOf('INSERT')))).toBe(true)
  expect(slice.text).toContain('CREATE TABLE `page` (')
  expect(await Array.fromAsync(sqlTuples(lines(slice.text), 'page'))).toEqual(all.filter((t) => t[0] === 16 || t[0] === 40))
  // Échappements MySQL réécrits : la chaîne relue est la même.
  const odd = String.raw`(5,0,'a\\b\"c\nd\0\'e\rf\Zg',0,0,0.5,'20260930180248',NULL,1,10,'wikitext',NULL)`
  const oddSlice = await sliceSql(lines(dump('page', PAGE_CREATE, [odd])), 'page', new Set([5]))
  expect(oddSlice.text).toContain(String.raw`'a\\b\"c\nd\0\'e\rf\Zg'`)
  expect((await Array.fromAsync(sqlTuples(lines(oddSlice.text), 'page')))[0][2]).toBe('a\\b"c\nd\0\'e\rf\x1ag')
})

test('sliceSql : redirections, autres espaces et homonymies en plus ; l’homonymie reste exclue par page_props', async () => {
  const disambiguation = String.raw`(48,0,'Mercure',0,0,0.5,'20260930180248',NULL,1,500,'wikitext',NULL)`
  const pageText = dump('page', PAGE_CREATE, [...PAGE_TUPLES, disambiguation])
  const page = await sliceSql(lines(pageText), 'page', new Set([3]), { redirects: 1, otherNs: 1, disambiguation: new Set([48]) })
  // 21 = redirection de l’espace 0, 40 = espace 1.
  expect(page.ids).toEqual(new Set([3, 21, 40, 48]))
  const props = await sliceSql(lines(dump('page_props', PROPS_CREATE, PROPS_TUPLES)), 'page_props', page.ids)
  expect(props.ids).toEqual(new Set([48]))

  const work = join(dir, 'disambiguation')
  await mkdir(work)
  await writeFile(join(work, 'page.sql'), page.text)
  await writeFile(join(work, 'page_props.sql'), props.text)
  await dumpsCommand({ page: join(work, 'page.sql'), props: join(work, 'page_props.sql'), dir: work })
  await writeFile(join(work, 'views.tsv'), '')
  expect((await joinCatalog(work)).map((r) => r.page_id)).toEqual([3])
})

test('slicePageviews : par page_id, ou par titre quand page_id manque', async () => {
  const text = [
    'fr.wikipedia Antoine_Meillet 3 desktop 10 A10',
    'fr.wikipedia Antoine_Meillet 3 mobile-web 5 A5',
    'fr.wikipedia Antoine_Meillet null mobile-app 2 A2',
    'fr.wikipedia Antoine_Meillet desktop 1 A1',
    'fr.wikipedia Autre 99 desktop 7 A7',
    'fr.wikipedia Autre null desktop 7 A7',
    'en.wikipedia Antoine_Meillet 3 desktop 4 A4',
  ].join('\n')
  expect(await slicePageviews(lines(text), new Set([3]), new Set(['Antoine_Meillet']))).toEqual([
    'fr.wikipedia Antoine_Meillet 3 desktop 10 A10',
    'fr.wikipedia Antoine_Meillet 3 mobile-web 5 A5',
    'fr.wikipedia Antoine_Meillet null mobile-app 2 A2',
    'fr.wikipedia Antoine_Meillet desktop 1 A1',
  ])
})

test('sliceCirrus : seule la paire d’un id gardé reste, sans source_text', async () => {
  const doc = (id: number) => ({
    page_id: id, namespace: 0, title: `T${id}`, opening_text: 'Texte.', text_bytes: 100, source_text: '{{Infobox}}', text: 'Texte long',
    template: ['Modèle:Bon article'], wiki: 'frwiki',
  })
  const text = [1, 2, 3].flatMap((id) => [`{"index": {"_id": ${id}}}`, JSON.stringify(doc(id))]).join('\n')
  const out = await Array.fromAsync(sliceCirrus(lines(text), new Set([2, 7])))
  expect(out).toEqual([
    '{"index": {"_id": 2}}',
    JSON.stringify({ page_id: 2, namespace: 0, title: 'T2', opening_text: 'Texte.', text_bytes: 100, template: ['Modèle:Bon article'], wiki: 'frwiki' }),
  ])
  await expect(Array.fromAsync(sliceCirrus(lines('{"create": {"_id": 1}}\n{}'), new Set([1])))).rejects.toThrow(
    "Format Cirrus inattendu : ligne d'index 1",
  )
})

test('slice-pageviews et slice-cirrus : flux lu après la tranche page, aucune ligne perdue', async () => {
  const fixtures = join(dir, 'stream')
  await mkdir(join(fixtures, 'raw'), { recursive: true })
  // Tranche page : 3, 16, 21 (redirection) et 40 (espace 1).
  await writeFile(join(fixtures, 'raw', 'page.sql'), dump('page', PAGE_CREATE, PAGE_TUPLES))
  const pv = Array.from({ length: 5000 }, (_, i) => `fr.wikipedia T${i} ${i} desktop 1 A1\n`).join('')
  expect(await slicePageviewsCommand({ fixtures, input: Readable.from([pv]) })).toEqual({ lines: 4 })
  expect(await readFile(join(fixtures, 'raw', 'pageviews.txt'), 'utf8')).toContain('fr.wikipedia T40 40 desktop 1 A1\n')

  const pairs = Array.from({ length: 5000 }, (_, i) => `{"index": {"_id": ${i}}}\n{"page_id": ${i}, "text": "x"}\n`).join('')
  let out = ''
  const output = new Writable({
    write(chunk, _, done) {
      out += chunk
      done()
    },
  })
  await sliceCirrusCommand({ fixtures, input: Readable.from([pairs]), output })
  expect(out.split('\n').filter((l) => l.startsWith('{"page_id"'))).toEqual(['{"page_id":3}', '{"page_id":16}', '{"page_id":21}', '{"page_id":40}'])
})

test('fetch : Règles de lots sur toutes les pages choisies, corps rangés par URL exacte', async () => {
  const work = join(dir, 'fetch')
  const fixtures = join(dir, 'fetch-fixtures')
  await mkdir(work)
  await mkdir(join(fixtures, 'raw'), { recursive: true })
  const ids = Array.from({ length: 45 }, (_, i) => i + 1)
  const image = (id: number) => (id % 2 ? `Vue_d'${id}.jpg` : null)
  await writeTsv(join(work, 'catalog.tsv'), [
    ...ids.map((id) => [id, `P${id}`, 100, 0, 'C', image(id), `Q${id}`, 0, 1]),
    [46, 'P46', 100, 0, 'C', 'Hors.jpg', 'Q46', 0, 0],
  ])
  // 44 : bandeau seul ; 45 : seulement une redirection du même id ; les autres ont un texte.
  const docs = [
    ...ids.slice(0, 43).map((id) => ({ page_id: id, namespace: 0, opening_text: 'Texte.' })),
    { page_id: 44, namespace: 0, opening_text: 'Pour les articles homonymes, voir Quarante-quatre.' },
    { page_id: 45, namespace: 0, page_type: 'redirect', opening_text: 'Texte.' },
  ]
  await writeFile(join(fixtures, 'raw', 'cirrus.ndjson'), docs.map((d) => `{"index": {"_id": ${d.page_id}}}\n${JSON.stringify(d)}\n`).join(''))

  const asked: string[] = []
  const client = {
    async get(url: string) {
      asked.push(url)
      return url.startsWith('https://commons.') ? { query: { pages: [{ title: "File:Vue_d'1.jpg", missing: true }] } } : { url }
    },
  }
  const result = await fetchCommand({ dir: work, fixtures, client })
  const read = async (name: string) => JSON.parse(await readFile(join(fixtures, 'raw', name), 'utf8')) as Record<string, unknown>

  const wikidata = entitiesUrls(ids.map((id) => `Q${id}`))
  const commons = imageInfoUrls(ids.flatMap((id) => image(id) ?? []), 'commons.wikimedia.org')
  const fr = imageInfoUrls(["Vue_d'1.jpg"], 'fr.wikipedia.org')
  const extracts = [...new Set([...extractsUrls([44, 45]), ...extractsUrls(ids.slice(0, 40))])]
  expect(Object.keys(await read('wikidata.json'))).toEqual(wikidata)
  expect(Object.keys(await read('commons.json'))).toEqual([...commons, ...fr])
  expect(Object.keys(await read('extracts.json'))).toEqual(extracts)
  expect((await read('wikidata.json'))[wikidata[0]]).toEqual({ url: wikidata[0] })
  expect(asked.toSorted()).toEqual([...wikidata, ...commons, ...fr, ...extracts].toSorted())
  expect(result).toEqual({ wikidata: wikidata.length, commons: commons.length + fr.length, extracts: extracts.length })
})

test('README et meta.json : sources datées, licences, mois en YYYY-MM', async () => {
  const text = fixturesReadme({ runDate: '2026-10-22', month: '2026-09', sources: [{ name: 'Dump `page`', url: 'https://dumps.wikimedia.org/x', date: '2026-10-01' }] })
  expect(text).toContain('| Dump `page` | https://dumps.wikimedia.org/x | 2026-10-01 |')
  for (const s of ['2026-10-22', 'CC BY-SA 4.0', 'CC0', 'licence de chaque fichier', '`source_text`']) expect(text).toContain(s)
  expect(text).toMatch(/^- Vues \(`pageviews.txt`\) : .* du mois 2026-09 .* CC0 1\.0 /m)

  const fixtures = join(dir, 'readme')
  await mkdir(join(fixtures, 'raw'), { recursive: true })
  await readmeCommand({ fixtures, month: '2026-09', cirrusDate: '20261018', dumpDate: '2026-10-01' })
  const meta = JSON.parse(await readFile(join(fixtures, 'raw', 'meta.json'), 'utf8'))
  expect(meta).toEqual({ run_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), month: '2026-09', cirrus_date: '2026-10-18' })
  const readme = await readFile(join(fixtures, 'README.md'), 'utf8')
  expect(readme).toContain('https://dumps.wikimedia.org/other/pageview_complete/monthly/2026/2026-09/pageviews-202609-user.bz2 | 2026-09 |')
  expect(readme).toContain('https://dumps.wikimedia.org/other/cirrus_search_index/20261018/index_name%3Dfrwiki_content/ | 2026-10-18 |')
  expect(readme).toContain('https://dumps.wikimedia.org/frwiki/latest/frwiki-latest-page.sql.gz | 2026-10-01 |')
})

test('CLI fixtures readme : --month hors YYYY-MM (mois 01 à 12) refusé', () => {
  const cli = new URL('./cli.ts', import.meta.url).pathname
  for (const month of ['2026-13', '2026-00', '2026-9']) {
    const args = ['fixtures', 'readme', '--fixtures', dir, '--month', month, '--cirrus-date', '20261018', '--dump-date', '2026-10-01']
    const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
    expect(run.status).toBe(1)
    expect(run.stderr.trim()).toBe(`Option --month invalide : ${month}`)
  }
})
