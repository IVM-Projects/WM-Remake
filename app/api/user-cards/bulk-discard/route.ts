import { z } from 'zod'
import { route } from '@/lib/route'

export const POST = route({
  fn: 'bulk_discard',
  input: z.object({ card_ids: z.array(z.uuid()).min(1).max(50) }),
  idem: true,
  args: (i) => ({ p_ids: i.card_ids }),
})
