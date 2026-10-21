// TextExtracts : résumés des pages retenues sans texte Cirrus utilisable, ou repli complet (P11).
import { batchUrls } from './http.ts'

const EXTRACTS = 'https://fr.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&maxlag=5&prop=extracts&exintro=1&explaintext=1&exlimit=20&pageids='

// Règles de lots : page_id dédoublonnés et croissants, 20 par appel (maximum de `exlimit`).
export function extractsUrls(pageIds: number[]): string[] {
  return batchUrls(EXTRACTS, [...new Set(pageIds)].sort((a, b) => a - b).map(String), 20)
}

// query.pages[] de formatversion=2 ; page manquante, invalide ou sans extrait ignorée. L'appelant nettoie et coupe.
export function parseExtracts(body: unknown): { page_id: number; extract: string }[] {
  const pages = (body as { query?: { pages?: unknown } } | null)?.query?.pages
  if (!Array.isArray(pages)) throw new Error('Format TextExtracts inattendu : query.pages absent')
  return pages.flatMap((p: { pageid?: unknown; extract?: unknown }) =>
    Number.isInteger(p.pageid) && typeof p.extract === 'string' && p.extract.trim() ? [{ page_id: p.pageid as number, extract: p.extract }] : [],
  )
}
