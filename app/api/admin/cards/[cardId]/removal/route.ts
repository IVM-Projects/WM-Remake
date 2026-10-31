import { withCatalogRevalidate } from '@/lib/catalog-revalidate'
import { route } from '@/lib/route'
import { AdminReason, CardIdParams } from '@/lib/schemas'

const args = (i: { reason: string }, { params }: { params: { cardId: string } }) => ({ p_card_id: params.cardId, p_reason: i.reason })

export const POST = route({
  fn: 'admin_card_remove', params: CardIdParams, input: AdminReason, idem: true, status: 201, call: withCatalogRevalidate('admin_card_remove'), args,
})

export const DELETE = route({
  fn: 'admin_card_restore', params: CardIdParams, input: AdminReason, idem: true, call: withCatalogRevalidate('admin_card_restore'), args,
})
