import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, test } from 'vitest'
import { rarityForViews } from '../../lib/rarity.ts'
import { cirrusCommand } from './cirrus.ts'
import { commonsCommand } from './commons.ts'
import { computeCommand, selectCommand } from './compute.ts'
import { CARD_CSV_COLUMNS, MEDIA_CSV_COLUMNS } from './emit.ts'
import type { Client } from './http.ts'
import { pageviewsCommand } from './pageviews.ts'
import { dumpsCommand, openLines } from './sqldump.ts'
import { readTsv } from './tsv.ts'
import { wikidataCommand } from './wikidata.ts'

// De bout en bout sur les tranches réelles (M2-7) : raw/ → cards.csv, media.csv, counts.json, figés dans expected/.
const RAW = fileURLToPath(new URL('../fixtures/raw/', import.meta.url))
const meta = JSON.parse(await readFile(join(RAW, 'meta.json'), 'utf8')) as { month: string; cirrus_date: string }
const bodies: Record<string, unknown> = {}
for (const name of ['wikidata.json', 'commons.json', 'extracts.json']) Object.assign(bodies, JSON.parse(await readFile(join(RAW, name), 'utf8')))

const root = await mkdtemp(join(tmpdir(), 'wm-pipeline-'))
afterAll(() => rm(root, { recursive: true, force: true }))

// Client simulé : corps de raw/*.json par URL exacte ; une URL inconnue fait échouer la commande.
const asked: string[] = []
const client: Client = {
  async get(url) {
    asked.push(url)
    if (!Object.hasOwn(bodies, url)) throw new Error(`URL inconnue : ${url}`)
    return bodies[url]
  },
}

async function run(name: string) {
  const dir = join(root, name)
  await mkdir(dir)
  await dumpsCommand({ page: join(RAW, 'page.sql'), props: join(RAW, 'page_props.sql'), dir })
  await pageviewsCommand({ input: openLines(join(RAW, 'pageviews.txt')), dir, minLines: 0 })
  await selectCommand({ dir, mode: 'sample', rate: 1 })
  await cirrusCommand({ dir, part: 'fixtures', mode: 'sample', input: openLines(join(RAW, 'cirrus.ndjson')) })
  expect((await wikidataCommand({ dir, client })).finished).toBe(true)
  expect((await commonsCommand({ dir, client })).finished).toBe(true)
  const out = join(dir, 'out')
  await computeCommand({ dir, out, mode: 'sample', month: meta.month, textDate: meta.cirrus_date, textSource: 'cirrus', client })
  return { dir, out }
}

const files = async (out: string) =>
  Object.fromEntries(await Promise.all(['cards.csv', 'media.csv', 'counts.json'].map(async (f) => [f, await readFile(join(out, f), 'utf8')])))

// RFC 4180 tel que l'écrit emit : champ vide non guillemeté = null, chaque ligne finie par \n.
function parseCsv(text: string): (string | null)[][] {
  const rows: (string | null)[][] = []
  let row: (string | null)[] = []
  for (const m of text.matchAll(/("(?:[^"]|"")*"|[^",\n]*)(,|\n)/g)) {
    row.push(m[1].startsWith('"') ? m[1].slice(1, -1).replaceAll('""', '"') : m[1] || null)
    if (m[2] === '\n') {
      rows.push(row)
      row = []
    }
  }
  return rows
}

function records(text: string, columns: readonly string[]): Record<string, string | null>[] {
  const [header, ...rows] = parseCsv(text)
  expect(header).toEqual(columns)
  for (const r of rows) expect(r).toHaveLength(columns.length)
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])))
}

const a = await run('a')
const out = await files(a.out)
const cards = records(out['cards.csv'], CARD_CSV_COLUMNS)
const media = records(out['media.csv'], MEDIA_CSV_COLUMNS)

test('cards.csv, media.csv et counts.json égalent les fichiers de référence', async () => {
  await expect(out['cards.csv']).toMatchFileSnapshot('../fixtures/expected/cards.csv')
  await expect(out['media.csv']).toMatchFileSnapshot('../fixtures/expected/media.csv')
  await expect(out['counts.json']).toMatchFileSnapshot('../fixtures/expected/counts.json')
})

test('lignes = ids de catalogue de raw/ids.tsv : aucune redirection, homonymie ni page d’un autre espace', async () => {
  const ids = (await Array.fromAsync(readTsv(join(RAW, 'ids.tsv')))).map((f) => Number(f[0]))
  expect(cards.map((c) => Number(c.page_id)).sort((x, y) => x - y)).toEqual(ids.sort((x, y) => x - y))
})

test('chaque ligne : rareté des vues, ATK, DEF et Q-Score bornés, résumé ≤ 600, titre sans _, dates du run', () => {
  const [y, m] = meta.month.split('-').map(Number)
  const next = `${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, '0')}-01T00:00:00Z`
  for (const c of cards) {
    expect(c.rarity).toBe(rarityForViews(Number(c.pageviews)))
    for (const k of ['atk', 'def'] as const) expect(Number(c[k])).toSatisfy((v: number) => Number.isInteger(v) && v >= 1000 && v <= 10000)
    expect(Number(c.q_score)).toSatisfy((v: number) => v >= 0 && v <= 100)
    expect(c.summary?.length ?? 0).toBeLessThanOrEqual(600)
    expect(c.wikipedia_title).not.toContain('_')
    expect(c.lang).toBe('fr')
    expect(c.pageviews_refreshed_at).toBe(next)
    expect(c.qscore_refreshed_at).toBe(`${meta.cirrus_date}T00:00:00Z`)
  }
})

test('AdQ : Q-Score ≥ 20, BA : ≥ 12', async () => {
  const badge = new Map((await Array.fromAsync(readTsv(join(a.dir, 'catalog.tsv')))).map((f) => [f[0], Number(f[7])]))
  const q = (b: number) => cards.filter((c) => badge.get(c.page_id) === b).map((c) => Number(c.q_score))
  expect(q(1).length).toBeGreaterThanOrEqual(3)
  expect(q(0.6).length).toBeGreaterThanOrEqual(3)
  for (const v of q(1)) expect(v).toBeGreaterThanOrEqual(20)
  for (const v of q(0.6)) expect(v).toBeGreaterThanOrEqual(12)
})

test('licences : chaque média a sa licence, chaque image a sa ligne de média et réciproquement', () => {
  for (const m of media) expect(m.license).toBeTruthy()
  const withImage = cards.filter((c) => c.image_url !== null).map((c) => c.page_id)
  expect(media.map((m) => m.page_id)).toEqual(withImage)
  expect(withImage.length).toBeGreaterThan(0)
})

test('deux exécutions donnent les mêmes octets ; une reprise sur le même dossier ne redemande rien', async () => {
  const b = await run('b')
  expect(await files(b.out)).toEqual(out)
  const n = asked.length
  const again = join(a.dir, 'again')
  await computeCommand({ dir: a.dir, out: again, mode: 'sample', month: meta.month, textDate: meta.cirrus_date, textSource: 'cirrus', client })
  expect(asked.length).toBe(n)
  expect(await files(again)).toEqual(out)
})
