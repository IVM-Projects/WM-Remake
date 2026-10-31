import { revalidateTag } from 'next/cache'
import type { RpcResult } from '@/lib/route'
import { createAdminClient } from '@/lib/supabase/admin'

// La RPC, puis le catalogue revalidé sur un succès.
export function withCatalogRevalidate(fn: string): (args: Record<string, unknown>) => Promise<RpcResult> {
  return async (args) => {
    const res = await createAdminClient().schema('wm').rpc(fn, args)
    // Action du staff : la carte retirée ou masquée doit disparaître dès la requête suivante (G15).
    if (!res.error) revalidateTag('catalog', { expire: 0 })
    return res
  }
}
