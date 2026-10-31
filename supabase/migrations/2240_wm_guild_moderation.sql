-- ADDITIVE : outils de guilde du staff (M6a-8, S:86) — dissolution notifiée (guild_kicked, acteur nul), suppression d'un message de guilde,
-- retrait d'un souhait ouvert ; recherche et détail d'une guilde ; tableau de bord (D:644, G18) et journal d'audit (G8). Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- Dissolution (admin) : souhaits ouverts (G3 du M5b), profils des membres en for key share (G2 du M5b), puis la guilde for update ;
-- notification avant le delete (notify_guild relit le nom) ; cascade (D-C20). L'audit ne copie pas le nom.
create or replace function wm.admin_guild_dissolve(p_uid uuid, p_guild_id uuid, p_reason text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_reason text;
  v_members uuid[];
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.staff_actor(p_uid, 'admin');
  v_reason := wm.admin_reason(p_reason);
  perform set_config('lock_timeout', '2s', true);
  perform from public.guild_wishlists where guild_id = p_guild_id and fulfilled_at is null order by id for update;
  perform from public.profiles where id in (select user_id from public.guild_members where guild_id = p_guild_id) order by id for key share;
  perform from public.guilds where id = p_guild_id for update;
  if not found then
    perform wm.raise_err(404, null, 'Guilde introuvable');
  end if;
  select coalesce(array_agg(user_id order by user_id), '{}') into v_members from public.guild_members where guild_id = p_guild_id;
  perform wm.notify_guild(v_members, 'guild_kicked', p_guild_id, null);
  delete from public.guilds where id = p_guild_id;
  perform wm.staff_log(p_uid, 'guild_dissolve', 'guild', p_guild_id::text, v_reason,
    jsonb_build_object('members', cardinality(v_members)));
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('ok', true, 'members', cardinality(v_members)));
end $$;

-- Message de guilde supprimé (modérateur) ; l'audit garde la guilde, l'auteur et l'instant, jamais le texte (G8).
create or replace function wm.admin_guild_message_delete(p_uid uuid, p_message_id uuid, p_reason text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_reason text;
  m public.guild_chat_messages;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.staff_actor(p_uid);
  v_reason := wm.admin_reason(p_reason);
  perform set_config('lock_timeout', '2s', true);
  delete from public.guild_chat_messages where id = p_message_id returning * into m;
  if not found then
    perform wm.raise_err(404, null, 'Message introuvable');
  end if;
  perform wm.staff_log(p_uid, 'guild_message_delete', 'guild_message', m.id::text, v_reason,
    jsonb_build_object('guild_id', m.guild_id, 'user_id', m.user_id, 'created_at', m.created_at));
  return wm.idem_store(p_uid, p_idem, '{"ok": true}');
end $$;

-- Souhait ouvert retiré (modérateur) ; un souhait comblé reste (historique des dons).
create or replace function wm.admin_guild_wish_remove(p_uid uuid, p_wishlist_id uuid, p_reason text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_reason text;
  w public.guild_wishlists;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.staff_actor(p_uid);
  v_reason := wm.admin_reason(p_reason);
  perform set_config('lock_timeout', '2s', true);
  select * into w from public.guild_wishlists where id = p_wishlist_id and fulfilled_at is null for update;
  if not found then
    perform wm.raise_err(404, null, 'Ce souhait n''existe plus');
  end if;
  delete from public.guild_wishlists where id = w.id and fulfilled_at is null;
  perform wm.staff_log(p_uid, 'guild_wish_remove', 'guild_wish', w.id::text, v_reason,
    jsonb_build_object('guild_id', w.guild_id, 'user_id', w.user_id, 'card_id', w.card_id));
  return wm.idem_store(p_uid, p_idem, '{"ok": true}');
end $$;

-- Recherche par fragment du nom, insensible à la casse, % et _ littéraux ; admin.search au plus.
create or replace function wm.staff_guild_search(p_uid uuid, p_q text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_q text := btrim(p_q);
begin
  perform wm.staff_actor(p_uid);
  if coalesce(char_length(v_q), 0) < 2 then
    perform wm.raise_err(400, 'invalid_request', 'Tape au moins 2 caractères');
  end if;
  v_q := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  return jsonb_build_object('guilds', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name,
      'member_count', g.member_count, 'leader_username', g.leader_username) order by lower(g.name), g.id)
    from (select g.id, g.name, (select count(*) from public.guild_members m where m.guild_id = g.id) member_count,
        (select p.username from public.profiles p where p.id = g.leader_id) leader_username
      from public.guilds g where g.name ilike '%' || v_q || '%'
      order by lower(g.name), g.id limit coalesce((select (value ->> 'search')::int from wm.config where key = 'admin'), 20)) g), '[]'));
end $$;

-- Détail : membres (chef d'abord, puis ancienneté), les admin.guild_messages derniers messages du plus ancien au plus récent, souhaits
-- ouverts. Messages lus sans audit (lus par toute la guilde, G9).
create or replace function wm.staff_guild_detail(p_uid uuid, p_guild_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare g public.guilds;
begin
  perform wm.staff_actor(p_uid);
  select * into g from public.guilds where id = p_guild_id;
  if not found then
    perform wm.raise_err(404, null, 'Guilde introuvable');
  end if;
  return jsonb_build_object(
    'guild', jsonb_build_object('id', g.id, 'name', g.name, 'description', g.description, 'leader_id', g.leader_id,
      'created_at', g.created_at),
    'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'username', p.username, 'role', m.role,
        'joined_at', m.joined_at) order by m.role = 'leader' desc, m.joined_at, m.user_id)
      from public.guild_members m join public.profiles p on p.id = m.user_id where m.guild_id = g.id), '[]'),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'user_id', t.user_id, 'username', t.username,
        'content', t.content, 'created_at', t.created_at) order by t.created_at, t.id)
      from (select m.id, m.user_id, p.username, m.content, m.created_at from public.guild_chat_messages m
        join public.profiles p on p.id = m.user_id where m.guild_id = g.id order by m.created_at desc, m.id desc
        limit coalesce((select (value ->> 'guild_messages')::int from wm.config where key = 'admin'), 100)) t), '[]'),
    'wishes', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'user_id', w.user_id, 'username', p.username,
        'card_id', w.card_id, 'wikipedia_title', c.wikipedia_title, 'created_at', w.created_at) order by w.created_at, w.id)
      from public.guild_wishlists w join public.profiles p on p.id = w.user_id join public.cards c on c.id = w.card_id
      where w.guild_id = g.id and w.fulfilled_at is null), '[]'));
end $$;

-- Tableau de bord : compteurs globaux et wm.health() (D:644, G18).
create or replace function wm.staff_dashboard(p_uid uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform wm.staff_actor(p_uid);
  return jsonb_build_object(
    'open_reports', (select count(*) from public.reports r where not exists (select from wm.report_reviews v where v.report_id = r.id)),
    'image_reports', (select count(distinct card_id) from wm.card_image_reports),
    -- Masquée d'office : hide_image encore vrai et aucune décision du staff sur la carte depuis l'auto-masquage.
    'auto_hidden_cards', (select count(*) from public.cards c
      where c.hide_image and (select a.action from wm.staff_actions a where a.target_type = 'card' and a.target_id = c.id::text
        order by a.created_at desc, a.id desc limit 1) = 'image_auto_hide'),
    'active_sanctions', (select count(*) from wm.sanctions s
      where s.revoked_at is null and s.starts_at <= now() and (s.ends_at is null or s.ends_at > now())),
    'removed_cards', (select count(*) from wm.card_removals),
    'auth_pending', (select count(*) from wm.deleted_accounts where auth_done_at is null),
    'health', wm.health());
end $$;

-- Journal (G8), lisible par les deux rôles : filtres cumulés quand non nuls, le plus récent d'abord, admin.page par page.
create or replace function wm.staff_audit(p_uid uuid, p_page int default 0, p_staff_id uuid default null, p_target_type text default null,
  p_target_id text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_size int := (select (value ->> 'page')::int from wm.config where key = 'admin');
  v_rows jsonb;
  v_more boolean;
begin
  perform wm.staff_actor(p_uid);
  select coalesce(jsonb_agg(x.j order by x.rn) filter (where x.rn <= v_size), '[]'), coalesce(bool_or(x.rn > v_size), false)
  into v_rows, v_more
  from (select z.j, row_number() over (order by z.created_at desc, z.id desc) rn from (select a.id, a.created_at,
      jsonb_build_object('id', a.id, 'staff_id', a.staff_id, 'staff_username', (select p.username from public.profiles p where p.id = a.staff_id),
        'action', a.action, 'target_type', a.target_type, 'target_id', a.target_id, 'reason', a.reason, 'payload', a.payload,
        'created_at', a.created_at) j
    from wm.staff_actions a
    where (p_staff_id is null or a.staff_id = p_staff_id) and (p_target_type is null or a.target_type = p_target_type)
      and (p_target_id is null or a.target_id = p_target_id)
    order by a.created_at desc, a.id desc
    limit v_size + 1 offset greatest(coalesce(p_page, 0), 0)::bigint * v_size) z) x;
  return jsonb_build_object('actions', v_rows, 'hasMore', v_more);
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
