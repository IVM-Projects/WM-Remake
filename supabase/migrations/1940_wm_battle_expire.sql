-- ADDITIVE : échéances des batailles et santé de la file de quiz (M5a-12, M5a-14, C6, C18) — défis échus, choix des cartes et parties
-- inactifs soldés par le job wm-battle-expire (9030) ; clé quiz de wm.health(). Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- Job wm-battle-expire (9030, M5a-12) : rien pendant la maintenance (personne ne peut jouer, donc personne ne perd). Sinon, par lots : défis
-- échus et choix des cartes inactifs (generating_quizzes hérité compris, C18) → cancelled, sans argent ni notification ; parties inactives →
-- perd celui qui doit jouer (l'attaquant en phase attack, le défenseur en phase quiz). Ni actor. Comme settle_due_auctions (1630) : parties
-- prises for update skip locked, puis tous leurs joueurs d'un seul lock_users (un ordre trié, C4), puis une sous-transaction par partie ; une
-- partie en erreur est sautée et reste active ; un 55P03 du lock_users fait échouer le lot, rejoué au passage suivant. Une ligne tenue par une
-- action en cours est sautée, et repassera. Rend le nombre de batailles changées.
create or replace function wm.expire_battles(p_batch int default 500)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := clock_timestamp();  -- variable, pas l'appel : les index partiels sur created_at et updated_at servent de borne
  c jsonb := (select value from wm.config where key = 'battle');
  v_ids uuid[];
  v_users uuid[];
  b public.battles;
  v_id uuid;
  v_loser uuid;
  n int;
  k int;
begin
  if (select value from wm.config where key = 'maintenance') = 'true'::jsonb then
    return 0;
  end if;
  perform set_config('lock_timeout', '2s', true);
  update public.battles set status = 'cancelled', updated_at = clock_timestamp()
  where id in (select id from public.battles where status = 'pending'
    and created_at <= v_now - make_interval(hours => (c ->> 'invite_ttl_h')::int) order by created_at limit p_batch for update skip locked);
  get diagnostics n = row_count;
  update public.battles set status = 'cancelled', updated_at = clock_timestamp()
  where id in (select id from public.battles where status in ('deck_selection', 'generating_quizzes')
    and updated_at <= v_now - make_interval(hours => (c ->> 'idle_loss_h')::int) order by updated_at limit p_batch for update skip locked);
  get diagnostics k = row_count;
  n := n + k;
  select coalesce(array_agg(id order by updated_at), '{}'), array_agg(challenger_id) || array_agg(opponent_id) into v_ids, v_users
  from (select id, updated_at, challenger_id, opponent_id from public.battles where status = 'active'
        and updated_at <= v_now - make_interval(hours => (c ->> 'idle_loss_h')::int) order by updated_at limit p_batch for update skip locked) d;
  perform wm.lock_users(v_users);
  foreach v_id in array v_ids loop
    begin
      select * into b from public.battles where id = v_id;
      v_loser := case when b.game_state ->> 'phase' = 'quiz' then b.game_state #>> '{pendingAttack,defenderId}'
        else b.game_state ->> 'currentTurnUserId' end;
      perform wm.battle_finish(b.id, case when v_loser = b.challenger_id then b.opponent_id else b.challenger_id end);
      n := n + 1;
    exception when others then
      raise warning 'wm.expire_battles : % %', sqlstate, sqlerrm;
    end;
  end loop;
  return n;
end $$;

-- Redéfinie de 1840, même signature, une clé en plus (M5a-14) : quiz = {queued, oldest_s} sur les lignes encore proposées de la file
-- (attempts < 3), oldest_s nul sur une file vide. Sa lecture a son propre bloc : une erreur (droit manquant) donne {queued: null,
-- oldest_s: 86400}, comme settle_lag_s (B16).
create or replace function wm.health()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_lag int;
  v_overdue int;
  v_push int;
  v_quiz jsonb;
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
  begin
    select jsonb_build_object('queued', count(*), 'oldest_s', extract(epoch from now() - min(enqueued_at))::int) into v_quiz
    from wm.quiz_queue where attempts < 3;
  exception when others then
    raise warning 'wm.health : % %', sqlstate, sqlerrm;
    v_quiz := '{"queued": null, "oldest_s": 86400}';
  end;
  return jsonb_build_object('ok', true, 'db', 'ok', 'now', now(), 'settle_lag_s', v_lag, 'overdue_s', v_overdue, 'push_lag_s', v_push,
    'quiz', v_quiz);
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
