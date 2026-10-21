// Client des API Wikimedia (Wikidata, Commons, frwiki) : concurrence, débit, 429/503, maxlag (Global Constraints, P16).
export const USER_AGENT = 'WMRCatalog/1.0 (https://github.com/IVM-Projects/wm-remake) node/24'

export type Client = { get(url: string): Promise<unknown> }

const MAXLAG_BUDGET_MS = 30 * 60_000

// Retry-After en secondes seulement ; une date HTTP est ignorée (repli sur l'attente par défaut).
function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after')
  return h !== null && /^\d+$/.test(h) ? Number(h) * 1000 : undefined
}

export function createClient(o: {
  concurrency?: number
  perMinute?: number
  maxRetries?: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
} = {}): Client {
  const concurrency = o.concurrency ?? 3
  const perMinute = o.perMinute ?? 200
  const maxRetries = o.maxRetries ?? 8
  const fetchImpl = o.fetchImpl ?? fetch
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = o.now ?? Date.now
  if (!(concurrency >= 1) || !(perMinute > 0)) throw new Error('Client Wikimedia : concurrency et perMinute doivent être > 0')
  const gap = 60_000 / perMinute

  let active = 0
  const waiting: (() => void)[] = []
  let nextStart = -Infinity

  // Chaque démarrage (nouvelles tentatives comprises) réserve son créneau, `gap` ms après le précédent.
  async function startSlot() {
    const t = now()
    const at = Math.max(t, nextStart)
    nextStart = at + gap
    if (at > t) await sleep(at - t)
  }

  async function attempt(url: string): Promise<unknown> {
    let retries = 0
    let lagged = 0
    for (;;) {
      await startSlot()
      const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip' } })
      if (res.status === 429 || res.status === 503) {
        await res.body?.cancel()
        if (retries >= maxRetries) {
          throw new Error(`Wikimedia : abandon après ${maxRetries} nouvelles tentatives (${res.status}) sur ${url}`)
        }
        await sleep(retryAfterMs(res) ?? Math.min(5000 * 2 ** retries, 120_000))
        retries++
        continue
      }
      if (!res.ok) {
        await res.body?.cancel()
        throw new Error(`Wikimedia : HTTP ${res.status} sur ${url}`)
      }
      const body = (await res.json()) as { error?: { code?: string } } | null
      const code = body?.error?.code
      if (code === 'maxlag') {
        if (lagged >= MAXLAG_BUDGET_MS) throw new Error(`Wikimedia : maxlag persistant sur ${url}`)
        const wait = Math.max(retryAfterMs(res) ?? 0, 5000)
        lagged += wait
        await sleep(wait)
        continue
      }
      if (body?.error) throw new Error(`Wikimedia : ${code} sur ${url}`)
      return body
    }
  }

  return {
    async get(url) {
      if (active < concurrency) active++
      else await new Promise<void>((resolve) => waiting.push(resolve))
      try {
        return await attempt(url)
      } finally {
        // La place passe directement au suivant en file, sinon elle se libère.
        const next = waiting.shift()
        if (next) next()
        else active--
      }
    },
  }
}

// URL par lots : `max` valeurs au plus, `maxLength` caractères au plus ; valeurs encodées, jointes par `|` (`%7C`).
export function batchUrls(base: string, values: string[], max: number, maxLength = Infinity): string[] {
  const urls: string[] = []
  let url = ''
  let n = 0
  for (const value of values) {
    const part = encodeURIComponent(value)
    if (n > 0 && (n === max || url.length + 3 + part.length > maxLength)) {
      urls.push(url)
      n = 0
    }
    url = n === 0 ? base + part : `${url}%7C${part}`
    n++
  }
  if (n > 0) urls.push(url)
  return urls
}
