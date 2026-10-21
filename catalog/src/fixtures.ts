// Mode `fixtures` de catalog.yml (M2-7) : choix d'environ 300 pages et tranches cohérentes des vraies sources.
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { imageInfoUrls, missingFiles } from './commons.ts'
import { fnv1a32, hasOpening, joinCatalog } from './compute.ts'
import type { CatalogRow } from './compute.ts'
import { extractsUrls } from './extracts.ts'
import type { Client } from './http.ts'
import { openLines, sqlTuples } from './sqldump.ts'
import type { SqlValue } from './sqldump.ts'
import { readTsv, writeTsv } from './tsv.ts'
import { entitiesUrls } from './wikidata.ts'

// page_id → raison : 250 plus petits hachages, puis, à chaque fois parmi les plus petits hachages non encore pris,
// 10 pages de chaque rareté L à R, 3 AdQ, 3 BA et 3 images SVG.
export function pickFixtureIds(rows: CatalogRow[]): Map<number, string> {
  const sorted = rows
    .map((r) => ({ r, h: fnv1a32(String(r.page_id)) }))
    .sort((a, b) => a.h - b.h || a.r.page_id - b.r.page_id)
    .map((x) => x.r)
  const picked = new Map<number, string>()
  const take = (reason: string, n: number, ok: (r: CatalogRow) => boolean) => {
    for (const r of sorted) {
      if (n === 0) return
      if (!picked.has(r.page_id) && ok(r)) {
        picked.set(r.page_id, reason)
        n--
      }
    }
  }
  take('hash', 250, () => true)
  for (const code of ['L', 'UR', 'SR', 'R']) take(code, 10, (r) => r.rarity === code)
  take('AdQ', 3, (r) => r.badge === 1)
  take('BA', 3, (r) => r.badge === 0.6)
  take('svg', 3, (r) => r.image?.toLowerCase().endsWith('.svg') ?? false)
  return picked
}

// Échappements de mysqldump : relus à l'identique par sqlTuples.
const SQL_ESCAPES: Record<string, string> = { '\\': '\\\\', "'": "\\'", '"': '\\"', '\0': '\\0', '\n': '\\n', '\r': '\\r', '\x1a': '\\Z' }
const sqlLiteral = (v: SqlValue): string =>
  v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/[\\'"\0\n\r\x1a]/g, (c) => SQL_ESCAPES[c])}'`

// En-tête du dump recopié jusqu'au premier INSERT (le parseur exige le CREATE TABLE), puis un tuple par ligne.
// Tranche `page` : en plus des pages gardées, les premières redirections de l'espace 0, les premières pages d'un autre
// espace et les homonymies données, que le pipeline doit écarter.
export async function sliceSql(
  lines: AsyncIterable<string>,
  table: 'page' | 'page_props',
  keep: Set<number>,
  extras?: { redirects: number; otherNs: number; disambiguation: Set<number> },
): Promise<{ text: string; ids: Set<number> }> {
  const head: string[] = []
  async function* tee() {
    let inHead = true
    for await (const line of lines) {
      if (line.startsWith('INSERT')) inHead = false
      if (inHead) head.push(line)
      yield line
    }
  }
  const ids = new Set<number>()
  const tuples: string[] = []
  let redirects = 0
  let otherNs = 0
  for await (const t of sqlTuples(tee(), table)) {
    const id = t[0] as number
    let take = keep.has(id)
    if (!take && extras) {
      // page_namespace, page_is_redirect : index 1 et 3 de PAGE_COLUMNS.
      if (extras.disambiguation.has(id)) take = true
      else if (t[1] === 0 && t[3] === 1) take = redirects++ < extras.redirects
      else if (t[1] !== 0) take = otherNs++ < extras.otherNs
    }
    if (!take) continue
    ids.add(id)
    tuples.push(`(${t.map(sqlLiteral).join(',')})`)
  }
  return { text: [...head, `INSERT INTO \`${table}\` VALUES`, `${tuples.join(',\n')};`, ''].join('\n'), ids }
}

// Lignes `fr.wikipedia` par page_id, ou par titre quand page_id manque (`null` ou ligne de 5 champs).
export async function slicePageviews(lines: AsyncIterable<string>, ids: Set<number>, titles: Set<string>): Promise<string[]> {
  const out: string[] = []
  for await (const line of lines) {
    const f = line.split(' ')
    if (f[0] !== 'fr.wikipedia') continue
    const id = f.length === 5 ? 'null' : f[2]
    if (id === 'null' ? titles.has(f[1]) : ids.has(Number(id))) out.push(line)
  }
  return out
}

export const CIRRUS_KEEP = [
  'page_id', 'namespace', 'title', 'page_type', 'redirect_target', 'opening_text', 'text_bytes', 'incoming_links',
  'template', 'wikibase_item', 'version', 'timestamp', 'index_name', 'wiki',
] as const
const KEEP = new Set<string>(CIRRUS_KEEP)

// Paires index/document du dump Cirrus dont l'`_id` est gardé ; document réduit à CIRRUS_KEEP (sans source_text ni text).
export async function* sliceCirrus(lines: AsyncIterable<string>, ids: Set<number>): AsyncGenerator<string> {
  let n = 0
  let index: string | null | undefined // undefined : ligne d'index attendue ; null : document à sauter
  for await (const line of lines) {
    n++
    if (index === undefined) {
      const id = (JSON.parse(line) as { index?: { _id?: unknown } }).index?._id
      if (id === undefined) throw new Error(`Format Cirrus inattendu : ligne d'index ${n}`)
      index = ids.has(Number(id)) ? line : null
      continue
    }
    if (index !== null) {
      yield index
      yield JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(line) as object).filter(([k]) => KEEP.has(k))))
    }
    index = undefined
  }
}

// Clé = URL exacte rendue par le constructeur, jamais res.url (Node réécrit ' en %27) : les tests servent les corps par URL.
export async function fetchRaw(client: Client, urls: string[]): Promise<Record<string, unknown>> {
  const bodies = await Promise.all(urls.map((url) => client.get(url)))
  return Object.fromEntries(urls.map((url, i) => [url, bodies[i]]))
}

export function fixturesReadme(meta: { runDate: string; month: string; sources: { name: string; url: string; date: string }[] }): string {
  return [
    '# Fixtures du catalogue',
    '',
    `Tranches réelles et cohérentes des sources Wikimedia pour un même ensemble d'environ 300 pages de Wikipédia en français (décision M2-7). Produites le ${meta.runDate} par le mode \`fixtures\` de \`.github/workflows/catalog.yml\` (\`node catalog/src/cli.ts fixtures …\`) et commitées telles quelles ; \`expected/\` en est tiré par le pipeline.`,
    '',
    '## Sources',
    '',
    '| Source | URL | Date |',
    '|---|---|---|',
    ...meta.sources.map((s) => `| ${s.name} | ${s.url} | ${s.date} |`),
    '',
    '## Licences',
    '',
    "- Textes de Wikipédia (`page.sql`, `page_props.sql`, `cirrus.ndjson`, `extracts.json`) : contributeurs de Wikipédia, sous licence CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/deed.fr) ; l'historique de chaque article sur fr.wikipedia.org nomme ses auteurs.",
    '- Descriptions de Wikidata (`wikidata.json`) : CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/deed.fr).',
    `- Vues (\`pageviews.txt\`) : fichier mensuel \`user\` de \`pageview_complete\` du mois ${meta.month} (https://dumps.wikimedia.org/other/pageview_complete/monthly/AAAA/AAAA-MM/pageviews-AAAAMM-user.bz2), sous CC0 1.0 comme tous les jeux de données Analytics de Wikimedia (https://dumps.wikimedia.org/other/pageview_complete/readme.html).`,
    '- Métadonnées des images (`commons.json`) : sous la licence de chaque fichier, donnée dans la réponse elle-même (`LicenseShortName`, `LicenseUrl`).',
    '',
    '## Contenu de `raw/`',
    '',
    '- `ids.tsv` : `page_id` et raison du choix (`hash` : les 250 plus petits hachages FNV-1a ; `L`, `UR`, `SR`, `R` : 10 pages de chaque rareté ; `AdQ`, `BA`, `svg` : 3 pages chacune).',
    "- `page.sql`, `page_props.sql` : tuples de ces pages réécrits au format du dump (en-tête d'origine, un tuple par ligne). `page.sql` garde aussi quelques redirections, pages d'autres espaces de noms et homonymies, que le pipeline doit écarter.",
    '- `pageviews.txt` : lignes `fr.wikipedia` du fichier mensuel `user` pour ces pages (par `page_id`, ou par titre quand `page_id` vaut `null`).',
    `- \`cirrus.ndjson\` : paires index/document du dump CirrusSearch pour ces pages. Les champs lourds (\`source_text\`, \`text\`, \`auxiliary_text\`, …) sont retirés ; restent ${CIRRUS_KEEP.map((k) => `\`${k}\``).join(', ')}.`,
    "- `wikidata.json`, `commons.json`, `extracts.json` : réponses des API, rangées par l'URL exacte de la requête.",
    "- `meta.json` : date du run, mois des vues (`YYYY-MM`), date de l'instantané Cirrus.",
    '',
    'Projet indépendant de la Fondation Wikimedia.',
    '',
  ].join('\n')
}

// --- Commandes `node catalog/src/cli.ts fixtures …` ; `fixtures` = dossier catalog/fixtures, tranches dans raw/.

// ids et titres (espace 0) de la tranche `page` déjà écrite : la base des autres tranches.
async function pageSlice(fixtures: string): Promise<{ ids: Set<number>; titles: Set<string> }> {
  const ids = new Set<number>()
  const titles = new Set<string>()
  for await (const t of sqlTuples(openLines(join(fixtures, 'raw', 'page.sql')), 'page')) {
    ids.add(t[0] as number)
    if (t[1] === 0) titles.add(t[2] as string)
  }
  return { ids, titles }
}

export async function pickCommand(o: { dir: string; fixtures: string }): Promise<Record<string, number>> {
  const picked = pickFixtureIds(await joinCatalog(o.dir))
  await writeTsv(join(o.fixtures, 'raw', 'ids.tsv'), picked)
  const counts: Record<string, number> = { ids: picked.size }
  for (const reason of picked.values()) counts[reason] = (counts[reason] ?? 0) + 1
  return counts
}

export async function sliceSqlCommand(o: { page: string; props: string; dir: string; fixtures: string }): Promise<{ pages: number; props: number }> {
  const raw = join(o.fixtures, 'raw')
  const keep = new Set<number>()
  for await (const f of readTsv(join(raw, 'ids.tsv'))) keep.add(Number(f[0]))
  // Les 3 premières homonymies de props.tsv (colonne disambig).
  const disambiguation: number[] = []
  for await (const f of readTsv(join(o.dir, 'props.tsv'))) if (f[4] === '1' && disambiguation.length < 3) disambiguation.push(Number(f[0]))
  const page = await sliceSql(openLines(o.page), 'page', keep, { redirects: 5, otherNs: 3, disambiguation: new Set(disambiguation) })
  await writeFile(join(raw, 'page.sql'), page.text)
  const props = await sliceSql(openLines(o.props), 'page_props', page.ids)
  await writeFile(join(raw, 'page_props.sql'), props.text)
  return { pages: page.ids.size, props: props.ids.size }
}

// Lignes lues seulement après pageSlice : une interface readline créée plus tôt perdrait celles émises pendant l'attente.
const readLines = (input: NodeJS.ReadableStream) => createInterface({ input, crlfDelay: Infinity })

export async function slicePageviewsCommand(o: { input: NodeJS.ReadableStream; fixtures: string }): Promise<{ lines: number }> {
  const { ids, titles } = await pageSlice(o.fixtures)
  const lines = await slicePageviews(readLines(o.input), ids, titles)
  await writeFile(join(o.fixtures, 'raw', 'pageviews.txt'), lines.map((l) => `${l}\n`).join(''))
  return { lines: lines.length }
}

// Écrit sur `output` (stdout, ajouté à raw/cirrus.ndjson part après part) ; ne rend rien.
export async function sliceCirrusCommand(o: { input: NodeJS.ReadableStream; fixtures: string; output: NodeJS.WritableStream }): Promise<void> {
  const { ids } = await pageSlice(o.fixtures)
  for await (const line of sliceCirrus(readLines(o.input), ids)) if (!o.output.write(`${line}\n`)) await once(o.output, 'drain')
}

// Règles de lots du plan sur toutes les pages `selected` de catalog.tsv, puis extractsUrls des 40 premiers ids.
// only 'extracts' (M2-R5) : extracts.json = exactement les lots de ces règles ; corps déjà là repris, les autres demandés.
export async function fetchCommand(o: {
  dir: string
  fixtures: string
  client: Client
  only?: 'extracts'
}): Promise<{ wikidata?: number; commons?: number; extracts: number }> {
  const raw = join(o.fixtures, 'raw')
  const rows: { id: number; image: string | null; qid: string | null }[] = []
  // catalog.tsv : page_id, title, len, views, rarity, image|\N, qid|\N, badge, selected (0|1).
  for await (const f of readTsv(join(o.dir, 'catalog.tsv'))) if (f[8] === '1') rows.push({ id: Number(f[0]), image: f[5], qid: f[6] })
  // Résumé Cirrus utilisable : document de l'espace 0, pas une redirection, qui passe hasOpening (règle de cirrusCommand).
  const opening = new Set<number>()
  for await (const line of openLines(join(raw, 'cirrus.ndjson'))) {
    const d = JSON.parse(line) as { page_id?: number; namespace?: number; title?: string; page_type?: string; opening_text?: string }
    if (d.page_id !== undefined && d.namespace === 0 && d.page_type !== 'redirect' && hasOpening(d.opening_text, d.title)) opening.add(d.page_id)
  }
  const ids = rows.map((r) => r.id)
  const extractUrls = [...new Set([...extractsUrls(ids.filter((id) => !opening.has(id))), ...extractsUrls(ids.slice(0, 40))])]

  if (o.only === 'extracts') {
    const path = join(raw, 'extracts.json')
    const old = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const fresh = await fetchRaw(o.client, extractUrls.filter((url) => !Object.hasOwn(old, url)))
    const extracts = Object.fromEntries(extractUrls.map((url) => [url, Object.hasOwn(old, url) ? old[url] : fresh[url]]))
    await writeFile(path, `${JSON.stringify(extracts, null, 2)}\n`)
    return { extracts: Object.keys(extracts).length }
  }

  const wikidata = await fetchRaw(o.client, entitiesUrls(rows.flatMap((r) => r.qid ?? [])))
  const commons = await fetchRaw(o.client, imageInfoUrls(rows.flatMap((r) => r.image ?? []), 'commons.wikimedia.org'))
  const missing = Object.values(commons).flatMap((body) => missingFiles(body))
  Object.assign(commons, await fetchRaw(o.client, imageInfoUrls(missing, 'fr.wikipedia.org')))
  const extracts = await fetchRaw(o.client, extractUrls)

  const files = { 'wikidata.json': wikidata, 'commons.json': commons, 'extracts.json': extracts }
  for (const [name, bodies] of Object.entries(files)) await writeFile(join(raw, name), `${JSON.stringify(bodies, null, 2)}\n`)
  return { wikidata: Object.keys(wikidata).length, commons: Object.keys(commons).length, extracts: Object.keys(extracts).length }
}

// README.md et raw/meta.json ; cirrusDate tel que cirrus-list le rend (YYYYMMDD).
export async function readmeCommand(o: { fixtures: string; month: string; cirrusDate: string; dumpDate: string }): Promise<void> {
  const runDate = new Date().toISOString().slice(0, 10)
  const cirrusDate = `${o.cirrusDate.slice(0, 4)}-${o.cirrusDate.slice(4, 6)}-${o.cirrusDate.slice(6)}`
  const dumps = 'https://dumps.wikimedia.org'
  const sources = [
    { name: 'Wikipédia en français, dump SQL `page`', url: `${dumps}/frwiki/latest/frwiki-latest-page.sql.gz`, date: o.dumpDate },
    { name: 'Wikipédia en français, dump SQL `page_props`', url: `${dumps}/frwiki/latest/frwiki-latest-page_props.sql.gz`, date: o.dumpDate },
    {
      name: 'Vues mensuelles (`pageview_complete`, `user`)',
      url: `${dumps}/other/pageview_complete/monthly/${o.month.slice(0, 4)}/${o.month}/pageviews-${o.month.replace('-', '')}-user.bz2`,
      date: o.month,
    },
    { name: 'CirrusSearch (`frwiki_content`, 21 parts)', url: `${dumps}/other/cirrus_search_index/${o.cirrusDate}/index_name%3Dfrwiki_content/`, date: cirrusDate },
    { name: 'Wikidata (`wbgetentities`, descriptions)', url: 'https://www.wikidata.org/w/api.php', date: runDate },
    { name: 'Wikimedia Commons (`imageinfo`, `extmetadata`)', url: 'https://commons.wikimedia.org/w/api.php', date: runDate },
    { name: 'Wikipédia en français (`imageinfo` des fichiers locaux, TextExtracts)', url: 'https://fr.wikipedia.org/w/api.php', date: runDate },
  ]
  await writeFile(join(o.fixtures, 'raw', 'meta.json'), `${JSON.stringify({ run_date: runDate, month: o.month, cirrus_date: cirrusDate }, null, 2)}\n`)
  await writeFile(join(o.fixtures, 'README.md'), fixturesReadme({ runDate, month: o.month, sources }))
}
