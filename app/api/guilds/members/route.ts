import { route } from '@/lib/route'
import { GuildMembersQuery } from '@/lib/schemas'

export const GET = route({ fn: 'guild_members', input: GuildMembersQuery, args: (i) => ({ p_limit: i.limit, p_offset: i.offset }) })
