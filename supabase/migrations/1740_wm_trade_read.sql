-- ADDITIVE : lectures des échanges et des notifications (D§7.6, R§3.6, R§3.7, M4-13, M4-16, P3, P7, P10) — en attente et derniers clos,
-- détail, 50 dernières notifications, marquage lu par ids ou en bloc. Idempotente. Seule écriture : le marquage, sans verrou explicite.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- Tous les pending stockés de p_uid, échus compris (lus expired par trade_json, P3), puis les list_caps.trades_closed derniers clos.
create or replace function wm.trades_list(p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('trades',
    (select coalesce(jsonb_agg(wm.trade_json(t) order by t.created_at desc, t.id), '[]') from public.trades t
      where p_uid in (t.initiator_id, t.recipient_id) and t.status = 'pending')
    || (select coalesce(jsonb_agg(wm.trade_json(c.t) order by (c.t).closed_at desc nulls last, (c.t).id), '[]')
      from (select t from public.trades t where p_uid in (t.initiator_id, t.recipient_id) and t.status <> 'pending'
        order by t.closed_at desc nulls last, t.id limit (select (value ->> 'trades_closed')::int from wm.config where key = 'list_caps')) c))
$$;

create or replace function wm.trade_detail(p_uid uuid, p_trade_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare t public.trades;
begin
  select * into t from public.trades where id = p_trade_id and p_uid in (initiator_id, recipient_id);
  if not found then
    perform wm.raise_err(404, null, 'Échange introuvable');
  end if;
  return jsonb_build_object('trade', wm.trade_json(t));
end $$;

create or replace function wm.notifications_list(p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('notifications', coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'type', n.type, 'data', n.data,
      'read', n.read, 'created_at', n.created_at) order by n.created_at desc, n.id desc), '[]'))
  from (select * from public.notifications where user_id = p_uid order by created_at desc, id desc
    limit (select (value ->> 'notifications')::int from wm.config where key = 'list_caps')) n
$$;

-- p_ids null : toutes mes non-lues ; les ids d'un autre sont ignorés (P10). Sans lock_timeout (P5) : ni for update ni profil tenu, et read
-- n'est pas une clé étrangère, donc aucun FOR KEY SHARE sur profiles ; seul un autre marquage du même joueur peut faire attendre.
create or replace function wm.notifications_read(p_uid uuid, p_ids uuid[] default null, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  n int;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  update public.notifications set read = true where user_id = p_uid and not read and (p_ids is null or id = any (p_ids));
  get diagnostics n = row_count;
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('ok', true, 'updated', n));
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
