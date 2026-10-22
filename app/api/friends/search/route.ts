import { z } from 'zod'
import { route } from '@/lib/route'
import { pgText } from '@/lib/schemas'

// Longueur minimale vérifiée en SQL : q absent ou trop court → 400 « La recherche demande au moins 2 caractères » (P12).
export const GET = route({ fn: 'friend_search', input: z.object({ q: pgText.optional() }), args: (i) => ({ p_q: i.q ?? null }) })
