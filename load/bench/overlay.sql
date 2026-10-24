-- Mesure de l'overlay des amis (load/bench/run.sh, B14), sur la base du banc seulement, après setup.sql (schéma bench, bench.player) : un
-- joueur O à 1 000 amis acceptés, chacun possédant les 50 premières cartes du seed, puis le plan de wm.cards_overlay lu par auto_explain
-- (sorties LOG, sur stderr). run.sh relit le plan, puis chronomètre le même appel.
\set ON_ERROR_STOP on
do $$ begin
  if current_database() <> 'wm_test' then
    raise exception 'overlay.sql : base wm_test du banc seulement, pas %', current_database();
  end if;
end $$;

-- O et une page de 50 cartes ; amis des deux sens de la ligne, un sur deux, pour les deux branches de l'union de friendOwners.
create table bench.overlay (uid uuid, ids uuid[]);
insert into bench.overlay values (bench.player('bench_overlay', 0), array(select id from public.cards order by id limit 50));
create table bench.overlay_friends (n int primary key, uid uuid);
insert into bench.overlay_friends select n, bench.player('bench_ami_' || n, 0) from generate_series(1, 1000) n;
insert into public.friendships (requester_id, addressee_id, status)
select case when f.n % 2 = 0 then o.uid else f.uid end, case when f.n % 2 = 0 then f.uid else o.uid end, 'accepted'
from bench.overlay_friends f, bench.overlay o;
insert into public.user_cards (user_id, card_id, count, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
select f.uid, c.id, 1, c.wikipedia_title, c.rarity, c.category, c.atk, c.def
from bench.overlay_friends f, bench.overlay o join public.cards c on c.id = any (o.ids);

-- Statistiques avant la mesure (DG:467) : sans elles, des boucles imbriquées sur toute user_cards.
analyze;

-- Contrôle : 50 cartes, chacune avec list_caps.friend_owners (3) amis possesseurs.
do $$ begin
  if (select count(*) filter (where jsonb_array_length(e.value) = 3) from bench.overlay o,
      jsonb_each(wm.cards_overlay(o.uid, o.ids) -> 'friendOwners') e) <> 50 then
    raise exception 'overlay.sql : friendOwners inattendu';
  end if;
end $$;

load 'auto_explain';
set auto_explain.log_min_duration = 0;
set auto_explain.log_nested_statements = on;
set auto_explain.log_analyze = on;
set client_min_messages = log;
select wm.cards_overlay(uid, ids) from bench.overlay;
