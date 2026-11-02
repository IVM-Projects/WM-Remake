import { route } from '@/lib/route'

// Dotations en attente (C6) ; access_check par route() (lecture).
export const GET = route({ fn: 'grace_status' })
export const POST = route({ fn: 'claim_grace', idem: true })
