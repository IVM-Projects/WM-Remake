import { route } from '@/lib/route'
import { ShopQuery } from '@/lib/schemas'

// Boutique, en-tête, retour de Checkout (G31, G34) ; access_check par route() (lecture).
export const GET = route({ fn: 'shop_state', input: ShopQuery, args: (i) => ({ p_session: i.session ?? null }) })
