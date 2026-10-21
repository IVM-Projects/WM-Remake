import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, test, vi } from 'vitest'
import { selectCommand } from './compute.ts'
import { batchValues } from './http.ts'
import type { Client } from './http.ts'
import { pageviewsCommand } from './pageviews.ts'
import { dumpsCommand, openLines } from './sqldump.ts'
import { readTsv, writeTsv } from './tsv.ts'
import { entitiesUrls, parseEntities, wikidataCommand } from './wikidata.ts'

const RAW = fileURLToPath(new URL('../fixtures/raw/', import.meta.url))
const bodies = JSON.parse(await readFile(join(RAW, 'wikidata.json'), 'utf8')) as Record<string, unknown>

// catalog.tsv des tranches : dumps, vues, puis select au taux 1 (toutes les pages selected).
const base = await mkdtemp(join(tmpdir(), 'wm-wikidata-'))
afterAll(() => rm(base, { recursive: true, force: true }))
await dumpsCommand({ page: join(RAW, 'page.sql'), props: join(RAW, 'page_props.sql'), dir: base })
await pageviewsCommand({ input: openLines(join(RAW, 'pageviews.txt')), dir: base, minLines: 0 })
await selectCommand({ dir: base, mode: 'sample', rate: 1 })
const qids = (await Array.fromAsync(readTsv(join(base, 'catalog.tsv')))).flatMap((f) => (f[8] === '1' && f[6] !== null ? [f[6]] : []))

async function work(name: string): Promise<string> {
  const dir = join(base, name)
  await mkdir(dir)
  await copyFile(join(base, 'catalog.tsv'), join(dir, 'catalog.tsv'))
  return dir
}

// Client simulé : les corps commités, par URL exacte ; une URL inconnue fait échouer la commande.
function fixtureClient(onGet = () => {}) {
  const urls: string[] = []
  const client: Client = {
    async get(url) {
      urls.push(url)
      onGet()
      if (!Object.hasOwn(bodies, url)) throw new Error(`URL inconnue : ${url}`)
      return bodies[url]
    },
  }
  return { client, urls }
}

const descTsv = async (dir: string) => Array.fromAsync(readTsv(join(dir, 'desc.tsv')))

test('parseEntities : description FR ou null, redirection rangée sous l’id demandé', () => {
  const body = {
    entities: {
      Q1: { type: 'item', id: 'Q1', descriptions: { fr: { language: 'fr', value: 'univers' } } },
      Q2: { type: 'item', id: 'Q2', descriptions: {} },
      Q3: { id: 'Q3', missing: true },
      Q4: { type: 'item', id: 'Q40', redirects: { from: 'Q4', to: 'Q40' }, descriptions: { fr: { language: 'fr', value: 'cible' } } },
      Q60: { type: 'item', id: 'Q60', redirects: { from: 'Q6', to: 'Q60' }, descriptions: { fr: { language: 'fr', value: 'autre' } } },
      Q7: { type: 'item', id: 'Q7', descriptions: { fr: { language: 'fr', value: '' } } },
      Q8: { type: 'item', id: 'Q8', descriptions: [] },
    },
    success: 1,
  }
  expect(parseEntities(body)).toEqual(
    new Map([['Q1', 'univers'], ['Q2', null], ['Q3', null], ['Q4', 'cible'], ['Q6', 'autre'], ['Q7', null], ['Q8', null]]),
  )
  expect(parseEntities({})).toEqual(new Map())
})

test('parseEntities sur raw/wikidata.json : chaque qid demandé a une entrée, 80 % au moins une description', () => {
  const all = new Map(Object.values(bodies).flatMap((body) => [...parseEntities(body)]))
  expect(qids.length).toBeGreaterThan(250)
  for (const q of qids) expect(all.has(q), q).toBe(true)
  const described = qids.filter((q) => all.get(q))
  expect(described.length / qids.length).toBeGreaterThanOrEqual(0.8)
})

test('wikidataCommand : les lots des tranches sans URL inconnue, une ligne par qid ; second run tout sauté', async () => {
  const dir = await work('full')
  const { client, urls } = fixtureClient()
  expect(await wikidataCommand({ dir, client })).toEqual({ done: 6, skipped: 0, finished: true })
  expect(urls.toSorted()).toEqual(Object.keys(bodies).toSorted())
  const rows = await descTsv(dir)
  expect(rows.map((f) => f[0]).toSorted()).toEqual([...new Set(qids)].toSorted())
  const all = new Map(Object.values(bodies).flatMap((body) => [...parseEntities(body)]))
  for (const [q, d] of rows) expect(d).toBe(all.get(q!) ?? null)

  const again = fixtureClient()
  expect(await wikidataCommand({ dir, client: again.client })).toEqual({ done: 0, skipped: 6, finished: true })
  expect(again.urls).toEqual([])
  expect(await descTsv(dir)).toEqual(rows)
})

test('wikidataCommand : desc.tsv déjà rempli des 50 premiers qids → le premier lot est sauté', async () => {
  const dir = await work('resume')
  const [first] = entitiesUrls(qids)
  await writeTsv(join(dir, 'desc.tsv'), batchValues(first).map((q) => [q, 'déjà là']))
  const { client, urls } = fixtureClient()
  expect(await wikidataCommand({ dir, client })).toEqual({ done: 5, skipped: 1, finished: true })
  expect(urls).not.toContain(first)
  const rows = await descTsv(dir)
  expect(rows).toHaveLength(new Set(qids).size)
  expect(rows.filter((f) => f[1] === 'déjà là')).toHaveLength(50)
})

test('wikidataCommand : un lot à moitié écrit (run tué) est redemandé sans répéter ses lignes', async () => {
  const dir = await work('partial')
  const [first] = entitiesUrls(qids)
  await writeTsv(join(dir, 'desc.tsv'), batchValues(first).slice(0, 10).map((q) => [q, 'déjà là']))
  const { client, urls } = fixtureClient()
  expect(await wikidataCommand({ dir, client })).toEqual({ done: 6, skipped: 0, finished: true })
  expect(urls).toContain(first)
  const rows = await descTsv(dir)
  expect(rows).toHaveLength(new Set(qids).size)
  expect(rows.filter((f) => f[1] === 'déjà là')).toHaveLength(10)
})

test('wikidataCommand : délai dépassé après le premier lot → finished: false, le run suivant finit sans doublon', async () => {
  const dir = await work('deadline')
  let t = 0
  // L'horloge passe 30 min dès la première requête lancée.
  const { client, urls } = fixtureClient(() => (t = 31 * 60_000))
  expect(await wikidataCommand({ dir, client, deadlineMin: 30, now: () => t })).toEqual({ done: 1, skipped: 0, finished: false })
  expect(urls).toHaveLength(1)
  expect(await descTsv(dir)).toHaveLength(50)

  const next = fixtureClient()
  expect(await wikidataCommand({ dir, client: next.client, deadlineMin: 30, now: () => 0 })).toEqual({ done: 5, skipped: 1, finished: true })
  const rows = await descTsv(dir)
  expect(new Set(rows.map((f) => f[0])).size).toBe(rows.length)
  expect(rows).toHaveLength(new Set(qids).size)
})

test('wikidataCommand : des requêtes sans réponse sont abandonnées à l’échéance, rien n’est écrit pour leurs lots', async () => {
  const dir = await work('hung')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    let started!: () => void
    const first = new Promise<void>((resolve) => (started = resolve))
    const client: Client = {
      get() {
        started()
        return new Promise(() => {})
      },
    }
    const run = wikidataCommand({ dir, client, deadlineMin: 30, now: () => 0 })
    await first
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(await run).toEqual({ done: 0, skipped: 0, finished: false })
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
  expect(existsSync(join(dir, 'desc.tsv'))).toBe(false)
})

// Sans réseau : --deadline-min 0 arrête avant la première requête, et un desc.tsv complet saute tous les lots.
test('CLI wikidata : délai atteint → code 3 ; tout déjà écrit → code 0 ; options validées', async () => {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url))
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'wikidata', ...args], { encoding: 'utf8' })
  const dir = await work('cli')
  const late = run('--dir', dir, '--deadline-min', '0', '--per-minute', '100', '--concurrency', '2')
  expect(late.status).toBe(3)
  expect(late.stderr).toBe('Délai atteint : reprendre au prochain run\n')
  expect(JSON.parse(late.stdout)).toEqual({ done: 0, skipped: 0, finished: false })
  expect(existsSync(join(dir, 'desc.tsv'))).toBe(false)

  await writeTsv(join(dir, 'desc.tsv'), qids.map((q) => [q, null]))
  const ok = run('--dir', dir)
  expect(ok.stderr).toBe('')
  expect(ok.status).toBe(0)
  expect(JSON.parse(ok.stdout)).toEqual({ done: 0, skipped: 6, finished: true })

  const cases: [string[], string][] = [
    [[], 'Option --dir manquante'],
    [['--dir', dir, '--per-minute', '0'], 'Option --per-minute invalide : 0'],
    [['--dir', dir, '--per-minute', '1.5'], 'Option --per-minute invalide : 1.5'],
    [['--dir', dir, '--concurrency', '0'], 'Option --concurrency invalide : 0'],
    [['--dir', dir, '--concurrency', 'trois'], 'Option --concurrency invalide : trois'],
    [['--dir', dir, '--deadline-min', '5h'], 'Option --deadline-min invalide : 5h'],
  ]
  for (const [args, message] of cases) {
    const bad = run(...args)
    expect(bad.status, message).toBe(1)
    expect(bad.stderr.trim()).toBe(message)
    expect(bad.stdout).toBe('')
  }
})
