import { route } from '@/lib/route'
import { AchievementCheck } from '@/lib/schemas'

// L'événement n'est validé que ici : il ne part pas en SQL. Limité en SQL (429), sans push.
export const POST = route({ fn: 'achievements_check', input: AchievementCheck, idem: true })
