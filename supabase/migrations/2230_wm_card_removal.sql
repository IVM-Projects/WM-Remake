-- ADDITIVE : retrait d'une carte par le staff (G6) — sortie du pool, enchères actives dénouées (meneur remboursé, copie rendue au vendeur),
-- échanges en attente annulés, souhaits de guilde ouverts supprimés, vitrines et avatars de ses copies vidés, banque et file de quiz
-- effacées ; remise (G7), effacement d'une banque de quiz, fiche et liste des retraits. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- Enchère dénouée, sous les verrous de l'appelant (l'enchère, les profils du vendeur et du meneur) ; rend la mise rendue (0 sans mise).
create or replace function wm.auction_void(p_auction_id uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare
  a public.auctions;
  v_bid uuid;
begin
  select * into a from public.auctions where id = p_auction_id;
  if not found or a.status <> 'active' then
    return 0;
  end if;
  -- Avant escrow_release : notification_data lit le séquestre.
  perform wm.notify_auction(array[a.seller_id, a.current_bidder_id], 'auction_voided', a.id, a.current_bid);
  if a.current_bidder_id is not null then
    -- Chemin de wm.place_bid : la dernière mise du meneur, remboursée sous sa référence.
    select id into v_bid from public.auction_bids where auction_id = a.id and bidder_id = a.current_bidder_id
    order by placed_at desc limit 1;
    perform wm.wallet_apply(a.current_bidder_id, a.current_bid, 'refund', 'refund:' || v_bid);
  end if;
  perform wm.escrow_release(a.id, a.seller_id);
  update public.auctions set status = 'cancelled' where id = a.id;
  return coalesce(a.current_bid, 0);
end $$;

-- Échange en attente annulé, sous le verrou de l'appelant ; aucun argent (un échange en attente ne retient rien).
create or replace function wm.trade_void(p_trade_id uuid, p_except uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.trades;
begin
  update public.trades set status = 'cancelled', closed_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = p_trade_id and status = 'pending'
  returning * into t;
  if found then
    perform wm.notify_trade(array_remove(array[t.initiator_id, t.recipient_id], p_except), 'trade_voided', t.id, null);
  end if;
end $$;

create or replace function wm.admin_card_remove(p_uid uuid, p_card_id uuid, p_reason text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_reason text;
  v_wishes uuid[];
  v_trades uuid[];
  v_auctions uuid[];
  v_id uuid;
  v_n jsonb;
  v_showcase int;
  v_quiz int;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.staff_actor(p_uid, 'admin');
  v_reason := wm.admin_reason(p_reason);
  if not exists (select from public.cards where id = p_card_id) then
    perform wm.raise_err(404, null, 'Carte introuvable');
  end if;
  perform set_config('lock_timeout', '2s', true);
  -- Avant toute enchère ou tout échange : sérialise deux retraits de la même carte.
  insert into wm.card_removals (card_id, reason, removed_by) values (p_card_id, v_reason, p_uid) on conflict do nothing;
  if not found then
    perform wm.raise_err(409, null, 'Cette carte est déjà retirée');
  end if;
  -- Ordre C4 : souhaits ouverts, échanges en attente, enchères actives, puis les profils.
  select coalesce(array_agg(w.id order by w.id), '{}') into v_wishes
  from (select id from public.guild_wishlists where card_id = p_card_id and fulfilled_at is null order by id for update) w;
  select coalesce(array_agg(t.id order by t.id), '{}') into v_trades
  from (select id from public.trades where status = 'pending'
    and id in (select trade_id from public.trade_items where card_id = p_card_id) order by id for update) t;
  select coalesce(array_agg(a.id order by a.id), '{}') into v_auctions
  from (select id from public.auctions where card_id = p_card_id and status = 'active' order by id for update) a;
  -- shortcut: lock_users de tous les propriétaires concernés en une fois ; une carte très répandue tient des milliers de profils, lots au M8 si un retrait expire en 503.
  perform wm.lock_users(array(
    select seller_id from public.auctions where id = any (v_auctions)
    union select current_bidder_id from public.auctions where id = any (v_auctions) and current_bidder_id is not null
    union select unnest(array[initiator_id, recipient_id]) from public.trades where id = any (v_trades)
    union select s.user_id from public.showcase s join public.user_cards uc on uc.id = s.user_card_id where uc.card_id = p_card_id
    -- Prédicat de wm.card_avatar_clear : ses profils sont ainsi déjà tenus, dans l'ordre.
    union select p.id from public.profiles p
    where p.avatar_user_card_id in (select uc.id from public.user_cards uc where uc.card_id = p_card_id)
      or (p.avatar_user_card_id is null and p.avatar_url is not null
        and p.avatar_url = (select c.image_url from public.cards c where c.id = p_card_id))));
  foreach v_id in array v_auctions loop
    perform wm.auction_void(v_id);
  end loop;
  foreach v_id in array v_trades loop
    perform wm.trade_void(v_id);
  end loop;
  delete from public.guild_wishlists where id = any (v_wishes) and fulfilled_at is null;
  delete from public.showcase where user_card_id in (select id from public.user_cards where card_id = p_card_id);
  get diagnostics v_showcase = row_count;
  v_n := jsonb_build_object('voided_auctions', cardinality(v_auctions), 'cancelled_trades', cardinality(v_trades),
    'removed_wishes', cardinality(v_wishes), 'cleared_showcase', v_showcase, 'cleared_avatars', wm.card_avatar_clear(p_card_id));
  perform wm.pool_remove(p_card_id);
  delete from wm.card_quizzes where card_id = p_card_id;
  get diagnostics v_quiz = row_count;
  delete from wm.quiz_queue where card_id = p_card_id;
  v_n := v_n || jsonb_build_object('quiz_bank_deleted', v_quiz > 0);
  perform wm.staff_log(p_uid, 'card_remove', 'card', p_card_id::text, v_reason, v_n);
  return wm.idem_store(p_uid, p_idem, '{"ok": true}'::jsonb || v_n);
end $$;

-- Remise (G7) : les engagements dénoués ne reviennent pas.
create or replace function wm.admin_card_restore(p_uid uuid, p_card_id uuid, p_reason text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_reason text;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.staff_actor(p_uid, 'admin');
  v_reason := wm.admin_reason(p_reason);
  perform set_config('lock_timeout', '2s', true);
  delete from wm.card_removals where card_id = p_card_id;
  if not found then
    perform wm.raise_err(409, null, 'Cette carte n''est pas retirée');
  end if;
  perform wm.pool_add(p_card_id, (select rarity from public.cards where id = p_card_id));
  perform wm.staff_log(p_uid, 'card_restore', 'card', p_card_id::text, v_reason);
  return wm.idem_store(p_uid, p_idem, '{"ok": true}');
end $$;

-- Banque de quiz effacée (S:91) ; wm.quiz_ensure la recrée à la demande.
create or replace function wm.admin_quiz_bank_clear(p_uid uuid, p_card_id uuid, p_reason text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_reason text;
  v_n int;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.staff_actor(p_uid, 'admin');
  v_reason := wm.admin_reason(p_reason);
  if not exists (select from public.cards where id = p_card_id) then
    perform wm.raise_err(404, null, 'Carte introuvable');
  end if;
  perform set_config('lock_timeout', '2s', true);
  delete from wm.card_quizzes where card_id = p_card_id;
  get diagnostics v_n = row_count;
  perform wm.staff_log(p_uid, 'quiz_clear', 'card', p_card_id::text, v_reason, jsonb_build_object('deleted', v_n > 0));
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('ok', true, 'deleted', v_n > 0));
end $$;

create or replace function wm.staff_card(p_uid uuid, p_card_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  c public.cards;
  v_copies uuid[];
begin
  perform wm.staff_actor(p_uid);
  select * into c from public.cards where id = p_card_id;
  if not found then
    perform wm.raise_err(404, null, 'Carte introuvable');
  end if;
  v_copies := array(select id from public.user_cards where card_id = c.id);
  return jsonb_build_object(
    'card', jsonb_build_object('id', c.id, 'wikipedia_title', c.wikipedia_title, 'rarity', c.rarity, 'image_url', c.image_url,
      'hide_image', c.hide_image, 'nsfw_image', c.nsfw_image, 'in_pool', exists (select from wm.draw_pool where card_id = c.id)),
    'removal', (select jsonb_build_object('reason', k.reason, 'removed_at', k.removed_at,
      'removed_by_username', (select p.username from public.profiles p where p.id = k.removed_by))
      from wm.card_removals k where k.card_id = c.id),
    'image_reports', (select count(*) from wm.card_image_reports where card_id = c.id),
    'quiz_bank', exists (select from wm.card_quizzes where card_id = c.id),
    'engagements', jsonb_build_object(
      'active_auctions', (select count(*) from public.auctions where card_id = c.id and status = 'active'),
      'pending_trades', (select count(*) from public.trades where status = 'pending'
        and id in (select trade_id from public.trade_items where card_id = c.id)),
      'open_wishes', (select count(*) from public.guild_wishlists where card_id = c.id and fulfilled_at is null),
      'showcase', (select count(*) from public.showcase where user_card_id = any (v_copies)),
      'avatars', (select count(*) from public.profiles p where p.avatar_user_card_id = any (v_copies)
        or (p.avatar_user_card_id is null and p.avatar_url is not null and p.avatar_url = c.image_url))));
end $$;

create or replace function wm.staff_card_removals(p_uid uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform wm.staff_actor(p_uid);
  return jsonb_build_object('removals', coalesce((select jsonb_agg(jsonb_build_object('card_id', r.card_id,
      'wikipedia_title', r.wikipedia_title, 'reason', r.reason, 'removed_at', r.removed_at, 'removed_by_username', r.removed_by_username)
      order by r.removed_at desc, r.card_id)
    from (select k.card_id, c.wikipedia_title, k.reason, k.removed_at, p.username removed_by_username
      from wm.card_removals k join public.cards c on c.id = k.card_id left join public.profiles p on p.id = k.removed_by
      order by k.removed_at desc, k.card_id
      limit coalesce((select (value ->> 'removals')::int from wm.config where key = 'admin'), 100)) r), '[]'));
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
