-- ADDITIVE : acceptation, refus, annulation et expiration d'un échange (D§7.6, R§3.6, M4-3, M4-4, M4-5, M4-9, M4-12, P3, P13, P25) — copies
-- déplacées en cinq instructions ensemblistes, WB nets par joueur, possession revérifiée sous les profils tenus. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- Seul update … set user_id permis hors défausse et enchères (M4-3) ; copies déjà verrouillées et vérifiées par l'appelant. k = éléments par
-- copie : k = n déplace la ligne (même id, même count), k < n crée une ligne de count k chez l'autre joueur et décrémente la source, sans fusion.
-- Ce qui arrive est sans étoile ni étiquette, et l'avatar d'un participant qui le montrait est effacé (P13 : pas de vitrine au M4a).
create or replace function wm.trade_move(p_trade public.trades)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_full uuid[];
  v_part uuid[];
  v_k int[];
begin
  select array_agg(x.id order by x.id) filter (where x.k = uc.count), array_agg(x.id order by x.id) filter (where x.k < uc.count),
    array_agg(x.k order by x.id) filter (where x.k < uc.count)
  into v_full, v_part, v_k
  from (select user_card_id id, count(*)::int k from public.trade_items where trade_id = p_trade.id group by user_card_id) x
  join public.user_cards uc on uc.id = x.id;
  update public.user_cards set user_id = case user_id when p_trade.initiator_id then p_trade.recipient_id else p_trade.initiator_id end,
    starred = false
  where id = any (v_full);
  insert into public.user_cards (user_id, card_id, count, starred, is_shiny, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk,
    snapshot_def, obtained_at)
  select case uc.user_id when p_trade.initiator_id then p_trade.recipient_id else p_trade.initiator_id end, uc.card_id, x.k, false, uc.is_shiny,
    uc.snapshot_title, uc.snapshot_rarity, uc.snapshot_category, uc.snapshot_atk, uc.snapshot_def, uc.obtained_at
  from unnest(v_part, v_k) x (id, k) join public.user_cards uc on uc.id = x.id;
  update public.user_cards set count = count - x.k from unnest(v_part, v_k) x (id, k) where user_cards.id = x.id;
  -- shortcut: un lien posé par l'ancien propriétaire pendant l'acceptation (insert concurrent qui attend la clé étrangère) survit sur la copie
  -- déplacée, invisible par RLS ; pour l'exclure, trigger after insert sur user_card_tags qui relit la copie for key share.
  delete from public.user_card_tags where user_card_id = any (v_full);
  update public.profiles set avatar_user_card_id = null
  where avatar_user_card_id = any (v_full) and id in (p_trade.initiator_id, p_trade.recipient_id);
end $$;

-- PATCH /api/trades/<id> (M4-9) → {status, trade}. p_tz est reçu, sans effet (C30). Refus et annulation ne verrouillent aucun profil.
create or replace function wm.trade_action(p_uid uuid, p_trade_id uuid, p_action text, p_tz text default null, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_now timestamptz;
  v_u uuid;
  v_d int;
  t public.trades;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if not coalesce(p_action in ('accept', 'decline', 'cancel'), false) then
    perform wm.raise_err(400, 'invalid_request', 'Action inconnue');
  end if;
  perform set_config('lock_timeout', '2s', true);
  -- L'échange d'abord, avant les profils (C4).
  select * into t from public.trades where id = p_trade_id and p_uid in (initiator_id, recipient_id) for update;
  if not found then
    perform wm.raise_err(404, null, 'Échange introuvable');
  end if;
  -- Garde d'échéance (M4-5) : le cron horaire passe jusqu'à une heure plus tard.
  if t.status <> 'pending' or t.expires_at <= clock_timestamp() then
    perform wm.raise_err(409, null, 'Cet échange n''est plus en attente (déjà traité)');
  end if;
  if p_uid <> (case p_action when 'cancel' then t.initiator_id else t.recipient_id end) then
    perform wm.raise_err(403, 'FORBIDDEN', case p_action when 'accept' then 'Seul le destinataire peut accepter cet échange'
      when 'decline' then 'Seul le destinataire peut refuser cet échange' else 'Seul l''initiateur peut annuler cet échange' end);
  end if;
  if p_action = 'accept' then
    perform wm.lock_users(array[t.initiator_id, t.recipient_id]);
    -- P4 : amitié lue sans verrou ; un retrait concurrent attend la ligne de l'échange, ou l'a déjà annulé.
    if not wm.are_friends(t.initiator_id, t.recipient_id) then
      perform wm.raise_err(403, 'FORBIDDEN', 'Vous devez être amis pour échanger');
    end if;
    -- Copies des deux joueurs seulement, par id (P25) : une copie partie chez un tiers manque au compte, sans attendre ni bloquer le tiers.
    perform from public.user_cards where id = any (array(select user_card_id from public.trade_items where trade_id = t.id))
      and user_id in (t.initiator_id, t.recipient_id) order by id for update;
    if exists (select from public.trade_items i left join public.user_cards uc on uc.id = i.user_card_id and uc.user_id = i.offered_by
        where i.trade_id = t.id group by i.user_card_id having coalesce(max(uc.count), 0) < count(*)) then
      perform wm.raise_err(409, null, 'Une carte de cet échange n''est plus disponible');
    end if;
    perform wm.trade_move(t);
    -- WB nets (M4-4) : un seul appel par joueur au net non nul, par id croissant.
    for v_u, v_d in select u, d from (values (t.initiator_id, t.recipient_wikibidous - t.initiator_wikibidous),
        (t.recipient_id, t.initiator_wikibidous - t.recipient_wikibidous)) v (u, d) where d <> 0 order by u loop
      perform wm.wallet_apply(v_u, v_d, 'trade', 'trade:' || t.id);
    end loop;
  end if;
  v_now := clock_timestamp();
  update public.trades set status = case p_action when 'accept' then 'accepted' when 'decline' then 'declined' else 'cancelled' end::public.trade_status,
    accepted_at = case when p_action = 'accept' then v_now end, completed_at = case when p_action = 'accept' then v_now end,
    closed_at = v_now, updated_at = v_now
  where id = t.id returning * into t;
  -- trade_accepted et trade_declined à l'initiateur, trade_cancelled au destinataire (M4-12).
  perform wm.notify_trade(array[case p_action when 'cancel' then t.recipient_id else t.initiator_id end],
    case p_action when 'accept' then 'trade_accepted' when 'decline' then 'trade_declined' else 'trade_cancelled' end, t.id, p_uid);
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('status', t.status, 'trade', wm.trade_json(t)));
end $$;

-- Job horaire wm-trade-expire (9010, M4-5) : pending échus → expired, par lots ; ni actor (tourne pendant la maintenance), ni argent, ni
-- profil, ni notification. Une ligne tenue par une action en cours est sautée, et repassera.
create or replace function wm.expire_trades(p_batch int default 5000)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := clock_timestamp();  -- variable, pas l'appel : l'index partiel sur expires_at sert de borne (comme 1630)
  n int;
begin
  perform set_config('lock_timeout', '2s', true);
  update public.trades set status = 'expired', closed_at = clock_timestamp(), updated_at = clock_timestamp()
  where id in (select id from public.trades where status = 'pending' and expires_at <= v_now order by expires_at limit p_batch
    for update skip locked);
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
