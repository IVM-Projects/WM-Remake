import { z } from 'zod'
import { route } from '@/lib/route'
import { Username } from '@/lib/schemas'

export const POST = route({ fn: 'change_username', input: z.object({ username: Username }), args: (i) => ({ p_username: i.username }) })
