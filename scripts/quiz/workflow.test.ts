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

// Contexte `secrets.`, pas `steps.secrets.outputs` (l'étape de contrôle a pour id `secrets`).
const secretRef = /(?<![\w.])secrets\./

// Étapes d'un bloc, chacune en texte : un élément `      - ` (6 espaces) et ses lignes plus indentées, sans commentaires
// (celui qui précède une étape tomberait sinon dans la précédente).
const stepsOf = (lines: string[]) =>
  lines
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')
    .split(/\n(?=      - )/)
    .slice(1)
const steps = stepsOf(block(yml, 'jobs:'))

test('image OmniRoute épinglée par digest ; ni artefact ni docker logs dans le workflow, aucune trace du shell nulle part', () => {
  expect(yml).toContain(
    'ghcr.io/diegosouzapw/omniroute:3.8.51@sha256:8bd462c9f60d8eda79329cfbb6ea7ea723505fe7721beb944f3d43835409e218',
  )
  for (const s of ['upload-artifact', 'docker logs']) expect(yml).not.toContain(s)
  const trace = /\bset -[a-z]*x\b|xtrace|\bbash -[a-z]*x\b/
  expect(yml).not.toMatch(trace)
  expect(sh).not.toMatch(trace)
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

test('permissions : contents: read seul ; QUIZ_MODEL dans l’env de tête', () => {
  expect(yml.match(/permissions:/g)).toHaveLength(1)
  expect(block(yml, 'permissions:').filter((l) => l.trim())).toEqual(['permissions:', '  contents: read'])
  expect(block(yml, 'env:').some((l) => l.startsWith('  QUIZ_MODEL: '))).toBe(true)
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
  // `steps.secrets.` est la sortie de l'étape de contrôle (id `secrets`), pas le contexte des secrets.
  const uses = ls.flatMap((l, i) =>
    [...l.matchAll(/\$\{\{(.*?)\}\}/g)].some((m) => /\bsecrets\b/.test(m[1].replaceAll('steps.secrets.', ''))) ? [i] : [],
  )
  expect(uses.length).toBeGreaterThan(0)
  for (const i of uses) {
    const env = parent(i)
    expect(ls[env], `ligne ${i + 1}`).toBe('        env:')
    expect(ls[parent(env)], `ligne ${i + 1}`).toMatch(/^ {6}- /)
  }
})

test('probe : sans if: au niveau du job ; complétion par la clé partagée, dans une étape après omniroute.sh, sans secret', () => {
  const probe = block(yml, '  probe:')
  expect(probe.length).toBeGreaterThan(0)
  expect(probe.some((l) => /^ {4}if:/.test(l))).toBe(false)
  const text = probe.join('\n')
  for (const s of [
    'Content-Type: application/json',
    'Authorization: Bearer $OMNIROUTE_KEY',
    '127.0.0.1:20128/v1/chat/completions',
    '--retry 1 --retry-delay 30',
  ])
    expect(text).toContain(s)
  const own = stepsOf(probe)
  const launch = own.findIndex((s) => s.includes('omniroute.sh'))
  const call = own.findIndex((s) => s.includes('127.0.0.1:20128/v1/chat/completions'))
  expect(launch).toBeGreaterThanOrEqual(0)
  expect(call).toBeGreaterThan(launch)
  expect(own[call]).not.toMatch(secretRef)
})

test('probe : le contrôle du secret d’abord (notice exacte), puis chaque étape gardée par sa sortie', () => {
  const [check, ...rest] = stepsOf(block(yml, '  probe:'))
  expect(check).toContain('        id: secrets\n')
  expect(check).toContain('echo "::notice::Sonde sautée : secret MISTRAL_API_KEY absent (D:1116)"')
  expect(check).toContain('echo "run=false" >> "$GITHUB_OUTPUT"')
  expect(rest.length).toBeGreaterThan(0)
  for (const s of rest) expect(s).toContain("\n        if: steps.secrets.outputs.run == 'true'\n")
})

test('probe : aucune étape n’imprime un corps ni un en-tête ; le diagnostic direct ne bloque pas, entre /v1/models et omniroute.sh', () => {
  const own = stepsOf(block(yml, '  probe:'))
  for (const s of own) expect(s).not.toMatch(/\b(cat|head|tail|less|tee)\b|\s-[vDi]\s|--verbose|--include|--dump-header|--trace/)
  const models = own.findIndex((s) => s.includes('api.mistral.ai/v1/models'))
  const diag = own.findIndex((s) => s.includes('api.mistral.ai/v1/chat/completions'))
  const launch = own.findIndex((s) => s.includes('omniroute.sh'))
  expect(models).toBeGreaterThanOrEqual(0)
  expect(diag).toBeGreaterThan(models)
  expect(launch).toBeGreaterThan(diag)
  const d = own[diag]
  expect(d).toContain('        env:\n          MISTRAL_API_KEY: ${{ secrets.MISTRAL_API_KEY }}\n')
  expect(d).toContain(`jq -r '(.message // .error.message // .detail // "") | if type == "string" then . else tojson end'`)
  expect(d).toContain('--max-time 30')
  expect(d).not.toContain('--retry')
  expect(d.match(/\$\(curl .*\|\| true\)/g)).toHaveLength(1)
  // Chaque curl de la sonde a un délai, et un échec réseau (code 000) passe par le test du code, pas par set -e.
  for (const c of own.join('\n').match(/\$\(curl [^\n]*/g) ?? []) {
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
