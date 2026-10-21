import { z } from 'zod'
import { salesCall } from '@/lib/market-cache'
import { route } from '@/lib/route'

// scope=summary : résumé partagé en cache ; sans scope : détail Pro par joueur, sans cache (M3-19).
export const GET = route({
  fn: 'card_sales',
  params: z.object({ cardId: z.uuid() }),
  input: z.object({ scope: z.enum(['summary']).optional() }),
  args: (i, { params }) => ({ p_card_id: params.cardId, p_scope: i.scope }),
  call: salesCall,
})
