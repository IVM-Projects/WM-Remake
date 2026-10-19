import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// Client lié à la session du cookie (vérification locale par getClaims()).
export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookieOptions: { name: process.env.NEXT_PUBLIC_AUTH_COOKIE_NAME || undefined },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        } catch {
          // Appel depuis un Server Component (cookies en lecture seule) : proxy.ts rafraîchit la session.
        }
      },
    },
  })
}
