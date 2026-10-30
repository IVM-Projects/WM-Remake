-- Classements (2060_wm_leaderboards.sql) : guildes de la semaine (saison ISO en UTC), joueurs par victoires, collection et légendaires,
-- semaine ou depuis toujours, rang du lecteur. Une seule transaction pour tout le fichier (now() figé) sur une base sans joueur
-- (scripts/db-test.sh) : les rangs y sont exacts. Valeurs posées par insert en superutilisateur (pas de quota de défis ici).
do $$ begin
  assert (select count(*) from public.profiles) = 0 and (select count(*) from public.guilds) = 0, 'base sans joueur ni guilde';
end $$;

create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare d text; begin
  execute p_sql;
  return null;
exception when sqlstate 'P0001' then
  get stacked diagnostics d = pg_exception_detail;
  return d::jsonb;
end $$;

create function pg_temp.card(p_title text, p_rarity public.rarity default 'R') returns uuid language sql as $$
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, category)
  values (p_title, 'https://fr.wikipedia.org/wiki/' || replace(p_title, ' ', '_'), p_rarity, 1200, 800, 'Catégorie échange')
  returning id
$$;

create function pg_temp.player(p_name text, p_balance int default 0) returns uuid language plpgsql as $$
declare u uuid := tests.make_user(p_name, p_balance); begin
  perform wm.set_human_verified(u);
  return u;
end $$;

-- Une ligne user_cards de p_count exemplaires, obtenue p_ago avant maintenant.
create function pg_temp.copy(p_uid uuid, p_card uuid, p_count int default 1, p_ago interval default '0') returns uuid language sql as $$
  insert into public.user_cards (user_id, card_id, count, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def, obtained_at)
  select p_uid, id, p_count, wikipedia_title, rarity, category, atk, def, now() - p_ago from public.cards where id = p_card
  returning id
$$;

create function pg_temp.friends(p_a uuid, p_b uuid) returns void language sql as $$
  insert into public.friendships (requester_id, addressee_id, status) values (p_a, p_b, 'accepted')
$$;

create function pg_temp.items(p_by uuid, p_copies uuid[]) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_card_id', x, 'card_id', (select card_id from public.user_cards where id = x),
    'offered_by', p_by) order by o), '[]')
  from unnest(p_copies) with ordinality u (x, o)
$$;

-- Bataille terminée gagnée par p_winner contre p_loser, mise à jour à p_at.
create function pg_temp.win(p_winner uuid, p_loser uuid, p_at timestamptz) returns void language sql as $$
  insert into public.battles (challenger_id, opponent_id, winner_id, status, updated_at) values (p_winner, p_loser, p_winner, 'completed', p_at)
$$;

-- Volatilité : les quatre lectures sont stable.
do $$ begin
  assert (select count(*) from pg_proc where oid in ('wm.guild_leaderboard()'::regprocedure, 'wm.guild_of(uuid)'::regprocedure,
    'wm.leaderboard_top(text,text)'::regprocedure, 'wm.leaderboard_me(uuid,text,text)'::regprocedure) and provolatile = 's') = 4, 'stable';
end $$;

-- Guildes : 900, 500, 500 cette semaine et 9 999 la semaine précédente.
do $$ declare ws timestamptz := wm.week_start(now()); g1 uuid; g2 uuid; g3 uuid; g4 uuid; u uuid; r jsonb; e jsonb; begin
  insert into public.guilds (name) values ('LbG1') returning id into g1;
  insert into public.guilds (name) values ('LbGb') returning id into g2;
  insert into public.guilds (name) values ('LbGa') returning id into g3;
  insert into public.guilds (name) values ('LbG4') returning id into g4;
  insert into public.guild_weekly_scores (week_start, guild_id, score_battles, score_wb) values
    (ws, g1, 400, 500), (ws, g2, 500, 0), (ws, g3, 0, 500), (ws - interval '7 days', g4, 9999, 0);
  u := pg_temp.player('LbGm1'); insert into public.guild_members (guild_id, user_id) values (g1, u);
  u := pg_temp.player('LbGm2'); insert into public.guild_members (guild_id, user_id) values (g1, u);
  u := pg_temp.player('LbGm3'); insert into public.guild_members (guild_id, user_id) values (g3, u);
  assert wm.guild_of(u) = g3, 'guild_of membre';
  assert wm.guild_of(pg_temp.player('LbGsans')) is null, 'guild_of sans guilde';
  r := wm.guild_leaderboard();
  assert (select array_agg(k order by k) from jsonb_object_keys(r) k) = array['entries', 'season', 'week_end', 'week_start'], r::text;
  assert (r ->> 'week_start')::timestamptz = ws and (r ->> 'week_end')::timestamptz = ws + interval '7 days', 'bornes';
  assert r ->> 'season' = 'S' || to_char(ws at time zone 'UTC', 'IW'), 'saison';
  assert jsonb_array_length(r -> 'entries') = 3, r::text;
  e := r -> 'entries' -> 0;
  assert (select array_agg(k order by k) from jsonb_object_keys(e) k)
    = array['guild_id', 'guild_name', 'member_count', 'rank', 'score_battles', 'score_wb', 'total_score'], e::text;
  assert (select array_agg(x ->> 'guild_name' || ':' || (x ->> 'rank') || ':' || (x ->> 'total_score') || ':' || (x ->> 'member_count'))
    from jsonb_array_elements(r -> 'entries') x) = array['LbG1:1:900:2', 'LbGa:2:500:1', 'LbGb:2:500:0'], r::text;
  assert (e ->> 'score_battles')::int = 400 and (e ->> 'score_wb')::int = 500 and e ->> 'guild_id' = g1::text, e::text;
  assert not exists (select from jsonb_array_elements(r -> 'entries') x where x ->> 'guild_id' = g4::text), 'semaine précédente absente';
  -- 101 guildes → 100 entrées.
  insert into public.guilds (name) select 'LbGx' || i from generate_series(1, 98) i;
  insert into public.guild_weekly_scores (week_start, guild_id, score_battles) select ws, id, 1 from public.guilds where name like 'LbGx%';
  assert (select count(*) from public.guilds) = 102 and jsonb_array_length(wm.guild_leaderboard() -> 'entries') = 100, 'plafond 100';
end $$;

-- Saison et fin de semaine en UTC quel que soit le TimeZone de session : SQL dynamique par zone (le plan d'une boucle statique serait figé).
do $$ declare z text; base jsonb; r jsonb; tz text := current_setting('TimeZone'); begin
  execute 'select wm.guild_leaderboard()' into base;
  foreach z in array array['America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata'] loop
    execute format('set local timezone = %L', z);
    execute 'select wm.guild_leaderboard()' into r;
    assert r ->> 'season' = base ->> 'season' and (r ->> 'week_end')::timestamptz = (base ->> 'week_end')::timestamptz
      and (r ->> 'week_start')::timestamptz = (base ->> 'week_start')::timestamptz, z || ' : ' || r::text || ' / ' || base::text;
  end loop;
  execute format('set local timezone = %L', tz);
end $$;

-- Joueurs : A, B, C valorisés ; Z à zéro. C est réservé aux amis (G17).
do $$ declare ws timestamptz := wm.week_start(now()); a uuid := pg_temp.player('LbA'); b uuid := pg_temp.player('LbB');
  c uuid := pg_temp.player('LbC'); z uuid := pg_temp.player('LbZ'); r jsonb; begin
  update public.profiles set is_public = false where id = c;
  update wm.user_stats set battles_won = case user_id when a then 5 when b then 3 when c then 3 else 0 end where user_id in (a, b, c, z);
  perform pg_temp.win(a, z, ws);
  perform pg_temp.win(a, z, ws + interval '1 second');
  perform pg_temp.win(a, z, ws - interval '1 second');
  perform pg_temp.win(b, z, now());
  perform pg_temp.win(c, z, now());
  insert into public.battles (challenger_id, opponent_id, winner_id, status, updated_at) values (z, a, a, 'active', now());  -- pas terminée
  perform pg_temp.copy(a, pg_temp.card('Lb A1'), 2);
  perform pg_temp.copy(a, pg_temp.card('Lb A2'), 5, interval '1 day' + (now() - ws));
  perform pg_temp.copy(b, pg_temp.card('Lb B1', 'L'), 1);
  perform pg_temp.copy(b, pg_temp.card('Lb B2', 'C'), 3, interval '1 day' + (now() - ws));
  perform pg_temp.copy(c, pg_temp.card('Lb C1', 'L'), 2, interval '1 day' + (now() - ws));
  perform pg_temp.copy(c, pg_temp.card('Lb C2', 'C'), 1);
  -- (board, period) -> "nom:rang:valeur" dans l'ordre d'affichage
  assert (select array_agg(x ->> 'username' || ':' || (x ->> 'rank') || ':' || (x ->> 'value'))
    from jsonb_array_elements(wm.leaderboard_top('battles', 'all') -> 'entries') x) = array['LbA:1:5', 'LbB:2:3', 'LbC:2:3'], 'battles all';
  assert (select array_agg(x ->> 'username' || ':' || (x ->> 'rank') || ':' || (x ->> 'value'))
    from jsonb_array_elements(wm.leaderboard_top('battles', 'week') -> 'entries') x) = array['LbA:1:2', 'LbB:2:1', 'LbC:2:1'], 'battles week';
  assert (select array_agg(x ->> 'username' || ':' || (x ->> 'rank') || ':' || (x ->> 'value'))
    from jsonb_array_elements(wm.leaderboard_top('collection', 'all') -> 'entries') x) = array['LbA:1:7', 'LbB:2:4', 'LbC:3:3'], 'collection all';
  assert (select array_agg(x ->> 'username' || ':' || (x ->> 'rank') || ':' || (x ->> 'value'))
    from jsonb_array_elements(wm.leaderboard_top('collection', 'week') -> 'entries') x) = array['LbA:1:2', 'LbB:2:1', 'LbC:2:1'], 'collection week';
  assert (select array_agg(x ->> 'username' || ':' || (x ->> 'rank') || ':' || (x ->> 'value'))
    from jsonb_array_elements(wm.leaderboard_top('legendary', 'all') -> 'entries') x) = array['LbC:1:2', 'LbB:2:1'], 'legendary all';
  assert (select array_agg(x ->> 'username' || ':' || (x ->> 'rank') || ':' || (x ->> 'value'))
    from jsonb_array_elements(wm.leaderboard_top('legendary', 'week') -> 'entries') x) = array['LbB:1:1'], 'legendary week';
  -- Clés, week_start, avatar_url.
  r := wm.leaderboard_top('battles', 'week');
  assert (select array_agg(k order by k) from jsonb_object_keys(r) k) = array['board', 'entries', 'period', 'week_start']
    and r ->> 'board' = 'battles' and r ->> 'period' = 'week' and (r ->> 'week_start')::timestamptz = ws, r::text;
  assert (select array_agg(k order by k) from jsonb_object_keys(r -> 'entries' -> 0) k) = array['avatar_url', 'rank', 'user_id', 'username', 'value'], r::text;
  r := wm.leaderboard_top('battles', 'all');
  assert r -> 'week_start' = 'null'::jsonb, 'week_start nul en all';
  -- Valeurs par défaut du contrat côté route : refus.
  assert pg_temp.err('select wm.leaderboard_top(''x'', ''week'')') ->> 'message' = 'Classement inconnu'
    and (pg_temp.err('select wm.leaderboard_top(''x'', ''week'')') ->> 'status')::int = 400, 'board inconnu';
  assert pg_temp.err('select wm.leaderboard_top(''battles'', ''y'')') ->> 'message' = 'Période inconnue', 'période inconnue';
  assert pg_temp.err(format('select wm.leaderboard_me(%L, ''x'', ''all'')', a)) ->> 'message' = 'Classement inconnu', 'me : board inconnu';
  assert pg_temp.err(format('select wm.leaderboard_me(%L, ''battles'', ''y'')', a)) ->> 'message' = 'Période inconnue', 'me : période inconnue';
  -- me : rang réel, égalités partagées, nul à zéro ; accord avec entries pour chaque tableau × période.
  assert wm.leaderboard_me(b, 'collection', 'all') = jsonb_build_object('rank', 2, 'value', 4), wm.leaderboard_me(b, 'collection', 'all')::text;
  assert wm.leaderboard_me(c, 'battles', 'all') = jsonb_build_object('rank', 2, 'value', 3), 'me égalité';
  assert not exists (select from (values ('battles'), ('collection'), ('legendary')) bd (board), (values ('week'), ('all')) pd (period)
    where wm.leaderboard_me(z, bd.board, pd.period) is not null), 'me à zéro : nul, 3 tableaux × 2 périodes';
  assert wm.leaderboard_me(a, 'legendary', 'all') is null, 'me légendaires à zéro';
  assert not exists (
    select from (values ('battles'), ('collection'), ('legendary')) bd (board), (values ('week'), ('all')) pd (period),
      jsonb_array_elements(wm.leaderboard_top(bd.board, pd.period) -> 'entries') x
    where wm.leaderboard_me((x ->> 'user_id')::uuid, bd.board, pd.period) is distinct from jsonb_build_object('rank', x -> 'rank', 'value', x -> 'value')),
    'me = entries';
  assert (select count(*) from public.profiles where not is_public) = 1
    and exists (select from jsonb_array_elements(wm.leaderboard_top('collection', 'all') -> 'entries') x where x ->> 'username' = 'LbC'), 'G17';
end $$;

-- Copie reçue par un échange cette semaine : garde son obtained_at d'origine → absente de collection/week du receveur, présente en all.
do $$ declare ws timestamptz := wm.week_start(now()); a uuid := (select id from public.profiles where username = 'LbA');
  d uuid := pg_temp.player('LbD'); a3 uuid := pg_temp.copy(a, pg_temp.card('Lb A3'), 1, interval '1 day' + (now() - ws)); t uuid; begin
  perform pg_temp.friends(a, d);
  t := wm.create_trade(a, d, pg_temp.items(a, array[a3])) ->> 'id';
  assert wm.trade_action(d, t, 'accept') ->> 'status' = 'accepted', 'acceptation';
  assert wm.leaderboard_me(d, 'collection', 'all') = jsonb_build_object('rank', 4, 'value', 1), wm.leaderboard_me(d, 'collection', 'all')::text;
  assert wm.leaderboard_me(d, 'collection', 'week') is null, 'échange hors semaine';
end $$;
