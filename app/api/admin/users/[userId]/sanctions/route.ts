import { withAuthSync } from '@/lib/admin-auth'
import { route } from '@/lib/route'
import { AdminSanction, UserParams } from '@/lib/schemas'

// GoTrue banni après la transaction (G4) ; un échec GoTrue rend auth_synced faux, jamais une erreur (G12).
export const POST = route({
  fn: 'admin_sanction',
  params: UserParams,
  input: AdminSanction,
  idem: true,
  status: 201,
  call: withAuthSync('admin_sanction'),
  args: (i, { params }) => ({
    p_user_id: params.userId, p_kind: i.kind, p_ends_at: i.ends_at ?? null, p_reason: i.reason, p_report_id: i.report_id ?? null,
  }),
})
