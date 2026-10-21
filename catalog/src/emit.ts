// cards.csv et media.csv : CSV RFC 4180 aux colonnes de wm.catalog_stage et wm.catalog_stage_media (1510), chargés par
// `\copy <table> (<colonnes>) from … with (format csv, header true)`.
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import type { Field } from './tsv.ts'

// Colonnes miroir sans id, hide_image, nsfw_image ni created_at, avec page_id (« Écarts au spec »).
export const CARD_CSV_COLUMNS = [
  'page_id', 'wikipedia_title', 'wikipedia_url', 'lang', 'rarity', 'atk', 'def', 'q_score', 'pageviews',
  'pageviews_refreshed_at', 'qscore_refreshed_at', 'category', 'summary', 'image_url',
] as const
export const MEDIA_CSV_COLUMNS = ['page_id', 'file', 'author', 'license', 'license_url'] as const

// null → champ vide non guillemeté (NULL pour \copy) ; une chaîne vide est guillemetée, sinon elle deviendrait NULL.
export function csvField(v: Field): string {
  if (v === null) return ''
  const s = String(v)
  return s === '' || /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export const wikipediaUrl = (title: string): string => `https://fr.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`

// En-tête puis une ligne par enregistrement, en flux (le mode full dépasse la taille d'une chaîne).
export async function writeCsv(path: string, columns: readonly string[], rows: Iterable<Field[]>): Promise<number> {
  let n = 0
  await pipeline(function* () {
    yield `${columns.join(',')}\n`
    for (const row of rows) {
      n++
      yield `${row.map(csvField).join(',')}\n`
    }
  }, createWriteStream(path))
  return n
}
