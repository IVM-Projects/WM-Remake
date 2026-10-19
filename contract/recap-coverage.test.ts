import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRecapRoutes, routeKey } from '@/lib/contract'

describe('parseRecapRoutes', () => {
  it('méthodes multiples, chemins relatifs, query retirée, GoTrue ignoré, dédoublonnage', () => {
    const md = `
## 3. Contrat
| GET / POST / DELETE | \`rest/v1/wishlist_items\` | — |
| POST | \`/api/guilds/invite\`, \`/kick\`, \`/transfer-leadership\` | x |
| GET | \`/api/marketplace?mine=1\` | x |
| GET | \`/api/marketplace\` | x |
| GET | \`rest/v1/achievements?select=*\` et \`rest/v1/user_achievements?select=a&user_id=eq.<me>\` | x |
| POST | \`https://<ref>.supabase.co/auth/v1/token?grant_type=password\` | x |
## 4. Modèle`
    expect(parseRecapRoutes(md).map((r) => routeKey(r.method, r.path))).toEqual([
      'GET rest/v1/wishlist_items', 'POST rest/v1/wishlist_items', 'DELETE rest/v1/wishlist_items',
      'POST /api/guilds/invite', 'POST /api/guilds/kick', 'POST /api/guilds/transfer-leadership',
      'GET /api/marketplace',
      'GET rest/v1/achievements', 'GET rest/v1/user_achievements',
    ])
  })

  it('le vrai recap', () => {
    const keys = parseRecapRoutes(readFileSync('docs/rea-recap.md', 'utf8')).map((r) => routeKey(r.method, r.path))
    expect(keys).toContain('POST /api/packs/open')
    expect(keys).toContain('PATCH /api/battles/{}')
    expect(keys).toContain('GET /api/guilds/leaderboard')
    expect(keys.some((k) => k.includes('auth/v1'))).toBe(false)
    expect(keys.length).toBeGreaterThanOrEqual(70)
  })
})

describe('routeKey', () => {
  it('paramètres normalisés en {}, query retirée', () => {
    expect(routeKey('GET', '/api/profile/{username}/collection?page=0')).toBe('GET /api/profile/{}/collection')
  })
})
