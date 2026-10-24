import { ECDH } from 'node:crypto'
import { fail, route } from '@/lib/route'
import { PushEndpoint, PushSubscriptionBody } from '@/lib/schemas'

// Origine refusée en SQL (B9) : 400 « Service de notifications non pris en charge ».
export const POST = route({
  fn: 'push_subscribe',
  input: PushSubscriptionBody,
  idem: true,
  // Un point hors de la courbe ferait lever chaque envoi ; contrôlé ici, lib/schemas.ts partant au navigateur. Le corps d'un refus zod.
  pre: async ({ keys }) => {
    try {
      ECDH.convertKey(keys.p256dh, 'prime256v1', 'base64url')
    } catch {
      return fail(400, 'Abonnement push invalide', 'invalid_request')
    }
  },
  args: (i) => ({ p_endpoint: i.endpoint, p_p256dh: i.keys.p256dh, p_auth: i.keys.auth }),
})

// Un endpoint inconnu, ou repris par un autre joueur, rend { ok: true } sans rien toucher.
export const DELETE = route({ fn: 'push_unsubscribe', input: PushEndpoint, idem: true, args: (i) => ({ p_endpoint: i.endpoint }) })
