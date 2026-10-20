import { z } from 'zod'
import { route } from '@/lib/route'

export const GET = route({ fn: 'special_packs' })
export const POST = route({ fn: 'claim_special', input: z.object({ packId: z.uuid() }), idem: true, args: (i) => ({ p_pack_id: i.packId }) })
