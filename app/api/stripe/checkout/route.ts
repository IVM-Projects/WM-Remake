import type { NextRequest } from 'next/server'
import { route } from '@/lib/route'
import { CheckoutInput } from '@/lib/schemas'
import { checkoutCall } from '@/lib/stripe'

// `fn` journalisé ; l'appel Stripe vit dans `call` (G31). Aucun montant ni Price lu du client : l'article seul.
export const POST = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) =>
  route({ fn: 'stripe_checkout_prepare', input: CheckoutInput, idem: true, args: (i) => ({ p_item: i.item }), call: checkoutCall(new URL(req.url).origin) })(req, ctx)
