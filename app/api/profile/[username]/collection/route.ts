import { z } from 'zod'
import { route } from '@/lib/route'
import { boolParam, pageParam, pgText, Username } from '@/lib/schemas'

export const GET = route({
  fn: 'profile_collection',
  params: z.object({ username: Username }),
  input: z.object({ page: pageParam, q: pgText.optional(), stats: boolParam }),
  args: (i, { params }) => ({ p_username: params.username, p_page: i.page, p_q: i.q, p_stats: i.stats }),
})
