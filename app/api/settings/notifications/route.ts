import { route, type RpcResult } from '@/lib/route'
import { PushTypes } from '@/lib/schemas'
import { createAdminClient } from '@/lib/supabase/admin'
import { vapidConfig } from '@/lib/vapid'

// La clé publique VAPID (M4b-14) ajoutée au corps d'un succès, null si le push est coupé : celle que /settings passe à pushManager.subscribe.
const withVapid = (fn: string) => async (args: Record<string, unknown>): Promise<RpcResult> => {
  const { data, error } = await createAdminClient().schema('wm').rpc(fn, args)
  return error ? { data, error } : { data: { ...data, vapid_public: vapidConfig()?.publicKey ?? null }, error }
}

export const GET = route({ fn: 'notification_prefs_get', call: withVapid('notification_prefs_get') })

// Liste entière remplacée (triée, dédoublonnée en SQL).
export const POST = route({
  fn: 'notification_prefs_set',
  input: PushTypes,
  idem: true,
  args: (i) => ({ p_push_types: i.push_types }),
  call: withVapid('notification_prefs_set'),
})
