import { route } from '@/lib/route'
import { DmThread } from '@/lib/schemas'

// Sans idem : la réponse stockée recopierait des messages privés dans wm.idempotency_keys.
export const POST = route({
  fn: 'admin_dm_thread',
  input: DmThread,
  args: (i) => ({ p_user_a: i.user_a, p_user_b: i.user_b, p_reason: i.reason }),
})
