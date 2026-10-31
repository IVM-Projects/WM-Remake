import { route } from '@/lib/route'

// Rôle du lecteur ({role: null} pour un joueur, jamais un 403) : lien « Administration » (G14).
export const GET = route({ fn: 'staff_me' })
