import { route } from '@/lib/route'
import { AdminReason, GuildParams } from '@/lib/schemas'

export const GET = route({ fn: 'staff_guild_detail', params: GuildParams, args: (_, { params }) => ({ p_guild_id: params.guildId }) })

export const DELETE = route({
  fn: 'admin_guild_dissolve',
  params: GuildParams,
  input: AdminReason,
  idem: true,
  args: (i, { params }) => ({ p_guild_id: params.guildId, p_reason: i.reason }),
})
