// TSV intermédiaires du pipeline : sans en-tête, `\N` = null, échappements \\ \t \n \r (Global Constraints du plan M2).
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { readFile, truncate } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream/promises'

export type Field = string | number | null

const ESCAPE: Record<string, string> = { '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' }
const UNESCAPE: Record<string, string> = { '\\': '\\', t: '\t', n: '\n', r: '\r' }

export const tsvLine = (fields: Field[]): string =>
  fields.map((f) => (f === null ? '\\N' : String(f).replace(/[\\\t\n\r]/g, (c) => ESCAPE[c]))).join('\t')

export const parseTsvLine = (line: string): (string | null)[] =>
  line.split('\t').map((f) => (f === '\\N' ? null : f.replace(/\\(.)/g, (_, c: string) => UNESCAPE[c] ?? c)))

export async function* readTsv(path: string): AsyncGenerator<(string | null)[]> {
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) yield parseTsvLine(line)
}

export async function writeTsv(
  path: string,
  rows: Iterable<Field[]> | AsyncIterable<Field[]>,
  opts: { append?: boolean } = {},
): Promise<number> {
  let n = 0
  await pipeline(async function* () {
    for await (const row of rows) {
      n++
      yield tsvLine(row) + '\n'
    }
  }, createWriteStream(path, { flags: opts.append ? 'a' : 'w' }))
  return n
}

// Ids (1re colonne) d'un TSV écrit en ajout par une commande reprenable ; vide s'il n'existe pas. Une dernière ligne sans
// `\n` (run tué, disque plein) est d'abord coupée : relue, elle compterait comme écrite et l'ajout suivant s'y collerait.
// shortcut: relit tout le fichier pour trouver le dernier `\n`, lire la fin par blocs si le mode full (M8) pèse trop.
export async function writtenIds(path: string): Promise<Set<string>> {
  const ids = new Set<string>()
  if (!existsSync(path)) return ids
  const bytes = await readFile(path)
  const end = bytes.lastIndexOf(0x0a) + 1
  if (end < bytes.length) await truncate(path, end)
  for await (const f of readTsv(path)) ids.add(String(f[0]))
  return ids
}
