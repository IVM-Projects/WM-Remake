import { NextResponse, type NextRequest } from 'next/server'
import { assertBrandSafe, brand } from '@/lib/brand'
import { GATE_COOKIE, gateDecision, gateEnv, isGateCookieValid } from '@/lib/gate'
import { isGameRoute } from '@/lib/routes'
import { updateSession } from '@/lib/supabase/proxy'

function redirectWithNext(request: NextRequest, pathname: string, next: string): NextResponse {
  const url = new URL(pathname, request.url)
  url.searchParams.set('next', next)
  return NextResponse.redirect(url)
}

async function handle(request: NextRequest, gate: ReturnType<typeof gateEnv>): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl
  // Ici et non dans next.config `redirects` : les `headers` de la config ne s'appliquent pas à ces redirections (X-Robots-Tag absent).
  if (pathname === '/pull') return NextResponse.redirect(new URL(`/pulls${search}`, request.url), 308)
  const cookieValid = !!gate && (await isGateCookieValid(request.cookies.get(GATE_COOKIE)?.value, gate.secret, gate.password))
  const decision = gateDecision(pathname, !!gate, cookieValid)
  if (decision === 'unauthorized') {
    return NextResponse.json({ error: 'Accès réservé', message: 'Accès réservé' }, { status: 401 })
  }
  if (decision === 'redirect') return redirectWithNext(request, '/gate', pathname + search)

  const { response, userId } = await updateSession(request)
  if (userId !== null || !isGameRoute(pathname)) return response
  const login = redirectWithNext(request, '/login', pathname)
  // Garde les Set-Cookie du rafraîchissement (ou de l'effacement) de session.
  response.cookies.getAll().forEach((c) => login.cookies.set(c))
  return login
}

export async function proxy(request: NextRequest) {
  let gate: ReturnType<typeof gateEnv>
  try {
    // brand.name est figé au build, la porte lue à l'exécution : porte à moitié configurée ou marque d'origine sans porte → 500.
    gate = gateEnv()
    assertBrandSafe(brand.name, gate?.password)
  } catch {
    return NextResponse.json({ error: 'Configuration invalide', message: 'Configuration invalide' }, { status: 500 })
  }
  const response = await handle(request, gate)
  if (gate) response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  return response
}

export const config = {
  // Aucune exclusion par extension : `/marketplace/x.png` passerait sinon la porte. Les polices sont sous _next/static.
  matcher: ['/((?!_next/static|_next/image).*)'],
}
