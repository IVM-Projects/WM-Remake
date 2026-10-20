import { z } from 'zod'
import { route } from '@/lib/route'

export const POST = route({
  fn: 'discard',
  params: z.object({ userCardId: z.uuid() }),
  idem: true,
  args: (_, { params }) => ({ p_user_card_id: params.userCardId }),
})
