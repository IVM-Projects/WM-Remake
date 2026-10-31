import { withAuthSync } from '@/lib/admin-auth'
import { route } from '@/lib/route'
import { AdminReason, SanctionParams } from '@/lib/schemas'

export const POST = route({
  fn: 'admin_sanction_revoke',
  params: SanctionParams,
  input: AdminReason,
  idem: true,
  call: withAuthSync('admin_sanction_revoke'),
  args: (i, { params }) => ({ p_sanction_id: params.sanctionId, p_reason: i.reason }),
})
