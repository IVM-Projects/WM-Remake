-- ADDITIVE : Web Push (R§3.7, D:600-602, M4b-12, M4b-13, M4b-16 à M4b-20, M4b-22, B9, B16) — préférences opt-in par type, abonnements à
-- liste blanche, outbox remplie dans la transaction de la notification, réservation skip locked, réveil par pg_net, push_lag_s. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

create or replace function wm.notification_prefs_get(p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('push_types', coalesce((select to_jsonb(push_types) from wm.notification_prefs where user_id = p_uid), '[]'))
$$;

-- Liste entière remplacée, triée et dédoublonnée ; un type inconnu (nul compris) refuse tout.
create or replace function wm.notification_prefs_set(p_uid uuid, p_push_types text[], p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_resp jsonb;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if exists (select from unnest(p_push_types) t
             where not coalesce((select value ? t from wm.config where key = 'push_types'), false)) then
    perform wm.raise_err(400, 'invalid_request', 'Type de notification inconnu');
  end if;
  perform set_config('lock_timeout', '2s', true);
  insert into wm.notification_prefs (user_id, push_types)
  values (p_uid, array(select distinct t from unnest(p_push_types) t order by t))
  on conflict (user_id) do update set push_types = excluded.push_types;
  return wm.idem_store(p_uid, p_idem, wm.notification_prefs_get(p_uid));
end $$;

-- Liste blanche (B9) : ASCII imprimable sans \, puis schéma://autorité en tête, égale à une origine listée ou hôte https nu d'un suffixe.
-- Après ces refus, l'hôte lu ici est celui que lit fetch. Un endpoint repris par un autre joueur (navigateur partagé) passe à lui ; au-delà
-- de push_max_subscriptions, les plus récents restent (M4b-20).
-- shortcut: deux push_subscribe concurrents du même joueur ne voient pas l'insertion de l'autre et peuvent laisser 9 + N abonnements, N
-- borné par le pool de connexions ; un pg_advisory_xact_lock par joueur avant l'insertion si un plafond strict devient nécessaire.
create or replace function wm.push_subscribe(p_uid uuid, p_endpoint text, p_p256dh text, p_auth text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_cfg jsonb := (select value from wm.config where key = 'push_origins');
  m text[];
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if p_endpoint ~ '^[!-~]+$' and strpos(p_endpoint, '\') = 0 then
    m := regexp_match(lower(p_endpoint), '^([a-z][a-z0-9+.-]*)://([^/?#]*)');  -- schéma, autorité
  end if;
  if m is null or not (exists (select from jsonb_array_elements_text(v_cfg -> 'origins') o where lower(o) = m[1] || '://' || m[2])
    or (m[1] = 'https' and m[2] ~ '^[a-z0-9.-]+$'
      and exists (select from jsonb_array_elements_text(v_cfg -> 'suffixes') s where right(m[2], length(s)) = lower(s)))) then
    perform wm.raise_err(400, 'invalid_request', 'Service de notifications non pris en charge');
  end if;
  perform set_config('lock_timeout', '2s', true);
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (p_uid, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
  delete from public.push_subscriptions where user_id = p_uid and id not in (select id from public.push_subscriptions where user_id = p_uid
    order by created_at desc, id desc limit (select value::int from wm.config where key = 'push_max_subscriptions'));
  return wm.idem_store(p_uid, p_idem, '{"ok": true}');
end $$;

-- Un endpoint inconnu, ou repris par un autre joueur, se désabonne sans erreur et sans rien toucher.
create or replace function wm.push_unsubscribe(p_uid uuid, p_endpoint text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_resp jsonb;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  perform set_config('lock_timeout', '2s', true);
  delete from public.push_subscriptions where user_id = p_uid and endpoint = p_endpoint;
  return wm.idem_store(p_uid, p_idem, '{"ok": true}');
end $$;

-- Une ligne par couple (notification, abonnement) d'un joueur qui a activé le type, dans la transaction qui insère : un échec annule
-- l'événement. Aucun verrou pris (outbox sans clé étrangère). Une notification de plus de 10 minutes (reprise des notifications migrées)
-- n'est jamais poussée.
create or replace function wm.push_enqueue()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into wm.push_outbox (subscription_id, notification_id)
  select s.id, n.id from new_n n
  join wm.notification_prefs p on p.user_id = n.user_id and n.type = any (p.push_types)
  join public.push_subscriptions s on s.user_id = n.user_id
  where n.created_at > now() - interval '10 minutes';
  return null;
end $$;

create or replace trigger notifications_push_enqueue after insert on public.notifications
  referencing new table as new_n for each statement execute function wm.push_enqueue();

-- Réservation du drain (M4b-19) : au plus p_limit lignes, les plus anciennes, sans attendre celles d'un autre drain. Une ligne orpheline,
-- dont l'abonnement est passé à un autre joueur (navigateur partagé), ou de plus d'une heure (réveil coupé ou arrêté, sa purge avec lui,
-- M4b-16), est consommée sans être rendue. Ni actor ni maintenance (M4b-22).
create or replace function wm.push_claim(p_limit int default 500)
returns jsonb language sql security definer set search_path = '' as $$
  with d as (
    delete from wm.push_outbox where id in (select id from wm.push_outbox order by id limit greatest(coalesce(p_limit, 0), 0)
      for update skip locked)
    returning id, subscription_id, notification_id, created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('subscription_id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
    'notification_id', n.id, 'type', n.type, 'data', n.data) order by d.id), '[]')
  from d join public.push_subscriptions s on s.id = d.subscription_id join public.notifications n on n.id = d.notification_id
    and n.user_id = s.user_id
  where d.created_at > now() - interval '1 hour'
$$;

-- Abonnements que le service de push dit expirés (404, 410).
create or replace function wm.push_gone(p_subscription_ids uuid[])
returns int language sql security definer set search_path = '' as $$
  with d as (delete from public.push_subscriptions where id = any (p_subscription_ids) returning 1)
  select count(*)::int from d
$$;

-- Job wm-push-wake (9020, toutes les 15 s) : purge d'une heure d'abord (M4b-16), puis, s'il reste des lignes et qu'une URL est posée, un
-- POST vers /api/cron/push par pg_net ; l'id de la requête. net.* et vault.* liés à l'exécution : la fonction se crée sans eux, et une vue
-- absente ou illisible ou un appel en erreur donnent un avertissement et null, la purge restant acquise.
create or replace function wm.push_wake()
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_url text := (select value #>> '{}' from wm.config where key = 'push_wake_url');
  v_secret text;
begin
  delete from wm.push_outbox where created_at < now() - interval '1 hour';
  if v_url is null or not exists (select from wm.push_outbox) then
    return null;
  end if;
  begin
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'CRON_SECRET';
    if v_secret is null then
      raise warning 'wm.push_wake : secret CRON_SECRET absent du vault';
      return null;
    end if;
    return net.http_post(url := v_url, body := '{}'::jsonb,
      headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret), timeout_milliseconds := 10000);
  exception when others then
    raise warning 'wm.push_wake : % %', sqlstate, sqlerrm;
    return null;
  end;
end $$;

-- Redéfinie de 1650, même signature, une clé en plus (M4b-18) : push_lag_s = âge en secondes de la plus vieille ligne de l'outbox, null si
-- elle est vide. Sa lecture a son propre bloc, hors de celui du cron : une erreur (droit manquant) donne 86400, comme settle_lag_s (B16).
create or replace function wm.health()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_lag int;
  v_overdue int;
  v_push int;
begin
  begin  -- to_regclass lève aussi (droit manquant sur le schéma cron) : dans le bloc
    if to_regclass('cron.job') is not null and to_regclass('cron.job_run_details') is not null then
      execute $q$
        select coalesce((select extract(epoch from now() - max(r.end_time))::int from cron.job_run_details r
                         where r.jobid = j.jobid and r.status = 'succeeded'), 86400)
        from cron.job j where j.jobname = 'wm-settle'
      $q$ into v_lag;
      if v_lag is not null then
        select extract(epoch from now() - min(end_at))::int into v_overdue
        from public.auctions where status = 'active' and end_at < now() - interval '60 seconds';
      end if;
    end if;
  exception when others then
    raise warning 'wm.health : % %', sqlstate, sqlerrm;
    v_lag := 86400;
    v_overdue := null;
  end;
  begin
    select extract(epoch from now() - created_at)::int into v_push from wm.push_outbox order by id limit 1;
  exception when others then
    raise warning 'wm.health : % %', sqlstate, sqlerrm;
    v_push := 86400;
  end;
  return jsonb_build_object('ok', true, 'db', 'ok', 'now', now(), 'settle_lag_s', v_lag, 'overdue_s', v_overdue, 'push_lag_s', v_push);
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
