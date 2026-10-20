import { z } from 'zod'
import { route } from '@/lib/route'

// Corps facultatif et ignoré : une extension envoie { count: 1 } (R§3.1).
export const POST = route({ fn: 'open_pack', input: z.looseObject({}), idem: true, args: (_, { tz }) => ({ p_tz: tz }) })
