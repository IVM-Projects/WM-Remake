import { route } from '@/lib/route'
import { AdminReason, UserParams } from '@/lib/schemas'

export const POST = route({
  fn: 'admin_achievements_recheck',
  params: UserParams,
  input: AdminReason,
  idem: true,
  args: (i, { params }) => ({ p_user_id: params.userId, p_reason: i.reason }),
})
