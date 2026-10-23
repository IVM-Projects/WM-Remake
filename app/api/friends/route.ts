import { z } from 'zod'
import { route } from '@/lib/route'

export const GET = route({ fn: 'friends_list' })

export const POST = route({
  fn: 'friend_request',
  input: z.object({ addressee_id: z.uuid() }),
  idem: true,
  args: (i) => ({ p_addressee_id: i.addressee_id }),
})
