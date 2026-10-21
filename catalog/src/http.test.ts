import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createClient, USER_AGENT } from './http.ts'

const URL_A = 'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q1'

beforeEach(() => {
  vi.useFakeTimers({ now: 0 })
})
afterEach(() => {
  vi.useRealTimers()
})

// Horloge et attentes simulées par les faux minuteurs de vitest : aucune vraie attente.
const sleep = vi.fn((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
beforeEach(() => sleep.mockClear())

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

// Réponses rendues dans l'ordre ; la dernière se répète.
function replies(...list: (() => Response)[]) {
  let i = 0
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    void url
    void init
    return list[Math.min(i++, list.length - 1)]()
  })
}

async function settle<T>(p: Promise<T>): Promise<T | Error> {
  const caught = p.catch((err: Error) => err)
  await vi.runAllTimersAsync()
  return caught
}

test.each([429, 503])('%i avec retry-after: 2 → attente de 2 s, puis le corps ; User-Agent et gzip', async (status) => {
  const fetchImpl = replies(() => json({}, status, { 'retry-after': '2' }), () => json({ ok: 1 }))
  const result = await settle(createClient({ fetchImpl, sleep }).get(URL_A))
  expect(result).toEqual({ ok: 1 })
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000])
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  const headers = new Headers(fetchImpl.mock.calls[0][1]?.headers)
  expect(headers.get('user-agent')).toBe(USER_AGENT)
  expect(headers.get('accept-encoding')).toBe('gzip')
  expect(USER_AGENT).toBe('WMRCatalog/1.0 (https://github.com/IVM-Projects/wm-remake) node/24')
})

test('429 sans en-tête trois fois → 5 s, 10 s, 20 s', async () => {
  const fetchImpl = replies(() => json({}, 429), () => json({}, 429), () => json({}, 429), () => json({ ok: 1 }))
  expect(await settle(createClient({ fetchImpl, sleep }).get(URL_A))).toEqual({ ok: 1 })
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 10000, 20000])
})

test('maxlag hors du compte des nouvelles tentatives, au moins 5 s, jusqu’à 30 min cumulées', async () => {
  const lag = (ra: string) => () => json({ error: { code: 'maxlag', info: 'Waiting for db: 6 seconds lagged' } }, 200, { 'retry-after': ra })
  const twelve = replies(...Array.from({ length: 12 }, () => lag('5')), () => json({ ok: 1 }))
  expect(await settle(createClient({ fetchImpl: twelve, sleep }).get(URL_A))).toEqual({ ok: 1 })
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(Array(12).fill(5000))

  sleep.mockClear()
  const endless = replies(lag('1'))
  const err = await settle(createClient({ fetchImpl: endless, sleep }).get(URL_A))
  expect(err).toEqual(new Error(`Wikimedia : maxlag persistant sur ${URL_A}`))
  expect(sleep.mock.calls.every(([ms]) => ms === 5000)).toBe(true)
  expect(sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0)).toBe(30 * 60_000)
})

test('une autre erreur dans un corps 200 est rejetée tout de suite', async () => {
  const fetchImpl = replies(() => json({ error: { code: 'toomanyvalues', info: 'Too many values' } }))
  const err = await settle(createClient({ fetchImpl, sleep }).get(URL_A))
  expect(err).toEqual(new Error(`Wikimedia : toomanyvalues sur ${URL_A}`))
  expect(sleep).not.toHaveBeenCalled()
})

test('9 refus 429 → abandon après 8 nouvelles tentatives, attente plafonnée à 120 s ; 404 → rejet immédiat', async () => {
  const refused = replies(() => json({}, 429))
  const err = await settle(createClient({ fetchImpl: refused, sleep }).get(URL_A))
  expect(err).toEqual(new Error(`Wikimedia : abandon après 8 nouvelles tentatives (429) sur ${URL_A}`))
  expect(refused).toHaveBeenCalledTimes(9)
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 10000, 20000, 40000, 80000, 120000, 120000, 120000])

  sleep.mockClear()
  const missing = replies(() => new Response('Not Found', { status: 404 }))
  expect(await settle(createClient({ fetchImpl: missing, sleep }).get(URL_A))).toEqual(
    new Error(`Wikimedia : HTTP 404 sur ${URL_A}`),
  )
  expect(missing).toHaveBeenCalledTimes(1)
  expect(sleep).not.toHaveBeenCalled()
})

test('10 appels lancés ensemble → jamais plus de requêtes en vol que permis', async () => {
  for (const [concurrency, expected] of [[undefined, 3], [1, 1]] as const) {
    const hung = vi.fn(() => new Promise<Response>(() => {}))
    const client = createClient({ fetchImpl: hung, sleep, concurrency })
    for (let i = 0; i < 10; i++) void client.get(`${URL_A}${i}`)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(hung).toHaveBeenCalledTimes(expected)
  }

  // Réponses après 1 s : la place libérée passe à l'appel suivant ; une seconde vague arrive en cours de route.
  let inFlight = 0
  let peak = 0
  const slow = vi.fn(async () => {
    peak = Math.max(peak, ++inFlight)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    inFlight--
    return json({ ok: 1 })
  })
  const client = createClient({ fetchImpl: slow, sleep })
  const first = Array.from({ length: 10 }, (_, i) => client.get(`${URL_A}${i}`))
  await vi.advanceTimersByTimeAsync(1500)
  const second = Array.from({ length: 5 }, (_, i) => client.get(`${URL_A}b${i}`))
  const all = await settle(Promise.all([...first, ...second]))
  expect(all).toEqual(Array(15).fill({ ok: 1 }))
  expect(slow).toHaveBeenCalledTimes(15)
  expect(peak).toBe(3)
})

test('perMinute: 2 → démarrages à 0, 30 s et 60 s ; options invalides refusées', async () => {
  const starts: number[] = []
  const fetchImpl = vi.fn(async () => {
    starts.push(Date.now())
    return json({ ok: 1 })
  })
  const client = createClient({ fetchImpl, sleep, perMinute: 2 })
  await settle(Promise.all([client.get(`${URL_A}1`), client.get(`${URL_A}2`), client.get(`${URL_A}3`)]))
  expect(starts).toEqual([0, 30_000, 60_000])

  expect(() => createClient({ concurrency: 0 })).toThrow('Client Wikimedia : concurrency et perMinute doivent être > 0')
  expect(() => createClient({ perMinute: 0 })).toThrow('Client Wikimedia : concurrency et perMinute doivent être > 0')
})
