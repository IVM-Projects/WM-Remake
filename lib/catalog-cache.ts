import { cacheLife, cacheTag } from 'next/cache'
import type { RpcResult } from '@/lib/route'
import { createAdminClient } from '@/lib/supabase/admin'

// Partie de wm.cards_page_shared lue ici ; le reste de la réponse passe tel quel.
export type SharedPage = { cards: { id: string }[]; total: number | null; rarityCounts?: Record<string, number>; searchHasMore?: boolean }

// Clé du cache : trim et minuscules seulement ; accents et espaces intérieurs comptent en SQL (2 caractères : préfixe tel quel).
export const normalizeQ = (q: string | undefined): string | null => q?.trim().toLowerCase() || null

// Page sans joueur, la même pour tous (M2-14) : les arguments forment la clé, revalidée par POST /api/cron/revalidate.
export async function sharedCardsPage(page: number, sort: 'rarity', q: string | null, rarity: string[] | null): Promise<RpcResult> {
  'use cache: remote'
  cacheTag('catalog')
  cacheLife('hours')
  const { data, error } = await createAdminClient().schema('wm').rpc('cards_page_shared', { p_page: page, p_sort: sort, p_q: q, p_rarity: rarity })
  // P14 : une erreur levée ici perdrait code et details en traversant le cache ; un P0001 est déterministe, donc rendu (et caché).
  if (error?.code === 'P0001') return { data: null, error: { code: error.code, message: error.message, details: error.details } }
  // shortcut: toute autre erreur, 55P03 et 57014 compris, devient un 500 et non un 503 BUSY ; la rendre sous cacheLife('seconds') si des 500 apparaissent sous charge.
  if (error) {
    // Le catch-all de route() journalise pg_code: null ; ce code-là décide du passage au shortcut ci-dessus.
    console.error(JSON.stringify({ rpc: 'cards_page_shared', pg_code: error.code ?? null }))
    throw new Error(`cards_page_shared : ${error.code}`)
  }
  return { data, error: null }
}

// Appel de /api/cards : souhaits et manquantes par joueur sans cache ; sinon page partagée en cache + overlay du joueur.
export async function cardsCall(args: Record<string, unknown>): Promise<RpcResult> {
  const wm = createAdminClient().schema('wm')
  if (args.p_wishlist || args.p_missing) return await wm.rpc('cards_page', args)
  const rarity = args.p_rarity as string[] | undefined
  const shared = await sharedCardsPage(args.p_page as number, 'rarity', normalizeQ(args.p_q as string | undefined),
    rarity?.length ? [...new Set(rarity)].sort() : null)
  if (shared.error) return shared
  const page = shared.data as SharedPage
  const overlay = await wm.rpc('cards_overlay', { p_uid: args.p_uid, p_card_ids: page.cards.map((c) => c.id) })
  return overlay.error ? overlay : { data: { ...page, ...overlay.data }, error: null }
}
