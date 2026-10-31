import { describe, it, expect, vi, beforeEach } from 'vitest'

const rpc = vi.fn()
const updateUserById = vi.fn()
const deleteUser = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ schema: () => ({ rpc }), auth: { admin: { updateUserById, deleteUser } } }),
}))

const { banDuration, applyAuthState, withAuthSync, deleteAccountCall } = await import('@/lib/admin-auth')

const ID = '00000000-0000-4000-8000-000000000001'
const state = (s: Partial<{ deleted: boolean; forever: boolean; ban_until: string | null }> = {}) =>
  ({ user_id: ID, deleted: false, forever: false, ban_until: null, ...s })
// Réponse de la RPC de route, puis de auth_state, puis de account_auth_done.
const rpcs = (...results: unknown[]) => results.forEach((r) => rpc.mockResolvedValueOnce(r))

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  updateUserById.mockResolvedValue({ data: {}, error: null })
  deleteUser.mockResolvedValue({ data: {}, error: null })
})

describe('banDuration', () => {
  const now = Date.parse('2026-10-31T12:00:00Z')
  const at = (ms: number) => state({ ban_until: new Date(now + ms).toISOString() })
  it('forever, secondes restantes arrondies au-dessus (1 s au moins), none', () => {
    expect(banDuration(state({ forever: true }), now)).toBe('876000h')
    expect(banDuration(at(71 * 60_000), now)).toBe('4260s')
    expect(banDuration(at(5 * 60_000), now)).toBe('300s')
    expect(banDuration(at(200), now)).toBe('1s')
    expect(banDuration(state(), now)).toBe('none')
  })
})

describe('applyAuthState', () => {
  it('bannissement → updateUserById(id, { ban_duration }) ; suppression → deleteUser(id, true)', async () => {
    expect(await applyAuthState(state({ forever: true }))).toBe(true)
    expect(updateUserById).toHaveBeenCalledWith(ID, { ban_duration: '876000h' })
    expect(await applyAuthState(state({ deleted: true }))).toBe(true)
    expect(deleteUser).toHaveBeenCalledWith(ID, true)
  })

  it('404 de deleteUser → fait ; autre erreur ou exception → false et une ligne sync_failed sans id', async () => {
    deleteUser.mockResolvedValueOnce({ data: null, error: { status: 404 } })
    expect(await applyAuthState(state({ deleted: true }))).toBe(true)
    expect(console.error).not.toHaveBeenCalled()
    updateUserById.mockResolvedValueOnce({ data: null, error: { status: 500 } })
    expect(await applyAuthState(state())).toBe(false)
    updateUserById.mockRejectedValueOnce(new Error('réseau'))
    expect(await applyAuthState(state())).toBe(false)
    expect(vi.mocked(console.error).mock.calls).toEqual([['{"auth":"sync_failed"}'], ['{"auth":"sync_failed"}']])
  })
})

describe('withAuthSync', () => {
  it('applique l\'état relu, pas celui d\'une réponse rejouée (forever → none) ; ajoute auth_synced', async () => {
    rpcs({ data: { sanction: { id: 1 }, auth: state({ forever: true }) }, error: null }, { data: state(), error: null })
    const res = await withAuthSync('admin_sanction')({ p_uid: 'staff', p_idem: 'k' })
    expect(rpc.mock.calls).toEqual([['admin_sanction', { p_uid: 'staff', p_idem: 'k' }], ['auth_state', { p_user_id: ID }]])
    expect(updateUserById).toHaveBeenCalledWith(ID, { ban_duration: 'none' })
    expect(res).toEqual({ data: { sanction: { id: 1 }, auth: state({ forever: true }), auth_synced: true }, error: null })
  })

  it('état deleted appliqué → account_auth_done ; GoTrue en échec → auth_synced faux, pas d\'account_auth_done', async () => {
    rpcs({ data: { auth: state() }, error: null }, { data: state({ deleted: true }), error: null }, { data: { ok: true }, error: null })
    expect((await withAuthSync('admin_auth_sync')({})).data).toMatchObject({ auth_synced: true })
    expect(rpc).toHaveBeenLastCalledWith('account_auth_done', { p_uid: ID })
    rpc.mockReset()
    deleteUser.mockResolvedValueOnce({ data: null, error: { status: 500 } })
    rpcs({ data: { auth: state() }, error: null }, { data: state({ deleted: true }), error: null })
    expect((await withAuthSync('admin_auth_sync')({})).data).toMatchObject({ auth_synced: false })
    expect(rpc).toHaveBeenCalledTimes(2)
    rpc.mockReset()
    vi.mocked(console.error).mockClear()
    rpcs({ data: { auth: state() }, error: null }, { data: state({ deleted: true }), error: null }, { data: null, error: { code: '55P03' } })
    expect((await withAuthSync('admin_auth_sync')({})).data).toMatchObject({ auth_synced: false })
    expect(vi.mocked(console.error).mock.calls).toEqual([['{"auth":"sync_failed"}']])
  })

  it('état non supprimé → aucun account_auth_done ; erreur ou réponse sans auth → rendue telle quelle', async () => {
    rpcs({ data: { auth: state() }, error: null }, { data: state({ ban_until: '2099-01-01T00:00:00Z' }), error: null })
    await withAuthSync('admin_sanction')({})
    expect(rpc).toHaveBeenCalledTimes(2)
    const err = { data: null, error: { code: 'P0001', details: '{}' } }
    rpc.mockReset()
    rpcs(err, { data: { ok: true }, error: null })
    expect(await withAuthSync('admin_sanction')({})).toBe(err)
    expect(await withAuthSync('admin_sanction')({})).toEqual({ data: { ok: true }, error: null })
    expect(rpc).toHaveBeenCalledTimes(2)
  })
})

describe('deleteAccountCall', () => {
  const done = { ok: true, voided_auctions: 0, cancelled_trades: 0, finished_battles: 0, cancelled_battles: 0, guild: null }
  const args = { p_username: 'moi', p_idem: 'k', p_uid: ID }

  it('account_delete, puis deleteUser(uid, true), puis account_auth_done → auth_pending faux', async () => {
    rpcs({ data: done, error: null }, { data: { ok: true }, error: null })
    expect(await deleteAccountCall(args)).toEqual({ data: { ...done, auth_pending: false }, error: null })
    expect(rpc.mock.calls).toEqual([['account_delete', args], ['account_auth_done', { p_uid: ID }]])
    expect(deleteUser).toHaveBeenCalledWith(ID, true)
    expect(deleteUser.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[1])
  })

  it('GoTrue en erreur → auth_pending vrai, aucun account_auth_done ; account_auth_done en erreur → auth_pending vrai', async () => {
    deleteUser.mockResolvedValueOnce({ data: null, error: { status: 500 } })
    rpcs({ data: done, error: null })
    expect((await deleteAccountCall(args)).data).toEqual({ ...done, auth_pending: true })
    expect(rpc).toHaveBeenCalledTimes(1)
    rpc.mockReset()
    rpcs({ data: done, error: null }, { data: null, error: { code: '55P03' } })
    expect((await deleteAccountCall(args)).data).toEqual({ ...done, auth_pending: true })
    expect(vi.mocked(console.error).mock.calls).toEqual([['{"auth":"sync_failed"}'], ['{"auth":"sync_failed"}']])
  })

  it('erreur SQL → rendue telle quelle, GoTrue jamais appelé', async () => {
    const err = { data: null, error: { code: 'P0001', details: '{"status":400}' } }
    rpcs(err)
    expect(await deleteAccountCall(args)).toBe(err)
    expect(deleteUser).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})
