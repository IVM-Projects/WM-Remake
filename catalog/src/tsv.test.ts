import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { parseTsvLine, readTsv, tsvLine, writeTsv, writtenIds } from './tsv.ts'

const dir = await mkdtemp(join(tmpdir(), 'wm-tsv-'))
afterAll(() => rm(dir, { recursive: true, force: true }))

test('aller-retour : tabulation, saut de ligne, barre oblique inverse, null et nombre', () => {
  const line = tsvLine(['a\tb', 'c\nd\\e', null, 42])
  expect(line).toBe('a\\tb\tc\\nd\\\\e\t\\N\t42')
  expect(parseTsvLine(line)).toEqual(['a\tb', 'c\nd\\e', null, '42'])
})

test('une chaîne vide reste vide, distincte de null ; la chaîne « \\N » reste une chaîne', () => {
  expect(parseTsvLine(tsvLine(['', null, '\\N']))).toEqual(['', null, '\\N'])
})

test('writeTsv rend le nombre de lignes et ajoute avec append ; readTsv relit', async () => {
  const path = join(dir, 'rows.tsv')
  expect(await writeTsv(path, [['a', 1], [null, 'b\r']])).toBe(2)
  expect(await writeTsv(path, (async function* () { yield ['c', null] })(), { append: true })).toBe(1)
  expect(await Array.fromAsync(readTsv(path))).toEqual([['a', '1'], [null, 'b\r'], ['c', null]])
})

test('writtenIds : première colonne ; dernière ligne sans \\n coupée avant lecture ; fichier absent → vide', async () => {
  const path = join(dir, 'resume.tsv')
  expect(await writtenIds(path)).toEqual(new Set())
  expect(existsSync(path)).toBe(false)

  await writeFile(path, 'Q1\tun\nQ2\t\\N\n')
  expect(await writtenIds(path)).toEqual(new Set(['Q1', 'Q2']))
  expect(await readFile(path, 'utf8')).toBe('Q1\tun\nQ2\t\\N\n')

  // Run tué au milieu d'une ligne : la moitié de ligne disparaît, l'ajout suivant repart d'une ligne propre.
  await writeFile(path, 'Q1\tun\nQ2\tde')
  expect(await writtenIds(path)).toEqual(new Set(['Q1']))
  await writeTsv(path, [['Q2', 'deux']], { append: true })
  expect(await readFile(path, 'utf8')).toBe('Q1\tun\nQ2\tdeux\n')

  await writeFile(path, 'Q9\tdemi')
  expect(await writtenIds(path)).toEqual(new Set())
  expect(await readFile(path, 'utf8')).toBe('')
})
