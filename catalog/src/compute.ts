// Calculs purs du catalogue (échantillon M2-1, rang percentile M2-2, stats_v1 D§10.1, résumé), commandes `select` et
// `compute`.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RARITY, rarityForViews } from '../../lib/rarity.ts'
import type { RarityCode } from '../../lib/rarity.ts'
import { CARD_CSV_COLUMNS, MEDIA_CSV_COLUMNS, wikipediaUrl, writeCsv } from './emit.ts'
import { extractsUrls, parseExtracts } from './extracts.ts'
import { batchValues, createClient, deadline, fetchBatches } from './http.ts'
import type { Client } from './http.ts'
import { readTsv, writeTsv, writtenIds } from './tsv.ts'
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
  rows: { text_bytes: number; incoming_links: number | null; badge: number }[],
): { atk: number; def: number; q_score: number }[] {
  const text = pct(rows.map((r) => r.text_bytes))
  // M2-R7 : liens inconnus (pages récentes) classés à part, au rang neutre 0,5.
  const known = pct(rows.flatMap((r) => (r.incoming_links === null ? [] : [Math.log1p(r.incoming_links)])))
  let k = 0
  const links = rows.map((r) => (r.incoming_links === null ? 0.5 : known[k++]))
  const q = rows.map((r, i) => Math.round(100 * (0.45 * text[i] + 0.35 * links[i] + 0.2 * r.badge) * 100) / 100)
  const qp = pct(q)
  return rows.map((_, i) => ({ atk: Math.round(1000 + 9000 * text[i]), def: Math.round(1000 + 9000 * qp[i]), q_score: q[i] }))
}

// Fin de phrase : ponctuation, puis « » » (après un blanc éventuel) ou « ) » éventuels, puis un blanc ou la fin du texte.
// Une ponctuation suivie de « » » ne finit la phrase qu'avec ce guillemet : « Ça ira ! », dit-il ne s'arrête pas à « ! ».
const STOP = String.raw`[.!?…](?:\s?»|\)|(?!\s?»))(?=\s|$)`
const STOPS = new RegExp(STOP, 'g')
// Bandeau de tête (relevés dans les tranches réelles de Cirrus : homonymie, ébauche, sources, label, article principal…) :
// une phrase jusqu'à la première fin de phrase, ou jusqu'à la fin du texte ; « (comment ?) » est pris dans le début
// pour ne pas finir là. « Trouver des sources » et « Sur les autres projets » n'ont pas de fin de phrase : bornés à part.
const BANNER = new RegExp(
  String.raw`^(?:(?:Pour [^.!?]*?,\s?vo(?:ir|yez)(?![\w-])|Ne doit pas être confondu|Ne pas confondre|Cet article (?:concerne|traite|est une ébauche|est orphelin|ne cite|ne s['’]appuie|peut contenir)|Cette page (?:d['’]homonymie|est une très courte ébauche|contient des caractères spéciaux)|Vous lisez un «|Vous pouvez (?:partager vos connaissances en l['’]améliorant \(comment\s?\?\)|aider en ajoutant|également enrichir les pages)|Articles? principa(?:l|ux)\s?:|Moins de trois articles lui sont liés|Si vous disposez d['’]ouvrages|En pratique\s?:\s?Quelles sources sont attendues\s?\?\s?Comment ajouter mes sources|À l['’]instar du célèbre «|L['’]article peut contenir des analyses|Pour améliorer la vérifiabilité|S['’]ils s['’]affichent mal|Voir la page de discussion pour plus de détails|Consultez la liste des tâches|«[^»]*»\s*redirige ici)[^]*?(?:${STOP}|$)|Trouver des sources sur «[^»]*»\s?:[^]*?\(wd\)\s?trouver des œuvres sur Wikidata|Sur les autres projets Wikimedia\s?:(?:[^,]*,\s?sur (?:le |la )?Wik\S*(?: Commons)?)+)\s*`,
)

// Notes de maintenance entre crochets (liste fixe : l'API « [pa.ʁi] » reste) et « Écouter » collé au mot ou entre la
// barre de l'API et « ) , ; » ; après une espace, « Écouter » est un vrai mot (« Son album Écouter… », « Lire / Écouter »).
// Barre de portails en dernière ligne : TextExtracts la garde dans l'intro d'un article sans section.
const NOISE =
  /\[(?:réf\.\s?(?:nécessaire|souhaitée)|(?:Quoi|Lequel|Laquelle|Lesquels|Lesquelles|Qui|Quand|Où|Comment|Pourquoi|Combien)\s?\?|source\sinsuffisante|non\sneutre|interprétation\spersonnelle|à\svérifier|pas\sclair)\]|(?<=[\p{L}\p{M}])Écouter(?![\p{L}\p{M}])|(?<=\/)\s?Écouter(?=\s?[),;])|\n[^\S\n]*Portail [^\n]*\s*$/gu

export function cleanOpening(text: string): string {
  // Une espace insécable seule est gardée (typographie française) ; tabulations et sauts de ligne deviennent des espaces.
  let t = text.replace(NOISE, '').replace(/\s{2,}|[\t\n\r]/g, ' ').trim()
  while (BANNER.test(t)) t = t.replace(BANNER, '')
  return t
}

// Texte d'infobox repérable sans le titre : liens de modification, légendes de carte, fiche de film, bandeau resté
// derrière une infobox, mots de tête répétés (« Placodermi Placodermi »).
const INFOBOX =
  /modifier - modifier le code|Localisation sur la carte|Pour plus de détails, voir Fiche technique|Pas d'image \? Cliquez ici| Navigation [\p{Lu}\d]|Cet article est une ébauche|Pour les articles homonymes, voir|» redirige ici|^Chronologies |^(\S+(?: \S+){0,5}) \1 /u
// Modèles dont l'infobox laisse sa légende dans opening_text (voir usableOpening).
const LEAKY_INFOBOX = /^Modèle:Infobox (?:V3\/Début|en Lua)$/

// Ouverture utilisable comme résumé (sinon TextExtracts) : seule règle de cirrusCommand et de `fixtures fetch`
// (usableOpening sur un texte déjà passé par cleanOpening, hasOpening sur le texte brut).
// M2-R5 : le titre (avec ou sans sa précision entre parenthèses) suivi d'une majuscule ou d'un chiffre ouvre un texte
// d'infobox (« René Guénon Photographie de 1925… ») ; sans titre, seul INFOBOX joue. Un faux positif coûte un appel
// TextExtracts, un faux négatif laisse passer l'infobox. Une infobox V3 ou en Lua (modèles de la page) laisse sa
// légende en tête d'opening_text même sans titre (« Cave Balve Entrée de la Balver Höhle… » : 14 des 15 pages de la
// tranche que le titre ne repérait pas) ; une infobox v2 n'y laisse rien.
// shortcut: une légende sans titre ni marqueur, hors infobox V3 ou Lua, passe encore (aucune sur la tranche), à reprendre
// si les résumés de la démo en souffrent.
export function usableOpening(clean: string, title?: string, templates?: string[]): boolean {
  // Insécables ramenées à l'espace pour comparer au titre.
  const t = clean.replace(/\s/g, ' ')
  if (t === '' || INFOBOX.test(t) || templates?.some((m) => LEAKY_INFOBOX.test(m))) return false
  const heads = title ? [title, title.replace(/ \([^()]*\)$/, '')].map((h) => `${h.replace(/\s/g, ' ')} `) : []
  return !heads.some((h) => t.startsWith(h) && /^[\p{Lu}\d]/u.test(t.slice(h.length)))
}

export const hasOpening = (text: string | undefined, title?: string, templates?: string[]): boolean =>
  usableOpening(cleanOpening(text ?? ''), title, templates)

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

// Complément TextExtracts (P11, M2-R5) : extracts.tsv (page_id, summary|\N, résumé déjà coupé : l'extrait brut pèserait
// plusieurs fois plus) écrit en ajout lot par lot, une ligne par page demandée ; un lot déjà écrit est sauté (reprise).
async function extractSummaries(dir: string, pageIds: number[], mode: Mode, client: Client): Promise<Map<number, string | null>> {
  const path = join(dir, 'extracts.tsv')
  const written = await writtenIds(path)
  const todo = extractsUrls(pageIds).filter((url) => !batchValues(url).every((id) => written.has(id)))
  await fetchBatches(client, todo, deadline({}), async (url, body) => {
    const found = new Map(parseExtracts(body).map((p) => [String(p.page_id), cutSummary(cleanOpening(p.extract), SUMMARY_MAX[mode])]))
    const fresh = batchValues(url).filter((id) => !written.has(id))
    await writeTsv(path, fresh.map((id) => [id, found.get(id) || null]), { append: true })
  })
  const out = new Map<number, string | null>()
  for await (const f of readTsv(path)) out.set(Number(f[0]), f[1])
  return out
}

// Description Wikidata d'une page de service (« page d'homonymie de Wikimedia », « page de liste de Wikipédia ») : l'élément
// lié n'est pas l'article ; « cofondateur de Wikipédia » reste.
const META = /^(?:page|catégorie|modèle)\b.*\bWiki(?:m[ée]dia|pédia)\s*$/i

// out/cards.csv et out/media.csv des pages retenues, out/counts.json ; stats_v1 sur tout catalog.tsv (M2-2).
// shortcut: textes et lignes gardés en mémoire (2,77 M lignes : ≈ 1,8 Go de tas en sample, ≈ 5,2 Go en full, 85 % des
// 6 Go du job), le mode full (M8) doit lire en flux.
export async function computeCommand(o: {
  dir: string
  out: string
  mode: Mode
  month: string
  textDate: string
  textSource: 'cirrus' | 'extracts'
  client?: Client
}): Promise<Counts> {
  const counts = JSON.parse(await readFile(join(o.dir, 'counts.json'), 'utf8')) as Counts
  // Les résumés Cirrus sont déjà coupés au maximum du mode de select.
  if (counts.mode !== o.mode) throw new Error(`Mode ${o.mode} différent de celui de select (${counts.mode})`)
  const rows: CatalogRow[] = []
  let line = 0
  for await (const f of readTsv(join(o.dir, 'catalog.tsv'))) {
    line++
    const n = (i: number) => num(f, i, 'catalog.tsv', line)
    rows.push({
      page_id: n(0), title: String(f[1]), len: n(2), views: n(3), rarity: f[4] as RarityCode,
      image: f[5], qid: f[6], badge: n(7), selected: f[8] === '1',
    })
  }
  // text-<part>.tsv : page_id, text_bytes, incoming_links|\N, summary|\N ; aucun en repli extracts (job text sauté).
  const text = new Map<number, { text_bytes: number; incoming_links: number | null; summary: string | null }>()
  if (o.textSource === 'cirrus') {
    const parts = (await readdir(o.dir)).filter((f) => /^text-.+\.tsv$/.test(f)).sort()
    if (parts.length === 0) throw new Error(`Aucun text-*.tsv dans ${o.dir}`)
    for (const part of parts) {
      line = 0
      for await (const f of readTsv(join(o.dir, part))) {
        line++
        const n = (i: number) => num(f, i, part, line)
        text.set(n(0), { text_bytes: n(1), incoming_links: f[2] === null ? null : n(2), summary: f[3] })
      }
    }
  }

  let absent = 0
  let unknown = 0
  // Repli extracts (P11) : text_bytes = len, liens à 0. Page absente de Cirrus : text_bytes = len, liens inconnus (M2-R7).
  // shortcut: len (wikitexte) et text_bytes (texte rendu) n'ont pas la même unité ; rare, à revoir si cirrus_absent grandit.
  const stats = statsV1(rows.map((r) => {
    if (o.textSource === 'extracts') return { text_bytes: r.len, incoming_links: 0, badge: r.badge }
    const t = text.get(r.page_id)
    if (!t) absent++
    if ((t?.incoming_links ?? null) === null) unknown++
    return { text_bytes: t?.text_bytes ?? r.len, incoming_links: t?.incoming_links ?? null, badge: r.badge }
  }))
  // Une part text-*.tsv manquante passerait pour des pages absentes, et des milliers d'appels TextExtracts.
  if (absent > Math.max(1, rows.length / 100)) {
    throw new Error(`Pages absentes de Cirrus : ${absent} sur ${rows.length} (plus de 1 %), une part text-*.tsv manque-t-elle, ou des documents Cirrus mal formés ont-ils été sautés ?`)
  }

  // Pages retenues sans résumé Cirrus (ouvertures d'infobox comprises, M2-R5 ; toutes en repli) : même sélection que
  // `fixtures fetch`, d'où les mêmes URL (Règles de lots).
  const selected = rows.flatMap((r, i) => (r.selected ? [i] : []))
  const need = selected.map((i) => rows[i].page_id).filter((id) => text.get(id)?.summary == null)
  const extracts = need.length > 0 ? await extractSummaries(o.dir, need, o.mode, o.client ?? createClient()) : new Map<number, string | null>()

  // desc.tsv : qid, description|\N ; media.tsv : file, author|\N, license|\N, license_url|\N, image_url|\N.
  const desc = new Map<string, string | null>()
  for await (const f of readTsv(join(o.dir, 'desc.tsv'))) desc.set(String(f[0]), f[1])
  const media = new Map<string, (string | null)[]>()
  for await (const f of readTsv(join(o.dir, 'media.tsv'))) media.set(String(f[0]), f)

  const [y, m] = o.month.split('-').map(Number)
  const viewsAt = `${new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)}T00:00:00Z` // 1er du mois suivant
  const statsAt = `${o.textDate}T00:00:00Z`
  const summaries = { cirrus: 0, extracts: 0, none: 0 }
  const credits: Field[][] = []
  await mkdir(o.out, { recursive: true })
  const cards = await writeCsv(join(o.out, 'cards.csv'), CARD_CSV_COLUMNS, (function* (): Generator<Field[]> {
    for (const i of selected) {
      const r = rows[i]
      const cirrus = text.get(r.page_id)?.summary ?? null
      const summary = cirrus ?? extracts.get(r.page_id) ?? null
      summaries[cirrus !== null ? 'cirrus' : summary !== null ? 'extracts' : 'none']++
      // P15 : media.tsv garde image_url sans licence ; ni image ni crédit dans ce cas.
      const [file, author, license, licenseUrl, imageUrl] = (r.image !== null && media.get(r.image)) || []
      const image = license && imageUrl ? imageUrl : null
      if (image) credits.push([r.page_id, file, author, license, licenseUrl])
      const title = r.title.replaceAll('_', ' ')
      const { atk, def, q_score } = stats[i]
      const description = r.qid === null ? null : (desc.get(r.qid) ?? null)
      const category = description !== null && META.test(description) ? null : description
      yield [r.page_id, title, wikipediaUrl(title), 'fr', r.rarity, atk, def, q_score, r.views, viewsAt, statsAt, category, summary, image]
    }
  })())
  await writeCsv(join(o.out, 'media.csv'), MEDIA_CSV_COLUMNS, credits)

  const result = {
    ...counts, month: o.month, text_date: o.textDate, text_source: o.textSource,
    cirrus_absent: absent, links_unknown: unknown, summaries, cards, media: credits.length,
  }
  await writeFile(join(o.out, 'counts.json'), JSON.stringify(result, null, 2) + '\n')
  return result
}
