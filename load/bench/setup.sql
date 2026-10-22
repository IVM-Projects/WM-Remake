-- Données des benchs du marché (load/bench/run.sh, P14), sur la base du banc seulement : le schéma bench n'est créé par aucune migration.
create schema bench;

-- Marché ouvert : ni rafale ni limite d'enchères. Minimum suivant = mise + 1 : au ratio 1,1, l'enchère disputée dépasserait le solde de 10⁹
-- après environ 190 mises, et le bench ne mesurerait plus que des refus insufficient_balance.
update wm.config set value = '{"count": 1000000, "window_s": 60}' where key in ('market_bid_burst', 'market_list_burst');
update wm.config set value = '{"free": 100000, "pro": 100000}' where key = 'max_concurrent_auctions';
update wm.config set value = '{"ratio": 1}' where key = 'bid_increment';

-- Joueur vérifié pour 24 h, le temps de tout le run (human_check_ttl_h n'en donne que 12).
create or replace function bench.player(p_name text, p_balance int) returns uuid language plpgsql as $$
declare v_id uuid := tests.make_user(p_name, p_balance);
begin
  insert into wm.user_state (user_id, human_verified_until) values (v_id, now() + interval '24 hours')
  on conflict (user_id) do update set human_verified_until = excluded.human_verified_until;
  return v_id;
end $$;

create table bench.bidders (n int primary key, uid uuid not null);
insert into bench.bidders select n, bench.player('bench_miseur_' || n, 1000000000) from generate_series(1, 50) n;

-- k = 0 : l'enchère disputée ; 1 à 50 : les enchères réparties. Toutes de 60 min, d'un vendeur hors de bench.bidders.
create table bench.auctions (k int primary key, id uuid not null);
do $$
declare s uuid := bench.player('bench_vendeur', 0);
begin
  insert into bench.auctions
  select k, (wm.create_auction(s, (wm.grant_copy(s, c.id, false)).id, 1, 60) ->> 'auction_id')::uuid
  from (select row_number() over (order by id) - 1 k, id from public.cards order by id limit 51) c;
end $$;

-- Verrou de l'enchère d'abord : le minimum lu est celui que place_bid verra. Seuls les refus métier (P0001, « Tu es déjà en tête »…)
-- rendent false : pgbench abandonne un client à sa première erreur, donc un 55P03 ou un 40P01 fait échouer run.sh.
create or replace function bench.bid(p_n int, p_k int) returns boolean language plpgsql as $$
declare a public.auctions;
begin
  select * into a from public.auctions where id = (select id from bench.auctions where k = p_k) for update;
  perform wm.place_bid((select uid from bench.bidders where n = p_n), a.id, wm.min_next_bid(a));
  return true;
exception when sqlstate 'P0001' then
  return false;
end $$;
