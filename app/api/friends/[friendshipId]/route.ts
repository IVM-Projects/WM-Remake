import { z } from 'zod'
import { route } from '@/lib/route'
import { FriendshipParams, pgText } from '@/lib/schemas'

// action validée en SQL : une valeur inconnue → 400 « Action inconnue » (P11).
export const PATCH = route({
  fn: 'friend_action',
  params: FriendshipParams,
  input: z.object({ action: pgText }),
  idem: true,
  args: (i, { params }) => ({ p_friendship_id: params.friendshipId, p_action: i.action }),
})

export const DELETE = route({
  fn: 'friend_remove',
  params: FriendshipParams,
  idem: true,
  args: (_, { params }) => ({ p_friendship_id: params.friendshipId }),
})
