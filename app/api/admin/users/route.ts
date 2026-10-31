import { route } from '@/lib/route'
import { AdminSearchQuery } from '@/lib/schemas'

export const GET = route({ fn: 'staff_user_search', input: AdminSearchQuery, args: (i) => ({ p_q: i.q }) })
