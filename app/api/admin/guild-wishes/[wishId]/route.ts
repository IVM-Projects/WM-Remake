import { route } from '@/lib/route'
import { AdminReason, WishParams } from '@/lib/schemas'

export const DELETE = route({
  fn: 'admin_guild_wish_remove',
  params: WishParams,
  input: AdminReason,
  idem: true,
  args: (i, { params }) => ({ p_wishlist_id: params.wishId, p_reason: i.reason }),
})
