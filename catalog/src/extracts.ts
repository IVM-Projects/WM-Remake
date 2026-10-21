// TextExtracts : résumés des pages retenues sans texte Cirrus utilisable, ou repli complet (P11 ; parseur à la Task 6).
import { batchUrls } from './http.ts'

const EXTRACTS = 'https://fr.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&maxlag=5&prop=extracts&exintro=1&explaintext=1&exlimit=20&pageids='

// Règles de lots : page_id dédoublonnés et croissants, 20 par appel (maximum de `exlimit`).
export function extractsUrls(pageIds: number[]): string[] {
  return batchUrls(EXTRACTS, [...new Set(pageIds)].sort((a, b) => a - b).map(String), 20)
}
