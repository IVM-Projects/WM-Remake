import { route } from '@/lib/route'
import { GuildTarget } from '@/lib/schemas'

export const POST = route({ fn: 'guild_transfer', input: GuildTarget, idem: true, args: (i) => ({ p_user_id: i.user_id }) })
