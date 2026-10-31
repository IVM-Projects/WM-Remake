import { withCatalogRevalidate } from '@/lib/catalog-revalidate'
import { route } from '@/lib/route'
import { CardFlags, CardIdParams } from '@/lib/schemas'

export const POST = route({
  fn: 'admin_card_flags',
  params: CardIdParams,
  input: CardFlags,
  idem: true,
  call: withCatalogRevalidate('admin_card_flags'),
  args: (i, { params }) => ({ p_card_id: params.cardId, p_hide_image: i.hide_image, p_nsfw_image: i.nsfw_image, p_reason: i.reason }),
})
