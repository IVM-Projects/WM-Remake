import type { NextRequest } from 'next/server'
import { safeNext } from '@/lib/gate'
import { createClient } from '@/lib/supabase/server'

// Lien d'e-mail (PKCE) : le code s'échange contre la session grâce au vérificateur laissé en cookie par le navigateur.
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const next = safeNext(searchParams.get('next'))
  const code = searchParams.get('code')
  const failed = !code || !!(await (await createClient()).auth.exchangeCodeForSession(code)).error
  const target = failed ? (next === '/reset-password' ? '/reset-password?error=invalid' : '/login?error=invalid') : next
  // Location relative : request.url porte l'hôte de `next start` (localhost), pas celui qu'a ouvert le navigateur.
  return new Response(null, { status: 307, headers: { location: target } })
}
