import { createBrowserClient } from '@supabase/ssr'

// Singleton : @supabase/ssr réutilise le même client dans le navigateur (isSingleton par défaut).
export function createBrowserSupabase() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookieOptions: { name: process.env.NEXT_PUBLIC_AUTH_COOKIE_NAME || undefined },
  })
}
