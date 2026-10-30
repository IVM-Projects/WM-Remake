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
    "reward_win":50,"reward_loss":10,"guild_points_win":500}'::jsonb, pg_temp.battle_config()::text;
  assert pg_temp.battle_config() #> '{list_caps,battles_closed}' = '50', 'list_caps.battles_closed';
  assert (select coalesce(note, '') <> '' from wm.config where key = 'battle'), 'note manquante';
end $$;

-- Rejeu de 1900, suivi de 2000 qui redéfinit check_invariants (M5b-18) : mêmes valeurs, et une valeur déjà posée garde la sienne.
create temp table battle_config as select pg_temp.battle_config() v;
update wm.config set value = value || '{"quota_free": 5}' where key = 'battle';
update wm.config set value = value || '{"battles_closed": 7}' where key = 'list_caps';
\ir ../migrations/1900_wm_battle_core.sql
\ir ../migrations/2000_wm_progress_core.sql
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
      "reward_loss":10,"guild_points_win":500}', d::text;
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
    -- Défi reçu par A aujourd'hui : seuls les défis créés comptent.
    insert into public.battles (challenger_id, opponent_id, status) values (e, a, 'cancelled');
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
-- retry_after = le plus ancien + 24 h. Sans la garde des 24 h, l'appel passe. Un défi reçu par A aujourd'hui, donc dans la fenêtre, ne
-- compte ni pour le jour ni pour les 24 h.
do $$ declare a uuid; f uuid; o uuid; tz text; d0 timestamptz; d jsonb; begin
  begin
    a := pg_temp.player('BatJumpA'); f := pg_temp.player('BatJumpF'); o := pg_temp.player('BatJumpO');
    perform pg_temp.friends(a, f);
    select t into tz from unnest(array['Etc/GMT+12', 'Etc/GMT-14']) t
    where now() - (now() at time zone t)::date::timestamp at time zone t < interval '22 hours' limit 1;
    d0 := (now() at time zone tz)::date::timestamp at time zone tz;
    insert into public.battles (challenger_id, opponent_id, status, created_at)
    select a, o, 'cancelled', d0 - i * interval '1 second' from generate_series(1, 6) i;
    insert into public.battles (challenger_id, opponent_id, status) values (o, a, 'cancelled');
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
-- deux bornes atteintes, retry_after = le plus tardif, d0 + 1 s + 24 h. La borne du jour seule rendrait resets_at. Puis 8 défis : le
-- (n − 2 × limit + 1)ᵉ plus ancien, d0 + 3 s + 24 h.
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
    -- Au-delà de 2 × limit (limite baissée, Pro perdu) : 8 défis, n repasse sous 6 quand le 3ᵉ plus ancien sort → d0 + 3 s + 24 h.
    insert into public.battles (challenger_id, opponent_id, status, created_at)
    select a, o, 'cancelled', d0 + i * interval '1 second' from generate_series(7, 8) i;
    d := pg_temp.err(format('select wm.battle_create(%L, %L, %L)', a, f, 'Etc/GMT-14'));
    assert d = pg_temp.berr(429, null, 'Limite quotidienne de défis atteinte', jsonb_build_object(
      'retry_after', d0 + interval '3 seconds' + interval '24 hours',
      'challenge_quota', jsonb_build_object('used', 8, 'limit', 3, 'resets_at', d0 + interval '24 hours'))), coalesce(d::text, 'accepté');
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

-- Défi échu (C6) : lu cancelled ; accept → 409 ; un nouveau défi de la paire solde l'ancien (stocké cancelled) et passe, dans les deux sens :
-- A → B échu, puis B → A ; B → A échu, puis B → A de nouveau.
do $$ declare a uuid; b uuid; x uuid; y uuid; z uuid; d jsonb; begin
  begin
    a := pg_temp.player('BatEchA'); b := pg_temp.player('BatEchB');
    perform pg_temp.friends(a, b);
    x := (wm.battle_create(a, b) ->> 'id')::uuid;
    update public.battles set created_at = created_at - interval '25 hours' where id = x;
    assert (select wm.battle_json(t, a) @> '{"status": "cancelled", "expires_at": null}' from public.battles t where t.id = x), 'échu lu pending';
    d := pg_temp.err(format('select wm.battle_action(%L, %L, %L)', b, x, 'accept'));
    assert d = pg_temp.berr(409, null, 'Ce défi n''est plus en attente'), coalesce(d::text, 'accepté');
    y := (wm.battle_create(b, a) ->> 'id')::uuid;
    assert (select status from public.battles where id = x) = 'cancelled' and (select status from public.battles where id = y) = 'pending',
      'A → B échu non soldé par B → A';
    update public.battles set created_at = created_at - interval '25 hours' where id = y;
    z := (wm.battle_create(b, a) ->> 'id')::uuid;
    assert (select status from public.battles where id = y) = 'cancelled' and (select status from public.battles where id = z) = 'pending',
      'B → A échu non soldé par B → A';
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
    -- forfeit en deck_selection confirmé comme une défaite (expect lose, phase changée sous la modale) → 409, rien d'écrit.
    upd := (select updated_at from public.battles where id = x);
    d := pg_temp.err(format('select wm.battle_action(%L, %L, %L, %L)', a, x, 'forfeit', '{"expect": "lose"}'));
    assert d = pg_temp.berr(409, null, 'La bataille a changé : relis-la avant d''abandonner.'), coalesce(d::text, 'accepté');
    assert (select status = 'deck_selection' and updated_at = upd from public.battles where id = x), 'forfeit refusé, bataille écrite';
    -- forfeit en deck_selection (expect cancel, la phase lue) → cancelled, sans argent ni notification, updated_at reposé ; puis 409 sur
    -- la bataille close.
    d := wm.battle_action(a, x, 'forfeit', '{"expect": "cancel"}');
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

-- Liste (C6) : clés exactes ; ouvertes avec game_state, closes sans ; 3 ouvertes et les 50 closes les plus récentes sur 51, mêlées en
-- created_at desc (la deck_selection, à now() − 90 s, entre les closes de −1 et −2 min), puis id desc à created_at égal (les deux pending,
-- insérées dans l'ordre croissant des id).
do $$ declare a uuid; b uuid; c uuid; dd uuid; oldest uuid; p1 uuid := gen_random_uuid(); p2 uuid := gen_random_uuid(); s uuid; m1 uuid;
  l jsonb; bad jsonb; begin
  begin
    a := pg_temp.player('BatLstA'); b := pg_temp.player('BatLstB'); c := pg_temp.player('BatLstC'); dd := pg_temp.player('BatLstD');
    insert into public.battles (challenger_id, opponent_id, status, created_at)
    select a, b, 'cancelled', now() - i * interval '1 minute' from generate_series(1, 51) i;
    select id into oldest from public.battles where challenger_id = a and created_at = now() - interval '51 minutes';
    select id into m1 from public.battles where challenger_id = a and created_at = now() - interval '1 minute';
    insert into public.battles (id, challenger_id, opponent_id) values (least(p1, p2), a, b);
    insert into public.battles (id, challenger_id, opponent_id) values (greatest(p1, p2), dd, a);
    insert into public.battles (challenger_id, opponent_id, status, game_state, created_at)
    values (c, a, 'deck_selection', '{"players": {}, "turnHistory": [], "pendingAttack": null}', now() - interval '90 seconds')
    returning id into s;
    l := wm.battles_list(a, 'Europe/Paris');
    assert (select array_agg(k order by k) from jsonb_object_keys(l) k) = array['battles', 'challenge_quota', 'rules'], l::text;
    assert jsonb_array_length(l -> 'battles') = 53, 'entrées : ' || jsonb_array_length(l -> 'battles');
    select jsonb_agg(j) into bad from jsonb_array_elements(l -> 'battles') j
    where not j ?& array['id', 'challenger_id', 'opponent_id', 'winner_id', 'status', 'created_at', 'updated_at', 'challenger', 'opponent',
        'expires_at', 'idle_at']
      or j ? 'game_state' <> (j ->> 'status' not in ('completed', 'cancelled'));
    assert bad is null, bad::text;
    assert (select count(*) from jsonb_array_elements(l -> 'battles') j where j ->> 'status' = 'cancelled') = 50, 'closes';
    assert not (l -> 'battles') @> jsonb_build_array(jsonb_build_object('id', oldest)), 'la 51ᵉ close listée';
    assert (select array_agg((j ->> 'id')::uuid order by o) from jsonb_array_elements(l -> 'battles') with ordinality e (j, o) where o <= 4)
      = array[greatest(p1, p2), least(p1, p2), m1, s], 'tête de liste';
    assert (select bool_and(x.c > x.n or x.c = x.n and x.i > x.ni) from (select (j ->> 'created_at')::timestamptz c, (j ->> 'id')::uuid i,
        lead((j ->> 'created_at')::timestamptz) over (order by o) n, lead((j ->> 'id')::uuid) over (order by o) ni
      from jsonb_array_elements(l -> 'battles') with ordinality e (j, o)) x where x.n is not null), 'ordre';
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Lectures (et statut lu) stable ; lock_timeout avant le premier verrou (P5) ; défi échu soldé avant les profils (C4, C6) ; la bataille for update d'abord.
do $$ declare bad text; begin
  assert (select jsonb_object_agg(proname, provolatile::text) from pg_proc where pronamespace = 'wm'::regnamespace
    and proname in ('battle_json', 'battles_list', 'battle_detail', 'battle_read_status'))
    = '{"battle_json": "s", "battles_list": "s", "battle_detail": "s", "battle_read_status": "s"}', 'volatilité';
  bad := tests.lock_timeout_violations(array['battle_create', 'battle_action', 'expire_battles'],
    array['update public.battles', 'for update', 'for key share', 'wm.lock_users(', 'wm.lock_user(']);
  assert bad is null, 'lock_timeout : ' || bad;
  assert (select strpos(prosrc, 'update public.battles') between 1 and strpos(prosrc, 'wm.lock_users(') from pg_proc
    where oid = to_regproc('wm.battle_create')), 'battle_create : profils avant le défi échu';
  assert (select strpos(prosrc, 'from public.battles') between 1 and strpos(prosrc, 'for update')
      and (strpos(prosrc, 'wm.lock_users(') = 0 or strpos(prosrc, 'for update') < strpos(prosrc, 'wm.lock_users('))
    from pg_proc where oid = to_regproc('wm.battle_action')), 'battle_action : profils avant la bataille';
  -- expire_battles : un seul lock_users de tous les joueurs du lot, avant la boucle des fins (wallet_apply prendrait sinon chaque paire à part,
  -- hors de l'ordre des id du lot).
  assert (select strpos(prosrc, 'wm.lock_users(') between 1 and least(strpos(prosrc, 'foreach'), strpos(prosrc, 'wm.battle_finish('))
    from pg_proc where oid = to_regproc('wm.expire_battles')), 'expire_battles : lock_users avant les fins';
end $$;

-- Partie (1930_wm_battle_play.sql) : vainqueur, deck figé, attaque, réponses une à une, fins et récompenses. Même règle que plus haut :
-- chaque bloc fait tout dans une sous-transaction annulée (WMT00), cartes et pool compris ; une bataille n'y est close que par battle_finish,
-- qui pose les deux lignes battle:<id>.

-- Cartes R d'essai (pg_temp.bcard : questions de vues seules), une par paire (ATK, DEF), titrées « p_prefix i ».
create function pg_temp.bcards(p_prefix text, p_atk int[], p_def int[]) returns uuid[] language plpgsql as $$
declare r uuid[] := '{}'; begin
  for i in 1 .. cardinality(p_atk) loop
    r := r || pg_temp.bcard(p_prefix || ' ' || i, 'R', p_atk[i], p_def[i]);
  end loop;
  return r;
end $$;

-- Deux cartes R de plus au pool : T5 tire ses pairs par 30 seq au hasard ; avec les 6 cartes des decks seules, deux pairs manqués (une
-- banque sur 20 000 environ) laisseraient template_quiz sous 3 questions.
create function pg_temp.fill() returns void language plpgsql as $$ begin
  perform pg_temp.bcards('Bataille pool', array[1, 1], array[1, 1]);
end $$;

-- Une copie de chaque carte pour p_uid ; rend les ids de copie, dans l'ordre.
create function pg_temp.own(p_uid uuid, p_cards uuid[]) returns uuid[] language plpgsql as $$
declare r uuid[] := '{}'; c uuid; begin
  foreach c in array p_cards loop
    r := r || pg_temp.copy(p_uid, c);
  end loop;
  return r;
end $$;

-- Bataille active par les fonctions publiques : défi de A (amis au besoin), acceptation de B, deck de A, puis deck de B.
create function pg_temp.active(p_a uuid, p_b uuid, p_a_cards uuid[], p_b_cards uuid[]) returns uuid language plpgsql as $$
declare x uuid; begin
  if not wm.are_friends(p_a, p_b) then
    perform pg_temp.friends(p_a, p_b);
  end if;
  x := (wm.battle_create(p_a, p_b) ->> 'id')::uuid;
  perform wm.battle_action(p_b, x, 'accept');
  perform wm.battle_action(p_a, x, 'submit_deck', jsonb_build_object('card_ids', p_a_cards));
  perform wm.battle_action(p_b, x, 'submit_deck', jsonb_build_object('card_ids', p_b_cards));
  return x;
end $$;

-- Bonne option d'une question (C3) ; id de la question i de l'attaque en cours ; une mauvaise option (la plus petite des trois autres).
create function pg_temp.secret(p_battle uuid, p_question uuid) returns text language sql as $$
  select correct_option_id from wm.battle_secrets where battle_id = p_battle and question_id = p_question
$$;

create function pg_temp.q(p_battle uuid, p_i int) returns uuid language sql as $$
  select (game_state #>> array['pendingAttack', 'questions', (p_i - 1)::text, 'id'])::uuid from public.battles where id = p_battle
$$;

create function pg_temp.wrong(p_battle uuid, p_question uuid) returns text language sql as $$
  select min(o ->> 'id') from public.battles t, jsonb_array_elements(t.game_state #> '{pendingAttack,questions}') q,
    jsonb_array_elements(q -> 'options') o
  where t.id = p_battle and q ->> 'id' = p_question::text and o ->> 'id' <> pg_temp.secret(p_battle, p_question)
$$;

-- Ids des questions et des options de l'attaque en cours.
create function pg_temp.ids(p_battle uuid) returns text[] language sql as $$
  select array_agg(u.v) from public.battles t, jsonb_array_elements(t.game_state #> '{pendingAttack,questions}') q,
    lateral (select q ->> 'id' union all select o ->> 'id' from jsonb_array_elements(q -> 'options') o) u (v)
  where t.id = p_battle
$$;

-- Occurrences de v dans t (C23).
create function pg_temp.n(t text, v text) returns int language sql as $$
  select (length(t) - length(replace(t, v, ''))) / length(v)
$$;

create function pg_temp.att(p_uid uuid, p_battle uuid, p_card uuid, p_idem text default null) returns jsonb language sql as $$
  select wm.battle_action(p_uid, p_battle, 'submit_attack', jsonb_build_object('attack_card_id', p_card), p_idem)
$$;

create function pg_temp.ans(p_uid uuid, p_battle uuid, p_question uuid, p_option text) returns jsonb language sql as $$
  select wm.battle_action(p_uid, p_battle, 'submit_single_answer', jsonb_build_object('questionId', p_question, 'answerId', p_option))
$$;

-- Réponses de p_def aux 3 questions de l'attaque en cours, les p_wrong dernières fausses ; rend la dernière réponse.
create function pg_temp.answers(p_battle uuid, p_def uuid, p_wrong int) returns jsonb language plpgsql as $$
declare r jsonb; q uuid; begin
  for i in 1 .. 3 loop
    q := pg_temp.q(p_battle, i);
    r := pg_temp.ans(p_def, p_battle, q, case when i > 3 - p_wrong then pg_temp.wrong(p_battle, q) else pg_temp.secret(p_battle, q) end);
  end loop;
  return r;
end $$;

-- Un tour : p_att attaque avec p_card, puis p_def répond.
create function pg_temp.turn(p_battle uuid, p_att uuid, p_def uuid, p_card uuid, p_wrong int) returns jsonb language plpgsql as $$ begin
  perform pg_temp.att(p_att, p_battle, p_card);
  return pg_temp.answers(p_battle, p_def, p_wrong);
end $$;

-- Lignes battle:<id> du grand livre, {user_id: delta}.
create function pg_temp.rewards(p_battle uuid) returns jsonb language sql as $$
  select jsonb_object_agg(user_id, delta) from wm.wb_ledger where reason = 'battle' and ref = 'battle:' || p_battle
$$;

-- battle_winner (C8), sur des états synthétiques, ratios écrits challenger d'abord : KO ; ratio en produit en croix ; ratios égaux, puis
-- PV bruts ; égalité totale, puis défenseur du dernier tour. Le dernier défenseur posé contre l'issue attendue tant qu'il ne décide pas.
create function pg_temp.wstate(p_a uuid, p_ahp int, p_amax int, p_o uuid, p_ohp int, p_omax int, p_last uuid) returns jsonb language sql as $$
  select jsonb_build_object('players', jsonb_build_object(p_a, jsonb_build_object('currentHp', p_ahp, 'maxHp', p_amax),
      p_o, jsonb_build_object('currentHp', p_ohp, 'maxHp', p_omax)),
    'turnHistory', jsonb_build_array(jsonb_build_object('defenderId', p_o), jsonb_build_object('defenderId', p_last)))
$$;

do $$ declare a uuid := gen_random_uuid(); o uuid := gen_random_uuid(); begin
  assert wm.battle_winner(pg_temp.wstate(a, 3000, 9000, o, 0, 6000, o), a, o) = a, 'KO';
  assert wm.battle_winner(pg_temp.wstate(a, 3000, 9000, o, 3000, 6000, a), a, o) = o, 'ratio';
  assert wm.battle_winner(pg_temp.wstate(a, 4000, 6000, o, 6000, 9000, a), a, o) = o, 'PV bruts';
  assert wm.battle_winner(pg_temp.wstate(a, 3000, 6000, o, 3000, 6000, a), a, o) = a, 'dernier défenseur, challenger';
  assert wm.battle_winner(pg_temp.wstate(a, 3000, 6000, o, 3000, 6000, o), a, o) = o, 'dernier défenseur, adversaire';
end $$;

-- submit_deck (C4, C10, C11, C18, M5a-11) : ids de copie chez A (titre et ATK figés de sa première copie retouchés), ids catalogue chez B
-- (deux copies par carte : la plus forte en DEF a le plus petit id pour d1, le plus grand pour d2 ; DEF égales pour d3, le plus petit id
-- gagne) ; refus exacts, défi échu compris ; deck de A tu, file comprise ; second deck → active.
do $$ declare a uuid; b uuid; carol uuid; c uuid[]; d uuid[]; ka uuid[]; kb uuid[]; lo uuid[]; hi uuid[]; k1 uuid; x uuid; x0 uuid; x1 uuid;
  r jsonb; e jsonb; gs jsonb; pa jsonb; q0 bigint; bad jsonb; q text := 'select wm.battle_action(%L, %L, %L, %L)'; begin
  begin
    a := pg_temp.player('BatDeckA'); b := pg_temp.player('BatDeckB'); carol := pg_temp.player('BatDeckCarol');
    c := pg_temp.bcards('BatDeck A', array[1000, 1100, 1200], array[500, 600, 700]);
    d := pg_temp.bcards('BatDeck B', array[900, 800, 700], array[400, 300, 200]);
    perform pg_temp.fill();
    ka := pg_temp.own(a, c);
    update public.user_cards set snapshot_title = 'Titre figé', snapshot_atk = 1001 where id = ka[1];
    -- Seconde copie de c1, plus forte : l'id de copie envoyé passe avant la plus forte DEF.
    k1 := pg_temp.copy(a, c[1]);
    update public.user_cards set snapshot_def = 900 where id = k1;
    perform pg_temp.own(b, d);
    perform pg_temp.own(b, d);
    lo := array(select (select uc.id from public.user_cards uc where uc.user_id = b and uc.card_id = d[i] order by uc.id limit 1)
      from generate_series(1, 3) i);
    hi := array(select (select uc.id from public.user_cards uc where uc.user_id = b and uc.card_id = d[i] order by uc.id desc limit 1)
      from generate_series(1, 3) i);
    update public.user_cards set snapshot_def = snapshot_def + 100 where id in (lo[1], hi[2]);
    kb := array[lo[1], hi[2], lo[3]];
    perform pg_temp.friends(a, b);
    x0 := (wm.battle_create(a, b) ->> 'id')::uuid;
    perform wm.battle_action(a, x0, 'withdraw_invite');
    e := pg_temp.err(format(q, a, x0, 'submit_deck', jsonb_build_object('card_ids', ka)));
    assert e = pg_temp.berr(409, null, 'Cette bataille est terminée'), coalesce(e::text, 'accepté');
    -- Défi échu, que le cron n'a pas passé : lu cancelled (C6).
    x1 := (wm.battle_create(a, b) ->> 'id')::uuid;
    update public.battles set created_at = created_at - interval '25 hours' where id = x1;
    e := pg_temp.err(format(q, a, x1, 'submit_deck', jsonb_build_object('card_ids', ka)));
    assert e = pg_temp.berr(409, null, 'Cette bataille est terminée'), coalesce(e::text, 'accepté');
    x := (wm.battle_create(a, b) ->> 'id')::uuid;
    e := pg_temp.err(format(q, a, x, 'submit_deck', jsonb_build_object('card_ids', ka)));
    assert e = pg_temp.berr(409, null, 'Ce défi n''est pas encore accepté'), coalesce(e::text, 'accepté');
    perform wm.battle_action(b, x, 'accept');
    e := pg_temp.err(format(q, a, x, 'submit_deck', jsonb_build_object('card_ids', ka[1:2])));
    assert e = pg_temp.berr(400, 'invalid_request', 'Choisis 3 cartes'), coalesce(e::text, 'accepté');
    e := pg_temp.err(format(q, a, x, 'submit_deck', jsonb_build_object('card_ids', array[ka[1], ka[2], pg_temp.copy(carol, c[3])])));
    assert e = pg_temp.berr(403, '42501', 'Vous ne possédez pas cette carte'), coalesce(e::text, 'accepté');
    e := pg_temp.err(format(q, a, x, 'submit_deck', jsonb_build_object('card_ids', array[ka[1], k1, ka[2]])));
    assert e = pg_temp.berr(400, 'invalid_request', 'Choisis 3 cartes différentes'), coalesce(e::text, 'accepté');
    -- Deck de A : 3 ids de copie.
    q0 := (select count(*) from wm.quiz_queue where attempts < 3);
    r := wm.battle_action(a, x, 'submit_deck', jsonb_build_object('card_ids', ka));
    gs := r #> '{battle,game_state}';
    assert r #>> '{battle,status}' = 'deck_selection' and r -> 'decks' = jsonb_build_array(jsonb_build_object('user_id', a, 'card_ids', c)),
      r::text;
    assert (gs -> 'players') - a::text = '{}' and (gs #> array['players', a::text]) - 'cards' = jsonb_build_object('cardIds', c,
      'usedCardIds', '[]'::jsonb, 'currentHp', 1800, 'maxHp', 1800), gs::text;
    assert gs #> array['players', a::text, 'cards', '0'] = jsonb_build_object('id', c[1], 'user_card_id', ka[1], 'wikipedia_title', 'Titre figé',
      'wikipedia_url', 'https://fr.wikipedia.org/wiki/BatDeck_A_1', 'rarity', 'R', 'atk', 1001, 'def', 500, 'image_url', null,
      'hide_image', false, 'nsfw_image', false), gs::text;
    assert (select jsonb_agg(jsonb_build_array(f -> 'id', f -> 'user_card_id', f -> 'def') order by o)
        from jsonb_array_elements(gs #> array['players', a::text, 'cards']) with ordinality t (f, o))
      = jsonb_build_array(jsonb_build_array(c[1], ka[1], 500), jsonb_build_array(c[2], ka[2], 600), jsonb_build_array(c[3], ka[3], 700)),
      gs::text;
    select jsonb_agg(f) into bad from jsonb_array_elements(gs #> array['players', a::text, 'cards']) f
    where (select array_agg(k order by k) from jsonb_object_keys(f) k) <> array['atk', 'def', 'hide_image', 'id', 'image_url', 'nsfw_image',
      'rarity', 'user_card_id', 'wikipedia_title', 'wikipedia_url'];
    assert bad is null, 'clés des faces : ' || bad::text;
    -- Deck tu (M5a-11) : ni pour B, ni par la file.
    assert wm.battle_detail(b, x) #> '{battle,game_state,players}' = '{}' and wm.battle_detail(b, x) -> 'decks' = '[]',
      wm.battle_detail(b, x)::text;
    assert not exists (select from wm.card_quizzes where card_id = any (c)) and not exists (select from wm.quiz_queue where card_id = any (c))
      and (select count(*) from wm.quiz_queue where attempts < 3) = q0, 'deck de A dans la file';
    e := pg_temp.err(format(q, a, x, 'submit_deck', jsonb_build_object('card_ids', ka)));
    assert e = pg_temp.berr(409, null, 'Ton deck est déjà validé'), coalesce(e::text, 'accepté');
    -- Deck de B : ids catalogue, résolus vers les copies à la plus forte DEF.
    pa := gs #> array['players', a::text];
    r := wm.battle_action(b, x, 'submit_deck', jsonb_build_object('card_ids', d));
    gs := r #> '{battle,game_state}';
    assert r #>> '{battle,status}' = 'active' and gs - 'players' = jsonb_build_object('phase', 'attack', 'currentTurnUserId', a,
      'turnNumber', 1, 'pendingAttack', null, 'turnHistory', '[]'::jsonb), gs::text;
    assert (select array_agg(k order by k) from jsonb_object_keys(gs -> 'players') k) = (select array_agg(u::text order by u::text)
      from unnest(array[a, b]) u) and gs #> array['players', a::text] = pa, gs::text;
    assert (gs #> array['players', b::text]) - 'cards' = jsonb_build_object('cardIds', d, 'usedCardIds', '[]'::jsonb, 'currentHp', 1100,
      'maxHp', 1100), gs::text;
    assert (select jsonb_agg(jsonb_build_array(f -> 'id', f -> 'user_card_id', f -> 'def') order by o)
        from jsonb_array_elements(gs #> array['players', b::text, 'cards']) with ordinality t (f, o))
      = jsonb_build_array(jsonb_build_array(d[1], kb[1], 500), jsonb_build_array(d[2], kb[2], 400), jsonb_build_array(d[3], kb[3], 200)),
      gs::text;
    assert wm.battle_detail(a, x) = wm.battle_detail(b, x) and jsonb_array_length(wm.battle_detail(a, x) -> 'decks') = 2
      and wm.battle_detail(a, x) #> '{battle,game_state}' = gs, wm.battle_detail(a, x)::text;
    -- Un seul quiz_ensure, au second deck : 6 banques template, 6 lignes de file à 100.
    assert (select count(*) from wm.card_quizzes where card_id = any (c || d) and source = 'template') = 6
      and (select count(*) from wm.quiz_queue where card_id = any (c || d) and priority = 100) = 6, 'banques ou file';
    assert (select jsonb_agg(n) from jsonb_array_elements(pg_temp.bnotes(x)) n where n ->> 'type' = 'battle_started')
      = jsonb_build_array(jsonb_build_object('user_id', a, 'type', 'battle_started',
        'data', jsonb_build_object('battle_id', x, 'user_id', b, 'username', 'BatDeckB'))), pg_temp.bnotes(x)::text;
    -- C11 : le statut avant le deck déjà posé.
    e := pg_temp.err(format(q, a, x, 'submit_deck', jsonb_build_object('card_ids', ka)));
    assert e = pg_temp.berr(409, null, 'Le choix des cartes est terminé'), coalesce(e::text, 'accepté');
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Review Focus, deck qui bouge (M5a-11) : une copie du deck de A défaussée, une autre mise en vente → faces, PV et PV max inchangés, et la
-- copie défaussée attaque encore par son id.
do $$ declare a uuid; b uuid; c uuid[]; ka uuid[]; x uuid; p jsonb; begin
  begin
    a := pg_temp.player('BatMovA'); b := pg_temp.player('BatMovB');
    c := pg_temp.bcards('BatMov', array[1000, 1100, 1200, 900, 800, 700], array[500, 600, 700, 400, 300, 200]);
    perform pg_temp.fill();
    ka := pg_temp.own(a, c[1:3]);
    x := pg_temp.active(a, b, ka, pg_temp.own(b, c[4:6]));
    p := wm.battle_detail(a, x) #> array['battle', 'game_state', 'players', a::text];
    perform wm.discard(a, ka[1]);
    perform wm.create_auction(a, ka[2], 10, 60);
    assert not exists (select from public.user_cards where id in (ka[1], ka[2])), 'copies restées';
    assert wm.battle_detail(a, x) #> array['battle', 'game_state', 'players', a::text] = p
      and wm.battle_detail(b, x) #> array['battle', 'game_state', 'players', a::text] = p, 'deck de A changé';
    assert pg_temp.att(a, x, ka[1]) #>> '{battle,game_state,pendingAttack,attackCardId}' = c[1]::text, 'copie défaussée';
    perform pg_temp.inv('deck qui bouge');
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- submit_attack (C7, C10, C11, C23) : refus, attaque, titre figé au deck (M5a-11), puis Review Focus, fuite : chacun des 12 ids d'option,
-- bonne option comprise, une seule fois dans chaque lecture, réponse et état stocké ; aucun dans les notifications ; aucune clé interdite à
-- aucune profondeur.
do $$ declare a uuid; b uuid; c uuid[]; d uuid[]; x uuid; x0 uuid; r jsonb; e jsonb; pa jsonb; t jsonb; opts text[]; o text; k text;
  i int := 0; q text := 'select wm.battle_action(%L, %L, %L, %L)'; begin
  begin
    a := pg_temp.player('BatAttA'); b := pg_temp.player('BatAttB');
    c := pg_temp.bcards('BatAtt A', array[1000, 1100, 1200], array[500, 600, 700]);
    d := pg_temp.bcards('BatAtt B', array[900, 800, 700], array[400, 300, 200]);
    perform pg_temp.fill();
    perform pg_temp.friends(a, b);
    x0 := (wm.battle_create(a, b) ->> 'id')::uuid;
    perform wm.battle_action(a, x0, 'withdraw_invite');
    e := pg_temp.err(format(q, a, x0, 'submit_attack', jsonb_build_object('attack_card_id', c[1])));
    assert e = pg_temp.berr(409, null, 'Cette bataille est terminée'), coalesce(e::text, 'accepté');
    x := (wm.battle_create(a, b) ->> 'id')::uuid;
    e := pg_temp.err(format(q, a, x, 'submit_attack', jsonb_build_object('attack_card_id', c[1])));
    assert e = pg_temp.berr(409, null, 'Ce défi n''est pas encore accepté'), coalesce(e::text, 'accepté');
    perform wm.battle_action(b, x, 'accept');
    perform wm.battle_action(a, x, 'submit_deck', jsonb_build_object('card_ids', pg_temp.own(a, c)));
    e := pg_temp.err(format(q, a, x, 'submit_attack', jsonb_build_object('attack_card_id', c[1])));
    assert e = pg_temp.berr(409, null, 'La bataille n''a pas commencé'), coalesce(e::text, 'accepté');
    perform wm.battle_action(b, x, 'submit_deck', jsonb_build_object('card_ids', pg_temp.own(b, d)));
    e := pg_temp.err(format(q, b, x, 'submit_attack', jsonb_build_object('attack_card_id', d[1])));
    assert e = pg_temp.berr(409, null, 'Ce n''est pas à toi d''attaquer'), coalesce(e::text, 'accepté');
    e := pg_temp.err(format(q, a, x, 'submit_attack', jsonb_build_object('attack_card_id', d[1])));
    assert e = pg_temp.berr(400, 'invalid_request', 'Cette carte n''est pas dans ton deck'), coalesce(e::text, 'accepté');
    -- La carte renommée au catalogue après le deck : l'attaque et la face gardent le titre figé.
    update public.cards set wikipedia_title = 'BatAtt renommée' where id = c[1];
    r := pg_temp.att(a, x, c[1], 'k-att');
    pa := r #> '{battle,game_state,pendingAttack}';
    assert r #>> '{battle,game_state,phase}' = 'quiz' and r #> array['battle', 'game_state', 'players', a::text, 'usedCardIds'] = to_jsonb(c[1:1])
      and pa - 'questions' = jsonb_build_object('attackerUserId', a, 'defenderId', b, 'attackCardId', c[1], 'attackCardName', 'BatAtt A 1',
        'answered', '[]'::jsonb)
      and r #>> array['battle', 'game_state', 'players', a::text, 'cards', '0', 'wikipedia_title'] = 'BatAtt A 1', r::text;
    assert jsonb_array_length(pa -> 'questions') = 3 and not exists (select from jsonb_array_elements(pa -> 'questions') qq
      where (select array_agg(kk order by kk) from jsonb_object_keys(qq) kk) <> array['id', 'options', 'prompt']
        or jsonb_array_length(qq -> 'options') <> 4
        or exists (select from jsonb_array_elements(qq -> 'options') oo
          where (select array_agg(kk order by kk) from jsonb_object_keys(oo) kk) <> array['id', 'text'])), pa::text;
    -- C7 : options triées par id.
    assert not exists (select from jsonb_array_elements(pa -> 'questions') qq
      where array(select oo ->> 'id' from jsonb_array_elements(qq -> 'options') with ordinality u (oo, n) order by n)
        <> array(select oo ->> 'id' from jsonb_array_elements(qq -> 'options') oo order by 1)), 'options non triées';
    assert (select count(*) from wm.battle_secrets s where s.battle_id = x) = 3 and (select count(*) from wm.battle_secrets s
      where s.battle_id = x and s.turn_number = 1 and s.defender_id = b and s.card_id = c[1] and s.answered_at is null
        and exists (select from jsonb_array_elements(pa -> 'questions') qq, jsonb_array_elements(qq -> 'options') oo
          where qq ->> 'id' = s.question_id::text and oo ->> 'id' = s.correct_option_id)) = 3, 'secrets';
    assert (select jsonb_agg(n) from jsonb_array_elements(pg_temp.bnotes(x)) n where n ->> 'type' = 'battle_attacked')
      = jsonb_build_array(jsonb_build_object('user_id', b, 'type', 'battle_attacked',
        'data', jsonb_build_object('battle_id', x, 'user_id', a, 'username', 'BatAttA'))), pg_temp.bnotes(x)::text;
    -- Fuite (C23).
    opts := array(select oo ->> 'id' from jsonb_array_elements(pa -> 'questions') qq, jsonb_array_elements(qq -> 'options') oo);
    assert cardinality(opts) = 12 and (select count(distinct v) from unnest(opts) v) = 12, 'ids d''option';
    foreach t in array array[wm.battle_detail(a, x), wm.battle_detail(b, x), wm.battles_list(a, null), wm.battles_list(b, null), r,
        (select response from wm.idempotency_keys where user_id = a and key = 'k-att'), (select game_state from public.battles where id = x)] loop
      i := i + 1;
      foreach o in array opts loop
        assert pg_temp.n(t::text, o) = 1, format('lecture %s : %s compté %s fois', i, o, pg_temp.n(t::text, o));
      end loop;
      foreach k in array array['correct_option_id', 'evidence', 'answer', 'q_index', 'correct'] loop
        assert not jsonb_path_exists(t, ('lax $.**.' || k)::jsonpath), format('lecture %s : clé %s', i, k);
      end loop;
    end loop;
    t := (select jsonb_agg(data) from public.notifications where data ->> 'battle_id' = x::text);
    assert t is not null and not exists (select from unnest(opts) v where pg_temp.n(t::text, v) > 0), 'notifications : ' || coalesce(t::text, 'nul');
    e := pg_temp.err(format(q, a, x, 'submit_attack', jsonb_build_object('attack_card_id', c[2])));
    assert e = pg_temp.berr(409, null, 'Ce n''est pas à toi d''attaquer'), coalesce(e::text, 'accepté');
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Attaque par l'id de copie (C4) : au tour suivant de A (3ᵉ), le user_card_id d'une carte donne le même résultat que son card_id.
create function pg_temp.attack_view(p_battle uuid) returns jsonb language sql as $$
  select jsonb_build_object('state', t.game_state #- '{pendingAttack,questions}', 'secrets', (select jsonb_agg(jsonb_build_array(s.turn_number,
      s.defender_id, s.card_id, s.answered_at)) from wm.battle_secrets s where s.battle_id = t.id and s.turn_number = 3))
  from public.battles t where t.id = p_battle
$$;

do $$ declare a uuid; b uuid; c uuid[]; ka uuid[]; x uuid; v1 jsonb; v2 jsonb; begin
  begin
    a := pg_temp.player('BatUcA'); b := pg_temp.player('BatUcB');
    c := pg_temp.bcards('BatUc', array[1000, 1100, 1200, 900, 800, 700], array[500, 600, 700, 400, 300, 200]);
    perform pg_temp.fill();
    ka := pg_temp.own(a, c[1:3]);
    x := pg_temp.active(a, b, c[1:3], pg_temp.own(b, c[4:6]));
    perform pg_temp.turn(x, a, b, c[1], 0);
    perform pg_temp.turn(x, b, a, c[4], 0);
    begin
      perform pg_temp.att(a, x, c[2]);
      v1 := pg_temp.attack_view(x);
      raise exception using errcode = 'WMT01';
    exception when sqlstate 'WMT01' then null;
    end;
    perform pg_temp.att(a, x, ka[2]);
    v2 := pg_temp.attack_view(x);
    assert v1 = v2 and v1 #>> '{state,pendingAttack,attackCardId}' = c[2]::text and v1 #>> '{state,turnNumber}' = '3'
      and jsonb_array_length(v1 -> 'secrets') = 3, v1::text || ' / ' || v2::text;
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- submit_single_answer (C5, C8, C11, C23) : refus ; réponse juste ; Review Focus, double réponse ; fin du tour (667 = round(1000 × 2 / 3)) ;
-- rejeu après le tour, sans écriture ; carte qui a déjà attaqué.
do $$ declare a uuid; b uuid; c uuid[]; d uuid[]; x uuid; q1 uuid; q2 uuid; q3 uuid; s1 text; r jsonb; e jsonb; g jsonb; o1 text[]; o23 text[];
  v text; k text; q text := 'select wm.battle_action(%L, %L, %L, %L)'; begin
  begin
    a := pg_temp.player('BatAnsA'); b := pg_temp.player('BatAnsB');
    c := pg_temp.bcards('BatAns A', array[1000, 400, 400], array[500, 500, 500]);
    d := pg_temp.bcards('BatAns B', array[400, 400, 400], array[1000, 1000, 1000]);
    perform pg_temp.fill();
    x := pg_temp.active(a, b, pg_temp.own(a, c), pg_temp.own(b, d));
    perform pg_temp.att(a, x, c[1]);
    q1 := pg_temp.q(x, 1); q2 := pg_temp.q(x, 2); q3 := pg_temp.q(x, 3); s1 := pg_temp.secret(x, q1);
    select array_agg(oo ->> 'id') filter (where qq ->> 'id' = q1::text and oo ->> 'id' <> s1), array_agg(oo ->> 'id') filter (where qq ->> 'id' <> q1::text)
    into o1, o23
    from public.battles t, jsonb_array_elements(t.game_state #> '{pendingAttack,questions}') qq, jsonb_array_elements(qq -> 'options') oo
    where t.id = x;
    e := pg_temp.err(format(q, a, x, 'submit_single_answer', jsonb_build_object('questionId', q1, 'answerId', s1)));
    assert e = pg_temp.berr(409, null, 'Aucune question ne t''attend'), coalesce(e::text, 'accepté');
    e := pg_temp.err(format(q, b, x, 'submit_single_answer', jsonb_build_object('questionId', gen_random_uuid(), 'answerId', s1)));
    assert e = pg_temp.berr(400, 'invalid_request', 'Question inconnue'), coalesce(e::text, 'accepté');
    e := pg_temp.err(format(q, b, x, 'submit_single_answer', jsonb_build_object('questionId', q1, 'answerId', o23[1])));
    assert e = pg_temp.berr(400, 'invalid_request', 'Réponse inconnue'), coalesce(e::text, 'accepté');
    -- Réponse juste à q1.
    r := pg_temp.ans(b, x, q1, s1);
    assert r - 'battle' - 'decks' - 'reward' = jsonb_build_object('correct', true, 'correct_answer_id', s1, 'last_turn', false, 'status', 'active')
      and r ?& array['battle', 'decks', 'reward'] and r #> '{battle,game_state,pendingAttack,answered}' = jsonb_build_array(q1), r::text;
    assert (select answer_id = s1 and correct and answered_at is not null from wm.battle_secrets where battle_id = x and question_id = q1), 'secret q1';
    foreach v in array o23 || o1 loop
      assert pg_temp.n(r::text, v) = 1, format('%s compté %s fois', v, pg_temp.n(r::text, v));
    end loop;
    assert pg_temp.n(r::text, s1) = 2, format('secret de q1 compté %s fois', pg_temp.n(r::text, s1));
    foreach k in array array['correct_option_id', 'evidence', 'answer', 'q_index', 'correct'] loop
      assert not jsonb_path_exists(r - 'correct', ('lax $.**.' || k)::jsonpath), 'clé ' || k;
    end loop;
    -- Double réponse : même option, puis une autre → le résultat enregistré, rien d'écrit.
    g := (select to_jsonb(t) from public.battles t where t.id = x) || jsonb_build_object('s', (select to_jsonb(s) from wm.battle_secrets s
      where s.battle_id = x and s.question_id = q1));
    r := pg_temp.ans(b, x, q1, s1);
    assert r - 'battle' - 'decks' - 'reward' = jsonb_build_object('correct', true, 'correct_answer_id', s1, 'last_turn', false, 'status', 'active'),
      r::text;
    r := pg_temp.ans(b, x, q1, o1[1]);
    assert r - 'battle' - 'decks' - 'reward' = jsonb_build_object('correct', true, 'correct_answer_id', s1, 'last_turn', false, 'status', 'active')
      and r #> '{battle,game_state,pendingAttack,answered}' = jsonb_build_array(q1), r::text;
    assert (select to_jsonb(t) from public.battles t where t.id = x) || jsonb_build_object('s', (select to_jsonb(s) from wm.battle_secrets s
      where s.battle_id = x and s.question_id = q1)) = g, 'double réponse écrite';
    -- q1 répondue, envoyée par A : pas de rejeu pour qui n'a pas répondu.
    e := pg_temp.err(format(q, a, x, 'submit_single_answer', jsonb_build_object('questionId', q1, 'answerId', s1)));
    assert e = pg_temp.berr(409, null, 'Aucune question ne t''attend'), coalesce(e::text, 'accepté');
    -- q2 et q3 fausses : 667 dégâts, tour de B.
    r := pg_temp.ans(b, x, q2, pg_temp.wrong(x, q2));
    assert r ->> 'last_turn' = 'false' and r ->> 'correct' = 'false' and r ->> 'correct_answer_id' = pg_temp.secret(x, q2), r::text;
    r := pg_temp.ans(b, x, q3, pg_temp.wrong(x, q3));
    assert r - 'battle' - 'decks' - 'reward' = jsonb_build_object('correct', false, 'correct_answer_id', pg_temp.secret(x, q3), 'last_turn', true,
      'status', 'active'), r::text;
    assert r #> '{battle,game_state,turnHistory}' = jsonb_build_array(jsonb_build_object('turnNumber', 1, 'attackerUserId', a, 'defenderId', b,
      'attackCardId', c[1], 'allCorrect', false, 'damageDealt', 667, 'wrong', 2, 'total', 3)), r::text;
    assert r #>> '{battle,game_state,phase}' = 'attack' and r #>> '{battle,game_state,currentTurnUserId}' = b::text
      and r #> '{battle,game_state,turnNumber}' = '2' and r #> '{battle,game_state,pendingAttack}' = 'null'
      and r #> array['battle', 'game_state', 'players', b::text, 'currentHp'] = '2333'
      and r #> array['battle', 'game_state', 'players', a::text, 'currentHp'] = '1500', r::text;
    -- Rejeu après la fin du tour (C5, C11) : le résultat enregistré, last_turn vrai, ni updated_at ni game_state écrits.
    g := (select to_jsonb(t) from public.battles t where t.id = x);
    r := pg_temp.ans(b, x, q1, s1);
    assert r - 'battle' - 'decks' - 'reward' = jsonb_build_object('correct', true, 'correct_answer_id', s1, 'last_turn', true, 'status', 'active'),
      r::text;
    assert (select to_jsonb(t) from public.battles t where t.id = x) = g, 'rejeu écrit';
    -- Tour 2 (B), puis A de nouveau avec c1 au tour 3.
    perform pg_temp.turn(x, b, a, d[1], 0);
    e := pg_temp.err(format(q, a, x, 'submit_attack', jsonb_build_object('attack_card_id', c[1])));
    assert e = pg_temp.berr(409, null, 'Cette carte a déjà attaqué'), coalesce(e::text, 'accepté');
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Dégâts arrondis (C8) : une mauvaise réponse sur trois, ATK 1 000 → 333. La banque de c1, effacée avant l'attaque (staff), est refaite.
do $$ declare a uuid; b uuid; c uuid[]; x uuid; r jsonb; begin
  begin
    a := pg_temp.player('BatDmgA'); b := pg_temp.player('BatDmgB');
    c := pg_temp.bcards('BatDmg', array[1000, 400, 400, 400, 400, 400], array[500, 500, 500, 1000, 1000, 1000]);
    perform pg_temp.fill();
    x := pg_temp.active(a, b, pg_temp.own(a, c[1:3]), pg_temp.own(b, c[4:6]));
    delete from wm.card_quizzes where card_id = c[1];
    r := pg_temp.turn(x, a, b, c[1], 1);
    assert exists (select from wm.card_quizzes where card_id = c[1] and source = 'template'), 'banque effacée non refaite';
    assert r ->> 'last_turn' = 'true' and r #> '{battle,game_state,turnHistory,0}' @> '{"damageDealt": 333, "wrong": 1, "total": 3, "allCorrect": false}'
      and r #> array['battle', 'game_state', 'players', b::text, 'currentHp'] = '2667', r::text;
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Review Focus, même carte des deux côtés (M5a-8, C7) : le second deck passe (un seul quiz_ensure sur les 6 ids, X deux fois) ; banque de X
-- posée à la main : à 6 questions, les tirages de A puis de B ont des q_index disjoints ; à 3, les mêmes, sous des ids tous neufs.
do $$ declare a uuid; b uuid; c uuid[]; x uuid; n int; s1 int[]; s2 int[]; i1 text[]; i2 text[]; begin
  begin
    a := pg_temp.player('BatSameA'); b := pg_temp.player('BatSameB');
    c := pg_temp.bcards('BatSame', array[1000, 400, 400, 400, 400], array[500, 500, 500, 500, 500]);
    perform pg_temp.fill();
    x := pg_temp.active(a, b, pg_temp.own(a, c[1:3]), pg_temp.own(b, array[c[1], c[4], c[5]]));
    assert (select status from public.battles where id = x) = 'active'
      and (select count(*) from wm.card_quizzes where card_id = any (c)) = 5, 'second deck à carte commune';
    foreach n in array array[6, 3] loop
      begin
        update wm.card_quizzes set questions = (select jsonb_agg(jsonb_build_object('kind', 'llm', 'prompt', format('Question %s sur la carte commune ?', i),
            'options', jsonb_build_array('Option A' || i, 'Option B' || i, 'Option C' || i, 'Option D' || i), 'correct', 0, 'evidence', 'Phrase ' || i))
          from generate_series(1, n) i)
        where card_id = c[1];
        perform pg_temp.att(a, x, c[1]);
        i1 := pg_temp.ids(x);
        perform pg_temp.answers(x, b, 0);
        perform pg_temp.att(b, x, c[1]);
        i2 := pg_temp.ids(x);
        s1 := array(select q_index from wm.battle_secrets where battle_id = x and turn_number = 1 order by 1);
        s2 := array(select q_index from wm.battle_secrets where battle_id = x and turn_number = 2 order by 1);
        assert cardinality(s1) = 3 and cardinality(s2) = 3 and cardinality(i1) = 15 and cardinality(i2) = 15 and not i1 && i2,
          format('banque de %s : %s / %s', n, i1, i2);
        assert case n when 6 then not s1 && s2 else s1 = s2 end, format('banque de %s : %s puis %s', n, s1, s2);
        raise exception using errcode = 'WMT01';
      exception when sqlstate 'WMT01' then null;
      end;
    end loop;
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Review Focus, fins (C8, C10, M5a-2) : KO au 1ᵉʳ tour (Σ DEF de B = 900, ATK de c1 = 1 000, trois mauvaises réponses) ; user_stats des deux
-- supprimées avant (profils migrés, C19) ; état final aux clés exactes, sans clé interdite chez l'un ni l'autre (C23) ; second
-- battle_finish direct → XX000, sans rien écrire.
do $$ declare a uuid; b uuid; c uuid[]; x uuid; r jsonb; g jsonb; m text; v jsonb; k text; begin
  begin
    a := pg_temp.player('BatKoA'); b := pg_temp.player('BatKoB');
    c := pg_temp.bcards('BatKo', array[1000, 400, 400, 300, 300, 300], array[500, 500, 500, 300, 300, 300]);
    perform pg_temp.fill();
    x := pg_temp.active(a, b, pg_temp.own(a, c[1:3]), pg_temp.own(b, c[4:6]));
    delete from wm.user_stats where user_id in (a, b);
    r := pg_temp.turn(x, a, b, c[1], 3);
    assert r ->> 'last_turn' = 'true' and r ->> 'status' = 'completed' and r #>> '{battle,status}' = 'completed', r::text;
    assert (select status = 'completed' and winner_id = a and game_state ->> 'phase' = 'over' and game_state ->> 'winnerId' = a::text
        and game_state ->> 'turnNumber' = '1' and game_state -> 'pendingAttack' = 'null'
        and game_state #> array['players', b::text, 'currentHp'] = '0' and game_state #> '{turnHistory,0,damageDealt}' = '1000'
      from public.battles where id = x), (select game_state::text from public.battles where id = x);
    assert (select array_agg(kk order by kk) from public.battles, jsonb_object_keys(game_state) kk where id = x) = array['currentTurnUserId',
      'pendingAttack', 'phase', 'players', 'turnHistory', 'turnNumber', 'winnerId'], (select game_state::text from public.battles where id = x);
    foreach v in array array[wm.battle_detail(a, x), wm.battle_detail(b, x)] loop
      foreach k in array array['correct_option_id', 'evidence', 'answer', 'q_index', 'correct'] loop
        assert not jsonb_path_exists(v, ('lax $.**.' || k)::jsonpath), 'fin : clé ' || k;
      end loop;
    end loop;
    assert pg_temp.rewards(x) = jsonb_build_object(a, 50, b, 10), pg_temp.rewards(x)::text;
    assert (select battles_won from wm.user_stats where user_id = a) = 1 and not exists (select from wm.user_stats where user_id = b), 'battles_won';
    assert (select jsonb_agg(n order by n ->> 'type') from jsonb_array_elements(pg_temp.bnotes(x)) n where n ->> 'type' in ('battle_won', 'battle_lost'))
      = jsonb_build_array(
        jsonb_build_object('user_id', b, 'type', 'battle_lost', 'data', jsonb_build_object('battle_id', x, 'user_id', a, 'username', 'BatKoA')),
        jsonb_build_object('user_id', a, 'type', 'battle_won', 'data', jsonb_build_object('battle_id', x, 'user_id', b, 'username', 'BatKoB'))),
      pg_temp.bnotes(x)::text;
    perform pg_temp.inv('KO');
    assert wm.battle_detail(a, x) -> 'reward' = '50' and wm.battle_detail(b, x) -> 'reward' = '10', 'reward';
    g := jsonb_build_array((select jsonb_agg(to_jsonb(l) order by l.id) from wm.wb_ledger l where l.user_id in (a, b)),
      (select jsonb_agg(to_jsonb(s)) from wm.user_stats s where s.user_id in (a, b)), pg_temp.bnotes(x), (select to_jsonb(t) from public.battles t where t.id = x));
    begin
      perform wm.battle_finish(x, a);
      assert false, 'second battle_finish accepté';
    exception when sqlstate 'XX000' then
      get stacked diagnostics m = message_text;
    end;
    assert m = format('battle_finish : bataille %s non active', x), m;
    assert jsonb_build_array((select jsonb_agg(to_jsonb(l) order by l.id) from wm.wb_ledger l where l.user_id in (a, b)),
      (select jsonb_agg(to_jsonb(s)) from wm.user_stats s where s.user_id in (a, b)), pg_temp.bnotes(x), (select to_jsonb(t) from public.battles t where t.id = x))
      = g, 'second battle_finish écrit';
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Review Focus, fins : decks aux mêmes Σ DEF, six tours sans erreur → aucun dégât, égalité totale, le challenger gagne (défenseur du 6ᵉ tour).
do $$ declare a uuid; b uuid; c uuid[]; x uuid; r jsonb; begin
  begin
    a := pg_temp.player('BatNulA'); b := pg_temp.player('BatNulB');
    c := pg_temp.bcards('BatNul', array[500, 500, 500, 500, 500, 500], array[1000, 1000, 1000, 1000, 1000, 1000]);
    perform pg_temp.fill();
    x := pg_temp.active(a, b, pg_temp.own(a, c[1:3]), pg_temp.own(b, c[4:6]));
    for i in 1 .. 3 loop
      r := pg_temp.turn(x, a, b, c[i], 0);
      assert r ->> 'status' = 'active', r::text;
      r := pg_temp.turn(x, b, a, c[i + 3], 0);
    end loop;
    assert r ->> 'last_turn' = 'true' and r ->> 'status' = 'completed', r::text;
    assert (select status = 'completed' and winner_id = a and game_state ->> 'turnNumber' = '6' and jsonb_array_length(game_state -> 'turnHistory') = 6
        and game_state #> '{turnHistory,5,defenderId}' = to_jsonb(a) and game_state #> array['players', a::text, 'currentHp'] = '3000'
        and game_state #> array['players', b::text, 'currentHp'] = '3000'
        and not exists (select from jsonb_array_elements(game_state -> 'turnHistory') h where h -> 'damageDealt' <> '0')
      from public.battles where id = x), (select game_state::text from public.battles where id = x);
    assert pg_temp.rewards(x) = jsonb_build_object(a, 50, b, 10), pg_temp.rewards(x)::text;
    perform pg_temp.inv('égalité');
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Review Focus, fins : forfeit de B en active → A gagne, +50 et +10 ; de nouveau, ou une attaque de A, → 409 (C11). Puis, pendant un quiz,
-- forfeit de l'attaquant A (expect lose, la phase lue) → B gagne, et la réponse de B → 409. La phase confirmée par la modale (expect) qui
-- n'est plus celle lue → 409, rien d'écrit.
do $$ declare a uuid; b uuid; c uuid[]; x uuid; q1 uuid; r jsonb; e jsonb; upd timestamptz; begin
  begin
    a := pg_temp.player('BatFfA'); b := pg_temp.player('BatFfB');
    c := pg_temp.bcards('BatFf', array[1000, 400, 400, 400, 400, 400], array[500, 500, 500, 500, 500, 500]);
    perform pg_temp.fill();
    x := pg_temp.active(a, b, pg_temp.own(a, c[1:3]), pg_temp.own(b, c[4:6]));
    -- Confirmé comme une annulation (expect cancel, modale ouverte en choix des cartes) → 409, rien d'écrit ni versé ; sans expect, la
    -- défaite.
    upd := (select updated_at from public.battles where id = x);
    e := pg_temp.err(format('select wm.battle_action(%L, %L, %L, %L)', b, x, 'forfeit', '{"expect": "cancel"}'));
    assert e = pg_temp.berr(409, null, 'La bataille a changé : relis-la avant d''abandonner.'), coalesce(e::text, 'accepté');
    assert (select status = 'active' and updated_at = upd from public.battles where id = x)
      and not exists (select from wm.wb_ledger where ref = 'battle:' || x), 'forfeit refusé, bataille écrite';
    r := wm.battle_action(b, x, 'forfeit');
    assert r #>> '{battle,status}' = 'completed' and r #>> '{battle,winner_id}' = a::text and r -> 'reward' = '10'
      and r #>> '{battle,game_state,phase}' = 'over', r::text;
    assert pg_temp.rewards(x) = jsonb_build_object(a, 50, b, 10), pg_temp.rewards(x)::text;
    perform pg_temp.inv('forfeit');
    e := pg_temp.err(format('select wm.battle_action(%L, %L, %L)', b, x, 'forfeit'));
    assert e = pg_temp.berr(409, null, 'Cette bataille est terminée'), coalesce(e::text, 'accepté');
    e := pg_temp.err(format('select wm.battle_action(%L, %L, %L, %L)', a, x, 'submit_attack', jsonb_build_object('attack_card_id', c[1])));
    assert e = pg_temp.berr(409, null, 'Cette bataille est terminée'), coalesce(e::text, 'accepté');
    -- Abandon pendant un quiz : la question en attente n'a plus de réponse possible.
    x := pg_temp.active(a, b, c[1:3], c[4:6]);
    perform pg_temp.att(a, x, c[1]);
    q1 := pg_temp.q(x, 1);
    r := wm.battle_action(a, x, 'forfeit', '{"expect": "lose"}');
    assert r #>> '{battle,status}' = 'completed' and r #>> '{battle,winner_id}' = b::text and r #> '{battle,game_state,pendingAttack}' = 'null',
      r::text;
    assert pg_temp.rewards(x) = jsonb_build_object(a, 10, b, 50), pg_temp.rewards(x)::text;
    e := pg_temp.err(format('select wm.battle_action(%L, %L, %L, %L)', b, x, 'submit_single_answer',
      jsonb_build_object('questionId', q1, 'answerId', pg_temp.secret(x, q1))));
    assert e = pg_temp.berr(409, null, 'Cette bataille est terminée'), coalesce(e::text, 'accepté');
    perform pg_temp.inv('forfeit pendant un quiz');
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Erreur injectée (M4-7 A) : la dernière réponse d'un KO échoue au grand livre (tests.boom) → XX000 et l'état entier inchangé ; trigger
-- retiré, le même appel finit la bataille.
create function pg_temp.bsnap(p_battle uuid) returns jsonb language sql as $$
  select jsonb_build_object('battle', to_jsonb(t),
    'secrets', (select jsonb_agg(to_jsonb(s) order by s.question_id) from wm.battle_secrets s where s.battle_id = t.id),
    'stats', (select jsonb_agg(to_jsonb(s) order by s.user_id) from wm.user_stats s where s.user_id in (t.challenger_id, t.opponent_id)),
    'ledger', (select jsonb_agg(to_jsonb(l) order by l.id) from wm.wb_ledger l where l.user_id in (t.challenger_id, t.opponent_id)),
    'notes', pg_temp.bnotes(t.id))
  from public.battles t where t.id = p_battle
$$;

do $$ declare a uuid; b uuid; c uuid[]; x uuid; q3 uuid; o text; g jsonb; m text; r jsonb; begin
  begin
    a := pg_temp.player('BatBoomA'); b := pg_temp.player('BatBoomB');
    c := pg_temp.bcards('BatBoom', array[1000, 400, 400, 300, 300, 300], array[500, 500, 500, 300, 300, 300]);
    perform pg_temp.fill();
    x := pg_temp.active(a, b, pg_temp.own(a, c[1:3]), pg_temp.own(b, c[4:6]));
    perform pg_temp.att(a, x, c[1]);
    perform pg_temp.ans(b, x, pg_temp.q(x, 1), pg_temp.wrong(x, pg_temp.q(x, 1)));
    perform pg_temp.ans(b, x, pg_temp.q(x, 2), pg_temp.wrong(x, pg_temp.q(x, 2)));
    q3 := pg_temp.q(x, 3); o := pg_temp.wrong(x, q3);
    execute format('create trigger zz_boom after insert on wm.wb_ledger for each row when (new.ref = %L) execute function tests.boom()',
      'battle:' || x);
    g := pg_temp.bsnap(x);
    begin
      perform pg_temp.ans(b, x, q3, o);
      assert false, 'erreur non levée';
    exception when sqlstate 'XX000' then
      get stacked diagnostics m = message_text;
    end;
    assert m = 'erreur injectée', m;
    assert pg_temp.bsnap(x) = g, 'état changé : ' || pg_temp.bsnap(x)::text;
    drop trigger zz_boom on wm.wb_ledger;
    r := pg_temp.ans(b, x, q3, o);
    assert r ->> 'status' = 'completed' and pg_temp.rewards(x) = jsonb_build_object(a, 50, b, 10), r::text;
    perform pg_temp.inv('erreur injectée');
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- P5 : battle_finish et les sous-fonctions de battle_action, appelées sous verrous, n'en prennent pas et ne posent aucun délai ; lock_users
-- seulement pour finir (battle_answer, battle_forfeit) ; for key share avant la première écriture du deck et avant les banques de
-- l'attaque (M4b-31) ; battle_winner pure.
do $$ declare bad text; begin
  select string_agg(f, ', ') into bad
  from unnest(array['battle_finish', 'battle_submit_deck', 'battle_submit_attack', 'battle_answer', 'battle_forfeit']) f
  left join pg_proc p on p.oid = to_regproc('wm.' || f)
  where p.prosrc is null or strpos(p.prosrc, 'for update') > 0 or strpos(p.prosrc, 'lock_timeout') > 0
    or (strpos(p.prosrc, 'wm.lock_users(') > 0) <> (f in ('battle_answer', 'battle_forfeit'));
  assert bad is null, 'verrous : ' || bad;
  assert (select strpos(prosrc, 'for key share') between 1 and least(strpos(prosrc, 'insert into public.battle_decks'), strpos(prosrc, 'wm.notify_battle('))
    from pg_proc where oid = to_regproc('wm.battle_submit_deck')), 'battle_submit_deck : for key share';
  assert (select strpos(prosrc, 'for key share') between 1 and least(strpos(prosrc, 'wm.quiz_ensure('), strpos(prosrc, 'wm.notify_battle('))
    from pg_proc where oid = to_regproc('wm.battle_submit_attack')), 'battle_submit_attack : for key share';
  assert (select provolatile = 'i' from pg_proc where oid = to_regproc('wm.battle_winner')), 'battle_winner non immutable';
end $$;

-- Échéances et santé (1940_wm_battle_expire.sql, 9030_wm_battle_cron.sql). Même règle : chaque bloc fait tout dans une sous-transaction
-- annulée (WMT00).

-- Review Focus, fins par le temps (M5a-12, C18) : le reliquat des blocs précédents soldé d'abord ; chaque compte vaut pour l'appel suivant.
-- Défi de 25 h → cancelled, celui de 23 h intact ; choix des cartes, generating_quizzes hérité et partie inactifs depuis 47 h → rien ; choix
-- des cartes (ou generating_quizzes) inactif depuis 49 h → cancelled, sans argent ; partie inactive en phase d'attaque → l'attaquant attendu
-- perd, en phase de quiz → le défenseur perd, récompenses normales ; aucune notification d'annulation.
-- Maintenance → 0, et rien ne change (un défi et une partie échus) ; elle finie, les deux sont soldés au premier passage.
do $$ declare a uuid; b uuid; c uuid; d uuid; e uuid; k uuid[]; p25 uuid; p23 uuid; ds uuid; gq uuid; x uuid; y uuid; z uuid; nt jsonb; g jsonb;
  w int; begin
  begin
    perform wm.expire_battles(5000);
    a := pg_temp.player('BatExpA'); b := pg_temp.player('BatExpB'); c := pg_temp.player('BatExpC'); d := pg_temp.player('BatExpD');
    e := pg_temp.player('BatExpE');
    perform pg_temp.friends(c, a); perform pg_temp.friends(d, a); perform pg_temp.friends(e, a);
    k := pg_temp.bcards('BatExp', array[1000, 400, 400, 400, 400, 400], array[500, 500, 500, 500, 500, 500]);
    perform pg_temp.fill();
    perform pg_temp.own(a, k[1:3]); perform pg_temp.own(b, k[4:6]);
    -- Défis : 25 h et 23 h.
    p25 := (wm.battle_create(c, a) ->> 'id')::uuid;
    p23 := (wm.battle_create(d, a) ->> 'id')::uuid;
    update public.battles set created_at = created_at - interval '25 hours' where id = p25;
    update public.battles set created_at = created_at - interval '23 hours' where id = p23;
    nt := pg_temp.bnotes(p25);
    assert wm.expire_battles() = 1, 'défi de 25 h';
    assert (select status from public.battles where id = p25) = 'cancelled' and (select status from public.battles where id = p23) = 'pending',
      'défis de 25 h et 23 h';
    assert pg_temp.bnotes(p25) = nt, 'défi échu : ' || pg_temp.bnotes(p25)::text;
    -- Choix des cartes, generating_quizzes hérité (C18) et partie au tour de A, inactifs depuis 47 h : rien.
    ds := (wm.battle_create(e, a) ->> 'id')::uuid;
    perform wm.battle_action(a, ds, 'accept');
    perform pg_temp.friends(c, e);
    gq := (wm.battle_create(c, e) ->> 'id')::uuid;
    perform wm.battle_action(e, gq, 'accept');
    update public.battles set status = 'generating_quizzes' where id = gq;
    x := pg_temp.active(a, b, k[1:3], k[4:6]);
    update public.battles set updated_at = updated_at - interval '47 hours' where id in (ds, gq, x);
    g := jsonb_build_array(pg_temp.bsnap(ds), pg_temp.bsnap(gq), pg_temp.bsnap(x));
    assert wm.expire_battles() = 0, 'inactifs depuis 47 h';
    assert jsonb_build_array(pg_temp.bsnap(ds), pg_temp.bsnap(gq), pg_temp.bsnap(x)) = g, '47 h : état changé';
    -- Les deux premiers, inactifs depuis 49 h.
    update public.battles set updated_at = updated_at - interval '2 hours' where id in (ds, gq);
    nt := pg_temp.bnotes(ds) || pg_temp.bnotes(gq);
    assert wm.expire_battles() = 2, 'choix des cartes inactif';
    assert (select status from public.battles where id = ds) = 'cancelled' and (select status from public.battles where id = gq) = 'cancelled',
      'choix des cartes : statuts';
    assert not exists (select from wm.wb_ledger where ref in ('battle:' || ds, 'battle:' || gq)) and pg_temp.bnotes(ds) || pg_temp.bnotes(gq) = nt,
      'choix des cartes : argent ou notification';
    -- La partie au tour de A, inactive depuis 49 h : B gagne.
    update public.battles set updated_at = updated_at - interval '2 hours' where id = x;
    w := coalesce((select battles_won from wm.user_stats where user_id = b), 0);
    assert wm.expire_battles() = 1, 'phase d''attaque';
    assert (select status = 'completed' and winner_id = b and game_state ->> 'winnerId' = b::text from public.battles where id = x), 'attaque : vainqueur';
    assert pg_temp.rewards(x) = jsonb_build_object(a, 10, b, 50), pg_temp.rewards(x)::text;
    assert (select battles_won from wm.user_stats where user_id = b) = w + 1, 'attaque : battles_won';
    assert (select jsonb_agg(n order by n ->> 'type') from jsonb_array_elements(pg_temp.bnotes(x)) n where n ->> 'type' in ('battle_won', 'battle_lost'))
      = jsonb_build_array(
        jsonb_build_object('user_id', a, 'type', 'battle_lost', 'data', jsonb_build_object('battle_id', x, 'user_id', b, 'username', 'BatExpB')),
        jsonb_build_object('user_id', b, 'type', 'battle_won', 'data', jsonb_build_object('battle_id', x, 'user_id', a, 'username', 'BatExpA'))),
      pg_temp.bnotes(x)::text;
    -- Partie en phase de quiz, défenseur B : A gagne.
    y := pg_temp.active(a, b, k[1:3], k[4:6]);
    perform pg_temp.att(a, y, k[1]);
    update public.battles set updated_at = updated_at - interval '49 hours' where id = y;
    assert wm.expire_battles() = 1, 'phase de quiz';
    assert (select status = 'completed' and winner_id = a from public.battles where id = y), 'quiz : vainqueur';
    assert pg_temp.rewards(y) = jsonb_build_object(a, 50, b, 10), pg_temp.rewards(y)::text;
    -- Maintenance : le défi de 23 h échu à son tour, une partie de B inactive (son tour).
    z := pg_temp.active(b, a, k[4:6], k[1:3]);
    update public.battles set updated_at = updated_at - interval '49 hours' where id = z;
    update public.battles set created_at = created_at - interval '2 hours' where id = p23;
    update wm.config set value = 'true' where key = 'maintenance';
    g := jsonb_build_array(pg_temp.bsnap(z), pg_temp.bsnap(p23));
    assert wm.expire_battles() = 0, 'maintenance';
    assert jsonb_build_array(pg_temp.bsnap(z), pg_temp.bsnap(p23)) = g, 'maintenance : état changé';
    update wm.config set value = 'false' where key = 'maintenance';
    assert wm.expire_battles() = 2, 'après la maintenance';
    assert (select status from public.battles where id = p23) = 'cancelled'
      and (select status = 'completed' and winner_id = a from public.battles where id = z), 'après la maintenance : statuts';
    perform pg_temp.inv('échéances');
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Partie en erreur dans le lot (M4-7 A, modèle 27_market.test.sql:724-755) : la fin de la première partie échoue au grand livre (tests.boom)
-- → elle reste active, sans rien écrire ; la seconde partie et le défi échu du même appel sont soldés, et l'appel rend 2.
do $$ declare a uuid; b uuid; c uuid; d uuid; k uuid[]; x1 uuid; x2 uuid; p uuid; g jsonb; n int; l text := current_setting('client_min_messages');
  begin
  begin
    perform wm.expire_battles(5000);
    a := pg_temp.player('BatLotA'); b := pg_temp.player('BatLotB'); c := pg_temp.player('BatLotC'); d := pg_temp.player('BatLotD');
    k := pg_temp.bcards('BatLot', array[1000, 400, 400, 400, 400, 400], array[500, 500, 500, 500, 500, 500]);
    perform pg_temp.fill();
    perform pg_temp.own(a, k[1:3]); perform pg_temp.own(b, k[4:6]); perform pg_temp.own(c, k[1:3]); perform pg_temp.own(d, k[4:6]);
    x1 := pg_temp.active(a, b, k[1:3], k[4:6]);
    x2 := pg_temp.active(c, d, k[1:3], k[4:6]);
    perform pg_temp.friends(a, c);
    p := (wm.battle_create(a, c) ->> 'id')::uuid;
    update public.battles set updated_at = updated_at - interval '49 hours' where id in (x1, x2);
    update public.battles set created_at = created_at - interval '25 hours' where id = p;
    execute format('create trigger zz_boom after insert on wm.wb_ledger for each row when (new.ref = %L) execute function tests.boom()',
      'battle:' || x1);
    g := pg_temp.bsnap(x1);
    perform set_config('client_min_messages', 'error', true);  -- avertissement attendu de la sous-transaction en erreur
    n := wm.expire_battles();
    perform set_config('client_min_messages', l, true);
    drop trigger zz_boom on wm.wb_ledger;
    assert n = 2, 'rendu du lot : ' || n;
    assert pg_temp.bsnap(x1) = g, 'partie en erreur changée : ' || pg_temp.bsnap(x1)::text;
    assert (select status = 'completed' and winner_id = d from public.battles where id = x2)
      and pg_temp.rewards(x2) = jsonb_build_object(c, 10, d, 50), 'seconde partie : ' || coalesce(pg_temp.rewards(x2)::text, 'non finie');
    assert (select status from public.battles where id = p) = 'cancelled', 'défi échu du lot';
    perform pg_temp.inv('lot en erreur');
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- 9030 sans pg_cron : sans erreur, ni schéma cron ni job.
do $$ begin
  assert to_regnamespace('cron') is null, 'schéma cron avant 9030';
end $$;
\ir ../migrations/9030_wm_battle_cron.sql
do $$ begin
  assert to_regnamespace('cron') is null, 'schéma cron créé par 9030 sans pg_cron';
end $$;

-- Santé (M5a-14) : quiz compte les lignes encore proposées (attempts < 3) ; file vide → 0 et null ; une ligne de 30 s → 1 et 30 ; une ligne
-- à 3 essais, plus vieille, n'est pas comptée. La file vidée d'abord, comme 30_push.test.sql:270.
do $$ declare k1 uuid; k2 uuid; begin
  begin
    delete from wm.quiz_queue where true;
    assert wm.health() -> 'quiz' = '{"queued": 0, "oldest_s": null}', wm.health()::text;
    k1 := pg_temp.bcard('BatSanté 1', 'R', 1, 1); k2 := pg_temp.bcard('BatSanté 2', 'R', 1, 1);
    insert into wm.quiz_queue (card_id, priority, enqueued_at) values (k1, 60, now() - interval '30 seconds');
    assert wm.health() -> 'quiz' = '{"queued": 1, "oldest_s": 30}', wm.health()::text;
    insert into wm.quiz_queue (card_id, priority, enqueued_at, attempts) values (k2, 60, now() - interval '1 hour', 3);
    assert wm.health() -> 'quiz' = '{"queued": 1, "oldest_s": 30}', 'ligne à 3 essais : ' || wm.health()::text;
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;

-- Review Focus, deck tu par la santé (M5a-11) : 6 cartes neuves, sans banque ni ligne de file ; queued ne bouge pas au deck de A, et prend
-- les 6 cartes au second deck.
do $$ declare a uuid; b uuid; c uuid[]; x uuid; q0 int; begin
  begin
    a := pg_temp.player('BatSanA'); b := pg_temp.player('BatSanB');
    c := pg_temp.bcards('BatSan', array[1000, 400, 400, 400, 400, 400], array[500, 500, 500, 500, 500, 500]);
    perform pg_temp.fill();
    perform pg_temp.own(a, c[1:3]); perform pg_temp.own(b, c[4:6]);
    perform pg_temp.friends(a, b);
    x := (wm.battle_create(a, b) ->> 'id')::uuid;
    perform wm.battle_action(b, x, 'accept');
    assert not exists (select from wm.card_quizzes where card_id = any (c)) and not exists (select from wm.quiz_queue where card_id = any (c)),
      'cartes déjà en banque ou en file';
    q0 := (wm.health() #>> '{quiz,queued}')::int;
    perform wm.battle_action(a, x, 'submit_deck', jsonb_build_object('card_ids', c[1:3]));
    assert (wm.health() #>> '{quiz,queued}')::int = q0, 'deck de A compté : ' || wm.health()::text;
    perform wm.battle_action(b, x, 'submit_deck', jsonb_build_object('card_ids', c[4:6]));
    assert (wm.health() #>> '{quiz,queued}')::int = q0 + 6, 'second deck : ' || wm.health()::text;
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
end $$;
