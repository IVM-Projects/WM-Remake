// Faux serveur compatible OpenAI (C13, D:550) : des questions valides construites à partir du texte reçu, ce qui éprouve toute la
// validation sans réponse en conserve. Sert le contrat (port choisi par l'OS) et le job smoke de quiz-bank.yml (127.0.0.1:18090).
// Lu aussi par node : imports relatifs en .ts seulement.
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { norm, type Question } from './schema.ts'

const MODES = ['ok', 'junk', 'rate_limit', 'error', 'unauthorized'] as const
type Mode = (typeof MODES)[number]
const DISTRACTORS = ['royaume', 'machine', 'tribunal', 'monastère', 'cathédrale', 'festival', 'parlement', 'vaisseau', 'jardinier',
  'horloge', 'faucille', 'boussole']
// Phrases, comme wm.quiz_sentences.
const SENTENCE = /(?<=[^\p{Lu}][.!?…])\s+(?!\p{Ll})/u

// Une question par phrase de 40 à 150 caractères, 8 au plus : un mot de 6 lettres ou plus, absent de l'énoncé masqué et du titre, et
// différent des autres réponses ; 3 distracteurs absents du texte ; evidence = la phrase.
export function fakeQuestions(text: string, title: string): Question[] {
  const t = norm(text)
  const ti = norm(title)
  const decoys = DISTRACTORS.filter((d) => !t.includes(norm(d))).slice(0, 3)
  const out: Question[] = []
  if (decoys.length < 3) return out
  for (const s of text.split(SENTENCE).map((x) => x.trim())) {
    if (out.length === 8) break
    if ([...s].length < 40 || [...s].length > 150) continue
    for (const w of s.match(/\p{L}{6,}/gu) ?? []) {
      const n = norm(w)
      const prompt = `Quel mot complète la phrase : « ${s.replace(w, '____')} » ?`
      if (norm(prompt).includes(n) || ti.includes(n) || (ti && n.includes(ti)) || out.some((q) => norm(q.options[q.correct]) === n)) continue
      const k = out.length % 4
      out.push({ prompt, options: [...decoys.slice(0, k), w, ...decoys.slice(k)], correct: k, evidence: s })
      break
    }
  }
  return out
}

// Le texte entre <article> et </article> du dernier message user, et le titre de ce message (jamais le message entier : evidence_source
// rejetterait tout).
function questionsFor(body: string): Question[] {
  const messages = (JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? []
  const user = String(messages.findLast((m) => m.role === 'user')?.content ?? '')
  return fakeQuestions(/<article>\n([\s\S]*)\n<\/article>/.exec(user)?.[1] ?? '', /^Titre : (.*)$/m.exec(user)?.[1] ?? '')
}

export async function startFakeUpstream(o: { mode?: Mode; port?: number } = {}): Promise<{ url: string; calls: () => number;
  close: () => Promise<void> }> {
  const mode = o.mode ?? 'ok'
  let calls = 0
  const server = createServer((req, res) => {
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      void res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
    if (req.method === 'GET' && req.url === '/v1/models') return json(200, { data: [{ id: 'fake-quiz' }] })
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(404, { error: { code: 'not_found' } })
    let body = ''
    req.setEncoding('utf8').on('data', (chunk: string) => (body += chunk))
    req.on('end', () => {
      calls++
      // Comme OmniRoute, avant tout routage.
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(415, { error: { code: 'unsupported_media_type' } })
      if (mode === 'rate_limit') return json(429, { error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } }, { 'retry-after': '120' })
      if (mode === 'error') return json(500, { error: { message: 'Internal error', type: 'server_error' } })
      if (mode === 'unauthorized') return json(401, { error: { message: 'Unauthorized', type: 'authentication_error', code: 'invalid_api_key' } })
      let qs: Question[]
      try {
        qs = questionsFor(body)
      } catch {
        return json(400, { error: { code: 'invalid_json' } })
      }
      // junk : le JSON précédé d'un mot, que JSON.parse refuse en citant le début de la réponse.
      const content = `${mode === 'junk' ? 'Voici : ' : ''}${JSON.stringify({ questions: qs })}`
      json(200, { id: `chatcmpl-${calls}`, object: 'chat.completion', model: 'fake-quiz',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] })
    })
  })
  await new Promise<void>((resolve) => server.listen(o.port ?? 0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    calls: () => calls,
    close: () => new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { port: { type: 'string', default: '18090' }, mode: { type: 'string', default: 'ok' } } })
    const port = Number(values.port)
    if (!(MODES as readonly string[]).includes(values.mode) || !Number.isInteger(port)) throw new Error()
    const { url } = await startFakeUpstream({ mode: values.mode as Mode, port })
    console.log(`fake-upstream ${values.mode} : ${url}/v1`)
  } catch {
    process.stderr.write('usage : node scripts/quiz/fake-upstream.ts --port 18090 [--mode ok|junk|rate_limit|error|unauthorized]\n')
    process.exit(1)
  }
}
