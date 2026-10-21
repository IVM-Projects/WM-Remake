// Calculs purs du catalogue (échantillon M2-1, rang percentile M2-2, stats_v1 D§10.1, résumé) et commande `select`.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RARITY, rarityForViews } from '../../lib/rarity.ts'
import type { RarityCode } from '../../lib/rarity.ts'
import { readTsv, writeTsv } from './tsv.ts'
import type { Field } from './tsv.ts'

export type Mode = 'full' | 'sample'
export const SUMMARY_MAX = { full: 1200, sample: 600 } as const

export type CatalogRow = {
  page_id: number
  title: string
  len: number
  views: number
  rarity: RarityCode
  image: string | null
  qid: string | null
  badge: number
  selected: boolean
}

export type Counts = { mode: Mode; rate: number; full: Record<RarityCode, number>; selected: Record<RarityCode, number> }

const UTF8 = new TextEncoder()

export function fnv1a32(s: string): number {
  let h = 0x811c9dc5
  for (const b of UTF8.encode(s)) h = Math.imul(h ^ b, 0x01000193)
  return h >>> 0
}

// pages.tsv ⋈ props.tsv (sans homonymies) ⋈ views.tsv ; ordre de pages.tsv.
export async function joinCatalog(dir: string): Promise<CatalogRow[]> {
  const props = new Map<number, (string | null)[]>()
  for await (const f of readTsv(join(dir, 'props.tsv'))) props.set(Number(f[0]), f)
  const byId = new Map<number, number>()
  const byTitle = new Map<string, number>()
  for await (const [id, title, views] of readTsv(join(dir, 'views.tsv'))) {
    if (id === null) byTitle.set(String(title), Number(views))
    else byId.set(Number(id), Number(views))
  }
  const rows: CatalogRow[] = []
  for await (const [id, title, len] of readTsv(join(dir, 'pages.tsv'))) {
    const page_id = Number(id)
    const p = props.get(page_id)
    if (p?.[4] === '1') continue
    const views = (byId.get(page_id) ?? 0) + (byTitle.get(String(title)) ?? 0)
    rows.push({
      page_id, title: String(title), len: Number(len), views, rarity: rarityForViews(views),
      image: p?.[1] ?? null, qid: p?.[2] ?? null, badge: p ? Number(p[3]) : 0, selected: false,
    })
  }
  return rows
}

// M2-1 : dans chaque rareté, les round(rate × n) premières pages par (hachage, page_id), au moins 1.
export function selectSample(rows: CatalogRow[], rate: number): Set<number> {
  if (rate >= 1) return new Set(rows.map((r) => r.page_id))
  const groups = new Map<RarityCode, { h: number; id: number }[]>()
  for (const r of rows) {
    const g = groups.get(r.rarity) ?? []
    g.push({ h: fnv1a32(String(r.page_id)), id: r.page_id })
    groups.set(r.rarity, g)
  }
  const keep = new Set<number>()
  for (const g of groups.values()) {
    g.sort((a, b) => a.h - b.h || a.id - b.id)
    for (const { id } of g.slice(0, Math.max(1, Math.round(rate * g.length)))) keep.add(id)
  }
  return keep
}

// M2-2 : (rang − 1) / (n − 1), ex æquo au rang moyen ; n = 1 → 0,5.
export function pct(values: number[]): number[] {
  const n = values.length
  if (n === 1) return [0.5]
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b])
  const out = new Array<number>(n)
  for (let i = 0; i < n; ) {
    let j = i
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j++
    for (let k = i; k <= j; k++) out[order[k]] = (i + j) / 2 / (n - 1)
    i = j + 1
  }
  return out
}

export function statsV1(
  rows: { text_bytes: number; incoming_links: number; badge: number }[],
): { atk: number; def: number; q_score: number }[] {
  const text = pct(rows.map((r) => r.text_bytes))
  const links = pct(rows.map((r) => Math.log1p(r.incoming_links)))
  const q = rows.map((r, i) => Math.round(100 * (0.45 * text[i] + 0.35 * links[i] + 0.2 * r.badge) * 100) / 100)
  const qp = pct(q)
  return rows.map((_, i) => ({ atk: Math.round(1000 + 9000 * text[i]), def: Math.round(1000 + 9000 * qp[i]), q_score: q[i] }))
}

// Bandeau de tête : une phrase jusqu'à la première fin de phrase suivie d'un blanc, ou jusqu'à la fin du texte.
const BANNER =
  /^(?:Pour les articles homonymes|Pour l['’]article homonyme|Pour les articles ayant des titres homonymes|Ne doit pas être confondu|Ne pas confondre|Cet article concerne|Pour un article plus général|«[^»]*»\s*redirige ici)[^]*?(?:[.!?…](?=\s|$)|$)\s*/

export function cleanOpening(text: string): string {
  // Une espace insécable seule est gardée (typographie française) ; tabulations et sauts de ligne deviennent des espaces.
  let t = text.replace(/\s{2,}|[\t\n\r]/g, ' ').trim()
  while (BANNER.test(t)) t = t.replace(BANNER, '')
  return t
}

export const hasOpening = (text: string | undefined): boolean => cleanOpening(text ?? '') !== ''

export function cutSummary(text: string, max: number): string {
  if (text.length <= max) return text
  // Le caractère d'indice max ne sert qu'à voir si une fin de phrase à max − 1 est suivie d'un blanc.
  const sentence = text.slice(0, max + 1).match(/^[^]*[.!?…](?=\s)/)
  if (sentence) return sentence[0]
  const head = text.slice(0, max)
  return (head.match(/^[^]*\S(?=\s)/)?.[0] ?? head.slice(0, max - 1)) + '…'
}

const zero = () => Object.fromEntries(RARITY.map((r) => [r.code, 0])) as Record<RarityCode, number>

// catalog.tsv : page_id, title, len, views, rarity, image|\N, qid|\N, badge, selected (0|1) ; ordre de pages.tsv.
export async function selectCommand(o: { dir: string; mode: Mode; rate: number }): Promise<Counts> {
  const rows = await joinCatalog(o.dir)
  const rate = o.mode === 'full' ? 1 : o.rate
  const keep = selectSample(rows, rate)
  const counts: Counts = { mode: o.mode, rate, full: zero(), selected: zero() }
  for (const r of rows) {
    r.selected = keep.has(r.page_id)
    counts.full[r.rarity]++
    if (r.selected) counts.selected[r.rarity]++
  }
  await writeTsv(join(o.dir, 'catalog.tsv'), (function* (): Generator<Field[]> {
    for (const r of rows) yield [r.page_id, r.title, r.len, r.views, r.rarity, r.image, r.qid, r.badge, r.selected ? 1 : 0]
  })())
  await writeFile(join(o.dir, 'counts.json'), JSON.stringify(counts, null, 2) + '\n')
  return counts
}
