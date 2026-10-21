import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { pageviewsCommand } from './pageviews.ts'
import { readTsv } from './tsv.ts'

const root = await mkdtemp(join(tmpdir(), 'wm-pageviews-'))
afterAll(() => rm(root, { recursive: true, force: true }))

let n = 0
async function run(input: string[], minLines?: number) {
  const dir = await mkdtemp(join(root, `${n++}-`))
  async function* lines() {
    yield* input
  }
  const result = await pageviewsCommand({ input: lines(), dir, minLines })
  return { result, rows: await Array.fromAsync(readTsv(join(dir, 'views.tsv'))) }
}

const valid = (count: number) => Array.from({ length: count }, (_, i) => `fr.wikipedia P${i} ${i + 1} desktop 1 A1`)

test('somme par page_id, une ligne par titre sans page_id (6 ou 5 champs)', async () => {
  const { result, rows } = await run([
    'fr.wikipedia Chat 1234 desktop 100 A50B50',
    'fr.wikipedia Chat 1234 mobile-web 30 A30',
    'fr.wikipedia Chat null mobile-app 5 A5',
    'fr.wikipedia Chien mobile-web 7 B7',
  ], 0)
  expect(result).toEqual({ lines: 4, malformed: 0 })
  expect(rows).toEqual([['1234', null, '130'], [null, 'Chat', '5'], [null, 'Chien', '7']])
})

test('une ligne d’un autre wiki est ignorée', async () => {
  const { rows } = await run(['fr.wikisource X 1 desktop 9 A9', 'fr.wikipedia Chat 1234 desktop 100 A100'], 0)
  expect(rows).toEqual([['1234', null, '100']])
})

test('1 % de lignes mal formées au plus', async () => {
  const { result } = await run([...valid(199), 'fr.wikipedia Truc 99 desktop abc A1'], 0)
  expect(result).toEqual({ lines: 200, malformed: 1 })

  const dir = await mkdtemp(join(root, 'bad-'))
  async function* bad() {
    yield* [...valid(97), 'fr.wikipedia Truc 99 desktop abc A1', 'fr.wikipedia Truc 98 bureau 1 A1', 'fr.wikipedia Truc x desktop 1 A1']
  }
  await expect(pageviewsCommand({ input: bad(), dir, minLines: 0 })).rejects.toThrow(
    'Format des vues inattendu : 3 lignes mal formées sur 100',
  )
  expect(existsSync(join(dir, 'views.tsv'))).toBe(false)
})

test('fichier trop court : 2 000 000 lignes attendues par défaut', async () => {
  await expect(run(valid(10))).rejects.toThrow('Format des vues inattendu : 10 lignes (2000000 attendues au moins)')
})
