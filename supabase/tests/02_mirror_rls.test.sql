-- RLS et droits de la surface PostgREST d'origine (0002_mirror_rls.sql, 0004_mirror_market.sql, 0005_mirror_trades.sql).
-- Fixtures communes posées en superutilisateur : Alice et Bob ont chacun une copie, une étiquette, une liaison, un souhait ;
-- Alice vend « Paris », Bob y a misé, chacun a une notification ; Alice et Bob sont amis, Alice propose à Bob
-- un échange de leurs deux copies ; Carol, authentifiée, n'a rien.

do $$ declare a uuid := tests.make_user('Alice'); b uuid := tests.make_user('Bob'); c uuid; t uuid; begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
  values ('Paris', 'https://fr.wikipedia.org/wiki/Paris', 'R', 10, 10) returning id into c;
  insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_atk, snapshot_def)
  values (a, c, 'Paris', 'R', 10, 10), (b, c, 'Paris', 'R', 10, 10);
  insert into public.tags (user_id, name) values (a, 'deck'), (b, 'deck');
  insert into public.user_card_tags (user_card_id, tag_id)
  select uc.id, t.id from public.user_cards uc join public.tags t using (user_id);
  insert into public.wishlist_items (user_id, card_id) values (a, c), (b, c);
  insert into public.auctions (seller_id, card_id, user_card_id, snapshot_rarity, base_amount, listing_base_amount,
    current_bid, current_bidder_id, bids_count, end_at)
  select a, c, id, 'R', 100, 100, 110, b, 1, now() + interval '1 hour' from public.user_cards where user_id = a;
  insert into public.auction_bids (auction_id, bidder_id, amount) select id, b, 110 from public.auctions;
  insert into public.notifications (user_id, type) values (a, 'auction_sold'), (b, 'auction_won');
  perform tests.make_user('Carol');
  insert into public.friendships (requester_id, addressee_id, status) values (a, b, 'accepted');
  insert into public.trades (initiator_id, recipient_id, expires_at) values (a, b, now() + interval '168 hours') returning id into t;
  insert into public.trade_items (trade_id, offered_by, user_card_id, card_id, snapshot_rarity)
  select t, user_id, id, card_id, snapshot_rarity from public.user_cards;
end $$;

do $$ begin
  assert (select array[count(*), count(*) filter (where not c.relrowsecurity)] from pg_class c
          where c.relnamespace = 'public'::regnamespace and c.relkind = 'r') = '{12, 0}',
    'tables de public : 12 attendues, toutes sous RLS';
end $$;

-- Droits exacts sur toutes les tables de public : anon lit le catalogue seul (0003), rien pour PUBLIC (grantee 0) ;
-- en écriture, seuls starred, tags.name/color et les insert/delete listés ; le marché (0004), les échanges et amitiés (0005)
-- en lecture seule.
do $$ declare got text; begin
  select string_agg(g, ', ' order by g collate "C") into got from (
    select format('%s %s %s', coalesce(nullif(a.grantee, 0)::regrole::text, 'public'), c.relname, a.privilege_type) g
    from pg_class c, aclexplode(c.relacl) a
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and a.grantee in ('anon'::regrole::oid, 'authenticated'::regrole::oid, 0)
    union all
    select format('%s %s.%s %s', coalesce(nullif(a.grantee, 0)::regrole::text, 'public'), c.relname, att.attname, a.privilege_type)
    from pg_class c join pg_attribute att on att.attrelid = c.oid, aclexplode(att.attacl) a
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and a.grantee in ('anon'::regrole::oid, 'authenticated'::regrole::oid, 0)
  ) s;
  assert got = 'anon cards SELECT, authenticated auction_bids SELECT, authenticated auctions SELECT, '
    'authenticated cards SELECT, authenticated friendships SELECT, authenticated notifications SELECT, '
    'authenticated profiles SELECT, authenticated tags DELETE, '
    'authenticated tags INSERT, authenticated tags SELECT, authenticated tags.color UPDATE, '
    'authenticated tags.name UPDATE, authenticated trade_items SELECT, authenticated trades SELECT, '
    'authenticated user_card_tags DELETE, authenticated user_card_tags INSERT, '
    'authenticated user_card_tags SELECT, authenticated user_cards SELECT, authenticated user_cards.starred UPDATE, '
    'authenticated wishlist_items DELETE, authenticated wishlist_items INSERT, authenticated wishlist_items SELECT',
    format('droits inattendus : %s', got);
end $$;

-- Bob ne voit que ses lignes, rien d'Alice ; le catalogue est lisible.
do $$ declare a uuid := (select id from public.profiles where username = 'Alice');
              b uuid := (select id from public.profiles where username = 'Bob'); begin
  perform tests.login(b);
  assert (select count(*) from public.cards) >= 1, 'catalogue illisible';
  assert (select array_agg(id) from public.profiles) = array[b], 'profils d''autrui visibles';
  assert (select count(*) from public.user_cards) = 1, 'Bob ne voit pas sa copie';
  assert (select count(*) from public.user_cards where user_id = a) = 0, 'copies d''Alice visibles';
  assert (select count(*) from public.tags) = 1, 'Bob ne voit pas son étiquette';
  assert (select count(*) from public.tags where user_id = a) = 0, 'étiquettes d''Alice visibles';
  assert (select count(*) from public.user_card_tags) = 1, 'liaisons d''Alice visibles';
  assert (select count(*) from public.wishlist_items) = 1, 'Bob ne voit pas son souhait';
  assert (select count(*) from public.wishlist_items where user_id = a) = 0, 'souhaits d''Alice visibles';
  perform tests.reset_role();
end $$;

-- Marché : Bob lit l'enchère d'Alice et la mise, sa seule notification ; Alice lit la mise de Bob ; aucune écriture client.
do $$ declare a uuid := (select id from public.profiles where username = 'Alice');
              b uuid := (select id from public.profiles where username = 'Bob');
              au uuid := (select id from public.auctions); s text; begin
  perform tests.login(b);
  assert (select array_agg(seller_id) from public.auctions) = array[a], 'Bob ne voit pas l''enchère d''Alice';
  assert (select array_agg(bidder_id) from public.auction_bids) = array[b], 'Bob ne voit pas la mise';
  assert (select array_agg(user_id) from public.notifications) = array[b], 'notifications d''autrui visibles';
  foreach s in array array[
    'insert into public.auctions (seller_id, card_id, snapshot_rarity, base_amount, listing_base_amount, end_at)'
      ' select $1, card_id, snapshot_rarity, 1, 1, end_at from public.auctions where id = $2',
    'update public.auctions set current_bid = 1 where id = $2',
    'delete from public.auctions where id = $2',
    'insert into public.auction_bids (auction_id, bidder_id, amount) values ($2, $1, 999)',
    'update public.auction_bids set amount = 1 where auction_id = $2',
    'delete from public.auction_bids where auction_id = $2',
    'insert into public.notifications (user_id, type) values ($1, ''auction_won'')',
    'update public.notifications set read = true where user_id = $1',
    'delete from public.notifications where user_id = $1'] loop
    begin execute s using b, au; assert false, format('écriture client permise : %s', s);
    exception when insufficient_privilege then null; end;
  end loop;
  perform tests.login(a);
  assert (select array_agg(bidder_id) from public.auction_bids) = array[b], 'Alice ne voit pas la mise de Bob';
  perform tests.logout();
  begin perform from public.auctions; assert false, 'anon lit les enchères';
  exception when insufficient_privilege then null; end;
  perform tests.reset_role();
end $$;

-- Échanges et amitiés : Bob lit l'échange, ses deux éléments et l'amitié ; Carol, étrangère, rien (M4-14) ;
-- aucune écriture client ; anon ne lit pas les échanges.
do $$ declare a uuid := (select id from public.profiles where username = 'Alice');
              b uuid := (select id from public.profiles where username = 'Bob');
              ca uuid := (select id from public.profiles where username = 'Carol');
              tr uuid := (select id from public.trades); s text; begin
  perform tests.login(b);
  assert (select array_agg(id) from public.trades) = array[tr], 'Bob ne voit pas l''échange d''Alice';
  assert (select count(*) from public.trade_items where trade_id = tr) = 2, 'Bob ne voit pas les deux éléments';
  assert (select count(*) from public.friendships) = 1, 'Bob ne voit pas l''amitié';
  foreach s in array array[
    'insert into public.trades (initiator_id, recipient_id, expires_at) values ($1, $3, now() + interval ''1 hour'')',
    'update public.trades set status = ''accepted'' where id = $2',
    'delete from public.trades where id = $2',
    'insert into public.trade_items (trade_id, offered_by, user_card_id, card_id, snapshot_rarity)'
      ' select $2, $1, user_card_id, card_id, snapshot_rarity from public.trade_items where trade_id = $2',
    'update public.trade_items set is_shiny = true where trade_id = $2',
    'delete from public.trade_items where trade_id = $2',
    'insert into public.friendships (requester_id, addressee_id) values ($1, $3)',
    'update public.friendships set status = ''pending'' where addressee_id = $1',
    'delete from public.friendships where addressee_id = $1'] loop
    begin execute s using b, tr, a; assert false, format('écriture client permise : %s', s);
    exception when insufficient_privilege then null; end;
  end loop;
  perform tests.login(ca);
  assert (select count(*) from public.trades) = 0, 'Carol voit l''échange d''Alice et Bob';
  assert (select count(*) from public.trade_items) = 0, 'Carol voit les éléments de l''échange';
  assert (select count(*) from public.friendships) = 0, 'Carol voit l''amitié d''Alice et Bob';
  perform tests.logout();
  begin perform from public.trades; assert false, 'anon lit les échanges';
  exception when insufficient_privilege then null; end;
  perform tests.reset_role();
end $$;

-- Contraintes : une seule amitié par paire, dans les deux sens (D:593) ; pas d'échange avec soi-même.
do $$ declare a uuid := (select id from public.profiles where username = 'Alice');
              b uuid := (select id from public.profiles where username = 'Bob'); begin
  begin insert into public.friendships (requester_id, addressee_id) values (b, a); assert false, 'amitié Bob → Alice en double';
  exception when unique_violation then null; end;
  begin insert into public.trades (initiator_id, recipient_id, expires_at) values (a, a, now() + interval '168 hours');
    assert false, 'échange d''Alice avec elle-même';
  exception when check_violation then null; end;
end $$;

-- Alice étoile sa copie, pas celle de Bob ; count et solde restent hors d'atteinte.
do $$ declare a uuid := (select id from public.profiles where username = 'Alice'); n int; begin
  perform tests.login(a);
  update public.user_cards set starred = true where user_id = a;
  get diagnostics n = row_count; assert n = 1, 'Alice ne peut pas étoiler sa copie';
  update public.user_cards set starred = true where user_id <> a;
  get diagnostics n = row_count; assert n = 0, 'Alice étoile la copie de Bob';
  begin update public.user_cards set count = 5 where user_id = a; assert false, 'count modifiable';
  exception when insufficient_privilege then null; end;
  begin update public.profiles set wikibidous_balance = 999 where id = a; assert false, 'solde modifiable';
  exception when insufficient_privilege then null; end;
  perform tests.reset_role();
end $$;

-- Liaisons : copie ET étiquette doivent être à Alice, des deux côtés.
do $$ declare a uuid := (select id from public.profiles where username = 'Alice');
              b uuid := (select id from public.profiles where username = 'Bob');
              ca uuid := (select id from public.user_cards where user_id = a);
              cb uuid := (select id from public.user_cards where user_id = b);
              tb uuid := (select id from public.tags where user_id = b);
              ta uuid; n int; begin
  perform tests.login(a);
  insert into public.tags (user_id, name) values (a, 'favoris') returning id into ta;
  insert into public.user_card_tags (user_card_id, tag_id) values (ca, ta);
  begin insert into public.user_card_tags (user_card_id, tag_id) values (cb, ta); assert false, 'étiquette liée à la copie de Bob';
  exception when insufficient_privilege then null; end;
  begin insert into public.user_card_tags (user_card_id, tag_id) values (ca, tb); assert false, 'étiquette de Bob liée';
  exception when insufficient_privilege then null; end;
  delete from public.user_card_tags where user_card_id = cb;
  get diagnostics n = row_count; assert n = 0, 'Alice délie la copie de Bob';
  delete from public.user_card_tags where user_card_id = ca and tag_id = ta;
  get diagnostics n = row_count; assert n = 1, 'Alice ne peut pas délier';
  perform tests.reset_role();
end $$;

-- Étiquettes : Alice gère les siennes, ne touche pas à celles de Bob, ne change pas de propriétaire.
do $$ declare a uuid := (select id from public.profiles where username = 'Alice');
              b uuid := (select id from public.profiles where username = 'Bob'); t uuid; n int; begin
  perform tests.login(a);
  insert into public.tags (user_id, name, color) values (a, 'rouges', '#fb7185') returning id into t;
  begin insert into public.tags (user_id, name) values (b, 'intrus'); assert false, 'étiquette créée pour Bob';
  exception when insufficient_privilege then null; end;
  update public.tags set name = 'roses', color = '#f9a8d4' where id = t;
  get diagnostics n = row_count; assert n = 1, 'Alice ne peut pas renommer';
  update public.tags set name = 'pris' where user_id = b;
  get diagnostics n = row_count; assert n = 0, 'Alice renomme l''étiquette de Bob';
  begin update public.tags set user_id = b where id = t; assert false, 'propriétaire d''étiquette modifiable';
  exception when insufficient_privilege then null; end;
  delete from public.tags where user_id = b;
  get diagnostics n = row_count; assert n = 0, 'Alice supprime l''étiquette de Bob';
  delete from public.tags where id = t;
  get diagnostics n = row_count; assert n = 1, 'Alice ne peut pas supprimer';
  perform tests.reset_role();
end $$;

-- Souhaits : Alice gère les siens, pas ceux de Bob.
do $$ declare a uuid := (select id from public.profiles where username = 'Alice');
              b uuid := (select id from public.profiles where username = 'Bob');
              c uuid := (select card_id from public.wishlist_items where user_id = a); n int; begin
  perform tests.login(a);
  delete from public.wishlist_items where user_id = b;
  get diagnostics n = row_count; assert n = 0, 'Alice supprime le souhait de Bob';
  delete from public.wishlist_items where user_id = a;
  get diagnostics n = row_count; assert n = 1, 'Alice ne peut pas retirer son souhait';
  insert into public.wishlist_items (user_id, card_id) values (a, c);
  begin insert into public.wishlist_items (user_id, card_id) values (b, gen_random_uuid()); assert false, 'souhait créé pour Bob';
  exception when insufficient_privilege then null; end;
  perform tests.reset_role();
end $$;

do $$ begin
  perform tests.as_service();
  assert (select count(*) from public.profiles) = 3, 'service_role ne voit pas tous les profils';
  assert (select count(distinct user_id) from public.user_cards) = 2, 'service_role ne voit pas toutes les copies';
  assert (select count(distinct user_id) from public.tags) = 2, 'service_role ne voit pas toutes les étiquettes';
  assert (select count(*) from public.user_card_tags) = 2, 'service_role ne voit pas toutes les liaisons';
  assert (select count(distinct user_id) from public.wishlist_items) = 2, 'service_role ne voit pas tous les souhaits';
  assert (select count(*) from public.auctions) = 1, 'service_role ne voit pas les enchères';
  assert (select count(*) from public.auction_bids) = 1, 'service_role ne voit pas les mises';
  assert (select count(distinct user_id) from public.notifications) = 2, 'service_role ne voit pas toutes les notifications';
  assert (select count(*) from public.trades) = 1, 'service_role ne voit pas les échanges';
  assert (select count(*) from public.trade_items) = 2, 'service_role ne voit pas les éléments d''échange';
  assert (select count(*) from public.friendships) = 1, 'service_role ne voit pas les amitiés';
  perform tests.reset_role();
end $$;
