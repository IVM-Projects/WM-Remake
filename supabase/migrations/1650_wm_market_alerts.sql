-- ADDITIVE : alertes de liste de souhaits par curseur (D§7.5, M3-20, P28), purge horaire (M3-20, P12), santé du règlement (M3-21, P13).
-- Idempotente. Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.
-- Appelées par les jobs de 9000 (wm-wishlist-alerts, wm-purge, wm-cron-history) ; wm.health par /api/health.

-- Budget de p_batch notifications sur tout l'appel. Paires (ligne, souhaitant) prises dans l'ordre (ligne, user_id), insérées en une seule
-- instruction triée par user_id (P28) : les FOR KEY SHARE sur profiles suivent l'ordre C4, sinon un lot hi, lo croiserait une mise lo, hi.
-- Renvoie le nombre de notifications.
-- shortcut: chaque appel lit toutes les lignes en attente et leurs paires avant le tri ; borner les lignes lues si la file dépasse quelques
-- milliers de lignes ou de souhaitants par carte.
create or replace function wm.wishlist_alerts_fanout(p_batch int default 5000)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_ids bigint[];
  n int;
begin
  select coalesce(array_agg(id), '{}') into v_ids
  from (select id from wm.wishlist_alert_queue where done_at is null order by id for update skip locked) q;
  with p as (
    select w.id, w.auction_id, s.user_id, a.base_amount
    from wm.wishlist_alert_queue w
    join public.auctions a on a.id = w.auction_id and a.status = 'active'
    join public.wishlist_items s on s.card_id = a.card_id and s.user_id <> a.seller_id
    where w.id = any (v_ids) and (w.cursor_user is null or s.user_id > w.cursor_user)
    order by w.id, s.user_id
    limit p_batch
  ), ins as (
    insert into public.notifications (user_id, type, data)
    select user_id, 'wishlist_listed', wm.notification_data('wishlist_listed', auction_id, base_amount) from p order by user_id
    returning 1
  ), cur as (  -- dernier souhaitant servi de chaque ligne
    update wm.wishlist_alert_queue w set cursor_user = l.user_id
    from (select distinct on (id) id, user_id from p order by id, user_id desc) l
    where w.id = l.id
  )
  select count(*) into n from ins;
  -- Terminée : enchère qui n'est plus active (sans notification), ou plus aucun souhaitant au-delà du curseur.
  update wm.wishlist_alert_queue w set done_at = now()
  from public.auctions a
  where w.id = any (v_ids) and a.id = w.auction_id
    and (a.status <> 'active' or not exists (select from public.wishlist_items s where s.card_id = a.card_id and s.user_id <> a.seller_id
      and (w.cursor_user is null or s.user_id > w.cursor_user)));
  return n;
end $$;

-- Job wm-purge (horaire) : clés d'idempotence de plus de 24 h, lignes de file terminées depuis plus d'une heure.
create or replace function wm.purge_expired()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  k int;
  q int;
begin
  delete from wm.idempotency_keys where created_at < now() - interval '24 hours';
  get diagnostics k = row_count;
  delete from wm.wishlist_alert_queue where done_at < now() - interval '1 hour';
  get diagnostics q = row_count;
  return jsonb_build_object('idempotency_keys', k, 'wishlist_alert_queue', q);
end $$;

-- Job wm-cron-history (horaire) : cron.job_run_details ne se vide pas seul (≈ 17 000 runs par jour). Ici et pas dans 9000, qui reste sans
-- suppression (P12) ; SQL dynamique : la fonction se crée sans pg_cron. Run marqué en échec au redémarrage : pas d'end_time, d'où start_time.
create or replace function wm.purge_cron_history()
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if to_regclass('cron.job_run_details') is null then
    return 0;
  end if;
  execute $q$delete from cron.job_run_details where coalesce(end_time, start_time) < now() - interval '24 hours'$q$;
  get diagnostics n = row_count;
  return n;
end $$;

-- Santé (M3-21, P13), même signature et clés en plus : settle_lag_s = secondes depuis la fin du dernier run succeeded de wm-settle (86400
-- sans run), null sans pg_cron ou sans job wm-settle ; overdue_s = retard de la plus ancienne enchère active échue depuis plus de 60 s
-- (une enchère que P9 saute alors que les runs réussissent). cron.* par SQL dynamique ; une lecture en erreur (colonne renommée, droit
-- manquant) donne 86400 et overdue_s null : health.yml alerte, /api/health reste 200.
create or replace function wm.health()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_lag int;
  v_overdue int;
begin
  if to_regclass('cron.job') is not null and to_regclass('cron.job_run_details') is not null then
    begin
      execute $q$
        select coalesce((select extract(epoch from now() - max(r.end_time))::int from cron.job_run_details r
                         where r.jobid = j.jobid and r.status = 'succeeded'), 86400)
        from cron.job j where j.jobname = 'wm-settle'
      $q$ into v_lag;
      if v_lag is not null then
        select extract(epoch from now() - min(end_at))::int into v_overdue
        from public.auctions where status = 'active' and end_at < now() - interval '60 seconds';
      end if;
    exception when others then
      v_lag := 86400;
      v_overdue := null;
    end;
  end if;
  return jsonb_build_object('ok', true, 'db', 'ok', 'now', now(), 'settle_lag_s', v_lag, 'overdue_s', v_overdue);
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
