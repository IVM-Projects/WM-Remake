import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

// Lecture du fichier comme texte (aucune dépendance YAML) : on/permissions/env/jobs sont des blocs à indentation fixe.
const yml = readFileSync(new URL('../../.github/workflows/quiz-bank.yml', import.meta.url), 'utf8')
const sh = readFileSync(new URL('./omniroute.sh', import.meta.url), 'utf8')

// Lignes du bloc ouvert par la ligne `head` (exacte, indentation comprise) : elle, puis les lignes vides ou plus indentées.
function block(text: string, head: string): string[] {
  const ls = text.split('\n')
  const i = ls.indexOf(head)
  if (i < 0) return []
  const ind = head.search(/\S/)
  let j = i + 1
  while (j < ls.length && (ls[j].trim() === '' || ls[j].search(/\S/) > ind)) j++
  return ls.slice(i, j)
}

// Étapes d'un bloc, chacune en texte : un élément `      - ` (6 espaces) et ses lignes plus indentées, sans commentaires
// (celui qui précède une étape tomberait sinon dans la précédente).
const stepsOf = (lines: string[]) =>
  lines
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')
    .split(/\n(?=      - )/)
    .slice(1)
const job = (name: string) => block(yml, `  ${name}:`)
const JOBS = block(yml, 'jobs:').flatMap((l) => /^ {2}([\w-]+):$/.exec(l)?.[1] ?? [])
const steps = JOBS.flatMap((j) => stepsOf(job(j)))
const probe = job('probe')
const own = stepsOf(probe)
const smoke = job('smoke')
const smokeSteps = stepsOf(smoke)
const gen = job('generate')
const genSteps = stepsOf(gen)
const at = (needle: string, ss = own) => ss.findIndex((s) => s.includes(needle))
const MODELS = at('https://api.mistral.ai/v1/models')
const LAUNCH = at('omniroute.sh')
const GATE = at('127.0.0.1:20128/v1/chat/completions')
const DIAG = at('https://api.mistral.ai/v1/chat/completions')
// Première aiguille absente de `t` ou placée avant la précédente ; undefined si toutes y sont, dans l'ordre.
const misordered = (t: string, xs: string[]) => {
  let from = 0
  for (const x of xs) {
    const i = t.indexOf(x, from)
    if (i < 0) return x
    from = i + x.length
  }
  return undefined
}

// Contexte des secrets (GitHub ignore la casse), hors `steps.secrets.`, la sortie de l'étape de contrôle d'id `secrets`.
const secretCtx = (t: string) => /\bsecrets\b/i.test(t.replaceAll('steps.secrets.', ''))
// Trace du shell : `set` ou `bash` suivi, plus loin sur la ligne (hors commentaire), d'une option groupée qui contient x, ou
// xtrace sous toute forme.
const trace = /\b(set|bash)\b[^#\n]*\s-[A-Za-z]*x|xtrace/i
// Options de curl qui impriment des en-têtes ou le dialogue, seules ou groupées (-v, -i, -D ; -sSv, -vsS, -sSi…).
const noisy = /(?<![\w-])-[A-Za-z]*[viD]|--verbose|--include|--dump-header|--trace/
// Attente du faux serveur (smoke) : sa liste de modèles est jetée ; sans --retry-connrefused, un refus n'est pas relancé.
const WAIT = 'curl -fsS --retry 30 --retry-connrefused --retry-delay 1 http://127.0.0.1:18090/v1/models > /dev/null'
// Fin de l'ancien faux serveur avant la relance sur le même port (5 s au plus).
const GONE = 'for _ in {1..50}; do kill -0 "$FAKE_PID" 2> /dev/null || break; sleep 0.1; done'
const SMOKE_RUN =
  'node scripts/quiz/generate.ts --base-url http://127.0.0.1:20128/v1 --input scripts/quiz/fixtures/cards.json --text summary --max 5 --min-gap-s 0 --dry-run | tee "$out"'
const OK_READ = `tail -n 1 "$out" | jq -e '.summary.cards == 5 and .summary.stored == 5'`
const QUOTA_READ = `tail -n 1 "$out" | jq -e '.summary.stopped == "quota"'`
// Seules lectures permises d'un fichier de sortie, à la lettre, options de jq comprises : un champ du corps (probe) ; les
// lignes de generate.ts, sans contenu de quiz, montrées par tee, et le résumé lu sur la dernière (smoke).
const reads = [
  `jq -er '.data[].id' "$out"`,
  `jq -er '.model' "$out"`,
  String.raw`jq -er '(.error.message // "sans message" | tostring | gsub("[\r\n]+"; " ")) + (if .upstream_details then " [source : amont]" else " [source : ?]" end)' "$out"`,
  String.raw`jq -r '.message // .error.message // .detail // "" | tostring | gsub("[\r\n]+"; " ")' "$out"`,
  SMOKE_RUN,
  OK_READ,
  QUOTA_READ,
]

test('les règles de trace et d’options bavardes attrapent les formes groupées, et pas les options sûres', () => {
  for (const s of [
    'set -x',
    'set -xe',
    'set -euxo pipefail',
    'set -xeuo pipefail',
    'set -Eeux',
    'set -e -x',
    'set -euo pipefail -x',
    'bash -xe omniroute.sh',
    'bash -e -x omniroute.sh',
    'shell: bash -xeo pipefail {0}',
    'shell: bash --noprofile --norc -xeo pipefail {0}',
    'shell: bash --login -x {0}',
    'set -o xtrace',
    'SHELLOPTS=xtrace',
  ])
    expect(s).toMatch(trace)
  for (const s of [
    'set -e',
    'set -euo pipefail',
    'set -o pipefail',
    'shell: bash # -eo pipefail',
    'bash scripts/x.sh',
    'bash -n scripts/quiz/omniroute.sh',
    'bash --noprofile --norc -eo pipefail {0}',
  ])
    expect(s).not.toMatch(trace)
  for (const s of ['curl -v', 'curl -sSv', 'curl -vsS', 'curl -sSi', 'curl -D - -sS', 'curl --verbose', 'curl -sS --include'])
    expect(s).toMatch(noisy)
  for (const s of [
    `curl -sS --max-time 30 --retry 1 --retry-delay 30 -o "$out" -w '%{http_code}' -H 'Content-Type: application/json'`,
    WAIT,
    `jq -er '.model' "$out" 2> /dev/null`,
    `jq -cn --arg m "$model"`,
    'rm -f "$out"',
    'ministral-8b-latest mistral-small-2603',
  ])
    expect(s).not.toMatch(noisy)
})

test('image OmniRoute épinglée par digest ; ni artefact ni docker logs dans le workflow, aucune trace du shell nulle part', () => {
  expect(yml).toContain(
    'ghcr.io/diegosouzapw/omniroute:3.8.51@sha256:8bd462c9f60d8eda79329cfbb6ea7ea723505fe7721beb944f3d43835409e218',
  )
  for (const s of ['upload-artifact', 'docker logs']) expect(yml).not.toContain(s)
  expect(yml).not.toMatch(trace)
  expect(sh).not.toMatch(trace)
})

test('omniroute.sh : OmniRoute n’écoute que sur la boucle locale', () => {
  expect(sh).toContain('-e OMNIROUTE_HOSTNAME=127.0.0.1')
})

test('déclencheurs : push sur les deux chemins et workflow_dispatch, sans pull_request ; aucun concurrency à la racine', () => {
  const paths = block(block(yml, 'on:').join('\n'), '    paths:')
    .slice(1)
    .map((l) => l.trim().replace(/^- /, '').replace(/^'(.*)'$/, '$1'))
    .filter(Boolean)
  expect(paths).toEqual(['scripts/quiz/**', '.github/workflows/quiz-bank.yml'])
  expect(block(yml, 'on:')).toContain('  workflow_dispatch:')
  expect(yml).not.toContain('pull_request')
  expect(yml).not.toMatch(/^concurrency:/m)
})

test('workflow_dispatch : max (chaîne, vide) et dry_run (booléen, faux), qui dit la remise en file de quiz_next (C12)', () => {
  const inputs = block(block(yml, 'on:').join('\n'), '    inputs:').join('\n')
  const max = block(inputs, '      max:')
  const dry = block(inputs, '      dry_run:')
  for (const l of ['        type: string', "        default: ''"]) expect(max).toContain(l)
  for (const l of ['        type: boolean', '        default: false']) expect(dry).toContain(l)
  expect(dry.find((l) => l.startsWith('        description: '))).toMatch(/sans --input.*quiz_next.*seule écriture.*C12/)
})

test('permissions : contents: read seul ; QUIZ_MODEL dans l’env de tête, repli ministral-14b-latest', () => {
  expect(yml.match(/permissions:/g)).toHaveLength(1)
  expect(block(yml, 'permissions:').filter((l) => l.trim())).toEqual(['permissions:', '  contents: read'])
  expect(
    block(yml, 'env:').some((l) => l.startsWith("  QUIZ_MODEL: ${{ vars.QUIZ_MODEL || 'ministral-14b-latest' }}")),
  ).toBe(true)
})

test('chaque actions/checkout porte persist-credentials: false', () => {
  const checkouts = steps.filter((s) => s.includes('actions/checkout'))
  expect(checkouts).toHaveLength(3)
  for (const s of checkouts) expect(s).toContain('persist-credentials: false')
})

test('secrets n’apparaît, dans une expression ${{ }}, que sous l’env: d’une étape', () => {
  const ls = yml.split('\n')
  const parent = (i: number) => {
    const ind = ls[i].search(/\S/)
    let p = i - 1
    while (ls[p].trim() === '' || ls[p].trimStart().startsWith('#') || ls[p].search(/\S/) >= ind) p--
    return p
  }
  const uses = ls.flatMap((l, i) => ([...l.matchAll(/\$\{\{(.*?)\}\}/g)].some((m) => secretCtx(m[1])) ? [i] : []))
  expect(uses.length).toBeGreaterThan(0)
  for (const i of uses) {
    const env = parent(i)
    expect(ls[env], `ligne ${i + 1}`).toBe('        env:')
    expect(ls[parent(env)], `ligne ${i + 1}`).toMatch(/^ {6}- /)
  }
})

test('jobs probe, smoke et generate ; if: de job exacts, aucun sur probe ; generate après probe, sous son concurrency', () => {
  expect(JOBS).toEqual(['probe', 'smoke', 'generate'])
  const ifs = (b: string[]) => b.filter((l) => /^ {4}if:/.test(l))
  expect(ifs(probe)).toEqual([])
  expect(ifs(smoke)).toEqual(["    if: github.event_name == 'push'"])
  expect(ifs(gen)).toEqual(["    if: github.event_name != 'push' && github.ref == 'refs/heads/develop'"])
  expect(gen).toContain('    needs: probe')
  expect(smoke).toContain('    timeout-minutes: 20')
  expect(gen).toContain('    timeout-minutes: 60')
  expect(gen.join('\n')).toContain('\n    concurrency:\n      group: quiz-bank-generate\n      cancel-in-progress: false\n')
  // bash -eo pipefail : une sortie non nulle de generate.ts, même derrière tee, fait échouer l'étape.
  expect(block(yml, 'defaults:')).toContain('    shell: bash # -eo pipefail')
  expect(yml.match(/^\s*shell:/gm)).toHaveLength(1)
  expect(yml).not.toContain('continue-on-error')
})

test('probe : sans if: au niveau du job ; ordre /v1/models, omniroute.sh, garde, diagnostic', () => {
  expect(probe.length).toBeGreaterThan(0)
  expect(probe.some((l) => /^ {4}if:/.test(l))).toBe(false)
  expect(MODELS).toBeGreaterThanOrEqual(0)
  expect(LAUNCH).toBeGreaterThan(MODELS)
  expect(GATE).toBeGreaterThan(LAUNCH)
  expect(DIAG).toBeGreaterThan(GATE)
})

test('probe : le contrôle du secret d’abord (notice exacte), puis chaque étape gardée par sa sortie, le diagnostic après un échec', () => {
  const [check, ...rest] = own
  expect(check).toContain('        id: secrets\n')
  expect(check).toContain('echo "::notice::Sonde sautée : secret MISTRAL_API_KEY absent (D:1116)"')
  expect(check).toContain('echo "run=false" >> "$GITHUB_OUTPUT"')
  expect(rest.length).toBeGreaterThan(0)
  for (const s of rest) {
    const guard = s === own[DIAG] ? "failure() && steps.secrets.outputs.run == 'true'" : "steps.secrets.outputs.run == 'true'"
    expect(s).toContain(`\n        if: ${guard}\n`)
  }
})

test('/v1/models : relance d’un échec passager, indice sur 401/403 jusqu’au ::error::, réponse illisible signalée', () => {
  const s = own[MODELS]
  expect(s).toMatch(/\$\(curl [^\n]*--retry 1 --retry-delay 30 [^\n]*https:\/\/api\.mistral\.ai\/v1\/models/)
  expect(s).toContain(`401 | 403) hint=" : recrée la clé avec l'accès API (console.mistral.ai)"`)
  expect(s).toContain('echo "::error::GET https://api.mistral.ai/v1/models : HTTP $code$hint"')
  expect(s).toContain('HTTP 200, réponse illisible')
})

test('garde : complétion par la clé partagée, dans une étape après omniroute.sh, sans secret', () => {
  const s = own[GATE]
  for (const x of [
    'Content-Type: application/json',
    'Authorization: Bearer $OMNIROUTE_KEY',
    '127.0.0.1:20128/v1/chat/completions',
    '--retry 1 --retry-delay 30',
    'HTTP 200, réponse illisible',
    '[source : ?]',
  ])
    expect(s).toContain(x)
  expect(s).not.toContain('[source : OmniRoute]')
  expect(secretCtx(s)).toBe(false)
})

test('diagnostic : secret dans son env: d’étape, sans relance, un appel borné et non bloquant', () => {
  const d = own[DIAG]
  expect(d).toContain('        env:\n          MISTRAL_API_KEY: ${{ secrets.MISTRAL_API_KEY }}\n')
  expect(d).toContain('--max-time 30')
  expect(d).not.toContain('--retry')
  expect(d.match(/\$\(curl .*\|\| true\)/g)).toHaveLength(1)
})

test('aucune étape n’imprime un corps ni un en-tête : un fichier de sortie n’est lu que par les lectures permises', () => {
  for (const s of steps) {
    let rest = s
    for (const r of reads) rest = rest.replaceAll(r, '')
    rest = rest.replace(/out="\$RUNNER_TEMP\/\w+\.jsonl?"/g, '').replace(/(rm -f|-o) "\$out"/g, '')
    expect(rest).not.toMatch(/\b(cat|head|tail|less|more|tee)\b/)
    expect(rest).not.toMatch(noisy)
    expect(rest).not.toContain('$out')
    expect(rest).not.toContain('RUNNER_TEMP')
  }
})

test('chaque curl écrit sa réponse dans un fichier (-o "$out" -w code en probe, /dev/null pour l’attente de smoke), jamais sur stdout', () => {
  const curls = (ss: string[]) => ss.join('\n').match(/^.*\bcurl\b.*$/gm) ?? []
  const p = curls(own)
  expect(p).toHaveLength(3)
  for (const c of p) {
    expect(c).toMatch(/\$\(curl /)
    expect(c).toContain(`-o "$out" -w '%{http_code}'`)
    expect(c).toContain('--max-time')
    expect(c).toMatch(/\|\| true\)$/)
  }
  expect(curls(smokeSteps).map((c) => c.trim())).toEqual([WAIT, WAIT])
  expect(curls(genSteps)).toEqual([])
  for (const t of [yml, sh]) expect(t).not.toMatch(/(-o|--output)[\s=]+-(\s|$)|\/dev\/stdout|\/dev\/fd\/1\b/m)
})

test('smoke : sans secret ; faux serveur attendu, OmniRoute devant lui, une passe ok puis une passe quota contre le faux serveur relancé', () => {
  expect(secretCtx(smoke.join('\n'))).toBe(false)
  expect(['actions/checkout', 'actions/setup-node', 'npm ci'].map((x) => at(x, smokeSteps))).toEqual([0, 1, 2])
  expect(smokeSteps).toHaveLength(6)
  expect(smokeSteps[0]).toContain('persist-credentials: false')
  expect(smokeSteps[1]).toContain('node-version-file: .nvmrc')
  const launch = at('omniroute.sh', smokeSteps)
  const ok = at('.summary.stored == 5', smokeSteps)
  const quota = at('kill "$FAKE_PID"', smokeSteps)
  expect(
    misordered(smokeSteps[launch], [
      'node scripts/quiz/fake-upstream.ts --port 18090 &\n',
      'echo "FAKE_PID=$!" >> "$GITHUB_ENV"\n',
      WAIT,
      'PROVIDER_KEY=fake scripts/quiz/omniroute.sh http://127.0.0.1:18090/v1',
    ]),
  ).toBeUndefined()
  expect(ok).toBeGreaterThan(launch)
  expect(misordered(smokeSteps[ok], [`${SMOKE_RUN}\n`, OK_READ])).toBeUndefined()
  expect(quota).toBeGreaterThan(ok)
  expect(
    misordered(smokeSteps[quota], [
      'kill "$FAKE_PID"\n',
      `${GONE}\n`,
      'node scripts/quiz/fake-upstream.ts --port 18090 --mode rate_limit &\n',
      WAIT,
      `${SMOKE_RUN}\n`,
      QUOTA_READ,
    ]),
  ).toBeUndefined()
})

test('generate : checkout, setup-node, npm ci, contrôle des secrets, omniroute.sh, generate.ts, dans cet ordre', () => {
  expect(['actions/checkout', 'actions/setup-node', 'npm ci', 'id: secrets', 'omniroute.sh', 'generate.ts'].map((x) => at(x, genSteps))).toEqual(
    [0, 1, 2, 3, 4, 5],
  )
  expect(genSteps).toHaveLength(6)
  expect(genSteps[0]).toContain('persist-credentials: false')
  expect(genSteps[1]).toContain('node-version-file: .nvmrc')
  const [, , , check, launch, run] = genSteps
  expect(
    misordered(check, [
      '        id: secrets\n',
      'echo "::notice::Sonde sautée : secret MISTRAL_API_KEY absent (D:1116)"',
      'echo "run=false" >> "$GITHUB_OUTPUT"',
      'echo "::error::Secret SUPABASE_SECRET_KEY absent (Settings → Secrets and variables → Actions)"',
      'exit 1',
      'echo "run=true" >> "$GITHUB_OUTPUT"',
    ]),
  ).toBeUndefined()
  for (const s of [launch, run]) expect(s).toContain("\n        if: steps.secrets.outputs.run == 'true'\n")
  expect(launch).toContain('PROVIDER_KEY="$MISTRAL_API_KEY" scripts/quiz/omniroute.sh https://api.mistral.ai/v1')
  expect(run).toContain('          MAX_INPUT: ${{ inputs.max }}\n')
  expect(run).toContain('          QUIZ_MAX: ${{ vars.QUIZ_MAX }}\n')
  expect(run).toContain('MAX="${MAX_INPUT:-${QUIZ_MAX:-250}}"\n')
  expect(run).toContain(
    `node scripts/quiz/generate.ts --base-url http://127.0.0.1:20128/v1 --max "$MAX" --deadline-min 50 --min-gap-s "\${{ vars.QUIZ_MIN_GAP_S || 30 }}" --text extracts \${{ inputs.dry_run && '--dry-run' || '' }}\n`,
  )
  expect(yml).not.toMatch(/inputs\.max\s*\|\|/)
})

test('SUPABASE_SECRET_KEY : env: du contrôle et de generate.ts seuls ; MISTRAL_API_KEY dans generate : contrôle et omniroute.sh', () => {
  const [, , , check, launch, run] = genSteps
  expect(yml.match(/secrets\.SUPABASE_SECRET_KEY/gi)).toHaveLength(2)
  expect(steps.filter((s) => s.includes('secrets.SUPABASE_SECRET_KEY'))).toEqual([check, run])
  expect(genSteps.filter((s) => s.includes('secrets.MISTRAL_API_KEY'))).toEqual([check, launch])
  expect(secretCtx(run.replace('${{ secrets.SUPABASE_SECRET_KEY }}', ''))).toBe(false)
  for (const s of [check, launch]) expect(s).toContain('          MISTRAL_API_KEY: ${{ secrets.MISTRAL_API_KEY }}\n')
  for (const s of [check, run]) expect(s).toContain('          SUPABASE_SECRET_KEY: ${{ secrets.SUPABASE_SECRET_KEY }}\n')
})

test('une étape ne lit un secret que sous ces deux formes exactes : ni crochets, ni toJSON(secrets), ni autre secret', () => {
  for (const s of steps) {
    const rest = s.replaceAll('${{ secrets.MISTRAL_API_KEY }}', '').replaceAll('${{ secrets.SUPABASE_SECRET_KEY }}', '')
    expect([...rest.matchAll(/\$\{\{.*?\}\}/g)].map((m) => m[0]).filter(secretCtx)).toEqual([])
  }
})

// Après omniroute.sh, docker inspect livre l'environnement du conteneur (la clé) : aucun gestionnaire de paquets, qui lancerait du
// code tiers, ne tourne plus.
test('omniroute.sh : une étape par job, sans 20128 ni generate.ts ; tout appel à OmniRoute vient après, sans npm ; un seul --base-url', () => {
  for (const ss of [own, smokeSteps, genSteps]) {
    const launches = ss.filter((s) => s.includes('omniroute.sh'))
    expect(launches).toHaveLength(1)
    expect(launches[0]).not.toContain('20128')
    expect(launches[0]).not.toContain('generate.ts')
    const l = ss.indexOf(launches[0])
    ss.forEach((s, i) => {
      if (s.includes('20128') || s.includes('generate.ts')) expect(i).toBeGreaterThan(l)
    })
    for (const s of [launches[0].slice(launches[0].indexOf('omniroute.sh')), ...ss.slice(l + 1)])
      expect(s).not.toMatch(/\b(npm|npx|pnpm|yarn)\b/)
  }
  expect(yml.match(/--base-url[=\s]+\S+/g)).toEqual(Array(3).fill('--base-url http://127.0.0.1:20128/v1'))
})
