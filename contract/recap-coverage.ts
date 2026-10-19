// `node contract/recap-coverage.ts` : routes de R§3 sans spec de contrat.
import { readFileSync } from 'node:fs'
import { parseRecapRoutes, routeKey } from '../lib/contract.ts'
import { specs } from './spec/index.ts'

const recap = parseRecapRoutes(readFileSync(new URL('../docs/rea-recap.md', import.meta.url), 'utf8'))
const covered = new Set(specs.map((s) => routeKey(s.method, s.path)))
const missing = recap.filter((r) => !covered.has(routeKey(r.method, r.path)))

console.log(`Recap : ${recap.length} routes · couvertes : ${recap.length - missing.length} · manquantes :`)
for (const r of missing) console.log(`  ${r.section.padEnd(6)} ${routeKey(r.method, r.path)}`)
// shortcut: rapport non bloquant jusqu'au M6 ; au M7, `process.exitCode = missing.length ? 1 : 0`.
