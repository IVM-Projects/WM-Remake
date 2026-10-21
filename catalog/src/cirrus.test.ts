import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, test } from 'vitest'
import { cirrusCommand } from './cirrus.ts'
import { selectCommand, SUMMARY_MAX } from './compute.ts'
import type { Mode } from './compute.ts'
import { extractsUrls } from './extracts.ts'
import { pageviewsCommand } from './pageviews.ts'
import { dumpsCommand, openLines } from './sqldump.ts'
import { readTsv, writeTsv } from './tsv.ts'

const raw = fileURLToPath(new URL('../fixtures/raw/', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'wm-cirrus-'))
afterAll(() => rm(root, { recursive: true, force: true }))

// catalog.tsv des tranches (Step 5 de la Task 5) : taux 1, toutes les pages selected.
const slice = join(root, 'slice')
await mkdir(slice)
await dumpsCommand({ page: join(raw, 'page.sql'), props: join(raw, 'page_props.sql'), dir: slice })
await pageviewsCommand({ input: openLines(join(raw, 'pageviews.txt')), dir: slice, minLines: 0 })
await selectCommand({ dir: slice, mode: 'sample', rate: 1 })

const ndjson = await readFile(join(raw, 'cirrus.ndjson'), 'utf8')
type Doc = { page_id: number; page_type: string; text_bytes: number; incoming_links?: number }
const docs: Doc[] = ndjson.trim().split('\n').filter((_, i) => i % 2 === 1).map((l) => JSON.parse(l))

// Débuts de bandeaux relevés dans les tranches réelles : aucun résumé ne commence ainsi.
const BANNERS =
  /^(?:Pour [^.]*, vo(?:ir|yez)|Ne doit pas|Ne pas confondre|Cet article (?:concerne|traite|est une ébauche|est orphelin|ne cite|ne s['’]appuie|peut contenir)|Cette page (?:d['’]homonymie|est une très courte|contient)|Vous (?:lisez|pouvez)|Articles? principa|Si vous disposez|En pratique|Moins de trois|Trouver des sources|Sur les autres projets|À l['’]instar du célèbre|Consultez la liste|Voir la page de discussion|L['’]article peut contenir|S['’]ils s['’]affichent|«[^»]*»\s*redirige)/

async function* lines(text: string) {
  yield* text.split('\n').filter(Boolean)
}
const pairs = (list: object[], id = (d: { page_id?: unknown }) => d.page_id) =>
  list.map((d) => `{"index": {"_id": ${id(d)}}}\n${JSON.stringify(d)}`).join('\n')

let n = 0
// Dossier écrit à la main : catalog.tsv (page_id, …, selected en colonne 9) et text-<part>.tsv relu.
async function run(mode: Mode, selected: [number, 0 | 1][], input: string) {
  const dir = await mkdtemp(join(root, `${n++}-`))
  await writeTsv(join(dir, 'catalog.tsv'), selected.map(([id, s]) => [id, `T${id}`, 100, 10, 'C', null, null, 0, s]))
  const result = await cirrusCommand({ dir, part: '00007', mode, input: lines(input) })
  return { result, rows: await Array.fromAsync(readTsv(join(dir, 'text-00007.tsv'))) }
}

test('tranche réelle, mode sample : une ligne par document hors redirection, nombres et résumés', async () => {
  const result = await cirrusCommand({ dir: slice, part: 'fixtures', mode: 'sample', input: openLines(join(raw, 'cirrus.ndjson')) })
  const rows = await Array.fromAsync(readTsv(join(slice, 'text-fixtures.tsv')))
  const primary = docs.filter((d) => d.page_type !== 'redirect')
  expect(docs.length - primary.length).toBe(5)
  expect(result).toEqual({ docs: docs.length, rows: primary.length })
  expect(rows.map((r) => Number(r[0]))).toEqual(primary.map((d) => d.page_id))

  const ids = new Set(rows.map((r) => Number(r[0])))
  const selected = (await Array.fromAsync(readTsv(join(slice, 'catalog.tsv')))).filter((f) => f[8] === '1').map((f) => Number(f[0]))
  for (const id of selected) expect(ids.has(id)).toBe(docs.some((d) => d.page_id === id && d.page_type !== 'redirect'))

  expect(primary.some((d) => d.incoming_links === undefined)).toBe(true)
  for (const [i, r] of rows.entries()) {
    expect(r[1]).toMatch(/^\d+$/)
    expect(Number(r[1])).toBe(primary[i].text_bytes)
    // M2-R7 : incoming_links absent = inconnu, écrit \N (jamais 0).
    expect(r[2]).toBe(primary[i].incoming_links === undefined ? null : String(primary[i].incoming_links))
  }

  const summaries = rows.flatMap((r) => (r[3] === null ? [] : [r[3]]))
  expect(summaries.length).toBeGreaterThan(100)
  for (const s of summaries) {
    expect(s.length).toBeLessThanOrEqual(SUMMARY_MAX.sample)
    expect(s).not.toMatch(BANNERS)
  }

  // Pages selected sans résumé Cirrus (ouverture vide ou d'infobox, M2-R5) : leurs lots TextExtracts sont parmi les
  // réponses commitées, car `fixtures fetch` les a choisies par le même hasOpening.
  const withSummary = new Set(rows.filter((r) => r[3] !== null).map((r) => Number(r[0])))
  const extracts = JSON.parse(await readFile(join(raw, 'extracts.json'), 'utf8')) as Record<string, unknown>
  const missing = selected.filter((id) => !withSummary.has(id))
  expect(missing).toHaveLength(160)
  // Clés de raw/extracts.json = exactement les lots des Règles de lots de `fixtures fetch` (plus les 40 premiers ids).
  const batches = new Set([...extractsUrls(missing), ...extractsUrls(selected.slice(0, 40))])
  expect(batches.size).toBe(10)
  expect(new Set(Object.keys(extracts))).toEqual(batches)
})

test('mode full : opening_text de 2 000 caractères → résumé de 601 à 1 200 caractères', async () => {
  const opening = 'Le chat est un petit mammifère carnivore domestique. '.repeat(40).slice(0, 2000)
  const { rows } = await run('full', [[1, 1]], pairs([{ page_id: 1, namespace: 0, title: 'Chat', page_type: 'primary', opening_text: opening, text_bytes: 5000, incoming_links: 3 }]))
  const summary = rows[0][3]!
  expect(summary.length).toBeGreaterThan(SUMMARY_MAX.sample)
  expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX.full)
})

test('page non selected ou ouverture d’infobox : résumé nul, nombres gardés ; autre espace et redirection sans ligne', async () => {
  const doc = (page_id: number, extra: object = {}) => ({
    page_id, namespace: 0, title: `T${page_id}`, page_type: 'primary', opening_text: 'Le chat est un mammifère.', text_bytes: 300 + page_id,
    incoming_links: page_id,
    ...extra,
  })
  const infobox = { title: 'Chat (animal)', opening_text: 'Chat Photo du chat. Le chat est un mammifère.' }
  const input = pairs([
    doc(1), doc(2), doc(3, { namespace: 104 }), doc(4, { page_type: 'redirect' }), doc(5, { incoming_links: undefined }), doc(6, infobox),
  ])
  const { result, rows } = await run('sample', [[1, 1], [2, 0], [5, 1], [6, 1]], input)
  expect(result).toEqual({ docs: 6, rows: 4 })
  expect(rows).toEqual([
    ['1', '301', '1', 'Le chat est un mammifère.'],
    ['2', '302', '2', null],
    ['5', '305', null, 'Le chat est un mammifère.'],
    ['6', '306', '6', null],
  ])
})

test('gardes de format : champs renommés, lignes d’index et documents illisibles, flux vide ou coupé, 95 % de documents valides', async () => {
  const all = (k: number, m = 0) => `${k} documents sur ${docs.length} sans page_id, namespace et text_bytes entiers et title texte, ${m} dont page_id n'est pas l'_id`
  for (const field of ['text_bytes', 'namespace', 'page_id', 'title']) {
    await expect(run('sample', [], ndjson.replaceAll(`"${field}":`, '"renamed":'))).rejects.toThrow(`Format Cirrus inattendu : ${all(docs.length)}`)
  }
  await expect(run('sample', [], '{"create": {"_id": 1}}\n{}')).rejects.toThrow("Format Cirrus inattendu : ligne d'index 1")
  const doc = (page_id: number) => ({ page_id, namespace: 0, title: `T${page_id}`, text_bytes: 10, incoming_links: 1 })
  await expect(run('sample', [], `${pairs([doc(1)])}\n${JSON.stringify(doc(2))}`)).rejects.toThrow(
    "Format Cirrus inattendu : ligne d'index 3",
  )
  await expect(run('sample', [], `${pairs([doc(1)])}\n{"index": {"_id": 2}}\n{"page_id": 2, "namesp`)).rejects.toThrow(
    'Format Cirrus inattendu : ligne 4',
  )
  await expect(run('sample', [], `${pairs([doc(1)])}\n{"index": {"_id": 2}}`)).rejects.toThrow(
    "Format Cirrus inattendu : ligne d'index 3 sans document",
  )
  await expect(run('sample', [], '')).rejects.toThrow('Format Cirrus inattendu : aucun document')

  // 19 sur 20 : passe ; 18 sur 20 (un sans text_bytes, un dont page_id n'est pas l'_id de sa ligne d'index) : refusé.
  const twenty = Array.from({ length: 20 }, (_, i) => doc(i + 1))
  const { rows } = await run('sample', [], pairs([...twenty.slice(1), { page_id: 1, namespace: 0 }]))
  expect(rows).toHaveLength(19)
  await expect(run('sample', [], pairs([...twenty.slice(2), { page_id: 1, namespace: 0 }, doc(2)], (d) => (d.page_id === 2 ? 99 : d.page_id)))).rejects.toThrow(
    "Format Cirrus inattendu : 1 documents sur 20 sans page_id, namespace et text_bytes entiers et title texte, 1 dont page_id n'est pas l'_id",
  )

  // incoming_links absent de plus de la moitié des lignes écrites (les redirections n'en ont jamais : hors compte).
  const noLinks = (page_id: number, extra: object = {}) => ({ page_id, namespace: 0, title: `T${page_id}`, text_bytes: 10, ...extra })
  await expect(run('sample', [], pairs([doc(1), noLinks(2), noLinks(3)]))).rejects.toThrow(
    'Format Cirrus inattendu : 2 documents sur 3 sans incoming_links',
  )
  const redirects = [4, 5, 6].map((id) => noLinks(id, { page_type: 'redirect' }))
  expect((await run('sample', [], pairs([doc(1), doc(2), noLinks(3), ...redirects]))).rows).toHaveLength(3)

  // template absent ou non tableau sur plus de la moitié des lignes, dès 100 lignes : règle d'infobox V3 ou Lua éteinte.
  const hundred = (withTemplate: number) =>
    Array.from({ length: 100 }, (_, i) => ({ ...doc(i + 1), ...(i < withTemplate ? { template: ['Modèle:Portail'] } : i % 2 ? { template: 'x' } : {}) }))
  await expect(run('sample', [], pairs(hundred(49)))).rejects.toThrow('Format Cirrus inattendu : 51 documents sur 100 sans template')
  expect((await run('sample', [], pairs(hundred(50)))).rows).toHaveLength(100)
})

test('CLI cirrus : stdin → text-<part>.tsv, résultat JSON ; --part et --mode validés', async () => {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url))
  // Nom de part tel que cirrusListing le rend (matrice `text` de catalog.yml).
  const part = 'frwiki_content-20261018-00000.json.bz2'
  const ok = spawnSync(process.execPath, [cli, 'cirrus', '--dir', slice, '--part', part, '--mode', 'sample'], { input: ndjson, encoding: 'utf8' })
  expect(ok.stderr).toBe('')
  expect(JSON.parse(ok.stdout)).toEqual({ docs: docs.length, rows: docs.length - 5 })
  await cirrusCommand({ dir: slice, part: 'direct', mode: 'sample', input: lines(ndjson) })
  expect(await readFile(join(slice, `text-${part}.tsv`), 'utf8')).toBe(await readFile(join(slice, 'text-direct.tsv'), 'utf8'))

  const cases: [string[], string][] = [
    [['--part', '../x', '--mode', 'sample'], 'Option --part invalide : ../x'],
    [['--part', 'a/b', '--mode', 'sample'], 'Option --part invalide : a/b'],
    [['--part', '00001', '--mode', 'demo'], 'Option --mode invalide : demo (full, sample)'],
  ]
  for (const [args, message] of cases) {
    const bad = spawnSync(process.execPath, [cli, 'cirrus', '--dir', slice, ...args], { input: '', encoding: 'utf8' })
    expect(bad.status).toBe(1)
    expect(bad.stderr.trim()).toBe(message)
  }
})
