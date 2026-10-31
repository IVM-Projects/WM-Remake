import { route } from '@/lib/route'
import { GuildDonate } from '@/lib/schemas'

export const POST = route({
  fn: 'guild_donate',
  input: GuildDonate,
  idem: true,
  args: (i) => ({ p_wishlist_id: i.wishlist_id, p_user_card_id: i.user_card_id }),
})
