-- ADDITIVE : messages privés (R§3.7, D:595, M4b-2, M4b-3, M4b-4, M4b-8, M4b-9, M4b-29, B2, B20) — conversations, fil des 100 derniers,
-- envoi entre amis sous les deux profils, 30 par minute, notification chat_message dédoublonnée, synchronisée par le marquage lu. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- Une entrée par pair (B2), la plus récente d'abord. shortcut: lit tous les messages du joueur ; une table de conversations au M8 si besoin.
create or replace function wm.chat_conversations(p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('conversations', coalesce(jsonb_agg(jsonb_build_object('peer_id', c.peer_id, 'peer_username', p.username,
      'peer_avatar_url', p.avatar_url, 'last_message', c.content, 'last_message_at', c.created_at, 'unread_count', c.unread_count)
      order by c.created_at desc, c.peer_id), '[]'))
  from (select * from (select distinct on (m.peer_id) m.peer_id, m.content, m.created_at,
          count(*) filter (where m.recipient_id = p_uid and not m.read) over (partition by m.peer_id) unread_count
        from (select case sender_id when p_uid then recipient_id else sender_id end peer_id, * from public.chat_messages
          where p_uid in (sender_id, recipient_id)) m
        order by m.peer_id, m.created_at desc, m.id desc) d
    order by d.created_at desc, d.peer_id limit (select (value ->> 'conversations')::int from wm.config where key = 'list_caps')) c
  join public.profiles p on p.id = c.peer_id
$$;

-- Fil du couple (M4b-9) : lisible sans amitié, seule l'écriture l'exige ; aucun marquage lu ici. Les cap derniers de chaque sens par son
-- index (union all), puis les cap derniers du tout : à chaque poll de 5 s, jamais tout le couple.
create or replace function wm.chat_thread(p_uid uuid, p_peer_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  p public.profiles;
  cap int := (select (value ->> 'messages')::int from wm.config where key = 'list_caps');
begin
  select * into p from public.profiles where id = p_peer_id;
  if not found then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  if p.id = p_uid then
    perform wm.raise_err(400, 'invalid_request', 'Tu ne peux pas t''écrire à toi-même');
  end if;
  return jsonb_build_object('messages', (select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at, m.id), '[]')
      from (select * from ((select * from public.chat_messages where sender_id = p_uid and recipient_id = p.id
          order by created_at desc, id desc limit cap)
        union all (select * from public.chat_messages where sender_id = p.id and recipient_id = p_uid
          order by created_at desc, id desc limit cap)) u
        order by created_at desc, id desc limit cap) m),
    'peer', jsonb_build_object('id', p.id, 'username', p.username, 'avatar_url', p.avatar_url), 'isFriend', wm.are_friends(p_uid, p.id));
end $$;

-- Envoi (M4b-2) : les deux profils tenus avant l'insertion, qui prend FOR KEY SHARE sur chacun (messages croisés). Un joueur supprimé depuis
-- le contrôle d'existence (sa suppression tenait la ligne) est relu absent sous le verrou : le même 404. La chat_message non lue du couple
-- est prise for update avant son insert … where not exists (B20) : un marquage lu en cours fait attendre, puis la ligne relue lue est exclue
-- et l'instruction suivante, sur un instantané neuf, en pose une neuve. Compteur après l'insertion (M4b-3) ; retry_after borné à la fenêtre,
-- qu'une transaction plus tardive a pu poser après notre now().
-- Verrous croisés avec wm.notifications_read (1740, « tout lire ») : elle attend désormais chat_send, qui tient cette chat_message for
-- update, et chat_read_sync ; elle ne tient aucun profil, donc aucun cycle. Son commentaire de 1740 (déployée, non retouchée) l'ignore.
-- shortcut: « tout lire » contre un PATCH multi-pairs du même joueur (rest/v1/chat_messages) peut donner 40P01, reproduit au banc ; l'UI
-- ne fait qu'un PATCH par pair (un seul verrou), seul un client REST écrit à la main y arrive, et l'échec annule tout et se rejoue. Parade
-- si un client s'en plaint : perform … order by id for update dans notifications_read, à vérifier contre chat_send.
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
  insert into public.notifications (user_id, type, data)
  select p_peer_id, 'chat_message', jsonb_build_object('user_id', p_uid, 'username', p.username) from public.profiles p
  where p.id = p_uid and not exists (select from public.notifications where user_id = p_peer_id and type = 'chat_message' and not read
    and data ->> 'user_id' = p_uid::text);
  update wm.user_state set chat_window_count = case when chat_window_start > now() - v_win then chat_window_count + 1 else 1 end,
    chat_window_start = case when chat_window_start > now() - v_win then chat_window_start else now() end
  where user_id = p_uid;
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('message', to_jsonb(m)));
end $$;

-- Marquage lu direct (PATCH sous RLS, M4b-4) : les chat_message des couples (destinataire, expéditeur) passés à lu sont prises for update,
-- puis marquées lues par une instruction à part (instantané neuf) si aucun message du couple ne reste non lu : un envoi validé pendant
-- l'attente garde la sienne (B20). Couples distincts lus une fois en tableaux, et sender_id comparé en uuid (index des fils) ; les
-- destinataires distincts (un seul sous RLS) en filtre de plus : sans lui, le planificateur compte un destinataire par couple et lit toute
-- notifications dès ~150 non-lues par joueur. Sans liste de colonnes : PG refuse une table de transition sur un trigger à liste de colonnes.
create or replace function wm.chat_read_sync()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_r uuid[];
  v_s uuid[];
  v_u uuid[];
begin
  select array_agg(c.recipient_id), array_agg(c.sender_id), array_agg(distinct c.recipient_id) into v_r, v_s, v_u
  from (select distinct n.recipient_id, n.sender_id from o join n using (id) where o.read is distinct from n.read and n.read) c;
  if v_r is null then
    return null;
  end if;
  perform from public.notifications where user_id = any (v_u) and type = 'chat_message' and not read
    and (user_id, data ->> 'user_id') in (select r, s::text from unnest(v_r, v_s) u (r, s))
  order by id for update;
  update public.notifications nt set read = true
  where user_id = any (v_u) and type = 'chat_message' and not read
    and (user_id, data ->> 'user_id') in (select r, s::text from unnest(v_r, v_s) u (r, s))
    and not exists (select from public.chat_messages m where m.recipient_id = nt.user_id and m.sender_id = (nt.data ->> 'user_id')::uuid
      and not m.read);
  return null;
end $$;

create or replace trigger chat_messages_read_sync after update on public.chat_messages
  referencing old table as o new table as n for each statement execute function wm.chat_read_sync();

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
