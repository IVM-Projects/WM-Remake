import { route } from '@/lib/route'

// Jour compté dans le fuseau du joueur (x-wiki-calendar-tz, R§3.1).
export const GET = route({ fn: 'pro_daily_status', args: (_, { tz }) => ({ p_tz: tz }) })
export const POST = route({ fn: 'pro_daily_claim', idem: true, args: (_, { tz }) => ({ p_tz: tz }) })
