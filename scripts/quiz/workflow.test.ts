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
const steps = stepsOf(block(yml, 'jobs:'))
const probe = block(yml, '  probe:')
const own = stepsOf(probe)
const at = (needle: string) => own.findIndex((s) => s.includes(needle))
const MODELS = at('https://api.mistral.ai/v1/models')
const LAUNCH = at('omniroute.sh')
const GATE = at('127.0.0.1:20128/v1/chat/completions')
const DIAG = at('https://api.mistral.ai/v1/chat/completions')

// Contexte des secrets (GitHub ignore la casse), hors `steps.secrets.`, la sortie de l'étape de contrôle d'id `secrets`.
const secretCtx = (t: string) => /\bsecrets\b/i.test(t.replaceAll('steps.secrets.', ''))
// Trace du shell : `set` ou `bash` avec une option groupée qui contient x, ou xtrace sous toute forme.
const trace = /\b(set|bash)\s+-[A-Za-z]*x|xtrace/i
// Options de curl qui impriment des en-têtes ou le dialogue, seules ou groupées (-v, -i, -D ; -sSv, -vsS, -sSi…).
const noisy = /(?<![\w-])-[A-Za-z]*[viD]|--verbose|--include|--dump-header|--trace/
// Seules lectures permises d'un fichier de sortie : ces champs, par jq -r ou -er.
const fieldReads = [
  `'.data[].id'`,
  `'.model'`,
  String.raw`'(.error.message // "sans message" | tostring | gsub("[\r\n]+"; " ")) + (if .upstream_details then " [source : amont]" else " [source : ?]" end)'`,
  String.raw`'.message // .error.message // .detail // "" | tostring | gsub("[\r\n]+"; " ")'`,
]

test('les règles de trace et d’options bavardes attrapent les formes groupées, et pas les options sûres', () => {
  for (const s of [
    'set -x',
    'set -xe',
    'set -euxo pipefail',
    'set -xeuo pipefail',
    'set -Eeux',
    'bash -xe omniroute.sh',
    'shell: bash -xeo pipefail {0}',
    'set -o xtrace',
    'SHELLOPTS=xtrace',
  ])
    expect(s).toMatch(trace)
  for (const s of [
    'set -euo pipefail',
    'set -o pipefail',
    'shell: bash # -eo pipefail',
    'bash -n scripts/quiz/omniroute.sh',
    'bash --noprofile --norc -eo pipefail {0}',
  ])
    expect(s).not.toMatch(trace)
  for (const s of ['curl -v', 'curl -sSv', 'curl -vsS', 'curl -sSi', 'curl -D - -sS', 'curl --verbose', 'curl -sS --include'])
    expect(s).toMatch(noisy)
  for (const s of [
    `curl -sS --max-time 30 --retry 1 --retry-delay 30 -o "$out" -w '%{http_code}' -H 'Content-Type: application/json'`,
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

test('permissions : contents: read seul ; QUIZ_MODEL dans l’env de tête, repli ministral-14b-latest', () => {
  expect(yml.match(/permissions:/g)).toHaveLength(1)
  expect(block(yml, 'permissions:').filter((l) => l.trim())).toEqual(['permissions:', '  contents: read'])
  expect(
    block(yml, 'env:').some((l) => l.startsWith("  QUIZ_MODEL: ${{ vars.QUIZ_MODEL || 'ministral-14b-latest' }}")),
  ).toBe(true)
})

test('chaque actions/checkout porte persist-credentials: false', () => {
  const checkouts = steps.filter((s) => s.includes('actions/checkout'))
  expect(checkouts.length).toBeGreaterThan(0)
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

test('/v1/models : relance d’un échec passager, indice sur 401/403, réponse illisible signalée', () => {
  const s = own[MODELS]
  expect(s).toMatch(/\$\(curl [^\n]*--retry 1 --retry-delay 30 [^\n]*https:\/\/api\.mistral\.ai\/v1\/models/)
  expect(s).toContain(`401 | 403) hint=" : recrée la clé avec l'accès API (console.mistral.ai)"`)
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

test('probe : aucune étape n’imprime un corps ni un en-tête ; chaque curl est borné et un 000 passe par le test du code', () => {
  for (const s of own) {
    expect(s).not.toMatch(/\b(cat|head|tail|less|more|tee)\b/)
    expect(s).not.toMatch(noisy)
    const rest = s
      .replace(/out="\$RUNNER_TEMP\/\w+\.json"/g, '')
      .replace(/(rm -f|-o) "\$out"/g, '')
      .replace(/jq -e?r ('[^']*') "\$out"/g, (m, expr: string) => (fieldReads.includes(expr) ? '' : m))
    expect(rest).not.toContain('$out')
    expect(rest).not.toContain('RUNNER_TEMP')
  }
  const curls = own.join('\n').match(/\$\(curl [^\n]*/g) ?? []
  expect(curls).toHaveLength(3)
  for (const c of curls) {
    expect(c).toContain('--max-time')
    expect(c).toMatch(/\|\| true\)$/)
  }
})

test('aucune étape qui appelle omniroute.sh ne contient 20128 ni generate.ts', () => {
  const launches = steps.filter((s) => s.includes('omniroute.sh'))
  expect(launches.length).toBeGreaterThan(0)
  for (const s of launches) {
    expect(s).not.toContain('20128')
    expect(s).not.toContain('generate.ts')
  }
})
