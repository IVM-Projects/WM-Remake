// `node catalog/src/cli.ts <commande> --option valeur` : point d'entrée des jobs de catalog.yml.
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { cirrusListing } from './cirrus.ts'
import { selectCommand } from './compute.ts'
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
  'cirrus-list': () => cirrusListing(),
  dumps: (v) => dumpsCommand({ page: need(v, 'page'), props: need(v, 'props'), dir: need(v, 'dir') }),
  pageviews: (v) => {
    // Options validées avant de lire stdin : sinon une option fausse attend la fin du flux.
    const dir = need(v, 'dir')
    const minLines = count(v, 'min-lines')
    return pageviewsCommand({ input: createInterface({ input: process.stdin, crlfDelay: Infinity }), dir, minLines })
  },
  select: (v) => {
    const mode = need(v, 'mode')
    if (mode !== 'full' && mode !== 'sample') throw new Error(`Option --mode invalide : ${mode} (full, sample)`)
    const rate = need(v, 'rate')
    if (!/^\d+(\.\d+)?$/.test(rate) || !(Number(rate) > 0)) throw new Error(`Option --rate invalide : ${rate}`)
    return selectCommand({ dir: need(v, 'dir'), mode, rate: Number(rate) })
  },
}

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      page: { type: 'string' }, props: { type: 'string' }, dir: { type: 'string' }, 'min-lines': { type: 'string' },
      mode: { type: 'string' }, rate: { type: 'string' },
    },
  })
  const name = positionals[0] ?? ''
  if (!Object.hasOwn(commands, name)) throw new Error(`Commande inconnue : ${name} (${Object.keys(commands).join(', ')})`)
  const result = await commands[name](values)
  // Rien sur stdout pour une commande sans résultat : elle peut écrire son flux sur stdout.
  if (result !== undefined) console.log(JSON.stringify(result))
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
