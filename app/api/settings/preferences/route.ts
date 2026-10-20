import { z } from 'zod'
import { route } from '@/lib/route'

const flag = z.boolean().optional()

export const GET = route({ fn: 'get_prefs' })
// null : champ absent, inchangé (coalesce dans wm.set_prefs).
export const POST = route({
  fn: 'set_prefs',
  input: z.object({ sounds: flag, hide_sensitive: flag, is_public: flag }),
  args: (i) => ({ p_sounds: i.sounds ?? null, p_hide_sensitive: i.hide_sensitive ?? null, p_is_public: i.is_public ?? null }),
})
