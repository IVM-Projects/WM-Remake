import { toHttpError, type HttpError } from '@/lib/route'
import { createAdminClient } from '@/lib/supabase/admin'

// G4 : 401 compte supprimé, 403 suspension ou bannissement actifs ; null si la lecture est permise.
export async function accessDenied(uid: string): Promise<HttpError | null> {
  const { error } = await createAdminClient().schema('wm').rpc('access_check', { p_uid: uid })
  return error ? toHttpError(error) : null
}
