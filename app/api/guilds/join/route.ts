import { route } from '@/lib/route'
import { GuildJoin } from '@/lib/schemas'

export const POST = route({ fn: 'guild_join', input: GuildJoin, idem: true, args: (i) => ({ p_guild_id: i.guild_id }) })
