-- ADDITIVE : mise avec débit immédiat, remboursement de l'ancien meneur, anti-snipe (D§7.5, M3-11…M3-15, P7). Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

create or replace function wm.place_bid(p_uid uuid, p_auction_id uuid, p_amount int, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_snipe jsonb := (select value from wm.config where key = 'antisnipe');
  v_resp jsonb;
  v_min int;
  v_bal int;
  v_bid uuid;
  v_prev public.auction_bids;
  a public.auctions;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  perform set_config('lock_timeout', '2s', true);
  select * into a from public.auctions where id = p_auction_id for update;
  if not found then
    perform wm.raise_err(404, null, 'Enchère introuvable');
  end if;
  -- Heure réelle sous le verrou : une mise qui a attendu ne passe pas après la fin (M3-11).
  if a.status <> 'active' or a.end_at <= clock_timestamp() then
    perform wm.raise_err(409, null, 'Cette enchère est terminée');
  end if;
  if a.seller_id = p_uid then
    perform wm.raise_err(409, null, 'Tu ne peux pas enchérir sur ta propre vente');
  end if;
  if a.current_bidder_id = p_uid then
    perform wm.raise_err(409, null, 'Tu es déjà en tête');
  end if;
  v_min := wm.min_next_bid(a);
  if coalesce(p_amount, 0) < v_min then
    perform wm.raise_err(409, 'bid_too_low', format('Mise trop basse (minimum %s wikibidous)', v_min), jsonb_build_object('min', v_min));
  end if;
  -- Miseur et ancien meneur d'un coup, triés (M3-12) : wallet_apply ne prend ensuite plus aucun verrou.
  perform wm.lock_users(array[p_uid, a.current_bidder_id]);
  perform wm.market_guard(p_uid, 'bid');
  -- Mise à rembourser : la dernière du meneur, celui dont le profil est verrouillé.
  select * into v_prev from public.auction_bids where auction_id = a.id and bidder_id = a.current_bidder_id order by placed_at desc limit 1;
  insert into public.auction_bids (auction_id, bidder_id, amount, placed_at) values (a.id, p_uid, p_amount, clock_timestamp())
  returning id into v_bid;
  v_bal := wm.wallet_apply(p_uid, -p_amount, 'bid', 'bid:' || v_bid);  -- insufficient_balance annule tout, mise comprise
  if v_prev.id is not null then
    perform wm.wallet_apply(v_prev.bidder_id, v_prev.amount, 'refund', 'refund:' || v_prev.id);
  end if;
  update public.auctions set current_bid = p_amount, current_bidder_id = p_uid, bids_count = bids_count + 1,
    end_at = end_at + case when end_at - clock_timestamp() < make_interval(secs => (v_snipe ->> 'window_s')::int)
      then make_interval(secs => (v_snipe ->> 'extend_s')::int) else interval '0' end
  where id = a.id
  returning * into a;
  perform wm.notify_auction(array[v_prev.bidder_id], 'auction_outbid', a.id, p_amount);
  perform wm.market_tick(p_uid, 'bid');
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('current_bid', a.current_bid, 'bidder_balance', v_bal, 'balance', v_bal,
    'end_at', a.end_at, 'min_next_bid', wm.min_next_bid(a)));
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
