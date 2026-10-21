// TSV intermédiaires du pipeline : sans en-tête, `\N` = null, échappements \\ \t \n \r (Global Constraints du plan M2).
import { createReadStream, createWriteStream } from 'node:fs'
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
