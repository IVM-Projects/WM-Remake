import { withAuthSync } from '@/lib/admin-auth'
import { route } from '@/lib/route'
import { AdminReason, UserParams } from '@/lib/schemas'

export const POST = route({
  fn: 'admin_auth_sync',
  params: UserParams,
  input: AdminReason,
  idem: true,
  call: withAuthSync('admin_auth_sync'),
  args: (i, { params }) => ({ p_user_id: params.userId, p_reason: i.reason }),
})
