// `node catalog/src/cli.ts <commande> --option valeur` : point d'entrée des jobs de catalog.yml.
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { cirrusCommand, cirrusListing } from './cirrus.ts'
import { selectCommand } from './compute.ts'
import type { Mode } from './compute.ts'
import { fetchCommand, pickCommand, readmeCommand, sliceCirrusCommand, slicePageviewsCommand, sliceSqlCommand } from './fixtures.ts'
import { createClient } from './http.ts'
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

function matching(v: Values, name: string, format: RegExp): string {
  const value = need(v, name)
  if (!format.test(value)) throw new Error(`Option --${name} invalide : ${value}`)
  return value
}

function mode(v: Values): Mode {
  const value = need(v, 'mode')
  if (value !== 'full' && value !== 'sample') throw new Error(`Option --mode invalide : ${value} (full, sample)`)
  return value
}

const commands: Record<string, (v: Values) => Promise<unknown>> = {
  'cirrus-list': () => cirrusListing(),
  cirrus: (v) => {
    // Options validées avant de lire stdin, comme pour pageviews ; part sans « / » : text-<part>.tsv reste dans --dir.
    const o = { dir: need(v, 'dir'), part: matching(v, 'part', /^\w+$/), mode: mode(v) }
    // readline créé au premier tour de boucle, après la lecture de catalog.tsv : créé avant, il perdrait des lignes.
    const input = (async function* () {
      yield* createInterface({ input: process.stdin, crlfDelay: Infinity })
    })()
    return cirrusCommand({ ...o, input })
  },
  dumps: (v) => dumpsCommand({ page: need(v, 'page'), props: need(v, 'props'), dir: need(v, 'dir') }),
  pageviews: (v) => {
    // Options validées avant de lire stdin : sinon une option fausse attend la fin du flux.
    const dir = need(v, 'dir')
    const minLines = count(v, 'min-lines')
    return pageviewsCommand({ input: createInterface({ input: process.stdin, crlfDelay: Infinity }), dir, minLines })
  },
  select: (v) => {
    const m = mode(v)
    const rate = need(v, 'rate')
    if (!/^\d+(\.\d+)?$/.test(rate) || !(Number(rate) > 0)) throw new Error(`Option --rate invalide : ${rate}`)
    return selectCommand({ dir: need(v, 'dir'), mode: m, rate: Number(rate) })
  },
  'fixtures pick': (v) => pickCommand({ dir: need(v, 'dir'), fixtures: need(v, 'fixtures') }),
  'fixtures slice-sql': (v) =>
    sliceSqlCommand({ page: need(v, 'page'), props: need(v, 'props'), dir: need(v, 'dir'), fixtures: need(v, 'fixtures') }),
  'fixtures slice-pageviews': (v) => slicePageviewsCommand({ fixtures: need(v, 'fixtures'), input: process.stdin }),
  'fixtures slice-cirrus': (v) => sliceCirrusCommand({ fixtures: need(v, 'fixtures'), input: process.stdin, output: process.stdout }),
  'fixtures fetch': (v) => fetchCommand({ dir: need(v, 'dir'), fixtures: need(v, 'fixtures'), client: createClient() }),
  'fixtures readme': (v) =>
    readmeCommand({
      fixtures: need(v, 'fixtures'),
      month: matching(v, 'month', /^\d{4}-(0[1-9]|1[0-2])$/),
      cirrusDate: matching(v, 'cirrus-date', /^\d{8}$/),
      dumpDate: matching(v, 'dump-date', /^\d{4}-\d{2}-\d{2}$/),
    }),
}

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      page: { type: 'string' }, props: { type: 'string' }, dir: { type: 'string' }, 'min-lines': { type: 'string' },
      mode: { type: 'string' }, rate: { type: 'string' }, fixtures: { type: 'string' }, month: { type: 'string' },
      'cirrus-date': { type: 'string' }, 'dump-date': { type: 'string' }, part: { type: 'string' },
    },
  })
  const name = positionals.join(' ') // `fixtures pick` : commande en deux mots
  if (!Object.hasOwn(commands, name)) throw new Error(`Commande inconnue : ${name} (${Object.keys(commands).join(', ')})`)
  const result = await commands[name](values)
  // Rien sur stdout pour une commande sans résultat : elle peut écrire son flux sur stdout.
  if (result !== undefined) console.log(JSON.stringify(result))
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  // Arrêt net : les requêtes encore en file ne doivent pas continuer après l'échec.
  process.exit(1)
}
