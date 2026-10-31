-- ADDITIVE : chat de guilde (D§7.8, R§3.10, M5b-6, M5b-9, G10, D-C18) — les 100 derniers messages, envoi de 1 000 caractères au plus,
-- seau de rafale partagé avec les messages privés (wm.config.chat_burst, wm.user_state.chat_window_*). Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- GET /api/guilds/chat : les list_caps.guild_messages derniers, rendus du plus ancien au plus récent. Sans guilde : 404 (M5b-9). Le message
-- d'un membre parti reste, avec son pseudo (union de R:295 : username, user, profile).
create or replace function wm.guild_chat_list(p_uid uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  g uuid;
begin
  select guild_id into g from public.guild_members where user_id = p_uid;
  if g is null then
    perform wm.raise_err(404, null, 'Tu n''es dans aucune guilde');
  end if;
  return jsonb_build_object('messages', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'user_id', t.user_id,
      'content', t.content, 'created_at', t.created_at, 'username', t.username, 'user', jsonb_build_object('username', t.username),
      'profile', jsonb_build_object('username', t.username)) order by t.created_at, t.id)
    from (select m.*, p.username from public.guild_chat_messages m join public.profiles p on p.id = m.user_id where m.guild_id = g
      order by m.created_at desc, m.id desc limit (select (value ->> 'guild_messages')::int from wm.config where key = 'list_caps')) t),
    '[]'));
end $$;

-- Envoi : le profil, puis la guilde en for key share (le message ne fait que la référencer) ; l'adhésion est relue sous la guilde (un départ
-- ne prend aucun profil). Fenêtre de rafale copiée de wm.chat_send (1860:39-52, G10) : le même seau, compté sous le profil de l'expéditeur.
create or replace function wm.guild_chat_send(p_uid uuid, p_content text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  b jsonb := (select value from wm.config where key = 'chat_burst');
  v_win interval := make_interval(secs => (b ->> 'window_s')::int);
  g uuid;
  s wm.user_state;
  m public.guild_chat_messages;
  v_name text;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if coalesce(btrim(p_content, E' \t\r\n'), '') = '' then
    perform wm.raise_err(400, 'invalid_request', 'Le message est vide');
  end if;
  if char_length(p_content) > 1000 then
    perform wm.raise_err(400, 'invalid_request', 'Un message fait au plus 1 000 caractères');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_user(p_uid);
  select guild_id into g from public.guild_members where user_id = p_uid;
  perform from public.guilds where id = g for key share;
  if not found or not exists (select from public.guild_members where user_id = p_uid and guild_id = g) then
    perform wm.raise_err(404, null, 'Tu n''es dans aucune guilde');
  end if;
  select * into s from wm.user_state where user_id = p_uid;
  if s.chat_window_start > now() - v_win and s.chat_window_count >= (b ->> 'count')::int then
    perform wm.raise_err(429, null, 'Le site demande de ralentir',
      jsonb_build_object('retry_after', least((b ->> 'window_s')::int,
        greatest(1, ceil(extract(epoch from s.chat_window_start + v_win - now())))::int)));
  end if;
  insert into public.guild_chat_messages (guild_id, user_id, content) values (g, p_uid, p_content) returning * into m;
  update wm.user_state set chat_window_count = case when chat_window_start > now() - v_win then chat_window_count + 1 else 1 end,
    chat_window_start = case when chat_window_start > now() - v_win then chat_window_start else now() end
  where user_id = p_uid;
  select username into v_name from public.profiles where id = p_uid;
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('message', jsonb_build_object('id', m.id, 'user_id', m.user_id,
    'content', m.content, 'created_at', m.created_at, 'username', v_name, 'user', jsonb_build_object('username', v_name),
    'profile', jsonb_build_object('username', v_name))));
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
