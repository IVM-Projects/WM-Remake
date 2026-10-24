import { z } from 'zod'
import { route } from '@/lib/route'
import { Username } from '@/lib/schemas'

export const GET = route({
  fn: 'profile_showcase',
  params: z.object({ username: Username }),
  args: (_, { params }) => ({ p_username: params.username }),
})
