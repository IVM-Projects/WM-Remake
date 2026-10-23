-- ADDITIVE : création d'un échange entre amis et contre-offre (D§7.6, R§3.6, M4-2, M4-9, M4-12, P2, P3, P4, P5) — possession, plafonds
-- par côté, solde de l'initiateur ; la contre-offre clôt son parent en countered. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- p_items : [{user_card_id, card_id, offered_by}], une unité par élément ; le card_id du client est ignoré (P2). p_tz est reçu, sans effet
-- (C30). Sans séquestre ni verrou d'échange à la création (M4-2) : la même copie peut figurer dans deux échanges en attente. Messages
-- figés (tableau des erreurs du M4a) : ils ne suivent pas trade_limits.
create or replace function wm.create_trade(p_uid uuid, p_recipient_id uuid, p_items jsonb, p_initiator_wikibidous int default 0,
  p_recipient_wikibidous int default 0, p_parent_trade_id uuid default null, p_tz text default null, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_lim jsonb := (select value from wm.config where key = 'trade_limits');
  v_iwb int := coalesce(p_initiator_wikibidous, 0);
  v_rwb int := coalesce(p_recipient_wikibidous, 0);
  p public.trades;
  t public.trades;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if p_recipient_id = p_uid then
    perform wm.raise_err(400, 'invalid_request', 'Tu ne peux pas échanger avec toi-même');
  end if;
  if v_iwb not between 0 and (v_lim ->> 'wb')::int or v_rwb not between 0 and (v_lim ->> 'wb')::int then
    perform wm.raise_err(400, 'invalid_request', 'Entre 0 et 10 000 wikibidous par côté');
  end if;
  if exists (select from jsonb_to_recordset(p_items) x (offered_by uuid) where not coalesce(x.offered_by in (p_uid, p_recipient_id), false)) then
    perform wm.raise_err(400, 'invalid_request', 'Élément d''échange invalide');
  end if;
  if jsonb_array_length(coalesce(p_items, '[]')) = 0 then
    perform wm.raise_err(400, 'invalid_request', 'Un échange contient au moins une carte');
  end if;
  if exists (select from jsonb_to_recordset(p_items) x (offered_by uuid) group by x.offered_by having count(*) > (v_lim ->> 'cards')::int) then
    perform wm.raise_err(400, 'invalid_request', 'Au plus 100 cartes par côté');
  end if;
  perform set_config('lock_timeout', '2s', true);
  -- Contre-offre : le parent d'abord, avant les profils (C4).
  if p_parent_trade_id is not null then
    select * into p from public.trades where id = p_parent_trade_id and p_uid in (initiator_id, recipient_id) for update;
    if not found then
      perform wm.raise_err(404, null, 'Échange introuvable');
    end if;
    if p.status <> 'pending' or p.expires_at <= clock_timestamp() then
      perform wm.raise_err(409, null, 'Cet échange n''est plus en attente (déjà traité)');
    end if;
    if p_uid <> p.recipient_id then
      perform wm.raise_err(403, 'FORBIDDEN', 'Seul le destinataire peut faire une contre-offre');
    end if;
    if p_recipient_id is distinct from p.initiator_id then
      perform wm.raise_err(400, 'invalid_request', 'La contre-offre s''adresse à l''initiateur de l''échange');
    end if;
  end if;
  if not exists (select from public.profiles where id = p_recipient_id) then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  perform wm.lock_users(array[p_uid, p_recipient_id]);
  -- P4 : amitié lue sans verrou ; un retrait concurrent laisse l'échange en attente, refusé à l'acceptation (403).
  if not wm.are_friends(p_uid, p_recipient_id) then
    perform wm.raise_err(403, 'FORBIDDEN', 'Vous devez être amis pour échanger');
  end if;
  -- Possession sous les profils tenus : chaque copie à son offrant, en assez d'unités pour ses éléments.
  if exists (select from jsonb_to_recordset(p_items) x (user_card_id uuid, offered_by uuid)
      left join public.user_cards uc on uc.id = x.user_card_id and uc.user_id = x.offered_by
      group by x.user_card_id, x.offered_by having coalesce(max(uc.count), 0) < count(*)) then
    perform wm.raise_err(403, '42501', 'Vous ne possédez pas cette carte');
  end if;
  if (select wikibidous_balance from public.profiles where id = p_uid) < v_iwb then
    perform wm.raise_err(409, 'insufficient_balance', 'Solde insuffisant');
  end if;
  insert into public.trades (initiator_id, recipient_id, initiator_wikibidous, recipient_wikibidous, parent_trade_id, expires_at)
  values (p_uid, p_recipient_id, v_iwb, v_rwb, p_parent_trade_id,
    clock_timestamp() + make_interval(hours => (v_lim ->> 'expiry_h')::int))
  returning * into t;
  insert into public.trade_items (trade_id, offered_by, user_card_id, card_id, snapshot_rarity, is_shiny)
  select t.id, uc.user_id, uc.id, uc.card_id, uc.snapshot_rarity, uc.is_shiny
  from jsonb_to_recordset(p_items) x (user_card_id uuid) join public.user_cards uc on uc.id = x.user_card_id;
  update public.trades set status = 'countered', closed_at = clock_timestamp(), updated_at = clock_timestamp() where id = p_parent_trade_id;
  perform wm.notify_trade(array[p_recipient_id], case when p_parent_trade_id is null then 'trade_received' else 'trade_countered' end,
    t.id, p_uid);
  return wm.idem_store(p_uid, p_idem, wm.trade_json(t));
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
