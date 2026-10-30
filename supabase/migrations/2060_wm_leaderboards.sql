-- ADDITIVE : classements (D§7.10, R§5.8, M5b-13, M5b-14, G17, D-C12, D-C14) — guildes de la semaine, joueurs (batailles, collection, légendaires ;
-- semaine ou depuis toujours), rang du lecteur. Lectures stable, sans actor. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : aucun DELETE/UPDATE ici.

-- La guilde du joueur, sinon nul.
create or replace function wm.guild_of(p_uid uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select guild_id from public.guild_members where user_id = p_uid
$$;

-- Guildes de la semaine en cours : seules les lignes de ws sont lues (aucune remise à zéro, D:575). week_end exclusif ; season et week_end
-- en UTC quel que soit le TimeZone de session (C3) : to_char(timestamptz) lirait la zone de session.
create or replace function wm.guild_leaderboard()
returns jsonb language sql stable security definer set search_path = '' as $$
  with w as (select wm.week_start(now()) ws),
  top as (
    select s.guild_id, g.name, s.score_battles, s.score_wb, s.total_score,
      rank() over (order by s.total_score desc) rnk
    from public.guild_weekly_scores s join public.guilds g on g.id = s.guild_id, w
    where s.week_start = w.ws
  ),
  shown as (
    select * from top order by total_score desc, name, guild_id
    limit (select (value ->> 'leaderboard')::int from wm.config where key = 'list_caps')
  )
  select jsonb_build_object(
    'entries', coalesce((select jsonb_agg(jsonb_build_object('rank', t.rnk, 'guild_id', t.guild_id, 'guild_name', t.name,
        'member_count', (select count(*) from public.guild_members m where m.guild_id = t.guild_id),
        'score_battles', t.score_battles, 'score_wb', t.score_wb, 'total_score', t.total_score)
        order by t.total_score desc, t.name, t.guild_id) from shown t), '[]'),
    'week_start', w.ws,
    'week_end', (w.ws at time zone 'UTC' + interval '7 days') at time zone 'UTC',
    'season', 'S' || to_char(w.ws at time zone 'UTC', 'IW'))
  from w
$$;

-- Agrégat unique des classements de joueurs (C12) : valeur et rang de chaque joueur à valeur > 0. Sert leaderboard_top (entries) et
-- leaderboard_me (rang du lecteur), donc les deux ne peuvent pas diverger. Refus de board puis de période : 400.
-- G17 : tout joueur est classé, profil réservé aux amis compris. Une copie reçue par échange garde son obtained_at d'origine (M5b-13).
-- shortcut: agrégat complet à chaque lecture partagée (60 s) ; une table de totaux au M8 si le bench le montre (D-C14).
create or replace function wm.leaderboard_values(p_board text, p_period text)
returns table (user_id uuid, value bigint, rnk bigint) language plpgsql stable security definer set search_path = '' as $$
declare ws timestamptz := wm.week_start(now());
begin
  if p_board is null or p_board not in ('battles', 'collection', 'legendary') then
    perform wm.raise_err(400, 'invalid_request', 'Classement inconnu');
  end if;
  if p_period is null or p_period not in ('week', 'all') then
    perform wm.raise_err(400, 'invalid_request', 'Période inconnue');
  end if;
  return query
  select v.uid, v.n, rank() over (order by v.n desc)
  from (
    select b.uid, b.n from (
      select s.user_id uid, s.battles_won::bigint n from wm.user_stats s
        where p_board = 'battles' and p_period = 'all'
      union all
      select bt.winner_id, count(*) from public.battles bt
        where p_board = 'battles' and p_period = 'week' and bt.status = 'completed' and bt.updated_at >= ws and bt.winner_id is not null
        group by bt.winner_id
      union all
      select c.user_id, sum(c.copies) from wm.user_rarity_counts c
        where p_period = 'all' and (p_board = 'collection' or (p_board = 'legendary' and c.snapshot_rarity = 'L'))
        group by c.user_id
      union all
      select uc.user_id, sum(uc.count) from public.user_cards uc
        where p_period = 'week' and p_board <> 'battles' and uc.obtained_at >= ws and (p_board = 'collection' or uc.snapshot_rarity = 'L')
        group by uc.user_id
    ) b where b.n > 0
  ) v;
end $$;

create or replace function wm.leaderboard_top(p_board text, p_period text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_entries jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('rank', t.rnk, 'user_id', t.user_id, 'username', t.username, 'avatar_url', t.avatar_url,
      'value', t.value) order by t.value desc, t.username, t.user_id), '[]')
  into v_entries
  from (
    select l.user_id, l.value, l.rnk, p.username, p.avatar_url
    from wm.leaderboard_values(p_board, p_period) l join public.profiles p on p.id = l.user_id
    order by l.value desc, p.username, l.user_id
    limit (select (value ->> 'leaderboard')::int from wm.config where key = 'list_caps')
  ) t;
  return jsonb_build_object('board', p_board, 'period', p_period, 'entries', v_entries,
    'week_start', case when p_period = 'week' then wm.week_start(now()) end);
end $$;

-- Rang réel parmi tous (pas seulement le top) et valeur du joueur ; rang nul à 0.
create or replace function wm.leaderboard_me(p_uid uuid, p_board text, p_period text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('rank', l.rnk, 'value', l.value) from wm.leaderboard_values(p_board, p_period) l
    where l.user_id = p_uid), jsonb_build_object('rank', null, 'value', 0))
$$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
