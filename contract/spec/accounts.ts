import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { api, failed, Iso, makeUser, noSession, ok, psql } from '../users.ts'

const Prefs = z.strictObject({ sounds: z.boolean(), hide_sensitive: z.boolean(), is_public: z.boolean() })
const post = (env: ContractEnv, path: string, uid: string, body: unknown) => api(env, path, { method: 'POST', uid, body })

export const usernameAvailable: RouteSpec = {
  method: 'GET',
  path: '/api/username-available',
  source: 'D§7.1',
  confidence: 'ajouté',
  cases: [
    {
      name: 'sans session : pseudo libre → { available: true } ; Admin → reserved ; pseudo pris (autre casse) → taken',
      run: async (env) => {
        const free = await api(env, `/api/username-available?u=l_${randomUUID().slice(-12)}`)
        assert.equal(free.status, 200)
        assert.deepEqual(await free.json(), { available: true })
        const admin = await api(env, '/api/username-available?u=Admin')
        assert.equal(admin.status, 200)
        assert.deepEqual(await admin.json(), { available: false, reason: 'reserved', error: 'Ce pseudo est réservé' })
        const { username } = makeUser(env.backend.databaseUrl)
        const taken = await api(env, `/api/username-available?u=${username.toUpperCase()}`)
        assert.deepEqual(await taken.json(), { available: false, reason: 'taken', error: 'Ce pseudo est déjà pris' })
      },
    },
    {
      name: 'u absent → 400 invalid_request',
      run: async (env) => void (await failed(await api(env, '/api/username-available'), 400, 'invalid_request')),
    },
  ],
}

export const changeUsername: RouteSpec = {
  method: 'POST',
  path: '/api/settings/username',
  source: 'D§7.1',
  confidence: 'ajouté',
  cases: [
    noSession('POST', '/api/settings/username'),
    {
      name: 'nouveau pseudo → 200 { username, next_change_at } ; second changement → 409 username_change_too_soon',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        const username = `n_${randomUUID().slice(-12)}`
        const done = await ok(await post(env, '/api/settings/username', uid, { username }),
          z.strictObject({ username: z.literal(username), next_change_at: Iso }))
        assert.ok(Date.parse(done.next_change_at) > Date.now() + 29 * 86_400_000)
        assert.equal(psql(env.backend.databaseUrl, `select username from public.profiles where id = :'uid'`, { uid }), username)
        const again = await failed(await post(env, '/api/settings/username', uid, { username: `${username}x` }), 409, 'username_change_too_soon')
        assert.equal(again.next_change_at, done.next_change_at)
      },
    },
    {
      name: '{} → 400 invalid_request ; Admin → 400 username_reserved',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        await failed(await post(env, '/api/settings/username', uid, {}), 400, 'invalid_request')
        await failed(await post(env, '/api/settings/username', uid, { username: 'Admin' }), 400, 'username_reserved')
      },
    },
  ],
}

export const getPreferences: RouteSpec = {
  method: 'GET',
  path: '/api/settings/preferences',
  source: 'D§7.1',
  confidence: 'ajouté',
  cases: [
    noSession('GET', '/api/settings/preferences'),
    {
      name: 'nouveau joueur → défauts { sounds: true, hide_sensitive: true, is_public: true }',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        assert.deepEqual(await ok(await api(env, '/api/settings/preferences', { uid }), Prefs), { sounds: true, hide_sensitive: true, is_public: true })
      },
    },
  ],
}

export const setPreferences: RouteSpec = {
  method: 'POST',
  path: '/api/settings/preferences',
  source: 'D§7.1',
  confidence: 'ajouté',
  cases: [
    noSession('POST', '/api/settings/preferences'),
    {
      name: 'champs absents inchangés : { sounds: false } puis { is_public: false } → relus par GET',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        assert.deepEqual(await ok(await post(env, '/api/settings/preferences', uid, { sounds: false }), Prefs),
          { sounds: false, hide_sensitive: true, is_public: true })
        const expected = { sounds: false, hide_sensitive: true, is_public: false }
        assert.deepEqual(await ok(await post(env, '/api/settings/preferences', uid, { is_public: false }), Prefs), expected)
        assert.deepEqual(await ok(await api(env, '/api/settings/preferences', { uid }), Prefs), expected)
      },
    },
    {
      name: '{ sounds: "non" } → 400 invalid_request',
      run: async (env) => {
        const { uid } = makeUser(env.backend.databaseUrl)
        await failed(await post(env, '/api/settings/preferences', uid, { sounds: 'non' }), 400, 'invalid_request')
      },
    },
  ],
}

export const accounts: RouteSpec[] = [usernameAvailable, changeUsername, getPreferences, setPreferences]
