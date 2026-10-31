import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const rpc = vi.fn()
const cacheTag = vi.fn()
const cacheLife = vi.fn()
vi.mock('next/cache', () => ({ cacheTag, cacheLife }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ schema: () => ({ rpc }) }) }))

const { guildBoardCall, playerBoardCall } = await import('@/lib/leaderboard-cache')

const NOW = Date.parse('2026-10-28T12:00:00Z')
const board = (weekEnd: string) => ({ entries: [], week_start: '2026-10-26T00:00:00Z', week_end: weekEnd, season: 'S44' })
let guild: unknown

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  guild = board('2026-11-02T00:00:00Z')
  rpc.mockImplementation(async (fn: string) => {
    if (fn === 'guild_leaderboard') return { data: guild, error: null }
    if (fn === 'guild_of') return { data: 'g1', error: null }
    if (fn === 'leaderboard_top') return { data: { board: 'battles', period: 'week', entries: [], week_start: null }, error: null }
    return { data: null, error: null } // leaderboard_me : SQL NULL
  })
})
afterEach(() => vi.useRealTimers())

const calls = (fn: string) => rpc.mock.calls.filter((c) => c[0] === fn)

describe('guildBoardCall', () => {
  it('milieu de semaine : un seul guild_leaderboard (partagé), reset_in_ms = week_end - maintenant, guilde du lecteur lue hors cache', async () => {
    const out = await guildBoardCall({ p_uid: 'u' })
    expect(calls('guild_leaderboard')).toHaveLength(1)
    expect(calls('guild_of')).toStrictEqual([['guild_of', { p_uid: 'u' }]])
    expect(out.data).toMatchObject({ reset_in_ms: Date.parse('2026-11-02T00:00:00Z') - NOW, user_guild_id: 'g1' })
    expect(cacheLife).toHaveBeenCalledExactlyOnceWith('guilds')
  })

  it('semaine qui bascule : week_end partagé passé → second guild_leaderboard hors cache, reset_in_ms > 0', async () => {
    rpc.mockImplementationOnce(async () => ({ data: board('2026-10-26T00:00:00Z'), error: null }))
    const out = await guildBoardCall({ p_uid: 'u' })
    expect(calls('guild_leaderboard')).toHaveLength(2)
    expect((out.data as { reset_in_ms: number }).reset_in_ms).toBeGreaterThan(0)
  })

  it('une erreur du partagé est rendue telle quelle', async () => {
    rpc.mockImplementationOnce(async () => ({ data: null, error: { code: '55P03', message: 'x', details: null } }))
    expect((await guildBoardCall({ p_uid: 'u' })).error?.code).toBe('55P03')
    expect(cacheLife).toHaveBeenCalledExactlyOnceWith('auction')
    expect(calls('guild_of')).toHaveLength(0)
  })
})

describe('playerBoardCall', () => {
  it('partagé sous le profil players, me lu hors cache (nul à 0)', async () => {
    const out = await playerBoardCall({ p_uid: 'u', p_board: 'battles', p_period: 'week' })
    expect(calls('leaderboard_top')).toStrictEqual([['leaderboard_top', { p_board: 'battles', p_period: 'week' }]])
    expect(calls('leaderboard_me')).toStrictEqual([['leaderboard_me', { p_uid: 'u', p_board: 'battles', p_period: 'week' }]])
    expect((out.data as { me: unknown }).me).toBeNull()
    expect(cacheLife).toHaveBeenCalledExactlyOnceWith('players')
  })
})
