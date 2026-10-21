import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { checkTextSource, firstCsvRecords, guardAfterCopy, guardBatch, guardBeforeCopy, maxShareGap, measureCommand, rateFor } from './load.ts'

const root = await mkdtemp(join(tmpdir(), 'wm-load-'))
afterAll(() => rm(root, { recursive: true, force: true }))

test('guardBeforeCopy : stage et cartes au-delà des pages liées projetés, cible pro sans garde', () => {
  // Premier passage : 440e6 + 250 000 × (811 + 2 485).
  expect(guardBeforeCopy(440e6, 250_000, 0, 'free')).toBe('Base trop pleine pour la cible free : 1264000000 octets projetés (limite 450000000)')
  // Le stage seul franchirait déjà 450e6, même sans nouvelle carte.
  expect(guardBeforeCopy(440e6, 250_000, 250_000, 'free')).toBe('Base trop pleine pour la cible free : 642750000 octets projetés (limite 450000000)')
  // Second passage identique : aucune nouvelle carte, le stage seul passe ; au premier passage, 100 000 cartes franchiraient.
  expect(guardBeforeCopy(250e6, 100_000, 100_000, 'free')).toBeNull()
  expect(guardBeforeCopy(250e6, 100_000, 0, 'free')).toBe('Base trop pleine pour la cible free : 579600000 octets projetés (limite 450000000)')
  // Plus de pages liées que de lignes : aucune carte retranchée de la projection.
  expect(guardBeforeCopy(445e6, 10_000, 300_000, 'free')).toBe('Base trop pleine pour la cible free : 453110000 octets projetés (limite 450000000)')
  expect(guardBeforeCopy(440e6, 250_000, 0, 'pro')).toBeNull()
})

test('guardAfterCopy : stage compris dans la taille, seules les nouvelles cartes projetées', () => {
  expect(guardAfterCopy(440e6, 0, 'free')).toBeNull()
  expect(guardAfterCopy(250e6, 0, 'free')).toBeNull()
  expect(guardAfterCopy(440e6, 10_000, 'free')).toBe('Base trop pleine pour la cible free : 464850000 octets projetés (limite 450000000)')
  expect(guardAfterCopy(440e6, 10_000, 'pro')).toBeNull()
})

test('guardBatch : taille mesurée entre deux lots', () => {
  expect(guardBatch(451e6, 'free')).toBe('Base trop pleine pour la cible free : 451000000 octets projetés (limite 450000000)')
  expect(guardBatch(450e6, 'free')).toBeNull()
  expect(guardBatch(451e6, 'pro')).toBeNull()
  // Taille illisible : refusée plutôt qu'acceptée.
  expect(guardBatch(Number.NaN, 'free')).not.toBeNull()
})

test('checkTextSource : repli extracts refusé sans gel des statistiques (P11)', () => {
  expect(checkTextSource('extracts', false)).toBe('Statistiques dégradées : poser catalog_stats_frozen ou relancer avec cirrus')
  expect(checkTextSource('extracts', true)).toBeNull()
  expect(checkTextSource('cirrus', false)).toBeNull()
})

test('maxShareGap : écart maximal en points de part et écart relatif maximal', () => {
  const zero = { L: 0, UR: 0, SR: 0, R: 0, PC: 0, C: 0 }
  expect(maxShareGap({ ...zero, L: 1, C: 99 }, { ...zero, L: 2, C: 98 })).toEqual({ points: 1, relative: 0.5 })
  expect(maxShareGap({ ...zero, L: 3, R: 30, C: 300 }, { ...zero, L: 30, R: 300, C: 3000 })).toEqual({ points: 0, relative: 0 })
})

test('firstCsvRecords : en-tête et n enregistrements entiers, saut de ligne guillemeté compris, sur plusieurs blocs lus', async () => {
  const header = 'page_id,summary\n'
  // ≈ 9 Ko par enregistrement : les 10 premiers dépassent un bloc de lecture (64 Kio).
  const records = Array.from({ length: 12 }, (_, i) =>
    i === 2 ? `3,"Première ligne ""citée""\nseconde ligne ${'x'.repeat(9000)}"\n` : `${i + 1},${'y'.repeat(9000)}\n`)
  const path = join(root, 'cards.csv')
  await writeFile(path, header + records.join(''))
  expect(await firstCsvRecords(path, 10)).toBe(header + records.slice(0, 10).join(''))
  expect(await firstCsvRecords(path, 2)).toBe(header + records.slice(0, 2).join(''))
  expect(await firstCsvRecords(path, 3)).toBe(header + records.slice(0, 3).join(''))
  expect(await firstCsvRecords(path, 50)).toBe(header + records.join(''))
})

test('rateFor : plus grand taux au pas de 0,005 sous 350 Mo établis et 450 Mo au pic du premier chargement (M2-3)', () => {
  // Pic : (450e6 − 16e6) / (1 400 + 900) = 188 695 cartes, soit 0,068 ; régime établi : 238 571 cartes.
  expect(rateFor({ base: 16e6, bytesPerCard: 1400, stageBytesPerRow: 900, nFull: 2_773_461 })).toBe(0.065)
  // Sans stage, le régime établi limite : 238 571 / 2 773 461 = 0,086.
  expect(rateFor({ base: 16e6, bytesPerCard: 1400, stageBytesPerRow: 0, nFull: 2_773_461 })).toBe(0.085)
})

test('measureCommand : refusée hors de la base wm_test du banc, sans connexion', async () => {
  await expect(measureCommand({ db: 'postgres://u:p@h:5432/postgres', csvDir: root, copies: 1 })).rejects.toThrow('measure : base wm_test du banc seulement')
})
