-- ADDITIVE : mise en vente en séquestre, retrait, baisse de prix (D§7.5, M3-14, M3-16, M3-17). Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

create or replace function wm.create_auction(p_uid uuid, p_card_id uuid, p_base_amount int, p_duration_minutes int, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_actor jsonb;
  v_max int;
  k public.user_cards;
  a public.auctions;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  v_actor := wm.actor(p_uid);
  if not coalesce((select value @> to_jsonb(p_duration_minutes) from wm.config where key = 'auction_durations'), false) then
    perform wm.raise_err(400, 'invalid_request', 'Durée d''enchère invalide');
  end if;
  if coalesce(p_base_amount, 0) < 1 then
    perform wm.raise_err(400, 'invalid_request', 'La mise de départ doit être d''au moins 1 wikibidou');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_users(array[p_uid]);
  perform wm.market_guard(p_uid, 'list');
  -- shortcut: aucun verrou d'échange avant le M4 (M3-9) ; le 409 « Cette carte est déjà engagée dans un échange en attente » arrive avec
  -- trades, ici en même temps que dans discard et bulk_discard.
  select * into k from public.user_cards where id = p_card_id and user_id = p_uid for update;
  if not found then  -- id catalogue : la plus ancienne copie du vendeur
    select * into k from public.user_cards where card_id = p_card_id and user_id = p_uid order by obtained_at, id limit 1 for update;
  end if;
  if not found then
    perform wm.raise_err(403, '42501', 'Vous ne possédez pas cette carte');
  end if;
  v_max := (select (value ->> case when (v_actor ->> 'is_pro')::boolean or (v_actor ->> 'is_vip')::boolean then 'pro' else 'free' end)::int
            from wm.config where key = 'max_concurrent_auctions');
  -- Échues non réglées comprises : elles sont encore active (M3-14).
  if (select count(*) from public.auctions where seller_id = p_uid and status = 'active') >= v_max then
    perform wm.raise_err(409, null, format('Limite de %s enchères actives atteinte', v_max));
  end if;
  insert into public.auctions (seller_id, card_id, user_card_id, snapshot_rarity, snapshot_atk, snapshot_def, snapshot_search_document,
    is_shiny, base_amount, listing_base_amount, end_at)
  select p_uid, k.card_id, k.id, k.snapshot_rarity, k.snapshot_atk, k.snapshot_def,
    concat_ws(' ', k.snapshot_title, k.snapshot_category, left(c.summary, 300)), k.is_shiny, p_base_amount, p_base_amount,
    clock_timestamp() + make_interval(mins => p_duration_minutes)
  from public.cards c where c.id = k.card_id
  returning * into a;
  perform wm.escrow_put(a.id, k, p_duration_minutes);
  insert into wm.wishlist_alert_queue (auction_id) values (a.id);
  perform wm.market_tick(p_uid, 'list');
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('auction_id', a.id, 'id', a.id, 'end_at', a.end_at));
end $$;

-- Refus communs au retrait et à la baisse (M3-16, M3-17), sous le verrou de l'enchère, première étape de C4.
create or replace function wm.seller_auction(p_uid uuid, p_auction_id uuid)
returns public.auctions language plpgsql security definer set search_path = '' as $$
declare a public.auctions;
begin
  select * into a from public.auctions where id = p_auction_id for update;
  if not found then
    perform wm.raise_err(404, null, 'Enchère introuvable');
  end if;
  if a.seller_id <> p_uid then
    perform wm.raise_err(403, null, 'Seul le vendeur peut modifier cette enchère');
  end if;
  if a.status <> 'active' then
    perform wm.raise_err(409, null, 'Cette enchère est terminée');
  end if;
  return a;
end $$;

-- Échue sans mise et pas encore réglée : retrait permis (M3-16). La copie revient sous un id neuf, sans étiquettes (M3-7).
create or replace function wm.cancel_auction(p_uid uuid, p_auction_id uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  a public.auctions;
  u public.user_cards;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  perform set_config('lock_timeout', '2s', true);
  a := wm.seller_auction(p_uid, p_auction_id);
  if a.bids_count > 0 then
    perform wm.raise_err(409, null, 'Une enchère en cours ne peut pas être retirée');
  end if;
  perform wm.lock_users(array[a.seller_id]);
  u := wm.escrow_release(a.id, a.seller_id);
  update public.auctions set status = 'cancelled' where id = a.id;
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('ok', true, 'user_card_id', u.id));
end $$;

-- Une fois, après la moitié de la durée (lue au séquestre), au plus la moitié du prix d'origine (M3-17). N'écrit que l'enchère : aucun profil.
create or replace function wm.reprice_auction(p_uid uuid, p_auction_id uuid, p_new_base_amount int, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_n int;
  a public.auctions;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  perform set_config('lock_timeout', '2s', true);
  a := wm.seller_auction(p_uid, p_auction_id);
  if a.bids_count > 0 then
    perform wm.raise_err(409, null, 'Une enchère en cours ne peut pas être modifiée');
  end if;
  if a.base_repriced_at is not null then
    perform wm.raise_err(409, null, 'Le prix a déjà été baissé une fois');
  end if;
  if clock_timestamp() < a.created_at + (select make_interval(mins => duration_minutes) / 2 from wm.auction_escrow where auction_id = a.id) then
    perform wm.raise_err(409, null, 'Le prix ne peut être baissé qu''après la moitié de la durée');
  end if;
  v_n := a.listing_base_amount / 2;
  if coalesce(p_new_base_amount, 0) not between 1 and v_n then
    perform wm.raise_err(400, 'invalid_request', format('Le nouveau prix doit être compris entre 1 et %s wikibidous', v_n));
  end if;
  update public.auctions set base_amount = p_new_base_amount, base_repriced_at = clock_timestamp() where id = a.id
  returning * into a;
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('ok', true, 'base_amount', a.base_amount, 'base_repriced_at', a.base_repriced_at));
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
