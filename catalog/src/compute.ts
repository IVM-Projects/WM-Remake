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

// rate = taux effectif : 1 en mode full, le taux donné en mode sample.
export type Counts = { mode: Mode; rate: number; full: Record<RarityCode, number>; selected: Record<RarityCode, number> }

const UTF8 = new TextEncoder()

export function fnv1a32(s: string): number {
  let h = 0x811c9dc5
  for (const b of UTF8.encode(s)) h = Math.imul(h ^ b, 0x01000193)
  return h >>> 0
}

// Champ numérique d'un TSV du pipeline : une ligne tronquée ou mal formée arrête le job au lieu de donner NaN.
const NUMBER = /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i
function num(f: (string | null)[], i: number, file: string, line: number): number {
  const v = f[i]
  if (!v || !NUMBER.test(v)) {
    throw new Error(`Nombre attendu dans ${file}, ligne ${line}, colonne ${i + 1} : ${v === undefined ? '(absent)' : (v ?? '\\N')}`)
  }
  return Number(v)
}

// pages.tsv ⋈ props.tsv (sans homonymies) ⋈ views.tsv ; ordre de pages.tsv.
export async function joinCatalog(dir: string): Promise<CatalogRow[]> {
  const props = new Map<number, { image: string | null; qid: string | null; badge: number; disambig: boolean }>()
  let line = 0
  for await (const f of readTsv(join(dir, 'props.tsv'))) {
    line++
    const page_id = num(f, 0, 'props.tsv', line)
    props.set(page_id, { image: f[1], qid: f[2], badge: num(f, 3, 'props.tsv', line), disambig: num(f, 4, 'props.tsv', line) === 1 })
  }
  const byId = new Map<number, number>()
  const byTitle = new Map<string, number>()
  line = 0
  for await (const f of readTsv(join(dir, 'views.tsv'))) {
    line++
    const views = num(f, 2, 'views.tsv', line)
    if (f[0] === null) byTitle.set(String(f[1]), views)
    else byId.set(num(f, 0, 'views.tsv', line), views)
  }
  const rows: CatalogRow[] = []
  line = 0
  for await (const f of readTsv(join(dir, 'pages.tsv'))) {
    line++
    const page_id = num(f, 0, 'pages.tsv', line)
    const len = num(f, 2, 'pages.tsv', line)
    const p = props.get(page_id)
    if (p?.disambig) continue
    const title = String(f[1])
    const views = (byId.get(page_id) ?? 0) + (byTitle.get(title) ?? 0)
    rows.push({
      page_id, title, len, views, rarity: rarityForViews(views),
      image: p?.image ?? null, qid: p?.qid ?? null, badge: p?.badge ?? 0, selected: false,
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
  // Un NaN rend le comparateur incohérent et désordonne tout le tri, pas seulement sa ligne.
  if (!values.every(Number.isFinite)) throw new Error('pct : valeur non finie')
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

// Fin de phrase : ponctuation, puis « » » (après un blanc éventuel) ou « ) » éventuels, puis un blanc ou la fin du texte.
// Une ponctuation suivie de « » » ne finit la phrase qu'avec ce guillemet : « Ça ira ! », dit-il ne s'arrête pas à « ! ».
const STOP = String.raw`[.!?…](?:\s?»|\)|(?!\s?»))(?=\s|$)`
const STOPS = new RegExp(STOP, 'g')
// Bandeau de tête : une phrase jusqu'à la première fin de phrase, ou jusqu'à la fin du texte.
const BANNER = new RegExp(
  String.raw`^(?:Pour les articles homonymes|Pour l['’]article homonyme|Pour les articles ayant des titres homonymes|Ne doit pas être confondu|Ne pas confondre|Cet article concerne|Pour un article plus général|«[^»]*»\s*redirige ici)[^]*?(?:${STOP}|$)\s*`,
)

export function cleanOpening(text: string): string {
  // Une espace insécable seule est gardée (typographie française) ; tabulations et sauts de ligne deviennent des espaces.
  let t = text.replace(/\s{2,}|[\t\n\r]/g, ' ').trim()
  while (BANNER.test(t)) t = t.replace(BANNER, '')
  return t
}

export const hasOpening = (text: string | undefined): boolean => cleanOpening(text ?? '') !== ''

export function cutSummary(text: string, max: number): string {
  if (text.length <= max) return text
  // Dernière fin de phrase (guillemet fermant compris) qui tient dans les max premiers caractères ; le blanc qui la
  // suit est lu dans le texte entier, donc un « » » au-delà de max écarte la phrase au lieu de couper la citation.
  // Une fin de phrase à l'intérieur d'une citation (plus de « que de ») avant elle) ne compte pas.
  let end = 0
  for (const m of text.matchAll(STOPS)) {
    const e = m.index + m[0].length
    if (e > max) break
    const head = text.slice(0, e)
    if ((head.match(/«/g)?.length ?? 0) <= (head.match(/»/g)?.length ?? 0)) end = e
  }
  if (end) return text.slice(0, end)
  const head = text.slice(0, max)
  // Coupe au dernier blanc ordinaire : jamais sur l'insécable qui suit « ou précède ».
  return (head.match(/^[^]*\S(?=[^\S\u00a0\u202f])/)?.[0] ?? head.slice(0, max - 1)) + '…'
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
