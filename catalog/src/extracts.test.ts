import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { parseExtracts } from './extracts.ts'

const bodies = JSON.parse(await readFile(new URL('../fixtures/raw/extracts.json', import.meta.url), 'utf8')) as Record<string, unknown>

test('parseExtracts sur raw/extracts.json : une ligne par page demandée qui a un extrait, texte non vide', () => {
  expect(Object.keys(bodies)).toHaveLength(3)
  for (const [url, body] of Object.entries(bodies)) {
    const asked = new URL(url).searchParams.get('pageids')!.split('|').map(Number)
    const rows = parseExtracts(body)
    // 9624536 (« 4 janvier 1916 ») : extrait vide dans la réponse.
    expect(rows.map((r) => r.page_id).sort((a, b) => a - b)).toEqual(asked.filter((id) => id !== 9624536))
    for (const r of rows) expect(r.extract.trim()).not.toBe('')
  }
})

test('parseExtracts : pages manquantes, invalides ou sans extrait ignorées ; corps sans query.pages refusé', () => {
  const body = {
    batchcomplete: true,
    query: {
      pages: [
        { pageid: 1, ns: 0, title: 'Chat', extract: 'Le chat est un mammifère.\nIl miaule.' },
        { pageid: 2, missing: true },
        { pageid: 0, invalid: true, invalidreason: 'pageid invalide' },
        { pageid: 3, ns: 0, title: 'Vide', extract: ' \n' },
        { pageid: 4, ns: 0, title: 'Sans extrait' },
      ],
    },
  }
  expect(parseExtracts(body)).toEqual([{ page_id: 1, extract: 'Le chat est un mammifère.\nIl miaule.' }])
  for (const bad of [{ batchcomplete: true }, null, { query: { pages: {} } }]) {
    expect(() => parseExtracts(bad)).toThrow('Format TextExtracts inattendu : query.pages absent')
  }
})
