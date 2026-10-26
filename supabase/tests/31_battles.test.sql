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
-- wm.draw_pool est NO ACTION) ; une bataille supprimée emporte ses secrets.
do $$ declare c uuid := pg_temp.bcard('Bataille au pool', 'R', 1000, 800); k uuid; a uuid := pg_temp.player('BatSecA');
  b uuid := pg_temp.player('BatSecB'); x uuid; begin
  assert exists (select from wm.draw_pool where card_id = c), 'bcard hors du pool';
  begin
    insert into wm.card_quizzes (card_id, prompt_version, source, questions) values (c, 1, 'x', '[]');
    assert false, 'source x acceptée';
  exception when check_violation then null;
  end;
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
  values ('Bataille hors pool', 'https://fr.wikipedia.org/wiki/Bataille_hors_pool', 'R', 1000, 800) returning id into k;
  insert into wm.card_quizzes (card_id, prompt_version, source, questions) values (k, 1, 'template', '[]');
  insert into wm.quiz_queue (card_id, priority) values (k, 60);
  delete from public.cards where id = k;
  assert not exists (select from wm.card_quizzes where card_id = k), 'banque restée';
  assert not exists (select from wm.quiz_queue where card_id = k), 'ligne de file restée';
  insert into public.battles (challenger_id, opponent_id) values (a, b) returning id into x;
  insert into wm.battle_secrets (battle_id, question_id, turn_number, defender_id, card_id, q_index, correct_option_id)
  values (x, gen_random_uuid(), 1, b, c, 0, gen_random_uuid()::text);
  delete from public.battles where id = x;
  assert not exists (select from wm.battle_secrets where battle_id = x), 'secrets restés';
end $$;

-- battle_money : chaque étape lue dans une sous-transaction annulée (WMT00), d contrôlé après.
do $$ declare a uuid := pg_temp.player('BatMonA'); b uuid := pg_temp.player('BatMonB'); c uuid := pg_temp.player('BatMonCarol');
  x uuid; d1 jsonb; d2 jsonb; d3 jsonb; d4 jsonb; d5 jsonb; begin
  perform pg_temp.friends(a, b);
  insert into public.battles (challenger_id, opponent_id) values (a, b) returning id into x;
  begin
    -- (a) Ligne battle:<id> d'une bataille pending.
    perform wm.wallet_apply(a, 50, 'battle', 'battle:' || x);
    d1 := wm.check_invariants();
    -- (b) Bataille completed sans la ligne du perdant, puis avec.
    update public.battles set status = 'completed', winner_id = a where id = x;
    d2 := wm.check_invariants();
    perform wm.wallet_apply(b, 10, 'battle', 'battle:' || x);
    d3 := wm.check_invariants();
    -- (a) Ligne d'un tiers, puis ref mal formée d'un joueur de la bataille (un cast y lèverait 22P02) : des violations, pas une erreur.
    perform wm.wallet_apply(c, 10, 'battle', 'battle:' || x);
    d4 := wm.check_invariants();
    perform wm.wallet_apply(a, 10, 'battle', 'battle:x');
    d5 := wm.check_invariants();
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert d1 = jsonb_build_array(jsonb_build_object('check', 'battle_money', 'ref', 'battle:' || x, 'user_id', a)), d1::text;
  assert d2 = jsonb_build_array(jsonb_build_object('check', 'battle_money', 'battle_id', x, 'user_id', b)), d2::text;
  assert d3 = '[]', d3::text;
  assert d4 = jsonb_build_array(jsonb_build_object('check', 'battle_money', 'ref', 'battle:' || x, 'user_id', c)), d4::text;
  assert d5 @> jsonb_build_array(jsonb_build_object('check', 'battle_money', 'ref', 'battle:x', 'user_id', a))
    and jsonb_array_length(d5) = 2, d5::text;
  perform pg_temp.inv('battle_money annulé');
end $$;
