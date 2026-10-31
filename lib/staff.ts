import { cache } from 'react'
import type { StaffRole } from '@/components/admin/types'
import { accessDenied } from '@/lib/access'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

// Rôle du lecteur lu côté serveur (cookie vérifié, puis wm.staff_me en SQL) ; null : pas de session, suspension ou bannissement actifs (G4), pas de rôle.
// Mis en cache par requête : le layout de l'admin et le titre de chaque page (qui ne doit pas fuiter à un non-staff) partagent une seule lecture.
export const staffRole = cache(async (): Promise<StaffRole | null> => {
  const { data } = await (await createClient()).auth.getClaims()
  const uid = data?.claims.sub
  if (!uid || (await accessDenied(uid))) return null
  const { data: me } = await createAdminClient().schema('wm').rpc('staff_me', { p_uid: uid })
  const role = (me as { role?: unknown } | null)?.role
  return role === 'admin' || role === 'moderator' ? role : null
})

// Titre d'une page d'admin : posé seulement pour le staff (G13), sinon celui par défaut.
export const adminTitle = (title: string) => async () => ((await staffRole()) ? { title } : {})
