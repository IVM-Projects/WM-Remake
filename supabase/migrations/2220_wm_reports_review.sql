-- ADDITIVE : signalements d'image (bascule, masquage d'office au seuil, G5), drapeaux d'image du staff, revue des signalements de joueurs,
-- lecture auditée et suppression des messages privés d'une paire signalée (G9), listes du staff. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- Vide les avatars d'une carte (S:89, M4b-6) : profils dont l'avatar est une copie de la carte (le trigger vide avatar_url), et profils
-- migrés sans copie dont avatar_url est l'image de la carte. Sans lock_timeout : posé par l'appelant, qui tient déjà la carte.
-- Condition de profil recopiée telle quelle dans wm.admin_card_remove (lock_users, ordre C4) et wm.staff_card : les trois restent identiques.
create or replace function wm.card_avatar_clear(p_card_id uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_copy uuid[];
  v_url uuid[];
begin
  select coalesce(array_agg(l.id) filter (where l.avatar_user_card_id is not null), '{}'),
    coalesce(array_agg(l.id) filter (where l.avatar_user_card_id is null), '{}')
  into v_copy, v_url
  from (select p.id, p.avatar_user_card_id from public.profiles p
    where p.avatar_user_card_id in (select uc.id from public.user_cards uc where uc.card_id = p_card_id)
      or (p.avatar_user_card_id is null and p.avatar_url is not null
        and p.avatar_url = (select c.image_url from public.cards c where c.id = p_card_id))
    order by p.id for update) l;
  update public.profiles set avatar_user_card_id = null where id = any (v_copy);
  update public.profiles set avatar_url = null where id = any (v_url);
  return cardinality(v_copy) + cardinality(v_url);
end $$;

create or replace function wm.card_image_report_get(p_uid uuid, p_card_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('reported', exists (select from wm.card_image_reports where card_id = p_card_id and user_id = p_uid))
$$;

-- Bascule du signalement du joueur ; au seuil de signaleurs distincts, la carte est masquée d'office (audit système, staff_id nul).
create or replace function wm.card_image_report_set(p_uid uuid, p_card_id uuid, p_reported boolean, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  c public.cards;
  v_n int;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  perform set_config('lock_timeout', '2s', true);
  select * into c from public.cards where id = p_card_id for update;
  if not found then
    perform wm.raise_err(404, null, 'Carte introuvable');
  end if;
  if p_reported then
    insert into wm.card_image_reports (card_id, user_id) values (p_card_id, p_uid) on conflict do nothing;
  else
    delete from wm.card_image_reports where card_id = p_card_id and user_id = p_uid;
  end if;
  select count(*) into v_n from wm.card_image_reports where card_id = p_card_id;
  if not c.hide_image and v_n >= (select (value ->> 'hide_threshold')::int from wm.config where key = 'image_reports') then
    update public.cards set hide_image = true where id = p_card_id;
    c.hide_image := true;
    perform wm.card_avatar_clear(p_card_id);
    perform wm.staff_log(null, 'image_auto_hide', 'card', p_card_id::text, 'Seuil de signalements atteint',
      jsonb_build_object('reports', v_n));
  end if;
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('reported', p_reported, 'hidden', c.hide_image));
end $$;

-- Décision du staff sur les drapeaux d'une carte ; efface les signalements d'image (revue faite, le compteur repart de 0, G5).
create or replace function wm.admin_card_flags(p_uid uuid, p_card_id uuid, p_hide_image boolean, p_nsfw_image boolean, p_reason text,
  p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_reason text;
  c public.cards;
  v_avatars int := 0;
  v_reports int;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.staff_actor(p_uid);
  v_reason := wm.admin_reason(p_reason);
  if p_hide_image is null or p_nsfw_image is null then
    perform wm.raise_err(400, 'invalid_request', 'Drapeaux invalides');
  end if;
  perform set_config('lock_timeout', '2s', true);
  select * into c from public.cards where id = p_card_id for update;
  if not found then
    perform wm.raise_err(404, null, 'Carte introuvable');
  end if;
  update public.cards set hide_image = p_hide_image, nsfw_image = p_nsfw_image where id = p_card_id;
  if (p_hide_image and not c.hide_image) or (p_nsfw_image and not c.nsfw_image) then
    v_avatars := wm.card_avatar_clear(p_card_id);
  end if;
  with d as (delete from wm.card_image_reports where card_id = p_card_id returning 1) select count(*) into v_reports from d;
  perform wm.staff_log(p_uid, 'card_flags', 'card', p_card_id::text, v_reason,
    jsonb_build_object('before', jsonb_build_object('hide_image', c.hide_image, 'nsfw_image', c.nsfw_image),
      'after', jsonb_build_object('hide_image', p_hide_image, 'nsfw_image', p_nsfw_image), 'cleared_reports', v_reports));
  return wm.idem_store(p_uid, p_idem, jsonb_build_object(
    'card', jsonb_build_object('id', p_card_id, 'hide_image', p_hide_image, 'nsfw_image', p_nsfw_image),
    'cleared_avatars', v_avatars, 'cleared_reports', v_reports));
end $$;

-- Revue d'un signalement de joueur : une ligne wm.report_reviews, au dernier statut ; chaque décision a sa ligne d'audit.
create or replace function wm.admin_report_review(p_uid uuid, p_report_id uuid, p_status text, p_reason text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_reason text;
  v_action bigint;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.staff_actor(p_uid);
  v_reason := wm.admin_reason(p_reason);
  if p_status is null or p_status not in ('resolved', 'dismissed') then
    perform wm.raise_err(400, 'invalid_request', 'Statut inconnu');
  end if;
  if not exists (select from public.reports where id = p_report_id) then
    perform wm.raise_err(404, null, 'Signalement introuvable');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform from public.reports where id = p_report_id for update;
  if not found then
    perform wm.raise_err(404, null, 'Signalement introuvable');
  end if;
  v_action := wm.staff_log(p_uid, 'report_review', 'report', p_report_id::text, v_reason, jsonb_build_object('status', p_status));
  insert into wm.report_reviews (report_id, status, reviewed_by, reviewed_at, staff_action_id)
  values (p_report_id, p_status, p_uid, now(), v_action)
  on conflict (report_id) do update set status = excluded.status, reviewed_by = excluded.reviewed_by,
    reviewed_at = excluded.reviewed_at, staff_action_id = excluded.staff_action_id;
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('ok', true, 'status', p_status));
end $$;

-- Les 100 derniers messages privés d'une paire liée par un signalement (G9) ; lecture auditée, sans clé d'idempotence (la réponse
-- stockée recopierait des messages privés dans wm.idempotency_keys).
create or replace function wm.admin_dm_thread(p_uid uuid, p_user_a uuid, p_user_b uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_reason text;
  v_msgs jsonb;
begin
  perform wm.staff_actor(p_uid);
  v_reason := wm.admin_reason(p_reason);
  if not exists (select from public.reports where (reporter_id = p_user_a and reported_user_id = p_user_b)
    or (reporter_id = p_user_b and reported_user_id = p_user_a)) then
    perform wm.raise_err(403, 'FORBIDDEN', 'Aucun signalement entre ces deux joueurs');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'sender_id', m.sender_id, 'recipient_id', m.recipient_id,
    'sender_username', (select p.username from public.profiles p where p.id = m.sender_id), 'content', m.content,
    'created_at', m.created_at) order by m.created_at, m.id), '[]')
  into v_msgs
  from (select * from public.chat_messages
    where (sender_id = p_user_a and recipient_id = p_user_b) or (sender_id = p_user_b and recipient_id = p_user_a)
    order by created_at desc, id desc
    limit coalesce((select (value ->> 'dm_messages')::int from wm.config where key = 'admin'), 100)) m;
  perform wm.staff_log(p_uid, 'dm_read', 'dm_pair', least(p_user_a, p_user_b)::text || ':' || greatest(p_user_a, p_user_b)::text,
    v_reason, jsonb_build_object('count', jsonb_array_length(v_msgs)));
  return jsonb_build_object('messages', v_msgs);
end $$;

-- Suppression d'un message privé d'une paire signalée (G9) ; l'audit ne garde pas le texte (G8).
create or replace function wm.admin_dm_delete(p_uid uuid, p_message_id uuid, p_reason text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_reason text;
  m public.chat_messages;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.staff_actor(p_uid);
  v_reason := wm.admin_reason(p_reason);
  perform set_config('lock_timeout', '2s', true);
  select * into m from public.chat_messages where id = p_message_id for update;
  if not found then
    perform wm.raise_err(404, null, 'Message introuvable');
  end if;
  if not exists (select from public.reports where (reporter_id = m.sender_id and reported_user_id = m.recipient_id)
    or (reporter_id = m.recipient_id and reported_user_id = m.sender_id)) then
    perform wm.raise_err(403, 'FORBIDDEN', 'Aucun signalement entre ces deux joueurs');
  end if;
  delete from public.chat_messages where id = m.id;
  perform wm.staff_log(p_uid, 'dm_delete', 'dm', m.id::text, v_reason,
    jsonb_build_object('sender_id', m.sender_id, 'recipient_id', m.recipient_id, 'created_at', m.created_at));
  return wm.idem_store(p_uid, p_idem, '{"ok": true}');
end $$;

-- Signalements de joueurs, ouverts (sans revue) ou revus ; page de admin.page lignes.
create or replace function wm.staff_reports(p_uid uuid, p_status text default 'open', p_page int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_size int := (select (value ->> 'page')::int from wm.config where key = 'admin');
  v_rows jsonb;
  v_more boolean;
begin
  perform wm.staff_actor(p_uid);
  if p_status is null or p_status not in ('open', 'reviewed') then
    perform wm.raise_err(400, 'invalid_request', 'Statut inconnu');
  end if;
  select coalesce(jsonb_agg(x.j order by x.created_at desc, x.id desc) filter (where x.rn <= v_size), '[]'), coalesce(bool_or(x.rn > v_size), false)
  into v_rows, v_more
  from (select z.*, row_number() over (order by z.created_at desc, z.id desc) rn from (select r.id, r.created_at,
      jsonb_build_object('id', r.id, 'reason', r.reason, 'details', r.details, 'created_at', r.created_at,
        'reporter', jsonb_build_object('id', r.reporter_id, 'username', (select username from public.profiles where id = r.reporter_id)),
        'reported', jsonb_build_object('id', r.reported_user_id, 'username', (select username from public.profiles where id = r.reported_user_id)),
        'review', (select jsonb_build_object('status', v.status, 'reviewed_at', v.reviewed_at,
            'reviewed_by_username', (select username from public.profiles where id = v.reviewed_by))
          from wm.report_reviews v where v.report_id = r.id),
        'active_sanctions', (select count(*) from wm.sanctions s where s.user_id = r.reported_user_id and s.revoked_at is null
          and s.starts_at <= now() and (s.ends_at is null or s.ends_at > now()))) j
    from public.reports r
    where (p_status = 'reviewed') = exists (select from wm.report_reviews v where v.report_id = r.id)
    order by r.created_at desc, r.id desc
    limit v_size + 1 offset greatest(coalesce(p_page, 0), 0)::bigint * v_size) z) x;
  return jsonb_build_object('reports', v_rows, 'hasMore', v_more);
end $$;

-- Cartes à au moins un signalement d'image, les plus signalées d'abord.
create or replace function wm.staff_image_reports(p_uid uuid, p_page int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_size int := (select (value ->> 'page')::int from wm.config where key = 'admin');
  v_rows jsonb;
  v_more boolean;
begin
  perform wm.staff_actor(p_uid);
  select coalesce(jsonb_agg(x.j order by x.rn) filter (where x.rn <= v_size), '[]'), coalesce(bool_or(x.rn > v_size), false)
  into v_rows, v_more
  from (select z.*, row_number() over (order by z.reports desc, z.last_reported_at desc, z.card_id) rn from (select q.reports,
      q.last_reported_at, q.card_id, jsonb_build_object('card_id', c.id, 'wikipedia_title', c.wikipedia_title, 'image_url', c.image_url, 'hide_image', c.hide_image,
        'nsfw_image', c.nsfw_image, 'reports', q.reports, 'last_reported_at', q.last_reported_at) j
    from (select card_id, count(*) reports, max(created_at) last_reported_at from wm.card_image_reports group by card_id) q
    join public.cards c on c.id = q.card_id
    order by q.reports desc, q.last_reported_at desc, q.card_id
    limit v_size + 1 offset greatest(coalesce(p_page, 0), 0)::bigint * v_size) z) x;
  return jsonb_build_object('cards', v_rows, 'hasMore', v_more);
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
