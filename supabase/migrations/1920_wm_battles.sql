-- ADDITIVE : défis entre amis et lectures des batailles (D§7.7, R§3.9, M5a-12, M5a-16, C4, C5, C6, C10, C11) — création sous les deux
-- profils, une bataille ouverte par paire, quota du jour du fuseau et borne glissante de 24 h, réponses au défi, aiguillage de battle_action,
-- liste et détail. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- data des notifications de bataille (C10) : l'autre joueur, sans texte. Une instruction triée par user_id (P28).
create or replace function wm.notify_battle(p_users uuid[], p_type text, p_battle_id uuid, p_actor uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_data jsonb := jsonb_build_object('battle_id', p_battle_id, 'user_id', p_actor,
    'username', (select username from public.profiles where id = p_actor));
  n int;
begin
  insert into public.notifications (user_id, type, data)
  select u, p_type, v_data from unnest(p_users) u where u is not null order by u;
  get diagnostics n = row_count;
  return n;
end $$;

-- Statut lu (C6) : un pending échu, que le cron n'a pas encore passé, se lit cancelled. Lu par battle_json, et par battle_action et ses
-- sous-fonctions (1930) sans construire l'objet Battle.
create or replace function wm.battle_read_status(b public.battles)
returns text language sql stable security definer set search_path = '' as $$
  select case when b.status = 'pending' and b.created_at + make_interval(hours => (value ->> 'invite_ttl_h')::int) <= clock_timestamp()
    then 'cancelled' else b.status::text end
  from wm.config where key = 'battle'
$$;

-- Seul constructeur de l'objet Battle (C6), au statut lu. Tant que players a moins de deux entrées, le lecteur ne voit que la sienne
-- (M5a-11).
create or replace function wm.battle_json(b public.battles, p_viewer uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(b) || jsonb_build_object(
    'status', s.status,
    'challenger', (select jsonb_build_object('id', p.id, 'username', p.username) from public.profiles p where p.id = b.challenger_id),
    'opponent', (select jsonb_build_object('id', p.id, 'username', p.username) from public.profiles p where p.id = b.opponent_id),
    'expires_at', case when s.status = 'pending' then e.expires_at end,
    'idle_at', case when b.status in ('deck_selection', 'generating_quizzes', 'active')
      then b.updated_at + make_interval(hours => (c.value ->> 'idle_loss_h')::int) end,
    'game_state', case when (select count(*) from jsonb_object_keys(b.game_state -> 'players')) < 2
        and not coalesce(b.game_state -> 'players' ? p_viewer::text, false)
      then jsonb_set(b.game_state, '{players}', '{}') else b.game_state end)
  from (select value from wm.config where key = 'battle') c,
    lateral (select b.created_at + make_interval(hours => (c.value ->> 'invite_ttl_h')::int) expires_at) e,
    lateral (select wm.battle_read_status(b) status) s
$$;

-- Défis créés par p_uid depuis le début du jour de son fuseau (R:130), quelle que soit leur issue ; 10 en Pro ou VIP (M5a-12).
create or replace function wm.battle_quota(p_uid uuid, p_tz text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'used', (select count(*) from public.battles where challenger_id = p_uid and created_at >= d.today::timestamp at time zone d.tz),
    'limit', (select (c.value ->> case when p.is_pro or p.is_vip then 'quota_pro' else 'quota_free' end)::int
      from public.profiles p, wm.config c where p.id = p_uid and c.key = 'battle'),
    'resets_at', (d.today + 1)::timestamp at time zone d.tz)
  from (select t.tz, (now() at time zone t.tz)::date today from (select wm.safe_tz(p_tz) tz) t) d
$$;

-- Toutes les batailles ouvertes (statut stocké) et les list_caps.battles_closed closes les plus récentes ; game_state tu sur les closes (C6).
create or replace function wm.battles_list(p_uid uuid, p_tz text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'battles', (select coalesce(jsonb_agg(x.j order by x.created_at desc, x.id desc), '[]') from (
        select b.created_at, b.id, wm.battle_json(b, p_uid) j from public.battles b
        where p_uid in (b.challenger_id, b.opponent_id) and b.status in ('pending', 'deck_selection', 'generating_quizzes', 'active')
        union all
        select (k.b).created_at, (k.b).id, wm.battle_json(k.b, p_uid) - 'game_state'
        from (select b from public.battles b where p_uid in (b.challenger_id, b.opponent_id) and b.status in ('completed', 'cancelled')
          order by b.created_at desc, b.id desc limit (select (value ->> 'battles_closed')::int from wm.config where key = 'list_caps')) k) x),
    'challenge_quota', wm.battle_quota(p_uid, p_tz),
    'rules', (select value from wm.config where key = 'battle'))
$$;

-- {battle, decks, reward} (C5) : decks du lecteur seul tant que les deux ne sont pas posés (M5a-11) ; reward = sa ligne battle:<id>.
create or replace function wm.battle_detail(p_uid uuid, p_battle_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare b public.battles;
begin
  select * into b from public.battles where id = p_battle_id and p_uid in (challenger_id, opponent_id);
  if not found then
    perform wm.raise_err(404, null, 'Bataille introuvable');
  end if;
  return jsonb_build_object('battle', wm.battle_json(b, p_uid),
    'decks', (select coalesce(jsonb_agg(jsonb_build_object('user_id', d.user_id, 'card_ids', d.card_ids) order by d.user_id)
        filter (where d.user_id = p_uid or d.n >= 2), '[]')
      from (select user_id, card_ids, count(*) over () n from public.battle_decks where battle_id = b.id) d),
    'reward', (select delta from wm.wb_ledger where reason = 'battle' and ref = 'battle:' || b.id and user_id = p_uid));
end $$;

-- POST /api/battles → {battle: {id}, id} (M5a-12). Le défi échu de la paire d'abord, puis les deux profils (C4) ; l'insertion, qui référence
-- les deux, se fait sous lock_users (M4b-31).
create or replace function wm.battle_create(p_uid uuid, p_opponent_id uuid, p_tz text default null, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_q jsonb;
  v_lim int;
  v_day boolean;
  v_n int;
  v_roll timestamptz;
  v_id uuid;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if p_opponent_id = p_uid then
    perform wm.raise_err(400, 'invalid_request', 'Tu ne peux pas te défier toi-même');
  end if;
  if not exists (select from public.profiles where id = p_opponent_id) then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  perform set_config('lock_timeout', '2s', true);
  -- C6 : sans skip locked, une ligne tenue par le cron ou par un accept est attendue, relue, puis sautée.
  update public.battles set status = 'cancelled', updated_at = clock_timestamp()
  where least(challenger_id, opponent_id) = least(p_uid, p_opponent_id) and greatest(challenger_id, opponent_id) = greatest(p_uid, p_opponent_id)
    and status = 'pending'
    and created_at + make_interval(hours => (select (value ->> 'invite_ttl_h')::int from wm.config where key = 'battle')) <= clock_timestamp();
  perform wm.lock_users(array[p_uid, p_opponent_id]);
  if not wm.are_friends(p_uid, p_opponent_id) then
    perform wm.raise_err(403, 'FORBIDDEN', 'Vous devez être amis pour vous défier');
  end if;
  select id into v_id from public.battles
  where least(challenger_id, opponent_id) = least(p_uid, p_opponent_id) and greatest(challenger_id, opponent_id) = greatest(p_uid, p_opponent_id)
    and status in ('pending', 'deck_selection', 'generating_quizzes', 'active');
  if found then
    perform wm.raise_err(409, null, 'Une bataille est déjà en cours avec ce joueur', jsonb_build_object('battle_id', v_id));
  end if;
  -- Quota du jour et borne glissante de 2 × limit sur 24 h (saut de fuseau), jugés ensemble : un seul 429, retry_after le plus tardif.
  v_q := wm.battle_quota(p_uid, p_tz);
  v_lim := (v_q ->> 'limit')::int;
  v_day := (v_q ->> 'used')::int >= v_lim;
  select count(*) into v_n from public.battles where challenger_id = p_uid and created_at > now() - interval '24 hours';
  -- Le (n − 2 × limit + 1)ᵉ plus ancien : sa sortie de la fenêtre ramène n sous 2 × limit, même au-delà (limite baissée, Pro perdu).
  if v_n >= 2 * v_lim then
    select created_at + interval '24 hours' into v_roll from public.battles
    where challenger_id = p_uid and created_at > now() - interval '24 hours'
    order by created_at offset v_n - 2 * v_lim limit 1;
  end if;
  if v_day or v_roll is not null then
    perform wm.raise_err(429, null, 'Limite quotidienne de défis atteinte', jsonb_build_object('retry_after',
      greatest(case when v_day then (v_q ->> 'resets_at')::timestamptz end, v_roll), 'challenge_quota', v_q));
  end if;
  insert into public.battles (challenger_id, opponent_id) values (p_uid, p_opponent_id) returning id into v_id;
  perform wm.notify_battle(array[p_opponent_id], 'battle_invite', v_id, p_uid);
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('battle', jsonb_build_object('id', v_id), 'id', v_id));
end $$;

-- PATCH /api/battles/<id> → {battle, decks, reward}, plus {correct, correct_answer_id, last_turn, status} pour submit_single_answer (C5).
-- Refus dans l'ordre de C11 : action inconnue, bataille introuvable, statut, rôle. Un refus n'écrit rien. Les réponses au défi ne verrouillent
-- aucun profil ; le jeu passe aux sous-fonctions de 1930, avec la bataille déjà tenue.
create or replace function wm.battle_action(p_uid uuid, p_battle_id uuid, p_action text, p_payload jsonb default '{}', p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_status text;
  v_answer jsonb := '{}';
  b public.battles;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if not coalesce(p_action in ('accept', 'decline', 'withdraw_invite', 'forfeit', 'submit_deck', 'submit_attack', 'submit_single_answer'), false)
  then
    perform wm.raise_err(400, 'invalid_request', 'Action inconnue');
  end if;
  perform set_config('lock_timeout', '2s', true);
  -- La bataille d'abord, avant tout profil (C4).
  select * into b from public.battles where id = p_battle_id and p_uid in (challenger_id, opponent_id) for update;
  if not found then
    perform wm.raise_err(404, null, 'Bataille introuvable');
  end if;
  v_status := wm.battle_read_status(b);
  if p_action in ('accept', 'decline', 'withdraw_invite') then
    if v_status <> 'pending' then
      perform wm.raise_err(409, null, 'Ce défi n''est plus en attente');
    end if;
    if p_action = 'withdraw_invite' and p_uid <> b.challenger_id then
      perform wm.raise_err(403, 'FORBIDDEN', 'Seul l''auteur du défi peut le retirer');
    end if;
    if p_action <> 'withdraw_invite' and p_uid <> b.opponent_id then
      perform wm.raise_err(403, 'FORBIDDEN', 'Seul le joueur défié peut répondre à ce défi');
    end if;
    if p_action = 'accept' and not wm.are_friends(b.challenger_id, b.opponent_id) then
      perform wm.raise_err(403, 'FORBIDDEN', 'Vous devez être amis pour vous défier');
    end if;
    update public.battles set status = case when p_action = 'accept' then 'deck_selection' else 'cancelled' end::public.battle_status,
      game_state = case when p_action = 'accept' then '{"players": {}, "turnHistory": [], "pendingAttack": null}'::jsonb else game_state end,
      updated_at = clock_timestamp()
    where id = b.id;
    -- Le retrait n'envoie rien (C10).
    if p_action <> 'withdraw_invite' then
      perform wm.notify_battle(array[b.challenger_id], case when p_action = 'accept' then 'battle_accepted' else 'battle_declined' end, b.id, p_uid);
    end if;
  elsif p_action = 'forfeit' and v_status in ('completed', 'cancelled') then
    perform wm.raise_err(409, null, 'Cette bataille est terminée');
  elsif p_action = 'forfeit' and v_status = 'pending' then
    perform wm.raise_err(409, null, 'Ce défi n''est pas encore accepté');
  elsif p_action = 'forfeit' and coalesce(p_payload ->> 'expect' <> case when v_status = 'active' then 'lose' else 'cancel' end, false) then
    -- Phase confirmée par le joueur (expect) qui n'est plus celle lue : rien n'est écrit, le client relit (une annulation annoncée ne
    -- devient pas une défaite).
    perform wm.raise_err(409, null, 'La bataille a changé : relis-la avant d''abandonner.');
  elsif p_action = 'forfeit' and v_status <> 'active' then
    -- Choix des cartes (ou generating_quizzes hérité, C18) : annulée, sans argent ni notification (M5a-12).
    update public.battles set status = 'cancelled', updated_at = clock_timestamp() where id = b.id;
  elsif p_action = 'forfeit' then
    perform wm.battle_forfeit(b, p_uid);
  elsif p_action = 'submit_deck' then
    perform wm.battle_submit_deck(b, p_uid, p_payload);
  elsif p_action = 'submit_attack' then
    perform wm.battle_submit_attack(b, p_uid, p_payload);
  else
    v_answer := wm.battle_answer(b, p_uid, p_payload);
  end if;
  return wm.idem_store(p_uid, p_idem, wm.battle_detail(p_uid, b.id) || v_answer);
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
