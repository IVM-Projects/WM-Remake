import { route } from '@/lib/route'
import { AdminAuditQuery } from '@/lib/schemas'

export const GET = route({
  fn: 'staff_audit',
  input: AdminAuditQuery,
  args: (i) => ({ p_page: i.page, p_staff_id: i.staff_id, p_target_type: i.target_type, p_target_id: i.target_id }),
})
