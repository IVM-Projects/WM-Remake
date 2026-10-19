'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { GATE_COOKIE, gateEnv, gateToken, isGateCookieValid, safeNext } from '@/lib/gate'

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

// Signature (état précédent, formulaire) imposée par useActionState ; renvoie le message d'erreur.
export async function enterGate(_prev: string | null, formData: FormData): Promise<string | null> {
  const field = (name: string) => {
    const v = formData.get(name)
    return typeof v === 'string' ? v : ''
  }
  const next = safeNext(field('next'))
  const gate = gateEnv()
  if (!gate) redirect(next)

  // HMAC des deux côtés puis comparaison à temps constant : ni le contenu ni la longueur du mot de passe ne fuient.
  const token = await gateToken(gate.secret, field('password'))
  if (!(await isGateCookieValid(token, gate.secret, gate.password))) return 'Mot de passe incorrect.'

  const host = (await headers()).get('host') ?? ''
  const store = await cookies()
  store.set(GATE_COOKIE, token, {
    httpOnly: true,
    secure: !LOCAL_HOST.test(host),
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  redirect(next)
}
