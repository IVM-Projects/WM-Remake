import { route } from '@/lib/route'
import { AchievementClaim } from '@/lib/schemas'

export const POST = route({
  fn: 'achievements_claim',
  input: AchievementClaim,
  idem: true,
  args: (i) => ({ p_achievement_id: i.achievement_id }),
})
