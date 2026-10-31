import assert from 'node:assert/strict'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { api, giveCards, Iso, makeUser, noSession, ok, psql, refused } from '../users.ts'
import { befriend } from './friends.ts'
import { guildWith } from './guilds.ts'

const Board = z.enum(['battles', 'collection', 'legendary'])
const GuildBoard = z.strictObject({
  entries: z.array(z.strictObject({
    rank: z.int().min(1), guild_id: z.uuid(), guild_name: z.string(), member_count: z.int().min(0), score_battles: z.int().min(0),
    score_wb: z.int().min(0), total_score: z.int().min(1),
  })),
  week_start: Iso, week_end: Iso, season: z.string().regex(/^S\d{2}$/), reset_in_ms: z.int().min(0), user_guild_id: z.uuid().nullable(),
})
const PlayerBoard = z.strictObject({
  board: Board, period: z.enum(['week', 'all']), week_start: Iso.nullable(),
  entries: z.array(z.strictObject({ rank: z.int().min(1), user_id: z.uuid(), username: z.string(), avatar_url: z.string().nullable(), value: z.int().min(1) })),
  me: z.strictObject({ rank: z.int().min(1), value: z.int().min(1) }).nullable(),
})

const sql = (env: ContractEnv, query: string, vars: Record<string, string> = {}) => psql(env.backend.databaseUrl, query, vars)
const json = (env: ContractEnv, query: string, vars: Record<string, string> = {}): unknown => JSON.parse(sql(env, query, vars))
const get = (env: ContractEnv, path: string, uid: string) => api(env, path, { uid })

// Une bataille gagnée par `winner` : défi, acceptation, deux decks (3 C chacun), abandon de `loser`.
function won(env: ContractEnv, winner: string, loser: string): void {
  befriend(env, winner, loser)
  const id = sql(env, `select wm.battle_create(:'a', :'b') ->> 'id'`, { a: winner, b: loser })
  sql(env, `select wm.battle_action(:'b', :'id', 'accept')`, { b: loser, id })
  for (const u of [winner, loser]) {
    const cards = giveCards(env.backend.databaseUrl, u, 'C', 3)
    sql(env, `select wm.battle_action(:'u', :'id', 'submit_deck', jsonb_build_object('card_ids', string_to_array(:'c', ',')))`, { u, id, c: cards.join(',') })
  }
  sql(env, `select wm.battle_action(:'l', :'id', 'forfeit', '{"expect": "lose"}')`, { l: loser, id })
}

export const leaderboards: RouteSpec[] = [
  {
    method: 'GET',
    path: '/api/guilds/leaderboard',
    source: 'R§3.10',
    confidence: 'prob.',
    cases: [
      noSession('GET', '/api/guilds/leaderboard'),
      {
        name: 'GuildBoard : entries, season et week_end = ceux de psql ; user_guild_id = G pour un membre, nul sans guilde ; reset_in_ms à 5 s près',
        run: async (env) => {
          const [leader, member, loner] = [1, 2, 3].map(() => makeUser(env.backend.databaseUrl))
          const g = guildWith(env, leader.uid, [member.uid])
          sql(env, `select wm.guild_score_add(:'u', 'wb', 700, now())`, { u: leader.uid })
          const body = await ok(await get(env, '/api/guilds/leaderboard', member.uid), GuildBoard)
          const db = json(env, `select wm.guild_leaderboard()`) as { entries: unknown; season: string; week_end: string }
          assert.deepEqual(body.entries, db.entries)
          assert.ok(body.entries.some((e) => e.guild_id === g && e.total_score === 700 && e.member_count === 2))
          assert.equal(body.season, db.season)
          assert.equal(Date.parse(body.week_end), Date.parse(db.week_end))
          assert.equal(body.user_guild_id, g)
          assert.ok(Math.abs(body.reset_in_ms - (Date.parse(db.week_end) - Date.now())) < 5_000)
          assert.equal((await ok(await get(env, '/api/guilds/leaderboard', loner.uid), GuildBoard)).user_guild_id, null)
        },
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/leaderboard',
    source: 'D:613',
    confidence: 'ajouté',
    cases: [
      noSession('GET', '/api/leaderboard'),
      {
        name: 'premier appel du contrat, legendary/all : entries = leaderboard_top en psql, week_start nul ; me nul à 0',
        run: async (env) => {
          const db = json(env, `select wm.leaderboard_top('legendary', 'all') -> 'entries'`)
          const body = await ok(await get(env, '/api/leaderboard?board=legendary&period=all', makeUser(env.backend.databaseUrl).uid), PlayerBoard)
          assert.deepEqual(body.entries, db)
          assert.deepEqual([body.board, body.period, body.week_start, body.me], ['legendary', 'all', null, null])
        },
      },
      {
        name: 'sans paramètre → battles/week ; ?board=x → 400 « Classement inconnu » ; ?period=y → 400 « Période inconnue » ; '
          + 'deux victoires cette semaine → me = leaderboard_me ; deux joueurs, mêmes entries, me différents',
        run: async (env) => {
          const [a, b, c] = [1, 2, 3].map(() => makeUser(env.backend.databaseUrl))
          won(env, a.uid, b.uid)
          won(env, a.uid, c.uid)
          const mine = await ok(await get(env, '/api/leaderboard', a.uid), PlayerBoard)
          assert.deepEqual([mine.board, mine.period], ['battles', 'week'])
          assert.ok(mine.week_start)
          assert.deepEqual(mine.me, json(env, `select wm.leaderboard_me(:'u', 'battles', 'week')`, { u: a.uid }))
          assert.equal(mine.me?.value, 2)
          const other = await ok(await get(env, '/api/leaderboard?board=battles&period=week', b.uid), PlayerBoard)
          assert.deepEqual(other.entries, mine.entries)
          assert.equal(other.me, null)
          await refused(await get(env, '/api/leaderboard?board=x', a.uid), 400, 'Classement inconnu', 'invalid_request')
          await refused(await get(env, '/api/leaderboard?period=y', a.uid), 400, 'Période inconnue', 'invalid_request')
        },
      },
    ],
  },
]
