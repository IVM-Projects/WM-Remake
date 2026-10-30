import { route } from '@/lib/route'
import { GuildParams } from '@/lib/schemas'

export const DELETE = route({ fn: 'guild_invite_decline', params: GuildParams, idem: true, args: (_, { params }) => ({ p_guild_id: params.guildId }) })
