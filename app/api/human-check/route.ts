import { z } from 'zod'
import { fail, route } from '@/lib/route'
import { verifyTurnstile } from '@/lib/turnstile'

const FAILED = fail(400, 'Vérification anti-bot échouée, réessaie.', 'human_check_failed')

export const POST = route({
  fn: 'set_human_verified',
  input: z.object({ token: z.string().min(1).max(2048) }),
  pre: async ({ token }, req) => {
    // Première entrée de x-forwarded-for : l'IP du client posée par Vercel.
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || null
    // ok: false en plus du corps D§8.2 : la réponse documentée est { ok: boolean } (R§3.1).
    if (!(await verifyTurnstile(token, ip))) return { ...FAILED, body: { ok: false, ...FAILED.body } }
  },
})
