-- Batailles (1900_wm_battle_core.sql, puis 1910…1950) : config, banques et file de quiz, secrets des réponses, battles_won, index, invariant
-- battle_money ; les tâches suivantes du M5a ajoutent leurs blocs.
-- Une seule transaction pour tout le fichier (now() figé) : chaque bloc crée ses joueurs et ses cartes, et ne filtre que sur eux. Le seed
-- n'est pas chargé hors --setup-only (scripts/db-test.sh:63-71) : aucun bloc ne compte sur lui.
-- check_invariants est global : un bloc qui crée une violation la défait avant de finir (sous-transaction WMT00, 27_market.test.sql:278-285),
-- et aucune bataille completed n'est insérée sans ses deux lignes battle:<id>.

-- Exécute p_sql et renvoie le detail JSON de l'erreur P0001 levée (null si aucune) ; l'effet de p_sql n'est annulé que si p_sql lève.
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare d text; begin
  execute p_sql;
  return null;
exception when sqlstate 'P0001' then
  get stacked diagnostics d = pg_exception_detail;
  return d::jsonb;
end $$;

create function pg_temp.inv(p_label text) returns void language plpgsql as $$ begin
  assert wm.check_invariants() = '[]'::jsonb, p_label || ' : ' || wm.check_invariants()::text;
end $$;

-- Joueur vérifié (fenêtres anti-bot remises à zéro).
create function pg_temp.player(p_name text, p_balance int default 0) returns uuid language plpgsql as $$
declare u uuid := tests.make_user(p_name, p_balance); begin
  perform wm.set_human_verified(u);
  return u;
end $$;

-- Une ligne user_cards aux snapshots de la carte.
create function pg_temp.copy(p_uid uuid, p_card uuid, p_count int default 1) returns uuid language sql as $$
  insert into public.user_cards (user_id, card_id, count, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
  select p_uid, id, p_count, wikipedia_title, rarity, category, atk, def from public.cards where id = p_card
  returning id
$$;

create function pg_temp.friends(p_a uuid, p_b uuid) returns void language sql as $$
  insert into public.friendships (requester_id, addressee_id, status) values (p_a, p_b, 'accepted')
$$;

-- Carte du catalogue au titre unique, ajoutée au pool. Vues par défaut à 20 % d'écart d'une carte à la suivante, sur un cycle de 60 (au plus
-- 100 × 1,2^59, environ 4,7 millions : jamais de débordement de l'int). Un null explicite donne une carte sans category ou sans résumé ; le
-- résumé par défaut, court et sans année, ne donne que des questions de vues (T5).
create function pg_temp.bcard(p_title text, p_rarity public.rarity, p_atk int, p_def int, p_views int default null,
  p_category text default 'Catégorie bataille', p_summary text default 'Carte d''essai des batailles.') returns uuid language plpgsql as $$
declare c uuid; begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, pageviews, category, summary)
  values (p_title, 'https://fr.wikipedia.org/wiki/' || replace(p_title, ' ', '_'), p_rarity, p_atk, p_def,
    coalesce(p_views, round(100 * 1.2 ^ ((select count(*) from public.cards) % 60))::int), p_category, p_summary)
  returning id into c;
  perform wm.pool_add(c, p_rarity);
  return c;
end $$;

-- Config des batailles (C2), avec sa note, et list_caps.battles_closed.
create function pg_temp.battle_config() returns jsonb language sql as $$
  select jsonb_object_agg(key, value) from wm.config where key in ('battle', 'list_caps')
$$;

do $$ begin
  assert pg_temp.battle_config() -> 'battle' = '{"questions":3,"pool":6,"quota_free":3,"quota_pro":10,"invite_ttl_h":24,"idle_loss_h":48,
    "reward_win":50,"reward_loss":10}'::jsonb, pg_temp.battle_config()::text;
  assert pg_temp.battle_config() #> '{list_caps,battles_closed}' = '50', 'list_caps.battles_closed';
  assert (select coalesce(note, '') <> '' from wm.config where key = 'battle'), 'note manquante';
end $$;

-- Rejeu de 1900 : mêmes valeurs, et une valeur déjà posée garde la sienne.
create temp table battle_config as select pg_temp.battle_config() v;
update wm.config set value = value || '{"quota_free": 5}' where key = 'battle';
update wm.config set value = value || '{"battles_closed": 7}' where key = 'list_caps';
\ir ../migrations/1900_wm_battle_core.sql
do $$ begin
  assert pg_temp.battle_config() = jsonb_set(jsonb_set((select v from battle_config), '{battle,quota_free}', '5'), '{list_caps,battles_closed}', '7'),
    pg_temp.battle_config()::text;
end $$;
update wm.config set value = value || '{"quota_free": 3}' where key = 'battle';
update wm.config set value = value || '{"battles_closed": 50}' where key = 'list_caps';

-- battles_won d'un joueur neuf (M5a-2).
do $$ declare u uuid := pg_temp.player('BatStats'); begin
  perform wm.lock_user(u);
  assert (select battles_won from wm.user_stats where user_id = u) = 0, 'battles_won';
end $$;

-- Index (C18, D:810), définition complète ; battles_open_pair_uidx unique (M5a-12).
do $$ declare bad text; begin
  select string_agg(v.n, ', ') into bad from (values
    ('battles_challenger_idx', '', 'public.battles USING btree (challenger_id, created_at DESC)'),
    ('battles_opponent_idx', '', 'public.battles USING btree (opponent_id, created_at DESC)'),
    ('battles_winner_idx', '', 'public.battles USING btree (winner_id) WHERE (winner_id IS NOT NULL)'),
    ('battle_decks_user_idx', '', 'public.battle_decks USING btree (user_id)'),
    ('battles_open_pair_uidx', 'UNIQUE ', 'public.battles USING btree (LEAST(challenger_id, opponent_id), GREATEST(challenger_id, opponent_id)) '
      || 'WHERE (status = ANY (ARRAY[''pending''::battle_status, ''deck_selection''::battle_status, ''generating_quizzes''::battle_status, '
      || '''active''::battle_status]))'),
    ('battles_pending_idx', '', 'public.battles USING btree (created_at) WHERE (status = ''pending''::battle_status)'),
    ('battles_live_idx', '', 'public.battles USING btree (updated_at) WHERE (status = ANY (ARRAY[''deck_selection''::battle_status, '
      || '''generating_quizzes''::battle_status, ''active''::battle_status]))'),
    ('quiz_queue_next_idx', '', 'wm.quiz_queue USING btree (priority DESC, enqueued_at) WHERE (attempts < 3)')) v (n, u, def)
  where not exists (select from pg_indexes i where i.indexname = v.n and i.indexdef = format('CREATE %sINDEX %s ON %s', v.u, v.n, v.def));
  assert bad is null, 'index absents ou différents : ' || bad;
end $$;

-- Tables (C3) : source contrôlée ; une carte supprimée emporte sa banque et sa ligne de file (insérée sans pool_add : la clé de
-- wm.draw_pool est NO ACTION) ; une bataille supprimée emporte ses secrets. bcard vérifiée dans une sous-transaction annulée (WMT00) : le
-- bloc ne laisse aucune carte au pool des blocs suivants.
do $$ declare c uuid; pooled boolean; k uuid; a uuid := pg_temp.player('BatSecA'); b uuid := pg_temp.player('BatSecB'); x uuid; begin
  begin
    c := pg_temp.bcard('Bataille au pool', 'R', 1000, 800);
    pooled := exists (select from wm.draw_pool where card_id = c);
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert pooled, 'bcard hors du pool';
  assert not exists (select from public.cards where id = c), 'carte de bcard restée';
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
  values ('Bataille hors pool', 'https://fr.wikipedia.org/wiki/Bataille_hors_pool', 'R', 1000, 800) returning id into k;
  begin
    insert into wm.card_quizzes (card_id, prompt_version, source, questions) values (k, 1, 'x', '[]');
    assert false, 'source x acceptée';
  exception when check_violation then null;
  end;
  insert into wm.card_quizzes (card_id, prompt_version, source, questions) values (k, 1, 'template', '[]');
  insert into wm.quiz_queue (card_id, priority) values (k, 60);
  delete from public.cards where id = k;
  assert not exists (select from wm.card_quizzes where card_id = k), 'banque restée';
  assert not exists (select from wm.quiz_queue where card_id = k), 'ligne de file restée';
  insert into public.battles (challenger_id, opponent_id) values (a, b) returning id into x;
  insert into wm.battle_secrets (battle_id, question_id, turn_number, defender_id, card_id, q_index, correct_option_id)
  values (x, gen_random_uuid(), 1, b, gen_random_uuid(), 0, gen_random_uuid()::text);
  delete from public.battles where id = x;
  assert not exists (select from wm.battle_secrets where battle_id = x), 'secrets restés';
end $$;

-- battle_money : tout le scénario dans une sous-transaction annulée (WMT00), d contrôlé après ; le bloc ne laisse ni amitié ni bataille.
do $$ declare a uuid := pg_temp.player('BatMonA'); b uuid := pg_temp.player('BatMonB'); c uuid := pg_temp.player('BatMonCarol');
  x uuid; y uuid; d1 jsonb; d2 jsonb; d3 jsonb; d4 jsonb; d5 jsonb; d6 jsonb; begin
  begin
    perform pg_temp.friends(a, b);
    insert into public.battles (challenger_id, opponent_id) values (a, b) returning id into x;
    -- (a) Ligne battle:<id> d'une bataille pending.
    perform wm.wallet_apply(a, 50, 'battle', 'battle:' || x);
    d1 := wm.check_invariants();
    -- (b) Bataille completed sans la ligne de l'opponent, puis avec.
    update public.battles set status = 'completed', winner_id = a where id = x;
    d2 := wm.check_invariants();
    perform wm.wallet_apply(b, 10, 'battle', 'battle:' || x);
    d3 := wm.check_invariants();
    -- (b) Bataille completed sans la ligne du challenger, puis avec (d5 exact le prouve).
    insert into public.battles (challenger_id, opponent_id, status, winner_id) values (a, b, 'completed', b) returning id into y;
    perform wm.wallet_apply(b, 50, 'battle', 'battle:' || y);
    d4 := wm.check_invariants();
    perform wm.wallet_apply(a, 10, 'battle', 'battle:' || y);
    -- (a) Ligne d'un tiers, puis ref mal formée d'un joueur de la bataille (un cast y lèverait 22P02) : des violations, pas une erreur.
    perform wm.wallet_apply(c, 10, 'battle', 'battle:' || x);
    d5 := wm.check_invariants();
    perform wm.wallet_apply(a, 10, 'battle', 'battle:x');
    d6 := wm.check_invariants();
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert d1 = jsonb_build_array(jsonb_build_object('check', 'battle_money', 'ref', 'battle:' || x, 'user_id', a)), d1::text;
  assert d2 = jsonb_build_array(jsonb_build_object('check', 'battle_money', 'battle_id', x, 'user_id', b)), d2::text;
  assert d3 = '[]', d3::text;
  assert d4 = jsonb_build_array(jsonb_build_object('check', 'battle_money', 'battle_id', y, 'user_id', a)), d4::text;
  assert d5 = jsonb_build_array(jsonb_build_object('check', 'battle_money', 'ref', 'battle:' || x, 'user_id', c)), d5::text;
  assert d6 @> d5 and d6 @> jsonb_build_array(jsonb_build_object('check', 'battle_money', 'ref', 'battle:x', 'user_id', a))
    and jsonb_array_length(d6) = 2, d6::text;
  assert not exists (select from public.battles where a in (challenger_id, opponent_id)), 'bataille restée';
  assert not exists (select from public.friendships where a in (requester_id, addressee_id)), 'amitié restée';
  perform pg_temp.inv('battle_money annulé');
end $$;

-- Défis et lectures (1920_wm_battles.sql). Chaque bloc fait tout dans une sous-transaction annulée (WMT00) : joueurs, amitiés, batailles,
-- notifications et config posés par lui disparaissent avant le bloc suivant.

-- Notifications d'une bataille, triées par type puis destinataire.
create function pg_temp.bnotes(p_battle uuid) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'type', type, 'data', data) order by type, user_id), '[]')
  from public.notifications where data ->> 'battle_id' = p_battle::text
$$;

-- Corps d'erreur sans code (404, 409, 429) ou avec, error = message.
create function pg_temp.berr(p_status int, p_code text, p_message text, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('status', p_status, 'code', p_code, 'error', p_message, 'message', p_message)) || p_extra
$$;

-- Création (C5, C10, C6) : réponse exacte, ligne pending sans game_state, battle_invite pour B, objet Battle exact, quota et règles (C2) ;
-- refus exacts, sans ligne de plus.
do $$ declare a uuid; b uuid; c uuid; x uuid; r jsonb; d jsonb;
  reset timestamptz := ((now() at time zone 'Europe/Paris')::date + 1)::timestamp at time zone 'Europe/Paris'; begin
  begin
    a := pg_temp.player('BatCreA'); b := pg_temp.player('BatCreB'); c := pg_temp.player('BatCreCarol');
    perform pg_temp.friends(a, b);
    r := wm.battle_create(a, b, 'Europe/Paris');
    x := (r ->> 'id')::uuid;
    assert r = jsonb_build_object('battle', jsonb_build_object('id', x), 'id', x), r::text;
    assert (select status = 'pending' and game_state is null and challenger_id = a and opponent_id = b from public.battles where id = x), 'ligne créée';
    assert pg_temp.bnotes(x) = jsonb_build_array(jsonb_build_object('user_id', b, 'type', 'battle_invite',
      'data', jsonb_build_object('battle_id', x, 'user_id', a, 'username', 'BatCreA'))), pg_temp.bnotes(x)::text;
    d := wm.battles_list(a, 'Europe/Paris');
    assert d -> 'challenge_quota' = jsonb_build_object('used', 1, 'limit', 3, 'resets_at', reset), d::text;
    assert d -> 'rules' = '{"questions":3,"pool":6,"quota_free":3,"quota_pro":10,"invite_ttl_h":24,"idle_loss_h":48,"reward_win":50,
      "reward_loss":10}', d::text;
    -- Détail d'un pending (C5, C6) : les 8 colonnes, les deux joueurs, expires_at, idle_at nul, game_state nul ; ni deck ni récompense.
    d := wm.battle_detail(b, x);
    assert d = jsonb_build_object('battle', jsonb_build_object('id', x, 'challenger_id', a, 'opponent_id', b, 'winner_id', null,
        'status', 'pending', 'game_state', null, 'created_at', now(), 'updated_at', now(),
        'challenger', jsonb_build_object('id', a, 'username', 'BatCreA'), 'opponent', jsonb_build_object('id', b, 'username', 'BatCreB'),
        'expires_at', now() + interval '24 hours', 'idle_at', null),
      'decks', '[]'::jsonb, 'reward', null), d::text;
    d := pg_temp.err(format('select wm.battle_create(%L, %L)', a, a));
    assert d = pg_temp.berr(400, 'invalid_request', 'Tu ne peux pas te défier toi-même'), coalesce(d::text, 'accepté');
    d := pg_temp.err(format('select wm.battle_create(%L, %L)', a, gen_random_uuid()));
    assert d = pg_temp.berr(404, null, 'Joueur introuvable'), coalesce(d::text, 'accepté');
    d := pg_temp.err(format('select wm.battle_create(%L, %L)', a, c));
    assert d = '{"status":403,"code":"FORBIDDEN","error":"Vous devez être amis pour vous défier","message":"Vous devez être amis pour vous défier"}',
      coalesce(d::text, 'accepté');
    d := pg_temp.err(format('select wm.battle_create(%L, %L)', a, b));
    assert d = pg_temp.berr(409, null, 'Une bataille est déjà en cours avec ce joueur', jsonb_build_object('battle_id', x)), coalesce(d::text, 'accepté');
    d := pg_temp.err(format('select wm.battle_create(%L, %L)', b, a));
    assert d = pg_temp.berr(409, null, 'Une bataille est déjà en cours avec ce joueur', jsonb_build_object('battle_id', x)), coalesce(d::text, 'accepté');
    update wm.config set value = 'true' where key = 'maintenance';
    d := pg_temp.err(format('select wm.battle_create(%L, %L)', a, c));
    assert d ->> 'status' = '503', coalesce(d::text, 'accepté');
    update wm.config set value = 'false' where key = 'maintenance';
    assert (select count(*) from public.battles where a in (challenger_id, opponent_id)) = 1, 'ligne de plus';
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Review Focus, quota et fuseau (M5a-12) : quota_free à 2 ; le 3ᵉ défi → 429 exact, sans ligne ; retrait et refus comptent ; 10 en Pro et
-- en VIP ; un défi de la veille du fuseau ne compte pas, un défi au premier instant du jour compte ; fuseau inconnu → Europe/Paris.
do $$ declare a uuid; c uuid; dd uuid; e uuid; h uuid; xc uuid; xd uuid; d jsonb; f text; df timestamptz; i int := 0;
  dp timestamptz := (now() at time zone 'Europe/Paris')::date::timestamp at time zone 'Europe/Paris';
  reset timestamptz := ((now() at time zone 'Europe/Paris')::date + 1)::timestamp at time zone 'Europe/Paris'; begin
  begin
    update wm.config set value = value || '{"quota_free": 2}' where key = 'battle';
    a := pg_temp.player('BatQuA'); c := pg_temp.player('BatQuC'); dd := pg_temp.player('BatQuD'); e := pg_temp.player('BatQuE');
    perform pg_temp.friends(a, c);
    perform pg_temp.friends(a, dd);
    perform pg_temp.friends(e, a);
    xc := (wm.battle_create(a, c, 'Europe/Paris') ->> 'id')::uuid;
    xd := (wm.battle_create(a, dd, 'Europe/Paris') ->> 'id')::uuid;
    d := pg_temp.err(format('select wm.battle_create(%L, %L, %L)', a, e, 'Europe/Paris'));
    assert d = pg_temp.berr(429, null, 'Limite quotidienne de défis atteinte', jsonb_build_object('retry_after', reset,
      'challenge_quota', jsonb_build_object('used', 2, 'limit', 2, 'resets_at', reset))), coalesce(d::text, 'accepté');
    assert (select count(*) from public.battles where challenger_id = a) = 2, 'ligne de plus au 429';
    perform wm.battle_action(a, xc, 'withdraw_invite');
    perform wm.battle_action(dd, xd, 'decline');
    assert wm.battles_list(a, 'Europe/Paris') -> 'challenge_quota' = jsonb_build_object('used', 2, 'limit', 2, 'resets_at', reset),
      'retrait et refus non comptés';
    update public.profiles set is_pro = true where id = a;
    assert wm.battles_list(a, 'Europe/Paris') #> '{challenge_quota,limit}' = '10', 'Pro';
    update public.profiles set is_pro = false, is_vip = true where id = a;
    assert wm.battles_list(a, 'Europe/Paris') #> '{challenge_quota,limit}' = '10', 'VIP';
    update public.profiles set is_vip = false where id = a;
    -- Une seconde avant minuit à Paris : la veille.
    insert into public.battles (challenger_id, opponent_id, status, created_at) values (a, e, 'cancelled', dp - interval '1 second');
    assert wm.battles_list(a, 'Europe/Paris') -> 'challenge_quota' = jsonb_build_object('used', 2, 'limit', 2, 'resets_at', reset),
      'défi de la veille compté';
    assert wm.battles_list(a, 'Mars/Olympus') -> 'challenge_quota' = jsonb_build_object('used', 2, 'limit', 2, 'resets_at', reset),
      'fuseau inconnu';
    -- Etc/GMT-14 (UTC+14) et Etc/GMT+12 (UTC−12) : premier instant du jour moins 1 s, puis exactement (22_packs.test.sql:139-146).
    foreach f in array array['Etc/GMT-14', 'Etc/GMT+12'] loop
      i := i + 1;
      h := pg_temp.player('BatQuTz' || i);
      df := (now() at time zone f)::date::timestamp at time zone f;
      insert into public.battles (challenger_id, opponent_id, status, created_at) values (h, a, 'cancelled', df - interval '1 second');
      assert wm.battles_list(h, f) #> '{challenge_quota,used}' = '0', f || ' : veille comptée';
      insert into public.battles (challenger_id, opponent_id, status, created_at) values (h, a, 'cancelled', df);
      assert wm.battles_list(h, f) -> 'challenge_quota' = jsonb_build_object('used', 1, 'limit', 2, 'resets_at', df + interval '24 hours'),
        f || ' : premier instant non compté';
    end loop;
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert pg_temp.battle_config() #> '{battle,quota_free}' = '3', 'quota_free non restauré';
end $$;

-- Review Focus, saut de fuseau (M5a-12) : quota_free à 3 ; dans le fuseau dont le jour a commencé il y a moins de 22 h (Etc/GMT+12 ou
-- Etc/GMT-14, débuts de jour à 2 h ou 22 h d'écart), 6 défis juste avant d0 : aucun ce jour-là, mais 6 = 2 × limit sur 24 h → 429,
-- retry_after = le plus ancien + 24 h. Sans la garde des 24 h, l'appel passe.
do $$ declare a uuid; f uuid; o uuid; tz text; d0 timestamptz; d jsonb; begin
  begin
    a := pg_temp.player('BatJumpA'); f := pg_temp.player('BatJumpF'); o := pg_temp.player('BatJumpO');
    perform pg_temp.friends(a, f);
    select t into tz from unnest(array['Etc/GMT+12', 'Etc/GMT-14']) t
    where now() - (now() at time zone t)::date::timestamp at time zone t < interval '22 hours' limit 1;
    d0 := (now() at time zone tz)::date::timestamp at time zone tz;
    insert into public.battles (challenger_id, opponent_id, status, created_at)
    select a, o, 'cancelled', d0 - i * interval '1 second' from generate_series(1, 6) i;
    assert wm.battles_list(a, tz) #> '{challenge_quota,used}' = '0', tz || ' : défis d''avant d0 comptés';
    d := pg_temp.err(format('select wm.battle_create(%L, %L, %L)', a, f, tz));
    assert d = pg_temp.berr(429, null, 'Limite quotidienne de défis atteinte', jsonb_build_object(
      'retry_after', d0 - interval '6 seconds' + interval '24 hours',
      'challenge_quota', jsonb_build_object('used', 0, 'limit', 3, 'resets_at', d0 + interval '24 hours'))), tz || ' → ' || coalesce(d::text, 'accepté');
    assert (select count(*) from public.battles where challenger_id = a) = 6, 'ligne de plus au saut de fuseau';
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Review Focus, les deux bornes (M5a-12) : Etc/GMT-14, sans heure d'été (resets_at = d0 + 24 h) ; 6 défis de d0 + 1 s à d0 + 6 s → les
-- deux bornes atteintes, retry_after = le plus tardif, d0 + 1 s + 24 h. La borne du jour seule rendrait resets_at.
do $$ declare a uuid; f uuid; o uuid; d0 timestamptz := (now() at time zone 'Etc/GMT-14')::date::timestamp at time zone 'Etc/GMT-14'; d jsonb; begin
  begin
    a := pg_temp.player('BatBothA'); f := pg_temp.player('BatBothF'); o := pg_temp.player('BatBothO');
    perform pg_temp.friends(a, f);
    insert into public.battles (challenger_id, opponent_id, status, created_at)
    select a, o, 'cancelled', d0 + i * interval '1 second' from generate_series(1, 6) i;
    assert wm.battles_list(a, 'Etc/GMT-14') #> '{challenge_quota,used}' = '6', 'défis du jour';
    d := pg_temp.err(format('select wm.battle_create(%L, %L, %L)', a, f, 'Etc/GMT-14'));
    assert d = pg_temp.berr(429, null, 'Limite quotidienne de défis atteinte', jsonb_build_object(
      'retry_after', d0 + interval '1 second' + interval '24 hours',
      'challenge_quota', jsonb_build_object('used', 6, 'limit', 3, 'resets_at', d0 + interval '24 hours'))), coalesce(d::text, 'accepté');
    assert (select count(*) from public.battles where challenger_id = a) = 6, 'ligne de plus aux deux bornes';
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Idempotency-Key : même corps, une seule bataille.
do $$ declare a uuid; b uuid; r1 jsonb; r2 jsonb; begin
  begin
    a := pg_temp.player('BatIdemA'); b := pg_temp.player('BatIdemB');
    perform pg_temp.friends(a, b);
    r1 := wm.battle_create(a, b, 'Europe/Paris', 'k-bat');
    r2 := wm.battle_create(a, b, 'Europe/Paris', 'k-bat');
    assert r1 = r2, r2::text;
    assert (select count(*) from public.battles where challenger_id = a) = 1, 'deux batailles';
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Défi échu (C6) : lu cancelled ; accept → 409 ; un nouveau défi de la paire solde l'ancien (stocké cancelled) et passe.
do $$ declare a uuid; b uuid; x uuid; y uuid; d jsonb; begin
  begin
    a := pg_temp.player('BatEchA'); b := pg_temp.player('BatEchB');
    perform pg_temp.friends(a, b);
    x := (wm.battle_create(a, b) ->> 'id')::uuid;
    update public.battles set created_at = created_at - interval '25 hours' where id = x;
    assert (select wm.battle_json(t, a) @> '{"status": "cancelled", "expires_at": null}' from public.battles t where t.id = x), 'échu lu pending';
    d := pg_temp.err(format('select wm.battle_action(%L, %L, %L)', b, x, 'accept'));
    assert d = pg_temp.berr(409, null, 'Ce défi n''est plus en attente'), coalesce(d::text, 'accepté');
    y := (wm.battle_create(a, b) ->> 'id')::uuid;
    assert y <> x and (select status from public.battles where id = x) = 'cancelled' and (select status from public.battles where id = y) = 'pending',
      'ancien défi non soldé';
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Réponses au défi (C10, C11 : le statut, puis le rôle) : accept, decline, withdraw_invite, forfeit hors partie, action inconnue, tiers.
do $$ declare a uuid; b uuid; c uuid; x uuid; d jsonb; upd timestamptz; begin
  begin
    update wm.config set value = value || '{"quota_free": 10}' where key = 'battle';
    a := pg_temp.player('BatRepA'); b := pg_temp.player('BatRepB'); c := pg_temp.player('BatRepCarol');
    perform pg_temp.friends(a, b);
    x := (wm.battle_create(a, b) ->> 'id')::uuid;
    d := pg_temp.err(format('select wm.battle_action(%L, %L, %L)', a, x, 'accept'));
    assert d = pg_temp.berr(403, 'FORBIDDEN', 'Seul le joueur défié peut répondre à ce défi'), coalesce(d::text, 'accepté');
    d := wm.battle_action(b, x, 'accept');
    assert d #>> '{battle,status}' = 'deck_selection' and d #> '{battle,game_state}' = '{"players": {}, "turnHistory": [], "pendingAttack": null}'
      and d - 'battle' = '{"decks": [], "reward": null}', d::text;
    assert (d #>> '{battle,updated_at}')::timestamptz > now()
      and (d #>> '{battle,idle_at}')::timestamptz = (d #>> '{battle,updated_at}')::timestamptz + interval '48 hours'
      and d #> '{battle,expires_at}' = 'null', d::text;
    assert d -> 'battle' = (select wm.battle_json(t, b) from public.battles t where t.id = x), 'réponse et battle_json';
    assert pg_temp.bnotes(x) = jsonb_build_array(
      jsonb_build_object('user_id', a, 'type', 'battle_accepted', 'data', jsonb_build_object('battle_id', x, 'user_id', b, 'username', 'BatRepB')),
      jsonb_build_object('user_id', b, 'type', 'battle_invite', 'data', jsonb_build_object('battle_id', x, 'user_id', a, 'username', 'BatRepA'))),
      pg_temp.bnotes(x)::text;
    d := pg_temp.err(format('select wm.battle_action(%L, %L, %L)', b, x, 'accept'));
    assert d = pg_temp.berr(409, null, 'Ce défi n''est plus en attente'), coalesce(d::text, 'accepté');
    -- C11 : le statut avant le rôle, A n'a pas le rôle mais lit d'abord le 409.
    d := pg_temp.err(format('select wm.battle_action(%L, %L, %L)', a, x, 'accept'));
    assert d = pg_temp.berr(409, null, 'Ce défi n''est plus en attente'), coalesce(d::text, 'accepté');
    -- forfeit en deck_selection → cancelled, sans argent ni notification, updated_at reposé ; puis 409 sur la bataille close.
    upd := (select updated_at from public.battles where id = x);
    d := wm.battle_action(a, x, 'forfeit');
    assert d #>> '{battle,status}' = 'cancelled' and d #> '{battle,idle_at}' = 'null' and (d #>> '{battle,updated_at}')::timestamptz > upd, d::text;
    assert not exists (select from wm.wb_ledger where ref = 'battle:' || x), 'grand livre au forfait';
    assert jsonb_array_length(pg_temp.bnotes(x)) = 2, pg_temp.bnotes(x)::text;
    d := pg_temp.err(format('select wm.battle_action(%L, %L, %L)', a, x, 'forfeit'));
    assert d = pg_temp.berr(409, null, 'Cette bataille est terminée'), coalesce(d::text, 'accepté');
    -- forfeit en pending → 409 ; decline → cancelled, battle_declined pour A.
    x := (wm.battle_create(a, b) ->> 'id')::uuid;
    d := pg_temp.err(format('select wm.battle_action(%L, %L, %L)', a, x, 'forfeit'));
    assert d = pg_temp.berr(409, null, 'Ce défi n''est pas encore accepté'), coalesce(d::text, 'accepté');
    d := wm.battle_action(b, x, 'decline');
    assert d #>> '{battle,status}' = 'cancelled' and d #> '{battle,game_state}' = 'null', d::text;
    assert pg_temp.bnotes(x) = jsonb_build_array(
      jsonb_build_object('user_id', a, 'type', 'battle_declined', 'data', jsonb_build_object('battle_id', x, 'user_id', b, 'username', 'BatRepB')),
      jsonb_build_object('user_id', b, 'type', 'battle_invite', 'data', jsonb_build_object('battle_id', x, 'user_id', a, 'username', 'BatRepA'))),
      pg_temp.bnotes(x)::text;
    -- withdraw_invite, sur une nouvelle bataille pending (PF15) : B → 403 ; A → cancelled, sans notification.
    x := (wm.battle_create(a, b) ->> 'id')::uuid;
    d := pg_temp.err(format('select wm.battle_action(%L, %L, %L)', b, x, 'withdraw_invite'));
    assert d = pg_temp.berr(403, 'FORBIDDEN', 'Seul l''auteur du défi peut le retirer'), coalesce(d::text, 'accepté');
    d := wm.battle_action(a, x, 'withdraw_invite');
    assert d #>> '{battle,status}' = 'cancelled', d::text;
    assert pg_temp.bnotes(x) = jsonb_build_array(jsonb_build_object('user_id', b, 'type', 'battle_invite',
      'data', jsonb_build_object('battle_id', x, 'user_id', a, 'username', 'BatRepA'))), pg_temp.bnotes(x)::text;
    -- Action inconnue ; tiers → 404, sur le détail comme sur l'action.
    d := pg_temp.err(format('select wm.battle_action(%L, %L, %L)', a, x, 'dance'));
    assert d = pg_temp.berr(400, 'invalid_request', 'Action inconnue'), coalesce(d::text, 'accepté');
    d := pg_temp.err(format('select wm.battle_detail(%L, %L)', c, x));
    assert d = pg_temp.berr(404, null, 'Bataille introuvable'), coalesce(d::text, 'accepté');
    d := pg_temp.err(format('select wm.battle_action(%L, %L, %L)', c, x, 'accept'));
    assert d = pg_temp.berr(404, null, 'Bataille introuvable'), coalesce(d::text, 'accepté');
    -- Amitié retirée avant l'acceptation → 403, la bataille reste pending.
    x := (wm.battle_create(a, b) ->> 'id')::uuid;
    delete from public.friendships where a in (requester_id, addressee_id) and b in (requester_id, addressee_id);
    d := pg_temp.err(format('select wm.battle_action(%L, %L, %L)', b, x, 'accept'));
    assert d = pg_temp.berr(403, 'FORBIDDEN', 'Vous devez être amis pour vous défier'), coalesce(d::text, 'accepté');
    assert (select status from public.battles where id = x) = 'pending', 'accept refusé écrit';
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Deck adverse tu (M5a-11, C6) : tant qu'un seul joueur a son entrée dans players et sa ligne battle_decks, l'autre ne voit ni l'une ni
-- l'autre ; aux deux, chacun voit tout.
do $$ declare a uuid; b uuid; x uuid; k uuid := gen_random_uuid(); begin
  begin
    a := pg_temp.player('BatTuA'); b := pg_temp.player('BatTuB');
    insert into public.battles (challenger_id, opponent_id, status, game_state)
    values (a, b, 'deck_selection', jsonb_build_object('players', jsonb_build_object(a, '{"currentHp": 1}'::jsonb), 'turnHistory', '[]'::jsonb, 'pendingAttack', null))
    returning id into x;
    insert into public.battle_decks (battle_id, user_id, card_ids) values (x, a, array[k, k, k]);
    assert wm.battle_detail(a, x) #> '{battle,game_state,players}' = jsonb_build_object(a, '{"currentHp": 1}'::jsonb)
      and wm.battle_detail(a, x) -> 'decks' = jsonb_build_array(jsonb_build_object('user_id', a, 'card_ids', array[k, k, k])), 'A seul';
    assert wm.battle_detail(b, x) #> '{battle,game_state,players}' = '{}' and wm.battle_detail(b, x) -> 'decks' = '[]', wm.battle_detail(b, x)::text;
    update public.battles set game_state = jsonb_set(game_state, array['players', b::text], '{"currentHp": 2}'::jsonb) where id = x;
    insert into public.battle_decks (battle_id, user_id, card_ids) values (x, b, array[k, k, k]);
    assert wm.battle_detail(b, x) #> '{battle,game_state,players}' = jsonb_build_object(a, '{"currentHp": 1}'::jsonb, b, '{"currentHp": 2}'::jsonb)
      and jsonb_array_length(wm.battle_detail(b, x) -> 'decks') = 2
      and wm.battle_detail(b, x) - 'battle' = wm.battle_detail(a, x) - 'battle', wm.battle_detail(b, x)::text;
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Liste (C6) : clés exactes ; ouvertes avec game_state, closes sans ; 2 ouvertes et les 50 closes les plus récentes sur 51, created_at desc.
do $$ declare a uuid; b uuid; c uuid; oldest uuid; l jsonb; bad jsonb; begin
  begin
    a := pg_temp.player('BatLstA'); b := pg_temp.player('BatLstB'); c := pg_temp.player('BatLstC');
    insert into public.battles (challenger_id, opponent_id, status, created_at)
    select a, b, 'cancelled', now() - i * interval '1 minute' from generate_series(1, 51) i;
    select id into oldest from public.battles where challenger_id = a and created_at = now() - interval '51 minutes';
    insert into public.battles (challenger_id, opponent_id) values (a, b);
    insert into public.battles (challenger_id, opponent_id, status, game_state)
    values (c, a, 'deck_selection', '{"players": {}, "turnHistory": [], "pendingAttack": null}');
    l := wm.battles_list(a, 'Europe/Paris');
    assert (select array_agg(k order by k) from jsonb_object_keys(l) k) = array['battles', 'challenge_quota', 'rules'], l::text;
    assert jsonb_array_length(l -> 'battles') = 52, 'entrées : ' || jsonb_array_length(l -> 'battles');
    select jsonb_agg(j) into bad from jsonb_array_elements(l -> 'battles') j
    where not j ?& array['id', 'challenger_id', 'opponent_id', 'winner_id', 'status', 'created_at', 'updated_at', 'challenger', 'opponent',
        'expires_at', 'idle_at']
      or j ? 'game_state' <> (j ->> 'status' not in ('completed', 'cancelled'));
    assert bad is null, bad::text;
    assert (select count(*) from jsonb_array_elements(l -> 'battles') j where j ->> 'status' = 'cancelled') = 50, 'closes';
    assert not (l -> 'battles') @> jsonb_build_array(jsonb_build_object('id', oldest)), 'la 51ᵉ close listée';
    assert (select bool_and(x.c >= x.n) from (select (j ->> 'created_at')::timestamptz c, lead((j ->> 'created_at')::timestamptz) over (order by o) n
      from jsonb_array_elements(l -> 'battles') with ordinality e (j, o)) x where x.n is not null), 'ordre';
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Lectures stable ; lock_timeout avant le premier verrou (P5) ; défi échu soldé avant les profils (C4, C6) ; la bataille for update d'abord.
do $$ declare bad text; begin
  assert (select jsonb_object_agg(proname, provolatile::text) from pg_proc where pronamespace = 'wm'::regnamespace
    and proname in ('battle_json', 'battles_list', 'battle_detail')) = '{"battle_json": "s", "battles_list": "s", "battle_detail": "s"}', 'volatilité';
  bad := tests.lock_timeout_violations(array['battle_create', 'battle_action'],
    array['update public.battles', 'for update', 'for key share', 'wm.lock_users(', 'wm.lock_user(']);
  assert bad is null, 'lock_timeout : ' || bad;
  assert (select strpos(prosrc, 'update public.battles') between 1 and strpos(prosrc, 'wm.lock_users(') from pg_proc
    where oid = to_regproc('wm.battle_create')), 'battle_create : profils avant le défi échu';
  assert (select strpos(prosrc, 'from public.battles') between 1 and strpos(prosrc, 'for update')
      and (strpos(prosrc, 'wm.lock_users(') = 0 or strpos(prosrc, 'for update') < strpos(prosrc, 'wm.lock_users('))
    from pg_proc where oid = to_regproc('wm.battle_action')), 'battle_action : profils avant la bataille';
end $$;
