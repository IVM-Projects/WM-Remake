import { route } from '@/lib/route'
import { GuildWish } from '@/lib/schemas'

export const PUT = route({ fn: 'guild_wish_set', input: GuildWish, idem: true, args: (i) => ({ p_card_id: i.card_id }) })

export const DELETE = route({ fn: 'guild_wish_clear', idem: true })
