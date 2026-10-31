import { route } from '@/lib/route'
import { GuildCreate } from '@/lib/schemas'

// Types guild_* dans la cloche seulement (D-C17) : aucun push à drainer.
export const GET = route({ fn: 'guild_get' })

export const POST = route({
  fn: 'guild_create',
  input: GuildCreate,
  idem: true,
  status: 201,
  args: (i) => ({ p_name: i.name, p_description: i.description }),
})
