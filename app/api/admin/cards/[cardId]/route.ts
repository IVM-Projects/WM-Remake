import { route } from '@/lib/route'
import { CardIdParams } from '@/lib/schemas'

export const GET = route({ fn: 'staff_card', params: CardIdParams, args: (_, { params }) => ({ p_card_id: params.cardId }) })
