// `node catalog/src/cli.ts <commande> --option valeur` : point d'entrée des jobs de catalog.yml.
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { cirrusCommand, cirrusListing } from './cirrus.ts'
import { commonsCommand } from './commons.ts'
import { computeCommand, selectCommand } from './compute.ts'
import type { Mode } from './compute.ts'
import { fetchCommand, pickCommand, readmeCommand, sliceCirrusCommand, slicePageviewsCommand, sliceSqlCommand } from './fixtures.ts'
import { createClient } from './http.ts'
import { loadCommand } from './load.ts'
import { pageviewsCommand } from './pageviews.ts'
import { dumpsCommand } from './sqldump.ts'
import { wikidataCommand } from './wikidata.ts'

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

// Jour réel en YYYY-MM-DD : Date reporte le 30 février au 2 mars, que \copy refuserait seulement au chargement.
function day(v: Values, name: string): string {
  const value = matching(v, name, /^\d{4}-\d{2}-\d{2}$/)
  const t = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(t.getTime()) || !t.toISOString().startsWith(value)) throw new Error(`Option --${name} invalide : ${value}`)
  return value
}

// Entier ≥ 1, `fallback` si l'option manque.
function positive(v: Values, name: string, fallback: number): number {
  const value = count(v, name) ?? fallback
  if (value < 1) throw new Error(`Option --${name} invalide : ${v[name]}`)
  return value
}

// Commandes reprenables : débit et parallélisme du client (P16 : le job les abaisse), délai sous le timeout du job.
function resumable(v: Values) {
  const dir = need(v, 'dir')
  const client = createClient({ perMinute: positive(v, 'per-minute', 200), concurrency: positive(v, 'concurrency', 3) })
  return { dir, client, deadlineMin: count(v, 'deadline-min') ?? 330 }
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
    const o = { dir: need(v, 'dir'), part: matching(v, 'part', /^[\w.-]+$/), mode: mode(v) }
    // readline créé au premier tour de boucle, après la lecture de catalog.tsv : créé avant, il perdrait des lignes.
    const input = (async function* () {
      yield* createInterface({ input: process.stdin, crlfDelay: Infinity })
    })()
    return cirrusCommand({ ...o, input })
  },
  commons: (v) => commonsCommand(resumable(v)),
  compute: (v) => {
    const textSource = need(v, 'text-source')
    if (textSource !== 'cirrus' && textSource !== 'extracts') throw new Error(`Option --text-source invalide : ${textSource} (cirrus, extracts)`)
    return computeCommand({
      dir: need(v, 'dir'),
      out: need(v, 'out'),
      mode: mode(v),
      month: matching(v, 'month', /^\d{4}-(0[1-9]|1[0-2])$/),
      textDate: day(v, 'text-date'),
      textSource,
      client: createClient(),
    })
  },
  dumps: (v) => dumpsCommand({ page: need(v, 'page'), props: need(v, 'props'), dir: need(v, 'dir') }),
  load: (v) => {
    const target = need(v, 'target')
    if (target !== 'free' && target !== 'pro') throw new Error(`Option --target invalide : ${target} (free, pro)`)
    // --db jamais cité dans un message : l'URL porte le mot de passe.
    return loadCommand({ dir: need(v, 'dir'), mode: mode(v), target, db: need(v, 'db'), batch: positive(v, 'batch', 10_000) })
  },
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
  wikidata: (v) => wikidataCommand(resumable(v)),
  'fixtures pick': (v) => pickCommand({ dir: need(v, 'dir'), fixtures: need(v, 'fixtures') }),
  'fixtures slice-sql': (v) =>
    sliceSqlCommand({ page: need(v, 'page'), props: need(v, 'props'), dir: need(v, 'dir'), fixtures: need(v, 'fixtures') }),
  'fixtures slice-pageviews': (v) => slicePageviewsCommand({ fixtures: need(v, 'fixtures'), input: process.stdin }),
  'fixtures slice-cirrus': (v) => sliceCirrusCommand({ fixtures: need(v, 'fixtures'), input: process.stdin, output: process.stdout }),
  'fixtures fetch': (v) => {
    if (v.only !== undefined && v.only !== 'extracts') throw new Error(`Option --only invalide : ${v.only} (extracts)`)
    return fetchCommand({ dir: need(v, 'dir'), fixtures: need(v, 'fixtures'), client: createClient(), only: v.only })
  },
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
      'per-minute': { type: 'string' }, concurrency: { type: 'string' }, 'deadline-min': { type: 'string' },
      only: { type: 'string' }, out: { type: 'string' }, 'text-date': { type: 'string' }, 'text-source': { type: 'string' },
      target: { type: 'string' }, db: { type: 'string' }, batch: { type: 'string' },
    },
  })
  const name = positionals.join(' ') // `fixtures pick` : commande en deux mots
  if (!Object.hasOwn(commands, name)) throw new Error(`Commande inconnue : ${name} (${Object.keys(commands).join(', ')})`)
  const result = await commands[name](values)
  // Rien sur stdout pour une commande sans résultat : elle peut écrire son flux sur stdout.
  if (result !== undefined) console.log(JSON.stringify(result))
  // Commande reprenable coupée par --deadline-min : code 3, le run suivant reprend depuis le cache de catalog.yml.
  if ((result as { finished?: boolean } | undefined)?.finished === false) {
    console.error('Délai atteint : reprendre au prochain run')
    process.exit(3)
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  // Arrêt net : les requêtes encore en file ne doivent pas continuer après l'échec.
  process.exit(1)
}
