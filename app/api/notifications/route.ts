import { z } from 'zod'
import { route } from '@/lib/route'

export const GET = route({ fn: 'notifications_list' })

// {} ou ids absent : toutes mes non-lues ; les ids d'un autre sont ignorés par le SQL (P10).
export const PATCH = route({
  fn: 'notifications_read',
  input: z.object({ ids: z.array(z.uuid()).max(100).optional() }),
  idem: true,
  args: (i) => ({ p_ids: i.ids ?? null }),
})
