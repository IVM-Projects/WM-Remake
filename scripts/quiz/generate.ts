// Générateur de banques (C12, C14, D:543-547) : la file par wm.quiz_next, une requête à la fois vers l'amont compatible OpenAI
// (OmniRoute, ou le faux serveur), validation par zod, écriture par wm.quiz_store (revalidée en SQL) ou échec par wm.quiz_fail.
// Journal : une ligne JSON par carte et le résumé, jamais un énoncé, une option, une evidence ni un corps de réponse (dépôt public).
// Lu aussi par vitest et par le contrat : la CLI ne tourne que lancée directement. Imports relatifs en .ts seulement.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createClient as createDb } from '@supabase/supabase-js'
import { parseExtracts } from '../../catalog/src/extracts.ts'
import { createClient, USER_AGENT } from '../../catalog/src/http.ts'
import { messages, PROMPT_VERSION, REQUEST } from './prompt.ts'
import { RULES, validate, type Question, type Rule } from './schema.ts'

export type QueueCard = { card_id: string; page_id: number | null; title: string; category: string | null; summary: string | null; rarity: string }
export type Summary = { cards: number; stored: number; failed: number; skipped: number; rejected: Partial<Record<Rule, number>>;
  stopped: null | 'quota' | 'deadline' | 'network' }
type Options = { baseUrl: string; apiKey?: string; max: number; deadlineMin: number; minGapS: number; dryRun: boolean;
  text: 'extracts' | 'summary'; input?: QueueCard[]; store?: { url: string; key: string }; log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>; fetchImpl?: typeof fetch }

// Erreur dont le message est un code (store, extracts…), seul imprimé par la CLI.
export class Fatal extends Error {}

// Page entière, sans exintro (C12).
const EXTRACT = 'https://fr.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&maxlag=5&prop=extracts&explaintext=1&pageids='
const MAX_TEXT = 4000
// Coupé en fin de phrase à 4 000 caractères au plus.
const cut = (t: string) => t.length <= MAX_TEXT ? t : (/^[\s\S]*[.!?…](?=\s|$)/.exec(t.slice(0, MAX_TEXT))?.[0] ?? t.slice(0, MAX_TEXT))

// Issue d'une requête amont : questions (null : réponse 2xx illisible), arrêt du run, ou échec amont (la carte reste en file).
type Reply = { kind: 'ok'; questions: unknown[] | null; model: string | null } | { kind: 'stop' } | { kind: 'fail' }

export async function run(o: Options): Promise<Summary> {
  const log = o.log ?? ((line: string) => console.log(line))
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const fetchImpl = o.fetchImpl ?? fetch
  const summary: Summary = { cards: 0, stored: 0, failed: 0, skipped: 0, rejected: {}, stopped: null }
  const end = Date.now() + o.deadlineMin * 60_000
  const wiki = createClient({ fetchImpl, sleep })
  const db = o.store && createDb(o.store.url, o.store.key, { auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchImpl } }).schema('wm')
  // Toute erreur de la base, hors refus de quiz_store, arrête le run ; rien de PostgREST n'est gardé.
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    if (!db) throw new Fatal('store')
    const { data, error } = await db.rpc(fn, args)
    if (error) throw Object.assign(new Fatal('store'), { pg: error })
    return data as unknown
  }
  // Vrai si la banque est écrite, faux sur un refus de quiz_store (400 et rule, C20).
  async function store(card: QueueCard, model: string | null, kept: Question[]): Promise<boolean> {
    try {
      await rpc('quiz_store', { p_card_id: card.card_id, p_prompt_version: PROMPT_VERSION, p_model: model, p_questions: kept })
      return true
    } catch (e) {
      const pg = (e as { pg?: { code?: string; details?: string | null } }).pg
      let d: { status?: unknown; rule?: unknown } = {}
      try {
        d = JSON.parse(pg?.details ?? '')
      } catch {}
      if (pg?.code === 'P0001' && d.status === 400 && typeof d.rule === 'string') return false
      throw e
    }
  }

  let lastStart = -Infinity
  async function ask(card: QueueCard, text: string, refusals?: string[]): Promise<Reply> {
    const body = JSON.stringify({ messages: messages(card, text, refusals), ...REQUEST })
    for (let waited = false; ; waited = true) {
      const wait = lastStart + o.minGapS * 1000 - Date.now()
      if (wait > 0) await sleep(wait)
      lastStart = Date.now()
      let res: Response
      let answer: string
      try {
        // Sans délai, undici attend 300 s : une carte entamée avant l'échéance finit avant la fin du job.
        res = await fetchImpl(`${o.baseUrl}/chat/completions`, { method: 'POST', body, signal: AbortSignal.timeout(120_000), headers: {
          'content-type': 'application/json', 'user-agent': USER_AGENT, ...(o.apiKey && { authorization: `Bearer ${o.apiKey}` }) } })
        answer = await res.text()
      } catch {
        return { kind: 'fail' }
      }
      if (res.ok) {
        let model: string | null = null
        try {
          const b = JSON.parse(answer) as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> }
          model = typeof b.model === 'string' ? b.model : null
          const q = (JSON.parse(String(b.choices?.[0]?.message?.content)) as { questions?: unknown }).questions
          return { kind: 'ok', questions: Array.isArray(q) ? q : [q], model }
        } catch {
          // Une erreur d'analyse devient la règle json, sans son message (V8 y cite le début de la réponse).
          return { kind: 'ok', questions: null, model }
        }
      }
      // Retry-After en secondes seulement, attendu une fois s'il tient en 60 s.
      const after = /^\d+$/.test(res.headers.get('retry-after') ?? '') ? Number(res.headers.get('retry-after')) : undefined
      if (res.status === 429 && !waited && after !== undefined && after <= 60) {
        await sleep(after * 1000)
        continue
      }
      if (res.status === 429) return { kind: 'stop' }
      if (res.status === 503) {
        let type: unknown
        try {
          type = (JSON.parse(answer) as { error?: { type?: unknown } }).error?.type
        } catch {}
        // Disjoncteur d'OmniRoute (C12).
        if (type === 'provider_error') return { kind: 'stop' }
      }
      return { kind: 'fail' }
    }
  }

  async function textOf(card: QueueCard): Promise<string> {
    if (o.text === 'summary' || card.page_id === null) return cut(card.summary ?? '')
    let pages: { page_id: number; extract: string }[]
    try {
      pages = parseExtracts(await wiki.get(EXTRACT + card.page_id))
    } catch {
      throw new Fatal('extracts')
    }
    return cut(pages[0]?.extract ?? card.summary ?? '')
  }

  const add = (into: Partial<Record<Rule, number>>, from: Partial<Record<Rule, number>>) => {
    for (const [r, n] of Object.entries(from) as [Rule, number][]) into[r] = (into[r] ?? 0) + n
  }
  // Règle la plus refusée ; à égalité, la première de RULES ; sans refus, count (C12).
  const top = (r: Partial<Record<Rule, number>>) => RULES.reduce<Rule | 'count'>((best, x) =>
    (r[x] ?? 0) > (best === 'count' ? 0 : r[best] ?? 0) ? x : best, 'count')
  const fail = (card: QueueCard, reason: string) => o.dryRun ? undefined : rpc('quiz_fail', { p_card_id: card.card_id, p_reason: reason })

  // Avec input et sans base (smoke), aucune connexion ; sinon la file (quiz_next en remet en file même en dry run, C12).
  const list = db ? ((await rpc('quiz_next', { p_limit: o.max })) as QueueCard[]) : (o.input ?? []).slice(0, Math.max(o.max, 0))
  summary.cards = list.length
  let failures = 0
  for (const card of list) {
    if (Date.now() >= end) {
      summary.stopped = 'deadline'
      break
    }
    const t0 = Date.now()
    const line = (ok: boolean, kept: number, rejected: Partial<Record<Rule, number>>, model: string | null) =>
      log(JSON.stringify({ card_id: card.card_id, ok, kept, rejected, model, ms: Date.now() - t0 }))
    const text = await textOf(card)
    const ctx = { title: card.title, text }
    if (text.length < 200) {
      summary.skipped++
      await fail(card, 'short_text')
      line(false, 0, {}, null)
      continue
    }
    const rejected: Partial<Record<Rule, number>> = {}
    let kept: Question[] = []
    let model: string | null = null
    let stop = false
    let upstreamFailed = false
    // Premier essai, puis un seul nouvel essai sous 6 questions, validé sur la suite des deux (la règle duplicate joue entre eux).
    for (const attempt of [1, 2]) {
      if (attempt === 2 && kept.length >= 6) break
      const reply = await ask(card, text, attempt === 2 ? Object.keys(rejected) : undefined)
      if (reply.kind === 'stop') {
        summary.stopped = 'quota'
        stop = true
        break
      }
      if (reply.kind === 'fail') {
        upstreamFailed = true
        break
      }
      failures = 0
      model = reply.model
      const v = reply.questions ? validate([...kept, ...reply.questions], ctx) : { kept, rejected: { json: 1 } }
      kept = v.kept
      add(rejected, v.rejected)
    }
    if (stop) break
    if (upstreamFailed) {
      line(false, 0, {}, null)
      if (++failures === 3) {
        summary.stopped = 'network'
        break
      }
      continue
    }
    add(summary.rejected, rejected)
    if (kept.length >= 3) {
      const stored = o.dryRun || (await store(card, model, kept))
      if (stored) summary.stored++
      else {
        add(rejected, { store: 1 })
        add(summary.rejected, { store: 1 })
        summary.failed++
        await fail(card, 'store')
      }
      line(stored, kept.length, rejected, model)
    } else {
      summary.failed++
      await fail(card, top(rejected))
      line(false, kept.length, rejected, model)
    }
  }
  log(JSON.stringify({ summary }))
  return summary
}

// Options de la CLI : --max entier de 0 à 1 500 (250 seulement si absent), --deadline-min 50, --min-gap-s 30, --text extracts.
export function cliOptions(argv: string[]): Omit<Options, 'input' | 'store' | 'apiKey'> & { input?: string } {
  let v
  try {
    v = parseArgs({ args: argv, options: { 'base-url': { type: 'string' }, max: { type: 'string' }, 'deadline-min': { type: 'string' },
      'min-gap-s': { type: 'string' }, text: { type: 'string' }, input: { type: 'string' }, 'dry-run': { type: 'boolean' } } }).values
  } catch {
    throw new Fatal('usage')
  }
  const int = (s: string | undefined, fallback: number) => {
    if (s === undefined) return fallback
    if (!/^\d+$/.test(s)) throw new Fatal('usage')
    return Number(s)
  }
  const text = v.text ?? 'extracts'
  if (text !== 'extracts' && text !== 'summary') throw new Fatal('usage')
  return { baseUrl: v['base-url'] ?? '', max: Math.min(int(v.max, 250), 1500), deadlineMin: int(v['deadline-min'], 50),
    minGapS: int(v['min-gap-s'], 30), text, input: v.input, dryRun: v['dry-run'] ?? false }
}

async function main(): Promise<number> {
  const { input, ...o } = cliOptions(process.argv.slice(2))
  // --input sans --dry-run lirait quand même la vraie file, écritures comprises.
  if (!o.baseUrl || (input !== undefined && !o.dryRun)) throw new Fatal('usage')
  let cards: QueueCard[] | undefined
  if (input !== undefined) {
    try {
      cards = JSON.parse(readFileSync(input, 'utf8')) as QueueCard[]
    } catch {
      throw new Fatal('input')
    }
  }
  // La base n'est lue que hors de --input --dry-run (job smoke, sans secret).
  let store: Options['store']
  if (!cards) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SECRET_KEY
    if (!url || !key) throw new Fatal('env')
    store = { url, key }
  }
  const s = await run({ ...o, input: cards, store, apiKey: process.env.OMNIROUTE_KEY || undefined })
  if (s.stopped === 'quota') process.stderr.write('::warning::Quota de l\'amont atteint : run arrêté, les cartes restantes attendent le prochain.\n')
  return s.stopped === 'network' ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main().catch((e: unknown) => {
    console.log(JSON.stringify({ fatal: e instanceof Fatal ? e.message : 'internal' }))
    return 1
  })
}
