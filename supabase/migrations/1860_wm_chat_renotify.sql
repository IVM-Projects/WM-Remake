-- ADDITIVE : notification de message renouvelée (M4b-4 amendé) — wm.chat_send remplace la chat_message non lue du couple quand elle a plus
-- de 10 minutes, sous le verrou déjà pris sur elle (B20) : toujours au plus une non lue par couple, remontée en tête de la cloche. Même
-- signature, même corps et même réponse qu'en 1820 (déployée, non retouchée), plus ce delete. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

create or replace function wm.chat_send(p_uid uuid, p_peer_id uuid, p_content text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  b jsonb := (select value from wm.config where key = 'chat_burst');
  v_win interval := make_interval(secs => (b ->> 'window_s')::int);
  s wm.user_state;
  m public.chat_messages;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if not exists (select from public.profiles where id = p_peer_id) then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  if p_peer_id = p_uid then
    perform wm.raise_err(400, 'invalid_request', 'Tu ne peux pas t''écrire à toi-même');
  end if;
  if coalesce(btrim(p_content, E' \t\r\n'), '') = '' then
    perform wm.raise_err(400, 'invalid_request', 'Le message est vide');
  end if;
  if char_length(p_content) > 2000 then
    perform wm.raise_err(400, 'invalid_request', 'Un message fait au plus 2 000 caractères');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_users(array[p_uid, p_peer_id]);
  if (select count(*) from public.profiles where id in (p_uid, p_peer_id)) < 2 then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  if not wm.are_friends(p_uid, p_peer_id) then
    perform wm.raise_err(403, 'FORBIDDEN', 'Vous devez être amis pour vous écrire');
  end if;
  select * into s from wm.user_state where user_id = p_uid;
  if s.chat_window_start > now() - v_win and s.chat_window_count >= (b ->> 'count')::int then
    perform wm.raise_err(429, null, 'Le site demande de ralentir',
      jsonb_build_object('retry_after', least((b ->> 'window_s')::int,
        greatest(1, ceil(extract(epoch from s.chat_window_start + v_win - now())))::int)));
  end if;
  insert into public.chat_messages (sender_id, recipient_id, content) values (p_uid, p_peer_id, p_content) returning * into m;
  perform from public.notifications where user_id = p_peer_id and type = 'chat_message' and not read and data ->> 'user_id' = p_uid::text
  for update;
  -- Une non lue ancienne n'empêche plus la notification ni le push : au plus un push par couple par 10 min, même fenêtre que wm.push_enqueue.
  delete from public.notifications where user_id = p_peer_id and type = 'chat_message' and not read and data ->> 'user_id' = p_uid::text
    and created_at < now() - interval '10 minutes';
  insert into public.notifications (user_id, type, data)
  select p_peer_id, 'chat_message', jsonb_build_object('user_id', p_uid, 'username', p.username) from public.profiles p
  where p.id = p_uid and not exists (select from public.notifications where user_id = p_peer_id and type = 'chat_message' and not read
    and data ->> 'user_id' = p_uid::text);
  update wm.user_state set chat_window_count = case when chat_window_start > now() - v_win then chat_window_count + 1 else 1 end,
    chat_window_start = case when chat_window_start > now() - v_win then chat_window_start else now() end
  where user_id = p_uid;
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('message', to_jsonb(m)));
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
