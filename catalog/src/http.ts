// Client des API Wikimedia (Wikidata, Commons, frwiki) : concurrence, débit, échecs passagers, ralentissement, maxlag
// (Global Constraints, P16, M2-R3).
export const USER_AGENT = 'WMRCatalog/1.0 (https://github.com/IVM-Projects/wm-remake) node/24'

export type Client = { get(url: string): Promise<unknown> }

const TIMEOUT_MS = 60_000
const BUDGET_MS = 30 * 60_000 // par requête, pour le ralentissement (429, 503 avec Retry-After) comme pour maxlag
const MAX_WAIT_MS = 15 * 60_000
const TRANSIENT = new Set([500, 502, 503, 504])
const backoff = (k: number) => Math.min(5000 * 2 ** k, 120_000)

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
    let retries = 0 // échecs passagers (réseau, délai, corps coupé, 5xx sans Retry-After) : comptés dans maxRetries
    let throttles = 0
    const left = { throttle: BUDGET_MS, maxlag: BUDGET_MS }

    async function transient(what: string, cause?: unknown) {
      if (retries >= maxRetries) {
        throw new Error(`Wikimedia : abandon après ${maxRetries} nouvelles tentatives (${what}) sur ${url}`, { cause })
      }
      await sleep(backoff(retries++))
    }
    // Attente demandée par le serveur : hors maxRetries, ≤ 15 min, prise sur un budget de 30 min. Une attente qui ne
    // tient plus dans le budget arrête tout de suite, plutôt que de relancer avant l'heure dite par le serveur.
    async function serverWait(kind: 'throttle' | 'maxlag', ms: number, message: string) {
      const wait = Math.min(ms, MAX_WAIT_MS)
      if (wait > left[kind]) throw new Error(message)
      left[kind] -= wait
      await sleep(wait)
    }

    for (;;) {
      await startSlot()
      let res: Response
      let text = ''
      try {
        const init = { headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(TIMEOUT_MS) }
        res = await fetchImpl(url, init)
        if (res.ok) text = await res.text()
        else await res.body?.cancel()
      } catch (cause) {
        await transient('réseau', cause)
        continue
      }
      const ra = retryAfterMs(res)
      if (res.status === 429 || (res.status === 503 && ra !== undefined)) {
        // Retry-After: 0 (ou absent) → attente croissante : une attente nulle ne prendrait rien au budget et bouclerait sans fin.
        await serverWait('throttle', ra || backoff(throttles++), `Wikimedia : ralentissement persistant (${res.status}) sur ${url}`)
        continue
      }
      if (TRANSIENT.has(res.status)) {
        await transient(String(res.status))
        continue
      }
      if (!res.ok) throw new Error(`Wikimedia : HTTP ${res.status} sur ${url}`)
      let body: { error?: { code?: string; info?: string } } | null
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`Wikimedia : réponse illisible sur ${url}`)
      }
      const error = body?.error
      if (error?.code === 'maxlag') {
        await serverWait('maxlag', Math.max(ra ?? 0, 5000), `Wikimedia : maxlag persistant sur ${url}`)
        continue
      }
      if (error) throw new Error(`Wikimedia : ${error.code ?? error.info ?? 'erreur inconnue'} sur ${url}`)
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

// Valeurs d'une URL de batchUrls (dernier paramètre) : la reprise sait quels ids un lot couvre.
export const batchValues = (url: string): string[] => url.slice(url.lastIndexOf('=') + 1).split('%7C').map(decodeURIComponent)

// Délai d'un job en minutes depuis l'appel ; sans `deadlineMin`, jamais atteint.
export function deadline(o: { deadlineMin?: number; now?: () => number }): () => boolean {
  const now = o.now ?? Date.now
  const end = now() + (o.deadlineMin ?? Infinity) * 60_000
  return () => now() >= end
}

// Lots demandés 3 à la fois (plafond des requêtes en vol ; le client borne concurrence et débit) tant que le délai
// n'est pas atteint ; chaque corps passe à `onBody` dès son arrivée. Rend false si des lots restent.
export async function fetchBatches(
  client: Client,
  urls: string[],
  late: () => boolean,
  onBody: (url: string, body: unknown) => Promise<void>,
): Promise<boolean> {
  let next = 0
  async function worker() {
    while (next < urls.length && !late()) {
      const url = urls[next++]
      await onBody(url, await client.get(url))
    }
  }
  await Promise.all([worker(), worker(), worker()])
  return next === urls.length
}
