// Lu aussi par `node contract/recap-coverage.ts` : imports relatifs en .ts seulement, aucun alias @/.
import type { Backend } from '../contract/harness.ts'

export type ContractEnv = { plain: string; gated: string; backend: Omit<Backend, 'stop'> }

export type RouteSpec = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string // paramètres en {nom}
  source: string // ex. '§3.5 · S 2926-2940' ou 'D§8.3'
  confidence: 'conf.' | 'prob.' | 'inc.' | 'ajouté'
  cases: Array<{ name: string; run: (env: ContractEnv) => Promise<void> }>
}

export type RecapRoute = { method: string; path: string; section: string }

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.split('?')[0].replace(/\{[^}]*\}/g, '{}')}`
}

// Lignes des tableaux de R§3 : 1re cellule = méthodes séparées par `/`, 2e = chemins entre accents graves.
export function parseRecapRoutes(md: string): RecapRoute[] {
  const routes = new Map<string, RecapRoute>()
  let inR3 = false
  let section = '§3'
  for (const line of md.split(/\r?\n/)) {
    if (line.startsWith('## ')) inR3 = line.startsWith('## 3.')
    if (!inR3) continue
    if (line.startsWith('### ')) section = `§${line.split(' ')[1]}`
    if (!line.startsWith('|')) continue
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim()) // `\|` échappé dans une cellule
    if (cells.length < 3) continue
    const methods = cells[1].split('/').map((m) => m.trim())
    if (!methods.every((m) => METHODS.has(m))) continue
    let dir: string | null = null
    for (const [, segment] of cells[2].matchAll(/`([^`]+)`/g)) {
      const path = segment.split('?')[0]
      let full: string
      if (path.startsWith('/api/') || path.startsWith('rest/v1/')) {
        full = path
        dir = path.slice(0, path.lastIndexOf('/'))
      } else if (path.startsWith('/') && dir !== null) {
        full = dir + path // `/kick` après `/api/guilds/invite`
      } else continue
      if (full.includes('auth/v1/')) continue // GoTrue, hors contrat
      for (const method of methods) {
        const key = routeKey(method, full)
        if (!routes.has(key)) routes.set(key, { method, path: full, section })
      }
    }
  }
  return [...routes.values()]
}
