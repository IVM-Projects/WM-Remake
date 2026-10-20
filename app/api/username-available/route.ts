import { z } from 'zod'
import { route } from '@/lib/route'
import { Username } from '@/lib/schemas'

// Sans session : vérification préalable du formulaire d'inscription (D§7.1).
export const GET = route({ fn: 'username_available', auth: false, input: z.object({ u: Username }), args: (i) => ({ p_username: i.u }) })
