import { route } from '@/lib/route'
import { BattleCreate } from '@/lib/schemas'

export const GET = route({ fn: 'battles_list', args: (_, { tz }) => ({ p_tz: tz }) })

export const POST = route({
  fn: 'battle_create',
  input: BattleCreate,
  idem: true,
  status: 201,
  args: (i, { tz }) => ({ p_opponent_id: i.opponent_id, p_tz: tz }),
})
