import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { fakeQuestions, startFakeUpstream } from './fake-upstream.ts'
import { cliOptions, run, type QueueCard } from './generate.ts'
import { RULES, type Question } from './schema.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
// 6 fiches de catalog/fixtures/expected/cards.csv : textes de Wikipédia sous CC BY-SA 4.0 (sources dans catalog/fixtures/README.md).
const cards = JSON.parse(readFileSync(new URL('./fixtures/cards.json', import.meta.url), 'utf8')) as QueueCard[]
const base = { apiKey: 'cle', max: 250, deadlineMin: 5, minGapS: 0, text: 'summary' as const, dryRun: true }
const quiet = { log: () => {}, sleep: async () => {} }
const store = { url: 'http://base.test', key: 'cle' }
const card = cards[0]
const qs = fakeQuestions(card.summary ?? '', card.title)

type Mode = 'ok' | 'junk' | 'rate_limit' | 'error' | 'unauthorized'
async function withFake<T>(mode: Mode, f: (fake: Awaited<ReturnType<typeof startFakeUpstream>>) => Promise<T>): Promise<T> {
  const fake = await startFakeUpstream({ mode })
  try {
    return await f(fake)
  } finally {
    await fake.close()
  }
}

const completion = (content: string) => Response.json({ id: 'x', object: 'chat.completion', model: 'fake-quiz',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] })
const questions = (list: Question[]) => completion(JSON.stringify({ questions: list }))

// fetchImpl d'essai : l'amont rend `replies` dans l'ordre (500 au-delà) ; la base factice sert quiz_next = [card] et note chaque appel
// RPC (`rpc` peut en remplacer la réponse) ; Wikipédia rend `extract` pour la page de card.
function stub(o: { replies?: Array<() => Response>; card?: QueueCard; extract?: string; rpc?: (fn: string) => Response | undefined }) {
  const rpc: Array<{ fn: string; args: unknown }> = []
  const upstream: RequestInit[] = []
  const wiki: string[] = []
  const replies = [...(o.replies ?? [])]
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    const fn = /\/rest\/v1\/rpc\/(\w+)$/.exec(url)?.[1]
    if (fn) {
      rpc.push({ fn, args: JSON.parse(String(init.body)) })
      return o.rpc?.(fn) ?? Response.json(fn === 'quiz_next' ? [o.card] : { ok: true })
    }
    if (url.startsWith('https://fr.wikipedia.org/')) {
      wiki.push(url)
      return Response.json({ batchcomplete: true, query: { pages: [{ pageid: o.card?.page_id, extract: o.extract }] } })
    }
    upstream.push(init)
    return (replies.shift() ?? (() => new Response('{}', { status: 500 })))()
  }) as typeof fetch
  return { fetchImpl, rpc, upstream, wiki }
}

test('ok, 3 cartes, dry run → 3 banques, un nouvel essai sous 6 questions (ses doublons comptés), aucune écriture', () =>
  withFake('ok', async (fake) => {
    const n = cards.slice(0, 3).map((c) => fakeQuestions(c.summary ?? '', c.title).length)
    expect(n.slice(0, 2)).toEqual([6, 6])
    const s = await run({ ...base, ...quiet, baseUrl: `${fake.url}/v1`, input: cards.slice(0, 3) })
    expect(s).toEqual({ cards: 3, stored: 3, failed: 0, skipped: 0, rejected: n[2] < 6 ? { duplicate: n[2] } : {}, stopped: null })
    expect(fake.calls()).toBe(n[2] < 6 ? 4 : 3)
  }))

test('junk → un nouvel essai par carte, puis échec, json compté', () => withFake('junk', async (fake) => {
  const s = await run({ ...base, ...quiet, baseUrl: `${fake.url}/v1`, input: cards.slice(0, 2) })
  expect(s).toEqual({ cards: 2, stored: 0, failed: 2, skipped: 0, rejected: { json: 4 }, stopped: null })
  expect(fake.calls()).toBe(4)
}))

test('rate_limit (Retry-After 120) → quota après un appel, aucune attente de plus de 60 s', () => withFake('rate_limit', async (fake) => {
  const sleep = vi.fn(async (ms: number) => void ms)
  const s = await run({ ...base, log: () => {}, sleep, baseUrl: `${fake.url}/v1`, input: cards.slice(0, 3) })
  expect(s).toMatchObject({ stored: 0, failed: 0, stopped: 'quota' })
  expect(fake.calls()).toBe(1)
  expect(sleep.mock.calls.filter(([ms]) => ms > 60_000)).toEqual([])
}))

test('429 à Retry-After 5 → attendu une fois, puis un second 429 → quota', async () => {
  const limited = () => new Response('{}', { status: 429, headers: { 'retry-after': '5' } })
  const { fetchImpl, upstream } = stub({ replies: [limited, limited] })
  const sleep = vi.fn(async (ms: number) => void ms)
  const s = await run({ ...base, log: () => {}, sleep, baseUrl: 'http://amont.test/v1', input: [card], fetchImpl })
  expect([s.stopped, upstream.length, sleep.mock.calls]).toEqual(['quota', 2, [[5000]]])
})

test.each([['provider_error', 'quota'], ['service_unavailable', null]])('503 de type %s (disjoncteur d\'OmniRoute) → stopped %s',
  async (type, stopped) => {
    const { fetchImpl } = stub({ replies: [() => Response.json({ error: { type } }, { status: 503 })] })
    expect((await run({ ...base, ...quiet, baseUrl: 'http://amont.test/v1', input: [card], fetchImpl })).stopped).toBe(stopped)
  })

test.each(['error', 'unauthorized'] as const)('%s, quatre cartes → network après trois appels, rien de compté', (mode) =>
  withFake(mode, async (fake) => {
    const s = await run({ ...base, ...quiet, baseUrl: `${fake.url}/v1`, input: cards.slice(0, 4) })
    expect(s).toEqual({ cards: 4, stored: 0, failed: 0, skipped: 0, rejected: {}, stopped: 'network' })
    expect(fake.calls()).toBe(3)
  }))

test('un 2xx remet à zéro le compte des échecs amont', async () => {
  const fail = () => new Response('{}', { status: 500 })
  const ok = (c: QueueCard) => () => questions(fakeQuestions(c.summary ?? '', c.title))
  const { fetchImpl } = stub({ replies: [fail, fail, ok(cards[0]), fail, fail, ok(cards[1])] })
  const input = [cards[2], cards[3], cards[0], cards[4], cards[5], cards[1]]
  const s = await run({ ...base, ...quiet, baseUrl: 'http://amont.test/v1', input, fetchImpl })
  expect(s).toMatchObject({ cards: 6, stored: 2, failed: 0, stopped: null })
})

test('nouvel essai (C12) : 4 questions valides puis 2 autres → deux appels, une banque de 6', async () => {
  expect(qs.length).toBeGreaterThanOrEqual(6)
  const { fetchImpl, upstream } = stub({ replies: [() => questions(qs.slice(0, 4)), () => questions(qs.slice(4, 6))] })
  const lines: string[] = []
  const s = await run({ ...base, ...quiet, baseUrl: 'http://amont.test/v1', input: [card], fetchImpl, log: (l) => lines.push(l) })
  expect(upstream).toHaveLength(2)
  expect(s).toMatchObject({ cards: 1, stored: 1, failed: 0 })
  expect(JSON.parse(lines[0])).toMatchObject({ card_id: card.card_id, ok: true, kept: 6, model: 'fake-quiz' })
})

test('nouvel essai : 2 questions valides et une mal formée, puis une réponse illisible → quiz_fail(json), première des règles à égalité',
  async () => {
  const bad = { ...qs[2], correct: 4 }
  const { fetchImpl, upstream, rpc } = stub({ card, replies: [() => questions([...qs.slice(0, 2), bad]), () => completion('pas du JSON')] })
  const s = await run({ ...base, ...quiet, dryRun: false, store, baseUrl: 'http://amont.test/v1', fetchImpl })
  expect(upstream).toHaveLength(2)
  expect(s).toMatchObject({ cards: 1, stored: 0, failed: 1, rejected: { json: 1, shape: 1 } })
  expect(rpc).toEqual([{ fn: 'quiz_next', args: { p_limit: 250 } }, { fn: 'quiz_fail', args: { p_card_id: card.card_id, p_reason: 'json' } }])
})

test('nouvel essai coupé par un 429 sans Retry-After → quota, ni quiz_store ni quiz_fail', async () => {
  const { fetchImpl, rpc } = stub({ card, replies: [() => questions(qs.slice(0, 4)), () => new Response('{}', { status: 429 })] })
  const s = await run({ ...base, ...quiet, dryRun: false, store, baseUrl: 'http://amont.test/v1', fetchImpl })
  expect(s).toMatchObject({ stored: 0, failed: 0, stopped: 'quota' })
  expect(rpc.map((r) => r.fn)).toEqual(['quiz_next'])
})

test('écriture : quiz_store reçoit les 6 questions gardées, PROMPT_VERSION et le model du corps ; un refus (400 et rule) → quiz_fail(store)',
  async () => {
    const six = () => questions(qs.slice(0, 6))
    const first = stub({ card, replies: [six] })
    expect(await run({ ...base, ...quiet, dryRun: false, store, baseUrl: 'http://amont.test/v1', fetchImpl: first.fetchImpl }))
      .toMatchObject({ stored: 1, failed: 0 })
    expect(first.rpc[1]).toEqual({ fn: 'quiz_store', args: { p_card_id: card.card_id, p_prompt_version: 1, p_model: 'fake-quiz',
      p_questions: qs.slice(0, 6) } })
    const refusal = () => Response.json({ code: 'P0001', message: 'Banque de questions invalide', hint: null,
      details: JSON.stringify({ status: 400, code: 'invalid_request', error: 'Banque de questions invalide', rule: 'answer_is_title' }) },
    { status: 400 })
    const second = stub({ card, replies: [six], rpc: (fn) => (fn === 'quiz_store' ? refusal() : undefined) })
    expect(await run({ ...base, ...quiet, dryRun: false, store, baseUrl: 'http://amont.test/v1', fetchImpl: second.fetchImpl }))
      .toMatchObject({ stored: 0, failed: 1, rejected: { store: 1 } })
    expect(second.rpc.map((r) => r.args)).toContainEqual({ p_card_id: card.card_id, p_reason: 'store' })
  })

test('max 0 → résumé à zéro, aucun appel ; cliOptions : --max 0, défaut 250, plafond 1 500', () => withFake('ok', async (fake) => {
  const s = await run({ ...base, ...quiet, max: 0, baseUrl: `${fake.url}/v1`, input: cards.slice(0, 3) })
  expect(s).toEqual({ cards: 0, stored: 0, failed: 0, skipped: 0, rejected: {}, stopped: null })
  expect(fake.calls()).toBe(0)
  expect(cliOptions(['--base-url', 'u', '--max', '0']).max).toBe(0)
  expect(cliOptions(['--base-url', 'u']).max).toBe(250)
  expect(cliOptions(['--max', '9999']).max).toBe(1500)
  expect(() => cliOptions(['--max', 'dix'])).toThrow('usage')
}))

test('texte de 150 caractères → skipped et quiz_fail(short_text), aucun appel amont', async () => {
  const short = { ...card, summary: 'Une phrase courte. '.repeat(8).slice(0, 150) }
  const { fetchImpl, upstream, rpc } = stub({ card: short })
  const s = await run({ ...base, ...quiet, dryRun: false, store, baseUrl: 'http://amont.test/v1', fetchImpl })
  expect(s).toMatchObject({ cards: 1, skipped: 1, stored: 0, failed: 0 })
  expect(upstream).toEqual([])
  expect(rpc[1]).toEqual({ fn: 'quiz_fail', args: { p_card_id: card.card_id, p_reason: 'short_text' } })
})

test('extrait de 5 000 caractères → texte envoyé de 4 000 au plus, fini par un point', async () => {
  const extract = 'Cette phrase d\'essai, assez longue, remplit le texte de l\'article. '.repeat(80).slice(0, 5000)
  const page = { ...card, page_id: 4242 }
  const { fetchImpl, upstream, wiki } = stub({ card: page, extract, replies: [() => questions(qs)] })
  await run({ ...base, ...quiet, text: 'extracts', baseUrl: 'http://amont.test/v1', input: [page], fetchImpl })
  expect(wiki).toEqual(['https://fr.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&maxlag=5&prop=extracts'
    + '&explaintext=1&pageids=4242'])
  const user = (JSON.parse(String(upstream[0].body)) as { messages: Array<{ content: string }> }).messages.at(-1)?.content ?? ''
  const article = /<article>\n([\s\S]*)\n<\/article>/.exec(user)?.[1] ?? ''
  expect(article.length).toBeLessThanOrEqual(4000)
  expect(article.length).toBeGreaterThan(3900)
  expect(article.endsWith('.')).toBe(true)
})

test('minGapS 30 → sleep(30000) entre deux appels', async () => {
  const ok = (c: QueueCard) => () => questions(fakeQuestions(c.summary ?? '', c.title))
  const { fetchImpl, upstream } = stub({ replies: [ok(cards[0]), ok(cards[1])] })
  const sleep = vi.fn(async (ms: number) => void ms)
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    await run({ ...base, log: () => {}, sleep, minGapS: 30, baseUrl: 'http://amont.test/v1', input: cards.slice(0, 2), fetchImpl })
  } finally {
    vi.useRealTimers()
  }
  expect([upstream.length, sleep.mock.calls]).toEqual([2, [[30_000]]])
})

test('corps envoyé : messages, response_format, temperature et max_tokens seuls, en application/json ; sans cet en-tête, 415',
  () => withFake('ok', async (fake) => {
    const seen: RequestInit[] = []
    const fetchImpl = ((input: string | URL | Request, init: RequestInit = {}) => {
      seen.push(init)
      return fetch(input, init)
    }) as typeof fetch
    await run({ ...base, ...quiet, baseUrl: `${fake.url}/v1`, input: [card], fetchImpl })
    expect(Object.keys(JSON.parse(String(seen[0].body))).sort()).toEqual(['max_tokens', 'messages', 'response_format', 'temperature'])
    const headers = new Headers(seen[0].headers)
    expect([headers.get('content-type'), headers.get('authorization')]).toEqual(['application/json', 'Bearer cle'])
    const res = await fetch(`${fake.url}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [] }) })
    expect([res.status, await res.json()]).toEqual([415, { error: { code: 'unsupported_media_type' } }])
  }))

// Review Focus : lignes JSON de formes connues, valeurs texte sans contenu de quiz (PF9 : valeurs de stopped comprises).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const WORDS = new Set<string>([...RULES, 'short_text', 'count', 'fake-quiz', 'quota', 'network', 'deadline', 'store', 'extracts', 'input',
  'env', 'usage', 'internal'])
const SHAPES = [['card_id', 'kept', 'model', 'ms', 'ok', 'rejected'], ['summary'], ['fatal']]
const strings = (v: unknown): string[] => typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []
function expectClean(lines: string[]) {
  expect(lines.length).toBeGreaterThan(0)
  for (const line of lines) {
    const o = JSON.parse(line) as Record<string, unknown>
    expect(SHAPES, line).toContainEqual(Object.keys(o).sort())
    const s = (o.summary ?? o) as Record<string, unknown>
    if (o.summary) expect(Object.keys(s).sort(), line).toEqual(['cards', 'failed', 'rejected', 'skipped', 'stopped', 'stored'])
    for (const t of [...strings(s), ...Object.keys(s.rejected ?? {})]) expect(UUID.test(t) || WORDS.has(t), `${t} dans ${line}`).toBe(true)
  }
}

test('Review Focus, journaux : ok, junk, error et quiz_store en erreur — rien d\'autre que des lignes JSON sans contenu', async () => {
  const out: string[] = []
  const keep = (...a: unknown[]) => void out.push(...a.map(String).join(' ').split('\n').filter(Boolean))
  const spies = [vi.spyOn(console, 'log').mockImplementation(keep), vi.spyOn(console, 'error').mockImplementation(keep),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      keep(chunk)
      return true
    })]
  try {
    for (const mode of ['ok', 'junk', 'error'] as const) {
      await withFake(mode, (fake) => run({ ...base, sleep: async () => {}, baseUrl: `${fake.url}/v1`, input: cards.slice(0, 3),
        log: (l) => keep(l) }))
    }
    const broken = stub({ card, replies: [() => questions(qs)], rpc: (fn) => (fn === 'quiz_store'
      ? Response.json({ code: 'XX000', message: 'boom', details: 'détail', hint: null }, { status: 500 }) : undefined) })
    await expect(run({ ...base, sleep: async () => {}, dryRun: false, store, baseUrl: 'http://amont.test/v1', fetchImpl: broken.fetchImpl,
      log: (l) => keep(l) })).rejects.toThrow('store')
  } finally {
    for (const s of spies) s.mockRestore()
  }
  expectClean(out)
})

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => void execFile(process.execPath, ['scripts/quiz/generate.ts', ...args],
    { cwd: root, env: { NODE_ENV: 'test', PATH: process.env.PATH, NODE_NO_WARNINGS: '1', OMNIROUTE_KEY: 'cle' } },
    (e, stdout, stderr) => resolve({ code: e ? Number(e.code) : 0, stdout, stderr })))
}

test('CLI sans secret de base : quota → dernière ligne summary, ::warning:: sur stderr, sortie 0 ; --input absent → {"fatal":"input"} seul, '
  + 'sortie 1 ; --input sans --dry-run → {"fatal":"usage"}', () => withFake('rate_limit', async (fake) => {
  const r = await cli(['--base-url', `${fake.url}/v1`, '--input', 'scripts/quiz/fixtures/cards.json', '--text', 'summary', '--max', '5',
    '--min-gap-s', '0', '--dry-run'])
  expect(r.code).toBe(0)
  const lines = r.stdout.trim().split('\n')
  expectClean(lines)
  expect(JSON.parse(lines.at(-1) ?? '')).toEqual({ summary: { cards: 5, stored: 0, failed: 0, skipped: 0, rejected: {}, stopped: 'quota' } })
  expect(r.stderr).toMatch(/^::warning::/m)
  const f = await cli(['--base-url', `${fake.url}/v1`, '--input', 'scripts/quiz/fixtures/absent.json', '--dry-run'])
  expect([f.code, f.stdout]).toEqual([1, '{"fatal":"input"}\n'])
  const u = await cli(['--base-url', `${fake.url}/v1`, '--input', 'scripts/quiz/fixtures/cards.json'])
  expect([u.code, u.stdout, fake.calls()]).toEqual([1, '{"fatal":"usage"}\n', 1])
}), 15_000)
