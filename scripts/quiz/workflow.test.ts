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

test('image OmniRoute épinglée par digest, ni artefact, ni set -x, ni docker logs dans le workflow', () => {
  expect(yml).toContain(
    'ghcr.io/diegosouzapw/omniroute:3.8.51@sha256:8bd462c9f60d8eda79329cfbb6ea7ea723505fe7721beb944f3d43835409e218',
  )
  for (const s of ['upload-artifact', 'set -x', 'docker logs']) expect(yml).not.toContain(s)
  expect(sh).not.toMatch(/set -\w*x/)
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

test('secrets. n’apparaît que sous un env: d’étape', () => {
  const ls = yml.split('\n')
  const uses = ls.flatMap((l, i) => (secretRef.test(l) ? [i] : []))
  expect(uses.length).toBeGreaterThan(0)
  for (const i of uses) {
    const ind = ls[i].search(/\S/)
    let p = i - 1
    while (ls[p].trim() === '' || ls[p].search(/\S/) >= ind) p--
    expect(ls[p], `ligne ${i + 1}`).toBe('        env:')
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

test('aucune étape qui appelle omniroute.sh ne contient 20128 ni generate.ts', () => {
  const launches = steps.filter((s) => s.includes('omniroute.sh'))
  expect(launches.length).toBeGreaterThan(0)
  for (const s of launches) {
    expect(s).not.toContain('20128')
    expect(s).not.toContain('generate.ts')
  }
})
