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
  // shortcut: deux membres du staff sur le même joueur au même instant peuvent laisser GoTrue en décalage (le dernier appel GoTrue l'emporte),
  // réparé par POST auth-sync ; passer à un verrou consultatif sur user_id si cela devient gênant.
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
        if (synced && state.deleted && (await db.rpc('account_auth_done', { p_uid: state.user_id })).error) {
          synced = false
          syncFailed()
        }
      }
    } catch {
      syncFailed()
    }
    return { data: { ...data, auth_synced: synced }, error: null }
  }
}

// Enveloppe `call` de POST /api/settings/delete-account : la transaction, puis la suppression douce GoTrue (G1) ; un échec GoTrue
// laisse auth_done_at nul (auth_pending: true), rattrapé par POST auth-sync.
export async function deleteAccountCall(args: Record<string, unknown>): Promise<RpcResult> {
  const db = createAdminClient().schema('wm')
  const res = await db.rpc('account_delete', args)
  if (res.error) return res
  // M6b : résilier l'abonnement Stripe ici, avant la suppression GoTrue (A3).
  let ok = await applyAuthState({ user_id: String(args.p_uid), deleted: true, forever: false, ban_until: null })
  if (ok) {
    try {
      ok = !(await db.rpc('account_auth_done', { p_uid: args.p_uid })).error
    } catch {
      ok = false
    }
    if (!ok) syncFailed()
  }
  return { data: { ...(res.data as object), auth_pending: !ok }, error: null }
}
