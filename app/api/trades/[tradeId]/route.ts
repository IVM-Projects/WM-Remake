import { z } from 'zod'
import { route } from '@/lib/route'
import { pgText, TradeParams } from '@/lib/schemas'

export const GET = route({ fn: 'trade_detail', params: TradeParams, args: (_, { params }) => ({ p_trade_id: params.tradeId }) })

// action validée en SQL : une valeur inconnue → 400 « Action inconnue » (P11).
export const PATCH = route({
  fn: 'trade_action',
  params: TradeParams,
  input: z.object({ action: pgText }),
  idem: true,
  push: true,
  args: (i, { params, tz }) => ({ p_trade_id: params.tradeId, p_action: i.action, p_tz: tz }),
})
