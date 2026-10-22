import { createBrowserSupabase } from '@/lib/supabase/browser'

// Liste de souhaits du joueur, sous RLS (P19) : modale de carte et bouton rond du détail d'une enchère.
// null : lecture en échec, état inconnu (« Ajouter » reste sûr, un doublon revient en 23505).
export async function readWished(cardId: string): Promise<boolean | null> {
  const { data, error } = await createBrowserSupabase().from('wishlist_items').select('card_id').eq('card_id', cardId).maybeSingle()
  return error ? null : !!data
}

// true : l'état voulu (on = dans la liste) est atteint.
export async function saveWished(cardId: string, on: boolean): Promise<boolean> {
  const sb = createBrowserSupabase()
  const { data: auth } = await sb.auth.getSession()
  // select : une écriture que la RLS écarte ne renvoie aucune ligne, ce n'est pas un succès.
  const { data: rows, error } = on
    ? await sb.from('wishlist_items').insert({ user_id: auth.session?.user.id, card_id: cardId }).select('card_id')
    : await sb.from('wishlist_items').delete().eq('card_id', cardId).select('card_id')
  // 23505 : déjà dans la liste (autre onglet), l'état voulu est atteint.
  return error?.code === '23505' || (!error && !!rows?.length)
}
