import { route } from '@/lib/route'
import { AdminReason, CardIdParams } from '@/lib/schemas'

export const POST = route({
  fn: 'admin_quiz_bank_clear',
  params: CardIdParams,
  input: AdminReason,
  idem: true,
  args: (i, { params }) => ({ p_card_id: params.cardId, p_reason: i.reason }),
})
