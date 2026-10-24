import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ContractEnv, RouteSpec } from '../../lib/contract.ts'
import { api, idem, Iso, makeUser, noSession, ok, psql, Rarity, refused, send } from '../users.ts'
import { befriend } from './friends.ts'

// Formes strictes (B2) : une clé en plus ferait échouer le cas au lieu de disparaître avant le deepEqual.
const Profile = z.strictObject({
  id: z.uuid(), username: z.string(), avatar_url: z.string().nullable(), bio: z.string().nullable(), is_public: z.boolean(), created_at: Iso,
})
// Profil privé lu par un tiers : sans bio (M4b-5).
const ProfileReduced = Profile.omit({ bio: true })
const ProfileResponse = z.strictObject({
  profile: Profile, isOwn: z.boolean(), isFriend: z.boolean(),
  friendship: z.strictObject({ id: z.uuid(), status: z.enum(['pending', 'accepted']), requester_id: z.uuid() }).nullable(),
})
const ReducedResponse = ProfileResponse.extend({ profile: ProfileReduced })
// Copie d'un autre joueur (B2) : card est l'objet card de wm.my_collection (1700_wm_trade_core.sql:58-60).
const Card = z.strictObject({
  id: z.uuid(), wikipedia_title: z.string(), rarity: Rarity, category: z.string().nullable(), atk: z.int(), def: z.int(),
  image_url: z.string().nullable(), hide_image: z.boolean(), nsfw_image: z.boolean(), wikipedia_url: z.string(),
  description: z.string().nullable(), summary: z.string().nullable(),
})
const ShowcaseItem = z.strictObject({
  position: z.int().min(0).max(3), user_card_id: z.uuid(),
  user_card: z.strictObject({ id: z.uuid(), card: Card, count: z.int().min(1), is_shiny: z.boolean(), snapshot_rarity: Rarity }),
})
const Showcase = z.strictObject({ showcase: z.array(ShowcaseItem) })
// GET /api/showcase et la réponse de ses écritures : galleries toujours vide (M4b-7, M4b-8).
const MyShowcase = Showcase.extend({ galleries: z.tuple([]) })
const EMPTY = { showcase: [], galleries: [] }

const db = (env: ContractEnv) => env.backend.databaseUrl
const sql = (env: ContractEnv, query: string, vars: Record<string, string> = {}) => psql(db(env), query, vars)
const player = (env: ContractEnv) => makeUser(db(env))
const at = (username: string) => `/api/profile/${encodeURIComponent(username)}`

// Copie d'une carte R à image (tests.image_card, B11) au titre unique, à fin non numérique ; renvoie l'id de la copie (aussi pour chat.ts).
export function imageCopy(env: ContractEnv, uid: string): string {
  return sql(env, `select tests.image_card(:'title') as card \\gset
insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
select :'uid', id, wikipedia_title, rarity, category, atk, def from public.cards where id = :'card' returning id`,
  { uid, title: `Zz image contrat ${randomUUID().slice(-12)} z` })
}

// Joueur au profil privé, à bio.
function privatePlayer(env: ContractEnv) {
  const user = player(env)
  sql(env, `update public.profiles set is_public = false, bio = 'Bio privée' where id = :'uid'`, { uid: user.uid })
  return user
}

export const profileGet: RouteSpec = {
  method: 'GET',
  path: '/api/profile/{username}',
  source: 'R§3.7',
  confidence: 'prob.',
  cases: [
    noSession('GET', '/api/profile/inconnu'),
    {
      name: 'soi → { profile } entier (B2), isOwn vrai, isFriend faux, friendship null',
      run: async (env) => {
        const me = player(env)
        const r = await ok(await api(env, at(me.username), { uid: me.uid }), ProfileResponse)
        assert.deepEqual(r, {
          profile: { id: me.uid, username: me.username, avatar_url: null, bio: null, is_public: true, created_at: r.profile.created_at },
          isOwn: true, isFriend: false, friendship: null,
        })
      },
    },
    {
      name: 'profil privé lu par un inconnu → profile réduit, sans bio (M4b-5)',
      run: async (env) => {
        const owner = privatePlayer(env)
        const r = await ok(await api(env, at(owner.username), { uid: player(env).uid }), ReducedResponse)
        assert.deepEqual(r, {
          profile: { id: owner.uid, username: owner.username, avatar_url: null, is_public: false, created_at: r.profile.created_at },
          isOwn: false, isFriend: false, friendship: null,
        })
      },
    },
    {
      name: 'profil privé lu par un ami → entier, isFriend vrai, friendship { id, status: accepted, requester_id }',
      run: async (env) => {
        const [owner, friend] = [privatePlayer(env), player(env)]
        const id = befriend(env, owner.uid, friend.uid)
        const r = await ok(await api(env, at(owner.username), { uid: friend.uid }), ProfileResponse)
        assert.deepEqual(r, {
          profile: { id: owner.uid, username: owner.username, avatar_url: null, bio: 'Bio privée', is_public: false, created_at: r.profile.created_at },
          isOwn: false, isFriend: true, friendship: { id, status: 'accepted', requester_id: owner.uid },
        })
      },
    },
    {
      name: 'pseudo inconnu → 404 « Joueur introuvable »',
      run: async (env) => refused(await api(env, at(`x_${randomUUID().slice(-12)}`), { uid: player(env).uid }), 404, 'Joueur introuvable'),
    },
    {
      name: 'Review Focus, pseudo hérité : renommé Élise Ü, a%b puis x?y#z (psql) → /api/profile/<encodeURIComponent> rend son id, sa vitrine répond',
      run: async (env) => {
        const [owner, viewer] = [player(env), player(env)]
        for (const name of ['Élise Ü', 'a%b', 'x?y#z']) {
          sql(env, `update public.profiles set username = :'name' where id = :'uid'`, { name, uid: owner.uid })
          const { profile } = await ok(await api(env, at(name), { uid: viewer.uid }), ProfileResponse)
          assert.deepEqual([profile.id, profile.username], [owner.uid, name], name)
          assert.deepEqual(await ok(await api(env, `${at(name)}/showcase`, { uid: viewer.uid }), Showcase), { showcase: [] }, name)
        }
      },
    },
  ],
}

const patch = (env: ContractEnv, uid: string, username: string, body: unknown, headers?: Record<string, string>) =>
  send(env, 'PATCH', at(username), uid, body, headers)
const bio = (env: ContractEnv, uid: string) => sql(env, `select coalesce(bio, '<null>') from public.profiles where id = :'uid'`, { uid })

export const profilePatch: RouteSpec = {
  method: 'PATCH',
  path: '/api/profile/{username}',
  source: 'R§3.7',
  confidence: 'prob.',
  cases: [
    noSession('PATCH', '/api/profile/inconnu'),
    {
      name: '{bio: Bonjour, is_public: false} → la forme du GET, avec ces valeurs (M4b-8)',
      run: async (env) => {
        const me = player(env)
        const r = await ok(await patch(env, me.uid, me.username, { bio: 'Bonjour', is_public: false }), ProfileResponse)
        assert.deepEqual([r.profile.bio, r.profile.is_public, r.isOwn], ['Bonjour', false, true])
        assert.deepEqual(await ok(await api(env, at(me.username), { uid: me.uid }), ProfileResponse), r)
      },
    },
    {
      name: '{avatar_user_card_id: copie à image} → avatar_url de sa carte ; {bio} seul le garde ; {avatar_user_card_id: null} → null',
      run: async (env) => {
        const me = player(env)
        const copy = imageCopy(env, me.uid)
        const url = sql(env, `select k.image_url from public.user_cards uc join public.cards k on k.id = uc.card_id where uc.id = :'copy'`, { copy })
        const set = await ok(await patch(env, me.uid, me.username, { avatar_user_card_id: copy }), ProfileResponse)
        assert.equal(set.profile.avatar_url, url)
        const kept = await ok(await patch(env, me.uid, me.username, { bio: 'Avec avatar' }), ProfileResponse)
        assert.deepEqual([kept.profile.avatar_url, kept.profile.bio], [url, 'Avec avatar'])
        const unset = await ok(await patch(env, me.uid, me.username, { avatar_user_card_id: null }), ProfileResponse)
        assert.deepEqual([unset.profile.avatar_url, unset.profile.bio], [null, 'Avec avatar'])
        assert.equal(sql(env, `select avatar_user_card_id is null from public.profiles where id = :'uid'`, { uid: me.uid }), 't')
      },
    },
    {
      name: 'bio de 281 caractères → 400 ; copie d\'un autre → 403 42501 ; pseudo d\'un autre → 403 FORBIDDEN ; bio a\\0 → 400 « Caractère invalide »',
      run: async (env) => {
        const [me, other] = [player(env), player(env)]
        await refused(await patch(env, me.uid, me.username, { bio: 'a'.repeat(281) }), 400, 'La bio fait au plus 280 caractères', 'invalid_request')
        await refused(await patch(env, me.uid, me.username, { avatar_user_card_id: imageCopy(env, other.uid) }), 403,
          'Vous ne possédez pas cette carte', '42501')
        await refused(await patch(env, me.uid, other.username, { bio: 'x' }), 403, 'Tu ne peux modifier que ton profil', 'FORBIDDEN')
        await refused(await patch(env, me.uid, me.username, { bio: 'a\u0000' }), 400, 'Caractère invalide', 'invalid_request')
        assert.deepEqual([bio(env, me.uid), bio(env, other.uid)], ['<null>', '<null>'])
      },
    },
    {
      name: 'même Idempotency-Key deux fois, la seconde avec une autre bio → corps identiques, la première bio gardée',
      run: async (env) => {
        const me = player(env)
        const key = idem()
        const first = await ok(await patch(env, me.uid, me.username, { bio: 'k1' }, key), ProfileResponse)
        assert.deepEqual(await ok(await patch(env, me.uid, me.username, { bio: 'k2' }, key), ProfileResponse), first)
        assert.deepEqual([first.profile.bio, bio(env, me.uid)], ['k1', 'k1'])
      },
    },
  ],
}

const showcaseOf = (env: ContractEnv, username: string, uid: string) => api(env, `${at(username)}/showcase`, { uid })

export const profileShowcase: RouteSpec = {
  method: 'GET',
  path: '/api/profile/{username}/showcase',
  source: 'R§3.7',
  confidence: 'prob.',
  cases: [
    noSession('GET', '/api/profile/inconnu/showcase'),
    {
      name: 'profil privé lu par un étranger → 403 FORBIDDEN « Ce profil est privé »',
      run: async (env) => {
        const owner = privatePlayer(env)
        await refused(await showcaseOf(env, owner.username, player(env).uid), 403, 'Ce profil est privé', 'FORBIDDEN')
      },
    },
    {
      name: 'profil privé lu par un ami → { showcase }, les emplacements de son GET /api/showcase',
      run: async (env) => {
        const [owner, friend] = [privatePlayer(env), player(env)]
        const copy = imageCopy(env, owner.uid)
        sql(env, `insert into public.showcase (user_id, position, user_card_id) values (:'uid', 2, :'copy')`, { uid: owner.uid, copy })
        befriend(env, owner.uid, friend.uid)
        const { showcase } = await ok(await api(env, '/api/showcase', { uid: owner.uid }), MyShowcase)
        assert.deepEqual(showcase.map((s) => [s.position, s.user_card_id, s.user_card.id]), [[2, copy, copy]])
        assert.deepEqual(await ok(await showcaseOf(env, owner.username, friend.uid), Showcase), { showcase })
      },
    },
    {
      name: 'pseudo inconnu → 404 « Joueur introuvable »',
      run: async (env) => refused(await showcaseOf(env, `x_${randomUUID().slice(-12)}`, player(env).uid), 404, 'Joueur introuvable'),
    },
  ],
}

const put = (env: ContractEnv, uid: string, body: unknown, headers?: Record<string, string>) => send(env, 'PUT', '/api/showcase', uid, body, headers)
const del = (env: ContractEnv, uid: string, body?: unknown, headers?: Record<string, string>) =>
  send(env, 'DELETE', '/api/showcase', uid, body, headers)
const slots = (env: ContractEnv, uid: string) =>
  sql(env, `select coalesce(string_agg(position || ':' || user_card_id, ',' order by position), '') from public.showcase where user_id = :'uid'`, { uid })

export const showcaseGet: RouteSpec = {
  method: 'GET',
  path: '/api/showcase',
  source: 'R§3.7',
  confidence: 'prob.',
  cases: [
    noSession('GET', '/api/showcase'),
    {
      name: 'aucun emplacement → { showcase: [], galleries: [] }',
      run: async (env) => assert.deepEqual(await ok(await api(env, '/api/showcase', { uid: player(env).uid }), MyShowcase), EMPTY),
    },
  ],
}

export const showcasePut: RouteSpec = {
  method: 'PUT',
  path: '/api/showcase',
  source: 'R§3.7',
  confidence: 'prob.',
  cases: [
    noSession('PUT', '/api/showcase'),
    {
      name: '{position: 0, user_card_id} → { showcase: [cet emplacement], galleries: [] }, le corps du GET (M4b-8)',
      run: async (env) => {
        const { uid } = player(env)
        const copy = imageCopy(env, uid)
        const r = await ok(await put(env, uid, { position: 0, user_card_id: copy }), MyShowcase)
        assert.deepEqual(r.showcase.map((s) => [s.position, s.user_card_id, s.user_card.id]), [[0, copy, copy]])
        assert.deepEqual(await ok(await api(env, '/api/showcase', { uid }), MyShowcase), r)
      },
    },
    {
      name: 'position 4 → 400 « Emplacement de vitrine inconnu (0 à 3) » ; copie d\'un autre → 403 42501 ; aucun emplacement posé',
      run: async (env) => {
        const [me, other] = [player(env), player(env)]
        await refused(await put(env, me.uid, { position: 4, user_card_id: imageCopy(env, me.uid) }), 400,
          'Emplacement de vitrine inconnu (0 à 3)', 'invalid_request')
        await refused(await put(env, me.uid, { position: 0, user_card_id: imageCopy(env, other.uid) }), 403, 'Vous ne possédez pas cette carte', '42501')
        assert.equal(slots(env, me.uid), '')
      },
    },
    {
      name: 'même Idempotency-Key deux fois, la seconde avec une autre copie → corps identiques, la première copie gardée',
      run: async (env) => {
        const { uid } = player(env)
        const [a, b] = [imageCopy(env, uid), imageCopy(env, uid)]
        const key = idem()
        const first = await ok(await put(env, uid, { position: 0, user_card_id: a }, key), MyShowcase)
        assert.deepEqual(await ok(await put(env, uid, { position: 0, user_card_id: b }, key), MyShowcase), first)
        assert.equal(slots(env, uid), `0:${a}`)
      },
    },
  ],
}

export const showcaseDelete: RouteSpec = {
  method: 'DELETE',
  path: '/api/showcase',
  source: 'R§3.7',
  confidence: 'prob.',
  cases: [
    noSession('DELETE', '/api/showcase'),
    {
      name: 'corps JSON {position: 0} → { showcase: [], galleries: [] }',
      run: async (env) => {
        const { uid } = player(env)
        await ok(await put(env, uid, { position: 0, user_card_id: imageCopy(env, uid) }), MyShowcase)
        assert.deepEqual(await ok(await del(env, uid, { position: 0 }), MyShowcase), EMPTY)
        assert.equal(slots(env, uid), '')
      },
    },
    {
      name: 'sans corps → 400 invalid_request, position manquante (zod)',
      run: async (env) => refused(await del(env, player(env).uid), 400, 'Entrée invalide : nombre attendu, indéfini reçu', 'invalid_request'),
    },
    {
      name: 'même Idempotency-Key deux fois, l\'emplacement remis entre-temps (psql) → corps identiques, l\'emplacement remis gardé',
      run: async (env) => {
        const { uid } = player(env)
        const copy = imageCopy(env, uid)
        await ok(await put(env, uid, { position: 0, user_card_id: copy }), MyShowcase)
        const key = idem()
        assert.deepEqual(await ok(await del(env, uid, { position: 0 }, key), MyShowcase), EMPTY)
        sql(env, `insert into public.showcase (user_id, position, user_card_id) values (:'uid', 0, :'copy')`, { uid, copy })
        assert.deepEqual(await ok(await del(env, uid, { position: 0 }, key), MyShowcase), EMPTY)
        assert.equal(slots(env, uid), `0:${copy}`)
      },
    },
  ],
}

export const profile: RouteSpec[] = [profileGet, profilePatch, profileShowcase, showcaseGet, showcasePut, showcaseDelete]
