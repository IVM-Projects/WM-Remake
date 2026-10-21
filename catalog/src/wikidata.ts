// Wikidata : descriptions FR des éléments des pages retenues (le parseur arrive à la Task 7).
import { batchUrls } from './http.ts'

const ENTITIES = 'https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&formatversion=2&maxlag=5&props=descriptions&languages=fr&ids='

// Règles de lots : qids dédoublonnés, triés par valeur numérique, 50 par appel (limite de `ids`).
export function entitiesUrls(qids: string[]): string[] {
  const sorted = [...new Set(qids)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  return batchUrls(ENTITIES, sorted, 50)
}
