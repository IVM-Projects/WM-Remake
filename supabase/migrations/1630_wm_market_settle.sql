-- ADDITIVE : règlement unique et idempotent (D§7.5, M3-18, P7…P9, P11) — par le cron (lot), par POST /settle et par le détail paresseux.
-- Idempotente. Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- {id, status, settled} ; settled vrai seulement si cet appel a réglé ; null si inconnue. Sans actor : le cron règle même en maintenance.
create or replace function wm.settle_auction(p_auction_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.auctions;
  v_at timestamptz;
begin
  perform set_config('lock_timeout', '2s', true);
  select * into a from public.auctions where id = p_auction_id for update;
  if not found then
    return null;
  end if;
  -- Heure réelle sous le verrou (M3-11) : une mise qui l'a tenu a pu repousser end_at.
  if a.status <> 'active' or a.end_at > clock_timestamp() then
    return jsonb_build_object('id', a.id, 'status', a.status, 'settled', false);
  end if;
  -- Déjà tenus dans un lot (P9) : rien de plus n'est pris. Les deux notifications ne touchent ensuite que des profils verrouillés.
  perform wm.lock_users(array[a.seller_id, a.current_bidder_id]);
  v_at := clock_timestamp();  -- P7
  -- shortcut: ni score de guilde du vendeur ni statistiques du marché avant le M5 (M3-9), qui les branche ici.
  if a.current_bidder_id is null then
    perform wm.notify_auction(array[a.seller_id], 'auction_unsold', a.id);  -- avant escrow_release, qui efface le séquestre lu ici
    perform wm.escrow_release(a.id, a.seller_id);
    update public.auctions set status = 'settled_unsold', settled_at = v_at where id = a.id returning * into a;
  else
    perform wm.notify_auction(array[a.current_bidder_id], 'auction_won', a.id, a.current_bid);
    perform wm.notify_auction(array[a.seller_id], 'auction_sold', a.id, a.current_bid);
    perform wm.escrow_release(a.id, a.current_bidder_id, v_at);
    perform wm.wallet_apply(a.seller_id, a.current_bid, 'settle', 'settle:' || a.id);
    update public.auctions set status = 'settled_sold', winner_id = current_bidder_id, final_price = current_bid, settled_at = v_at
    where id = a.id returning * into a;
  end if;
  return jsonb_build_object('id', a.id, 'status', a.status, 'settled', true);
end $$;

-- Lot du cron (P9) : enchères dues verrouillées, puis tous leurs vendeurs et meneurs d'un seul lock_users, avant la première. Une
-- sous-transaction validée garde ses verrous jusqu'à la fin du lot : pris enchère par enchère, ils ne seraient plus triés (cycle avec une mise).
-- Un 55P03 ici fait échouer le lot, rejoué au passage suivant ; une enchère en erreur est sautée et reste active (overdue_s, P13).
create or replace function wm.settle_due_auctions(p_limit int default 500)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := clock_timestamp();  -- variable, pas l'appel : l'index partiel sur end_at sert de borne
  v_ids uuid[];
  v_users uuid[];
  v_id uuid;
  v_state text;
  n int := 0;
begin
  perform set_config('lock_timeout', '2s', true);
  select coalesce(array_agg(id order by end_at), '{}'), array_agg(seller_id) || array_agg(current_bidder_id) into v_ids, v_users
  from (select id, end_at, seller_id, current_bidder_id from public.auctions
        where status = 'active' and end_at <= v_now order by end_at limit p_limit for update skip locked) d;
  perform wm.lock_users(v_users);
  foreach v_id in array v_ids loop
    begin
      if (wm.settle_auction(v_id) ->> 'settled')::boolean then
        n := n + 1;
      end if;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate;
      raise warning 'settle_due_auctions : enchère % sautée (%)', v_id, v_state;
    end;
  end loop;
  return n;
end $$;

-- POST /settle (P8) : refus d'abord sans verrou, puis d'après l'issue du règlement unique ; owned calculé pour p_uid (P11).
create or replace function wm.settle_request(p_uid uuid, p_auction_id uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  a public.auctions;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  select * into a from public.auctions where id = p_auction_id;
  if not found or a.status = 'cancelled' then
    perform wm.raise_err(404, null, 'Enchère introuvable');
  end if;
  if a.status = 'active' and a.end_at > clock_timestamp() then
    perform wm.raise_err(409, null, 'L''enchère n''est pas encore terminée');
  end if;
  -- Issue lue sous le verrou : une mise de dernière seconde (anti-snipe) ou un retrait a pu être validé pendant l'attente.
  v_resp := wm.settle_auction(a.id);
  if v_resp is null or v_resp ->> 'status' = 'cancelled' then
    perform wm.raise_err(404, null, 'Enchère introuvable');
  end if;
  if v_resp ->> 'status' = 'active' then
    perform wm.raise_err(409, null, 'L''enchère n''est pas encore terminée');
  end if;
  select * into a from public.auctions where id = a.id;
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('auction', wm.auction_json(a)
    || jsonb_build_object('owned', exists (select from public.user_cards where user_id = p_uid and card_id = a.card_id))));
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
