// Dumps SQL de frwiki (`page`, `page_props`, MariaDB-dump) → pages.tsv et props.tsv.
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { writeTsv } from './tsv.ts'

export type SqlValue = string | number | null

// Ordre des colonnes du CREATE TABLE du dump : les tuples sont positionnels.
export const PAGE_COLUMNS = [
  'page_id', 'page_namespace', 'page_title', 'page_is_redirect', 'page_is_new', 'page_random',
  'page_touched', 'page_links_updated', 'page_latest', 'page_len', 'page_content_model', 'page_lang',
] as const
export const PROPS_COLUMNS = ['pp_page', 'pp_propname', 'pp_value', 'pp_sortkey'] as const

const COLUMNS: Record<'page' | 'page_props', readonly string[]> = { page: PAGE_COLUMNS, page_props: PROPS_COLUMNS }
// \' \" \\ (et tout autre caractère échappé) donnent le caractère lui-même.
const ESCAPES: Record<string, string> = { '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a' }
const NUMBER = /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i
// AdQ et BA (M2-4).
const BADGES = new Map([['wikibase-badge-Q17437796', 1], ['wikibase-badge-Q17437798', 0.6]])

// Automate caractère par caractère : un tuple par ligne (dump de 2026) ou tous sur une ligne (anciens dumps).
export async function* sqlTuples(lines: AsyncIterable<string>, table: 'page' | 'page_props'): AsyncGenerator<SqlValue[]> {
  const columns = COLUMNS[table]
  const create = `CREATE TABLE \`${table}\` (`
  const insert = `INSERT INTO \`${table}\` VALUES`
  let schema: string[] | null = null // colonnes du CREATE TABLE en cours de lecture
  let checked = false
  let inInsert = false
  let tuple: SqlValue[] | null = null
  let str: string | null = null // chaîne entre apostrophes en cours
  let escaped = false
  let token = ''

  const value = (t: string): SqlValue => {
    if (t === 'NULL') return null
    if (!NUMBER.test(t)) throw new Error(`Valeur inattendue pour ${table} : ${t}`)
    return Number(t)
  }

  for await (const raw of lines) {
    let i = 0
    if (!inInsert) {
      if (schema) {
        const column = /^\s*`([^`]+)`/.exec(raw)
        if (column) schema.push(column[1])
        else if (raw.startsWith(')')) {
          if (schema.join() !== columns.join()) throw new Error(`Colonnes inattendues pour ${table} : ${schema.join(', ')}`)
          schema = null
          checked = true
        }
        continue
      }
      if (raw.startsWith(create)) schema = []
      if (schema || !raw.startsWith('INSERT')) continue
      // `INSERT IGNORE …` ou `INSERT INTO \`page\` (colonnes) VALUES` : sauter ces lignes rendrait 0 ligne sans erreur.
      if (!raw.startsWith(insert)) {
        if (raw.includes(`\`${table}\``)) throw new Error(`Format INSERT inattendu pour ${table}`)
        continue
      }
      if (!checked) throw new Error(`CREATE TABLE absent pour ${table}`)
      inInsert = true
      i = insert.length
    }
    // La fin de ligne est un blanc hors chaîne ; mysqldump échappe les sauts de ligne des chaînes.
    const line = raw + '\n'
    for (; i < line.length; i++) {
      const c = line[i]
      if (str !== null) {
        if (escaped) {
          str += ESCAPES[c] ?? c
          escaped = false
        } else if (c === '\\') escaped = true
        else if (c === "'") {
          tuple!.push(str)
          str = null
        } else {
          let j = i + 1
          while (j < line.length && line[j] !== '\\' && line[j] !== "'") j++
          str += line.slice(i, j)
          i = j - 1
        }
      } else if (tuple) {
        if (c === "'") str = ''
        else if (c === ',' || c === ')') {
          if (token) tuple.push(value(token))
          token = ''
          if (c === ')') {
            if (tuple.length !== columns.length) {
              throw new Error(`Tuple de ${tuple.length} valeurs pour ${table} (${columns.length} attendues)`)
            }
            yield tuple
            tuple = null
          }
        } else if (c !== ' ' && c !== '\n') token += c
      } else if (c === '(') tuple = []
      else if (c === ';') {
        inInsert = false
        break
      }
    }
  }
  if (!checked) throw new Error(`CREATE TABLE absent pour ${table}`)
  if (inInsert) throw new Error(`Dump tronqué pour ${table}`)
}

export async function* openLines(path: string): AsyncIterable<string> {
  const file = createReadStream(path)
  const gunzip = path.endsWith('.gz') ? createGunzip() : null
  // pipeline propage une erreur de lecture ou de gzip à readline, donc à la boucle qui lit.
  const input = gunzip ? pipeline(file, gunzip, () => {}) : file
  try {
    yield* createInterface({ input, crlfDelay: Infinity })
  } finally {
    // Lecteur sorti tôt (erreur du parseur) : sans cela, une erreur de zlib plus tardive n'a plus d'écouteur.
    file.destroy()
    gunzip?.destroy()
  }
}

// pages.tsv : page_id, title (avec les `_` du dump), len ; espace 0 hors redirections, aucune valeur nulle.
async function* articles(tuples: AsyncIterable<SqlValue[]>) {
  // page_id, page_namespace, page_title, page_is_redirect, page_len : index 0, 1, 2, 3, 9 de PAGE_COLUMNS.
  for await (const t of tuples) if (t[1] === 0 && t[3] === 0) yield [t[0], t[2], t[9]]
}

export async function dumpsCommand(o: { page: string; props: string; dir: string }): Promise<{ pages: number; props: number }> {
  const pages = await writeTsv(join(o.dir, 'pages.tsv'), articles(sqlTuples(openLines(o.page), 'page')))
  // props.tsv : page_id, image|\N, qid|\N, badge (0|0.6|1), disambig (0|1) ; une ligne par page portant une propriété utile.
  const byPage = new Map<number, [number, string | null, string | null, number, number]>()
  for await (const [page, name, value] of sqlTuples(openLines(o.props), 'page_props')) {
    const badge = BADGES.get(name as string)
    if (name !== 'page_image_free' && name !== 'wikibase_item' && name !== 'disambiguation' && badge === undefined) continue
    const id = page as number
    const row = byPage.get(id) ?? [id, null, null, 0, 0]
    byPage.set(id, row)
    if (name === 'page_image_free') row[1] = value as string
    else if (name === 'wikibase_item') row[2] = value as string
    else if (name === 'disambiguation') row[4] = 1
    else row[3] = Math.max(row[3], badge!)
  }
  return { pages, props: await writeTsv(join(o.dir, 'props.tsv'), byPage.values()) }
}
