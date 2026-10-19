import 'server-only'
import { createClient } from '@supabase/supabase-js'

// Clé secrète (service_role) : seul rôle autorisé à exécuter wm.*. Jamais de session.
export function createAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
