import type { RpcResult } from '@/lib/route'
import { createAdminClient } from '@/lib/supabase/admin'

// État GoTrue attendu d'un compte (wm.auth_state, G12).
export type AuthState = { user_id: string; deleted: boolean; forever: boolean; ban_until: string | null }

// Durée Go : en secondes restantes, GoTrue ne tient plus le compte banni après ends_at.
export function banDuration(s: AuthState, now: number): string {
  if (s.forever) return '876000h'
  if (s.ban_until) return `${Math.max(1, Math.ceil((Date.parse(s.ban_until) - now) / 1000))}s`
  return 'none'
}

const syncFailed = () => console.error(JSON.stringify({ auth: 'sync_failed' }))

// Bannissement, levée ou suppression douce ; un échec rend false, jamais une exception (G12).
export async function applyAuthState(s: AuthState): Promise<boolean> {
  try {
    const admin = createAdminClient().auth.admin
    const { error } = s.deleted
      ? await admin.deleteUser(s.user_id, true)
      : await admin.updateUserById(s.user_id, { ban_duration: banDuration(s, Date.now()) })
    if (!error || (s.deleted && error.status === 404)) return true
  } catch {}
  syncFailed()
  return false
}

// Enveloppe `call` de route() : la RPC, puis l'état GoTrue relu (une réponse rejouée porte l'état d'alors, G4) et appliqué.
// La transaction a abouti : un échec GoTrue ne change que auth_synced.
export function withAuthSync(fn: string): (args: Record<string, unknown>) => Promise<RpcResult> {
  return async (args) => {
    const db = createAdminClient().schema('wm')
    const res = await db.rpc(fn, args)
    const data = res.data as { auth?: { user_id: string } } | null
    if (res.error || !data?.auth) return res
    let synced = false
    try {
      const fresh = await db.rpc('auth_state', { p_user_id: data.auth.user_id })
      const state = fresh.data as AuthState | null
      if (fresh.error || !state) syncFailed()
      else {
        synced = await applyAuthState(state)
        if (synced && state.deleted) synced = !(await db.rpc('account_auth_done', { p_uid: state.user_id })).error
      }
    } catch {
      syncFailed()
    }
    return { data: { ...data, auth_synced: synced }, error: null }
  }
}
