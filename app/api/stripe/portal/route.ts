import type { NextRequest } from 'next/server'
import { route } from '@/lib/route'
import { portalCall } from '@/lib/stripe'

// `fn` journalisé ; l'appel Stripe vit dans `call` (G31).
export const POST = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) =>
  route({ fn: 'stripe_portal_prepare', call: portalCall(new URL(req.url).origin) })(req, ctx)
