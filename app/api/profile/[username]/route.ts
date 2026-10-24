import { z } from 'zod'
import { route } from '@/lib/route'
import { ProfilePatch, Username } from '@/lib/schemas'

const Params = z.object({ username: Username })

export const GET = route({ fn: 'profile_get', params: Params, args: (_, { params }) => ({ p_username: params.username }) })

export const PATCH = route({
  fn: 'profile_update',
  params: Params,
  input: ProfilePatch,
  idem: true,
  args: (i, { params }) => ({
    p_username: params.username,
    p_bio: i.bio ?? null,
    p_is_public: i.is_public ?? null,
    p_avatar_user_card_id: i.avatar_user_card_id ?? null,
    p_avatar_set: i.avatar_user_card_id !== undefined,
  }),
})
