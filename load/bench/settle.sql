-- Règlement de 5 000 enchères (M3-4, P9), en deux appels de run.sh : -v regle=off prépare le lot, -v regle=on le règle, chronométré,
-- et le contrôle. read.sql tourne entre les deux : ses lectures recouvrent le règlement, pas la préparation.
\if :{?regle}
\else
\warn 'settle.sql : -v regle=off (préparation) ou -v regle=on (règlement et contrôles), comme load/bench/run.sh'
\quit
\endif
\if :regle
\timing on
select wm.settle_due_auctions(5000);
\timing off
-- 5 000 vendues, 5 000 notifications auction_won et 5 000 auction_sold, 5 000 copies neuves chez les gagnants (count 1, pas favorites).
do $$
declare
  v_sold int := (select count(*) from public.auctions where status = 'settled_sold');
  v_won int := (select count(*) filter (where type = 'auction_won') from public.notifications);
  v_sold_notes int := (select count(*) filter (where type = 'auction_sold') from public.notifications);
  v_copies int := (select count(*) from public.auctions a join public.user_cards k on k.user_id = a.winner_id and k.card_id = a.card_id
    and k.obtained_at = a.settled_at and k.count = 1 and not k.starred where a.status = 'settled_sold');
begin
  if (v_sold, v_won, v_sold_notes, v_copies) <> (5000, 5000, 5000, 5000) then
    raise exception 'règlement : % vendues, % auction_won, % auction_sold, % copies (5000 de chaque attendues)', v_sold, v_won, v_sold_notes,
      v_copies;
  end if;
end $$;
\else
-- 500 vendeurs Pro × 10 enchères, chacune avec une mise d'un joueur de bench.bidders, puis toutes échues depuis une seconde.
do $$
declare
  v_cards uuid[] := array(select id from public.cards order by id);
  s uuid;
  x uuid;
begin
  for i in 0 .. 4999 loop
    if i % 10 = 0 then
      s := bench.player('bench_vendeur_pro_' || i / 10, 0);
      update public.profiles set is_pro = true where id = s;
    end if;
    x := wm.create_auction(s, (wm.grant_copy(s, v_cards[1 + i % cardinality(v_cards)], false)).id, 1, 60) ->> 'auction_id';
    perform wm.place_bid((select uid from bench.bidders where n = 1 + i % 50), x, 1);
  end loop;
  update public.auctions set end_at = clock_timestamp() - interval '1 second'
  where status = 'active' and id not in (select id from bench.auctions);
end $$;
\endif
