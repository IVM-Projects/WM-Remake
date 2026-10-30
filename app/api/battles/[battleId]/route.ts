import { route } from '@/lib/route'
import { BattleAction, BattleParams } from '@/lib/schemas'

export const GET = route({ fn: 'battle_detail', params: BattleParams, args: (_, { params }) => ({ p_battle_id: params.battleId }) })

// Sans push : aucun type battle_* n'est dans push_types, un drain n'y trouverait rien (C10, M5a-13).
export const PATCH = route({
  fn: 'battle_action',
  params: BattleParams,
  input: BattleAction,
  idem: true,
  args: (i, { params }) => ({ p_battle_id: params.battleId, p_action: i.action, p_payload: i }),
})
