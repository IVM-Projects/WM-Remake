// Dump CirrusSearch hebdomadaire de frwiki_content (M2-5) : instantané, parts, documents → text-<part>.tsv.
import { join } from 'node:path'
import { cleanOpening, cutSummary, hasOpening, SUMMARY_MAX } from './compute.ts'
import type { Mode } from './compute.ts'
import { USER_AGENT } from './http.ts'
import { readTsv, writeTsv } from './tsv.ts'
import type { Field } from './tsv.ts'

const ROOT = 'https://dumps.wikimedia.org/other/cirrus_search_index/'

// 3 essais à 5 s d'intervalle sur une erreur réseau ou un 5xx ; 404 → null (dossier absent).
async function fetchDumpText(url: string): Promise<string | null> {
  let failure = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 5000))
    let res: Response
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) })
      if (res.ok) return await res.text()
    } catch {
      failure = 'réseau'
      continue
    }
    if (res.status === 404) return null
    if (res.status < 500) throw new Error(`Cirrus : HTTP ${res.status} sur ${url}`)
    failure = `HTTP ${res.status}`
  }
  throw new Error(`Cirrus : ${failure} sur ${url} après 3 essais`)
}

// Le plus récent dossier `YYYYMMDD/` dont `index_name=frwiki_content/` contient `_SUCCESS` ; parts triées.
// Un dossier en 404 (instantané en cours d'écriture) est sauté ; un listing racine en 404 est une erreur.
export async function cirrusListing(
  fetchText: (url: string) => Promise<string | null> = fetchDumpText,
): Promise<{ date: string; parts: string[] }> {
  const root = await fetchText(ROOT)
  if (root === null) throw new Error(`Cirrus : listing des dumps introuvable sur ${ROOT}`)
  const dates = [...new Set(root.matchAll(/href="(\d{8})\/"/g).map((m) => m[1]))].sort().reverse()
  for (const date of dates) {
    const html = (await fetchText(`${ROOT}${date}/index_name%3Dfrwiki_content/`)) ?? ''
    const parts = new RegExp(`href="(frwiki_content-${date}-\\d{5}\\.json\\.bz2)"`, 'g')
    const names = [...new Set(html.matchAll(parts).map((m) => m[1]))].sort()
    if (html.includes('href="_SUCCESS"') && names.length > 0) return { date, parts: names }
  }
  throw new Error('Cirrus : aucun instantané complet de frwiki_content')
}

export type CirrusDoc = {
  page_id: number
  namespace: number
  title: string
  page_type?: string
  opening_text?: string
  text_bytes: number
  incoming_links?: number
}

const parse = (line: string): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

// Paires index/document ; la ligne d'index donne l'id attendu du document qui la suit. Un document sans page_id,
// namespace et text_bytes entiers, ou dont page_id n'est pas cet id, est sauté ; au-delà de 5 %, le format a changé.
export async function* cirrusDocs(lines: AsyncIterable<string>): AsyncGenerator<CirrusDoc> {
  let n = 0
  let docs = 0
  let invalid = 0
  let mismatch = 0
  let expected: number | undefined
  for await (const line of lines) {
    n++
    const json = parse(line)
    if (expected === undefined) {
      const id = (json as { index?: { _id?: unknown } } | null | undefined)?.index?._id
      if (id === undefined) throw new Error(`Format Cirrus inattendu : ligne d'index ${n}`)
      expected = Number(id)
      continue
    }
    if (typeof json !== 'object' || json === null) throw new Error(`Format Cirrus inattendu : ligne ${n}`)
    const d = json as Record<string, unknown>
    docs++
    const id = expected
    expected = undefined
    if (!Number.isInteger(d.page_id) || !Number.isInteger(d.namespace) || !Number.isInteger(d.text_bytes)) {
      invalid++
      continue
    }
    if (d.page_id !== id) {
      mismatch++
      continue
    }
    yield {
      page_id: d.page_id as number,
      namespace: d.namespace as number,
      title: typeof d.title === 'string' ? d.title : '',
      page_type: typeof d.page_type === 'string' ? d.page_type : undefined,
      opening_text: typeof d.opening_text === 'string' ? d.opening_text : undefined,
      text_bytes: d.text_bytes as number,
      incoming_links: Number.isInteger(d.incoming_links) ? (d.incoming_links as number) : undefined,
    }
  }
  // Flux coupé ou vide : jamais une part sans erreur.
  if (expected !== undefined) throw new Error(`Format Cirrus inattendu : ligne d'index ${n} sans document`)
  if (docs === 0) throw new Error('Format Cirrus inattendu : aucun document')
  if (docs - invalid - mismatch < 0.95 * docs) {
    throw new Error(
      `Format Cirrus inattendu : ${invalid} documents sur ${docs} sans page_id, namespace et text_bytes entiers, ${mismatch} dont page_id n'est pas l'_id`,
    )
  }
}

// text-<part>.tsv : page_id, text_bytes, incoming_links (0 si absent), summary|\N ; espace 0 hors redirections.
// Résumé seulement pour une page selected qui passe hasOpening : les autres reçoivent TextExtracts (Règles de lots).
export async function cirrusCommand(o: { dir: string; part: string; mode: Mode; input: AsyncIterable<string> }): Promise<{ docs: number; rows: number }> {
  const selected = new Set<number>()
  // catalog.tsv : page_id, title, len, views, rarity, image|\N, qid|\N, badge, selected (0|1).
  for await (const f of readTsv(join(o.dir, 'catalog.tsv'))) if (f[8] === '1') selected.add(Number(f[0]))
  let docs = 0
  let noLinks = 0
  const rows = await writeTsv(join(o.dir, `text-${o.part}.tsv`), (async function* (): AsyncGenerator<Field[]> {
    for await (const d of cirrusDocs(o.input)) {
      docs++
      if (d.namespace !== 0 || d.page_type === 'redirect') continue
      if (d.incoming_links === undefined) noLinks++
      const usable = selected.has(d.page_id) && hasOpening(d.opening_text, d.title)
      yield [d.page_id, d.text_bytes, d.incoming_links ?? 0, usable ? cutSummary(cleanOpening(d.opening_text ?? ''), SUMMARY_MAX[o.mode]) : null]
    }
  })())
  // Environ 12 % des articles n'ont pas le champ (0 lien) ; au-delà de la moitié, il a changé de nom ou de type.
  if (noLinks > rows / 2) throw new Error(`Format Cirrus inattendu : ${noLinks} documents sur ${rows} sans incoming_links`)
  return { docs, rows }
}
