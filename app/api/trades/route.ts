import { route } from '@/lib/route'
import { TradeBody } from '@/lib/schemas'

// active et count acceptés sans effet (M4-9) : sans input, la query n'est pas lue.
export const GET = route({ fn: 'trades_list' })

export const POST = route({
  fn: 'create_trade',
  input: TradeBody,
  idem: true,
  args: (i, { tz }) => ({
    p_recipient_id: i.recipient_id,
    p_items: i.items,
    p_initiator_wikibidous: i.initiator_wikibidous,
    p_recipient_wikibidous: i.recipient_wikibidous,
    p_parent_trade_id: i.parent_trade_id ?? null,
    p_tz: tz,
  }),
})
