import { z } from 'zod'
import { route } from '@/lib/route'

export const POST = route({
  fn: 'create_auction',
  status: 201,
  input: z.object({ card_id: z.uuid(), base_amount: z.int32(), duration_minutes: z.int32() }),
  idem: true,
  args: (i) => ({ p_card_id: i.card_id, p_base_amount: i.base_amount, p_duration_minutes: i.duration_minutes }),
})
