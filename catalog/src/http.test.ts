import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createClient, deadline, fetchBatches, USER_AGENT } from './http.ts'
import type { Client } from './http.ts'

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

test('une autre erreur dans un corps 200 est rejetée tout de suite ; sans code → info, puis « erreur inconnue »', async () => {
  const fetchImpl = replies(() => json({ error: { code: 'toomanyvalues', info: 'Too many values' } }))
  const err = await settle(createClient({ fetchImpl, sleep }).get(URL_A))
  expect(err).toEqual(new Error(`Wikimedia : toomanyvalues sur ${URL_A}`))
  expect(sleep).not.toHaveBeenCalled()

  const info = replies(() => json({ error: { info: 'Bad request' } }))
  expect(await settle(createClient({ fetchImpl: info, sleep }).get(URL_A))).toEqual(new Error(`Wikimedia : Bad request sur ${URL_A}`))
  const bare = replies(() => json({ error: {} }))
  expect(await settle(createClient({ fetchImpl: bare, sleep }).get(URL_A))).toEqual(
    new Error(`Wikimedia : erreur inconnue sur ${URL_A}`),
  )
})

test('fetch rejeté deux fois (réseau), puis 200 → résolu ; chaque requête porte un délai', async () => {
  const fetchImpl = replies(
    () => {
      throw new TypeError('fetch failed')
    },
    () => {
      throw new TypeError('fetch failed')
    },
    () => json({ ok: 1 }),
  )
  expect(await settle(createClient({ fetchImpl, sleep }).get(URL_A))).toEqual({ ok: 1 })
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 10000])
  for (const [, init] of fetchImpl.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal)
})

test('délai dépassé et corps coupé comptent comme des échecs réseau', async () => {
  const timeout = replies(() => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  }, () => json({ ok: 1 }))
  expect(await settle(createClient({ fetchImpl: timeout, sleep }).get(URL_A))).toEqual({ ok: 1 })
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5000])

  sleep.mockClear()
  const cut = () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"ok"'))
          c.error(new TypeError('terminated'))
        },
      }),
      { status: 200 },
    )
  const cutBody = replies(cut, () => json({ ok: 1 }))
  expect(await settle(createClient({ fetchImpl: cutBody, sleep }).get(URL_A))).toEqual({ ok: 1 })
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5000])
})

test('200 qui n’est pas du JSON → « réponse illisible », sans nouvelle tentative', async () => {
  const fetchImpl = replies(() => new Response('<html>Erreur</html>', { status: 200 }))
  expect(await settle(createClient({ fetchImpl, sleep }).get(URL_A))).toEqual(new Error(`Wikimedia : réponse illisible sur ${URL_A}`))
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  expect(sleep).not.toHaveBeenCalled()
})

test('500, 502, 503 et 504 sans Retry-After → réessayés (5 s doublées), puis OK', async () => {
  const fetchImpl = replies(() => json({}, 502), () => json({}, 503), () => json({}, 504), () => json({}, 500), () => json({ ok: 1 }))
  expect(await settle(createClient({ fetchImpl, sleep }).get(URL_A))).toEqual({ ok: 1 })
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 10000, 20000, 40000])
})

test('9 échecs passagers → abandon après 8 nouvelles tentatives, attente plafonnée à 120 s ; 404 → rejet immédiat', async () => {
  const failing = replies(() => json({}, 500))
  const err = await settle(createClient({ fetchImpl: failing, sleep }).get(URL_A))
  expect(err).toEqual(new Error(`Wikimedia : abandon après 8 nouvelles tentatives (500) sur ${URL_A}`))
  expect(failing).toHaveBeenCalledTimes(9)
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 10000, 20000, 40000, 80000, 120000, 120000, 120000])

  const offline = replies(() => {
    throw new TypeError('fetch failed')
  })
  expect(await settle(createClient({ fetchImpl: offline, sleep }).get(URL_A))).toEqual(
    new Error(`Wikimedia : abandon après 8 nouvelles tentatives (réseau) sur ${URL_A}`),
  )

  sleep.mockClear()
  const missing = replies(() => new Response('Not Found', { status: 404 }))
  expect(await settle(createClient({ fetchImpl: missing, sleep }).get(URL_A))).toEqual(
    new Error(`Wikimedia : HTTP 404 sur ${URL_A}`),
  )
  expect(missing).toHaveBeenCalledTimes(1)
  expect(sleep).not.toHaveBeenCalled()
})

test('rafale de 429 hors des 8 tentatives : Retry-After respecté, budget de 30 min, attente ≤ 15 min', async () => {
  const throttled = (ra: string) => () => json({}, 429, { 'retry-after': ra })
  const storm = replies(...Array.from({ length: 20 }, () => throttled('23')), () => json({ ok: 1 }))
  expect(await settle(createClient({ fetchImpl: storm, sleep }).get(URL_A))).toEqual({ ok: 1 })
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(Array(20).fill(23_000))

  sleep.mockClear()
  const endless = replies(throttled('23'))
  expect(await settle(createClient({ fetchImpl: endless, sleep }).get(URL_A))).toEqual(
    new Error(`Wikimedia : ralentissement persistant (429) sur ${URL_A}`),
  )
  // 78 attentes de 23 s tiennent dans les 30 min ; la 79e n'y tient plus : arrêt sans relance anticipée.
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(Array(78).fill(23_000))

  sleep.mockClear()
  const zero = replies(throttled('0'))
  expect(await settle(createClient({ fetchImpl: zero, sleep }).get(URL_A))).toEqual(
    new Error(`Wikimedia : ralentissement persistant (429) sur ${URL_A}`),
  )
  const zeroWaits = sleep.mock.calls.map(([ms]) => ms)
  expect(zeroWaits.slice(0, 4)).toEqual([5_000, 10_000, 20_000, 40_000])
  expect(zeroWaits.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(30 * 60_000)

  sleep.mockClear()
  const hour = replies(throttled('3600'))
  expect(await settle(createClient({ fetchImpl: hour, sleep }).get(URL_A))).toEqual(
    new Error(`Wikimedia : ralentissement persistant (429) sur ${URL_A}`),
  )
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([15 * 60_000, 15 * 60_000])
})

test('un appel rejeté rend sa place : 4 appels, le premier reçoit un 404, les 4 démarrent', async () => {
  let i = 0
  const fetchImpl = vi.fn(() => (i++ === 0 ? Promise.resolve(new Response('', { status: 404 })) : new Promise<Response>(() => {})))
  const client = createClient({ fetchImpl, sleep })
  const first = client.get(`${URL_A}0`).catch((err: Error) => err)
  for (let n = 1; n < 4; n++) void client.get(`${URL_A}${n}`)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await first).toEqual(new Error(`Wikimedia : HTTP 404 sur ${URL_A}0`))
  expect(fetchImpl).toHaveBeenCalledTimes(4)
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

test('fetchBatches : une requête sans réponse est abandonnée à l’échéance, rien pour son lot ; minuteurs effacés', async () => {
  const got: string[] = []
  const client: Client = { get: (url) => (url === 'b' ? new Promise(() => {}) : Promise.resolve({ url })) }
  const run = fetchBatches(client, ['a', 'b', 'c', 'd'], deadline({ deadlineMin: 1 }), async (url) => void got.push(url))
  await vi.advanceTimersByTimeAsync(59_999)
  expect(got).toEqual(['a', 'c', 'd'])
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(await run).toBe(false)
  expect(got).toEqual(['a', 'c', 'd'])
  expect(vi.getTimerCount()).toBe(0)

  // Échéance passée : aucun appel ; tout servi avant : true.
  const get = vi.fn(client.get)
  expect(await fetchBatches({ get }, ['a'], deadline({ deadlineMin: 0 }), async () => {})).toBe(false)
  expect(get).not.toHaveBeenCalled()
  expect(await fetchBatches({ get }, ['a', 'c'], deadline({ deadlineMin: 1 }), async () => {})).toBe(true)
  expect(vi.getTimerCount()).toBe(0)

  // Sans délai : une réponse au bout d'une heure arrive (un setTimeout au-delà de 2^31 - 1 ms partirait à 1 ms).
  const slow: Client = { get: () => new Promise((resolve) => setTimeout(resolve, 3600_000, { ok: 1 })) }
  const patient = fetchBatches(slow, ['x'], deadline({}), async (url) => void got.push(url))
  await vi.advanceTimersByTimeAsync(3600_000)
  expect(await patient).toBe(true)
  expect(got).toContain('x')
})

test('fetchBatches : une réponse avec `continue` arrête tout, rien pour son lot', async () => {
  const got: string[] = []
  for (const more of [{ iicontinue: 'x', continue: '||' }, { excontinue: 20, continue: '||' }, { iistart: 't', iicontinue: 'x' }]) {
    const client: Client = { get: async () => ({ continue: more, query: { pages: [] } }) }
    await expect(fetchBatches(client, ['u'], deadline({}), async (url) => void got.push(url))).rejects.toThrow(
      'Wikimedia : réponse incomplète (continue) sur u',
    )
  }
  expect(got).toEqual([])
})

test('fetchBatches : `continue` fait de iistart seul (versions anciennes d’un titre seul) passe à onBody', async () => {
  const body = { continue: { iistart: '2006-03-07T15:51:32Z', continue: '||' }, query: { pages: [{ title: 'File:A.jpg' }] } }
  const got: unknown[] = []
  expect(await fetchBatches({ get: async () => body }, ['u'], deadline({}), async (url, b) => void got.push([url, b]))).toBe(true)
  expect(got).toEqual([['u', body]])
})
