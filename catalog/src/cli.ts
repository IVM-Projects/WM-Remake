// `node catalog/src/cli.ts <commande> --option valeur` : point d'entrée des jobs de catalog.yml.
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { pageviewsCommand } from './pageviews.ts'
import { dumpsCommand } from './sqldump.ts'

type Values = Record<string, string | undefined>

function need(v: Values, name: string): string {
  const value = v[name]
  if (value === undefined) throw new Error(`Option --${name} manquante`)
  return value
}

function count(v: Values, name: string): number | undefined {
  const value = v[name]
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) throw new Error(`Option --${name} invalide : ${value}`)
  return Number(value)
}

const commands: Record<string, (v: Values) => Promise<unknown>> = {
  dumps: (v) => dumpsCommand({ page: need(v, 'page'), props: need(v, 'props'), dir: need(v, 'dir') }),
  pageviews: (v) =>
    pageviewsCommand({
      input: createInterface({ input: process.stdin, crlfDelay: Infinity }),
      dir: need(v, 'dir'),
      minLines: count(v, 'min-lines'),
    }),
}

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { page: { type: 'string' }, props: { type: 'string' }, dir: { type: 'string' }, 'min-lines': { type: 'string' } },
  })
  const name = positionals[0] ?? ''
  if (!Object.hasOwn(commands, name)) throw new Error(`Commande inconnue : ${name} (${Object.keys(commands).join(', ')})`)
  console.log(JSON.stringify(await commands[name](values)))
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
