import { route } from '@/lib/route'
import { AdminReason, MessageParams } from '@/lib/schemas'

export const DELETE = route({
  fn: 'admin_dm_delete',
  params: MessageParams,
  input: AdminReason,
  idem: true,
  args: (i, { params }) => ({ p_message_id: params.messageId, p_reason: i.reason }),
})
