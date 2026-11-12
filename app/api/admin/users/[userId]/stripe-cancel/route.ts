import { withStripeCancel } from '@/lib/admin-auth'
import { route } from '@/lib/route'
import { AdminReason, UserParams } from '@/lib/schemas'

export const POST = route({
  fn: 'admin_stripe_cancel',
  params: UserParams,
  input: AdminReason,
  idem: true,
  call: withStripeCancel('admin_stripe_cancel'),
  args: (i, { params }) => ({ p_user_id: params.userId, p_reason: i.reason }),
})
