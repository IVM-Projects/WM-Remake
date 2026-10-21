// Wikidata : descriptions FR des éléments des pages retenues (catégorie de la carte), reprenables par lots.
import { join } from 'node:path'
import { batchUrls, batchValues, deadline, fetchBatches } from './http.ts'
import type { Client } from './http.ts'
import { readTsv, writeTsv, writtenIds } from './tsv.ts'

const ENTITIES = 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&formatversion=2&maxlag=5&props=descriptions&languages=fr&ids='

// Règles de lots : qids valides (`Q` + chiffres) dédoublonnés, triés par valeur numérique, 50 par appel (limite de `ids`).
export function entitiesUrls(qids: string[]): string[] {
  const sorted = [...new Set(qids)].filter((q) => /^Q\d+$/.test(q)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  return batchUrls(ENTITIES, sorted, 50)
}

type Entity = { redirects?: { from?: string }; descriptions?: { fr?: { value?: string } } }

// qid demandé → description FR, ou null (élément manquant ou sans description) ; une redirection suivie est rangée
// sous l'id demandé (`redirects.from`).
export function parseEntities(body: unknown): Map<string, string | null> {
  const entities = (body as { entities?: Record<string, Entity> } | null)?.entities ?? {}
  return new Map(Object.entries(entities).map(([id, e]) => [e.redirects?.from ?? id, e.descriptions?.fr?.value || null]))
}

// desc.tsv : qid, description|\N ; une ligne par qid demandé, écrite en ajout lot par lot. Un lot dont chaque qid y est
// déjà est sauté : un run coupé par le délai reprend là où il s'est arrêté.
export async function wikidataCommand(o: {
  dir: string
  client: Client
  deadlineMin?: number
  now?: () => number
}): Promise<{ done: number; skipped: number; finished: boolean }> {
  const qids: string[] = []
  // catalog.tsv : qid en colonne 7, selected en colonne 9.
  for await (const f of readTsv(join(o.dir, 'catalog.tsv'))) if (f[8] === '1' && f[6] !== null) qids.push(f[6])
  const path = join(o.dir, 'desc.tsv')
  const written = await writtenIds(path)

  const urls = entitiesUrls(qids)
  const todo = urls.filter((url) => !batchValues(url).every((q) => written.has(q)))
  let done = 0
  const finished = await fetchBatches(o.client, todo, deadline(o), async (url, body) => {
    done++
    const desc = parseEntities(body)
    // Lignes d'un lot à moitié écrit (run tué) pas répétées.
    const fresh = batchValues(url).filter((q) => !written.has(q))
    await writeTsv(path, fresh.map((q) => [q, desc.get(q) ?? null]), { append: true })
  })
  return { done, skipped: urls.length - todo.length, finished }
}
