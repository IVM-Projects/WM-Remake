-- RLS et droits de la surface PostgREST d'origine (0002_mirror_rls.sql, 0004_mirror_market.sql, 0005_mirror_trades.sql,
-- 0006_mirror_social.sql, 0007_mirror_battles.sql, 0008_mirror_progress.sql).
-- Fixtures communes posées en superutilisateur : Alice et Bob ont chacun une copie, une étiquette, une liaison, un souhait ;
-- Alice vend « Paris », Bob y a misé, chacun a une notification ; Alice et Bob sont amis, Alice propose à Bob
-- un échange de leurs deux copies ; Carol, authentifiée, n'a rien. Alice écrit « Salut » à Bob (non lu), met sa copie
-- en vitrine (emplacement 0), signale Bob pour spam et a un abonnement push. Alice défie Bob (bataille en attente)
-- et y a déjà un deck, trois fois « Paris ». Alice fonde une guilde dont Bob est membre ; Bob y a un souhait, qu'Alice a
-- honoré (un don), et Alice un message ; la guilde a une ligne de score. Un succès « X fixture » est débloqué par Alice et par Bob.

do $$ declare a uuid := tests.make_user('Alice'); b uuid := tests.make_user('Bob'); c uuid; t uuid; bt uuid; g uuid; w uuid; x uuid; begin
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
  select t, user_id, id, card_id, snapshot_rarity from public.user_cards where user_id in (a, b);
  insert into public.chat_messages (sender_id, recipient_id, content) values (a, b, 'Salut');
  insert into public.showcase (user_id, position, user_card_id) select a, 0, id from public.user_cards where user_id = a;
  insert into public.reports (reporter_id, reported_user_id, reason) values (a, b, 'spam');
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (a, 'https://fcm.googleapis.com/fcm/send/fixture', 'k', 'a');
  insert into public.battles (challenger_id, opponent_id, status) values (a, b, 'pending') returning id into bt;
  insert into public.battle_decks (battle_id, user_id, card_ids) values (bt, a, array[c, c, c]);
  insert into public.guilds (name, leader_id) values ('Fixture', a) returning id into g;
  insert into public.guild_members (guild_id, user_id, role) values (g, a, 'leader'), (g, b, 'member');
  insert into public.guild_wishlists (guild_id, user_id, card_id) values (g, b, c) returning id into w;
  insert into public.guild_donations (guild_id, wishlist_id, donor_id, recipient_id, user_card_id)
  select g, w, a, b, id from public.user_cards where user_id = a;
  insert into public.guild_chat_messages (guild_id, user_id, content) values (g, a, 'Bienvenue');
  insert into public.guild_weekly_scores (week_start, guild_id, score_battles, score_wb) values ('2026-10-26', g, 500, 7);
  insert into public.achievements (id, title, description, wikibidous_reward, sort_order, category, threshold)
  values (gen_random_uuid(), 'X fixture', 'Un succès de test', 10, 1, 'collection', 1) returning id into x;
  insert into public.user_achievements (user_id, achievement_id) values (a, x), (b, x);
end $$;

do $$ begin
  assert (select array[count(*), count(*) filter (where not c.relrowsecurity)] from pg_class c
          where c.relnamespace = 'public'::regnamespace and c.relkind = 'r') = '{26, 0}',
    'tables de public : 26 attendues, toutes sous RLS';
end $$;

-- Droits exacts sur toutes les tables de public : anon lit le catalogue seul (0003), rien pour PUBLIC (grantee 0) ;
-- en écriture, seuls starred, tags.name/color, chat_messages.read et les insert/delete listés ; le marché (0004), les échanges
-- et amitiés (0005) en lecture seule ; ni vitrine, ni signalements, ni abonnements push (0006, M4b-28) ; ni batailles,
-- ni decks (0007, M5a-11) ; ni les six tables de guilde, mais les succès et les succès débloqués sont lisibles (0008, R:267).
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
  assert got = 'anon cards SELECT, authenticated achievements SELECT, authenticated auction_bids SELECT, authenticated auctions SELECT, '
    'authenticated cards SELECT, authenticated chat_messages SELECT, authenticated chat_messages.read UPDATE, '
    'authenticated friendships SELECT, authenticated notifications SELECT, '
    'authenticated profiles SELECT, authenticated tags DELETE, '
    'authenticated tags INSERT, authenticated tags SELECT, authenticated tags.color UPDATE, '
    'authenticated tags.name UPDATE, authenticated trade_items SELECT, authenticated trades SELECT, '
    'authenticated user_achievements SELECT, authenticated user_card_tags DELETE, authenticated user_card_tags INSERT, '
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

-- Succès : tout joueur lit le catalogue des succès (autant de lignes que le superutilisateur), et ses seuls succès débloqués.
do $$ declare a uuid := (select id from public.profiles where username = 'Alice');
              b uuid := (select id from public.profiles where username = 'Bob');
              x uuid := (select id from public.achievements where title = 'X fixture');
              total int := (select count(*) from public.achievements); begin
  perform tests.login(b);
  assert (select count(*) from public.achievements where id = x) = 1, 'Bob ne voit pas le succès X';
  assert (select count(*) from public.achievements) = total, 'Bob ne voit pas tout le catalogue des succès';
  assert (select array_agg(user_id) from public.user_achievements) = array[b], 'succès débloqués d''autrui visibles';
  assert (select count(*) from public.user_achievements where user_id = a) = 0, 'succès d''Alice visibles';
  perform tests.reset_role();
end $$;

-- Échanges et amitiés : Bob et Alice lisent l'échange, ses deux éléments et l'amitié ; Carol, étrangère, rien (M4-14) ;
-- aucune écriture client ; anon ne lit pas les échanges. Vitrine, signalements et abonnements push : aucun droit client (M4b-28) ;
-- batailles et decks non plus, même pour le défié (M5a-11).
do $$ declare a uuid := (select id from public.profiles where username = 'Alice');
              b uuid := (select id from public.profiles where username = 'Bob');
              ca uuid := (select id from public.profiles where username = 'Carol');
              tr uuid := (select id from public.trades); s text; begin
  -- Les deux côtés : une politique réduite au destinataire (ou au demandeur) ne passe pas.
  perform tests.login(a);
  assert (select array_agg(id) from public.trades) = array[tr], 'Alice ne voit pas son échange';
  assert (select count(*) from public.trade_items where trade_id = tr) = 2, 'Alice ne voit pas les deux éléments';
  assert (select count(*) from public.friendships) = 1, 'Alice ne voit pas l''amitié';
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
    'delete from public.friendships where addressee_id = $1',
    'select count(*) from public.showcase',
    'insert into public.showcase (user_id, position, user_card_id) select $1, 1, id from public.user_cards where user_id = $1',
    'update public.showcase set position = 1 where user_id = $3',
    'delete from public.showcase where user_id = $3',
    'select count(*) from public.reports',
    'insert into public.reports (reporter_id, reported_user_id, reason) values ($1, $3, ''spam'')',
    'update public.reports set details = ''x'' where reporter_id = $3',
    'delete from public.reports where reporter_id = $3',
    'select count(*) from public.push_subscriptions',
    'insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)'
      ' values ($1, ''https://fcm.googleapis.com/fcm/send/bob'', ''k'', ''a'')',
    'update public.push_subscriptions set auth = ''x'' where user_id = $3',
    'delete from public.push_subscriptions where user_id = $3',
    'select count(*) from public.battles',
    'insert into public.battles (challenger_id, opponent_id) values ($1, $3)',
    'update public.battles set status = ''active'' where opponent_id = $1',
    'delete from public.battles where opponent_id = $1',
    'select count(*) from public.battle_decks',
    'insert into public.battle_decks (battle_id, user_id, card_ids)'
      ' values (gen_random_uuid(), $1, array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()])',
    'update public.battle_decks set created_at = now() where user_id = $3',
    'delete from public.battle_decks where user_id = $3',
    'select count(*) from public.guilds',
    'insert into public.guilds (name) values (''x'')',
    'update public.guilds set name = ''x'' where leader_id = $3',
    'delete from public.guilds where leader_id = $3',
    'select count(*) from public.guild_members',
    'insert into public.guild_members (guild_id, user_id) values (gen_random_uuid(), $1)',
    'update public.guild_members set role = ''leader'' where user_id = $1',
    'delete from public.guild_members where user_id = $1',
    'select count(*) from public.guild_wishlists',
    'insert into public.guild_wishlists (guild_id, user_id, card_id) values (gen_random_uuid(), $1, gen_random_uuid())',
    'update public.guild_wishlists set fulfilled_at = now() where user_id = $1',
    'delete from public.guild_wishlists where user_id = $1',
    'select count(*) from public.guild_donations',
    'insert into public.guild_donations (guild_id, wishlist_id, donor_id, recipient_id, user_card_id)'
      ' values (gen_random_uuid(), gen_random_uuid(), $1, $3, gen_random_uuid())',
    'update public.guild_donations set created_at = now() where donor_id = $3',
    'delete from public.guild_donations where donor_id = $3',
    'select count(*) from public.guild_chat_messages',
    'insert into public.guild_chat_messages (guild_id, user_id, content) values (gen_random_uuid(), $1, ''x'')',
    'update public.guild_chat_messages set content = ''x'' where user_id = $3',
    'delete from public.guild_chat_messages where user_id = $3',
    'select count(*) from public.guild_weekly_scores',
    'insert into public.guild_weekly_scores (week_start, guild_id) values (now(), gen_random_uuid())',
    'update public.guild_weekly_scores set score_wb = 1 where week_start > ''2000-01-01''',
    'delete from public.guild_weekly_scores where week_start > ''2000-01-01''',
    'insert into public.achievements (id, title, description, wikibidous_reward, sort_order, category, threshold)'
      ' values (gen_random_uuid(), ''x'', ''x'', 1, 1, ''x'', 1)',
    'update public.achievements set wikibidous_reward = 999 where title = ''X fixture''',
    'delete from public.achievements where title = ''X fixture''',
    'insert into public.user_achievements (user_id, achievement_id) values ($1, gen_random_uuid())',
    'update public.user_achievements set claimed_at = now() where user_id = $1',
    'delete from public.user_achievements where user_id = $1'] loop
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

-- Messages privés : Alice et Bob lisent leur fil, Carol rien (M4-14), anon pas du tout ; seul le destinataire marque lu,
-- et rien d'autre que read (M4b-28).
do $$ declare a uuid := (select id from public.profiles where username = 'Alice');
              b uuid := (select id from public.profiles where username = 'Bob');
              ca uuid := (select id from public.profiles where username = 'Carol'); n int; begin
  perform tests.login(a);
  assert (select count(*) from public.chat_messages) = 1, 'Alice ne voit pas son message';
  update public.chat_messages set read = true;
  get diagnostics n = row_count; assert n = 0, 'l''expéditrice marque lu';
  perform tests.reset_role();
  assert not (select read from public.chat_messages), 'message marqué lu par l''expéditrice';
  perform tests.login(ca);
  assert (select count(*) from public.chat_messages) = 0, 'Carol voit le message d''Alice à Bob';
  perform tests.login(b);
  assert (select count(*) from public.chat_messages) = 1, 'Bob ne voit pas le message d''Alice';
  update public.chat_messages set read = true where sender_id = a;
  get diagnostics n = row_count; assert n = 1, 'Bob ne peut pas marquer lu';
  begin update public.chat_messages set content = 'x' where sender_id = a; assert false, 'contenu du message modifiable';
  exception when insufficient_privilege then null; end;
  begin insert into public.chat_messages (sender_id, recipient_id, content) values (b, a, 'x'); assert false, 'message inséré par Bob';
  exception when insufficient_privilege then null; end;
  begin delete from public.chat_messages where sender_id = a; assert false, 'message supprimé par Bob';
  exception when insufficient_privilege then null; end;
  perform tests.logout();
  begin perform from public.chat_messages; assert false, 'anon lit les messages';
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
  assert (select count(*) from public.guilds) = 1, 'service_role ne voit pas la guilde';
  assert (select count(*) from public.guild_members) = 2, 'service_role ne voit pas les membres';
  perform tests.reset_role();
end $$;

-- Contraintes des miroirs social (M4b-7, M4b-10) et des batailles, en superutilisateur. En dernier : les blocs précédents
-- comptent la copie d'Alice et le message unique, et le profil de Bob y est supprimé.
do $$ declare a uuid := (select id from public.profiles where username = 'Alice');
              b uuid := (select id from public.profiles where username = 'Bob');
              ca uuid := (select id from public.user_cards where user_id = a);
              bt uuid := (select id from public.battles);
              dk uuid[] := (select card_ids from public.battle_decks); begin
  begin insert into public.chat_messages (sender_id, recipient_id, content) values (a, b, repeat('é', 2001));
    assert false, 'message de 2001 caractères';
  exception when check_violation then null; end;
  insert into public.chat_messages (sender_id, recipient_id, content) values (a, b, repeat('é', 2000));
  begin insert into public.reports (reporter_id, reported_user_id, reason, details) values (b, a, 'spam', repeat('x', 501));
    assert false, 'détails de 501 caractères';
  exception when check_violation then null; end;
  begin insert into public.reports (reporter_id, reported_user_id, reason) values (a, b, 'cheating');
    assert false, 'second signalement d''Alice sur Bob';
  exception when unique_violation then null; end;
  begin insert into public.reports (reporter_id, reported_user_id, reason) values (b, a, 'abuse'); assert false, 'motif inconnu';
  exception when invalid_text_representation then null; end;
  begin insert into public.showcase (user_id, position, user_card_id) values (a, 4, ca); assert false, 'emplacement 4';
  exception when check_violation then null; end;
  begin insert into public.showcase (user_id, position, user_card_id) values (a, 0, ca); assert false, 'emplacement 0 en double';
  exception when unique_violation then null; end;
  begin insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
    values (b, 'https://fcm.googleapis.com/fcm/send/fixture', 'k', 'a');
    assert false, 'endpoint en double';
  exception when unique_violation then null; end;
  delete from public.user_cards where id = ca;
  assert not exists (select from public.showcase where user_id = a), 'emplacement d''une copie supprimée';
  begin insert into public.battles (challenger_id, opponent_id) values (a, a); assert false, 'bataille d''Alice contre elle-même';
  exception when check_violation then null; end;
  begin insert into public.battles (challenger_id, opponent_id, status) values (a, b, 'x'); assert false, 'statut inconnu';
  exception when invalid_text_representation then null; end;
  begin insert into public.battle_decks (battle_id, user_id, card_ids) values (bt, b, dk[1:2]); assert false, 'deck de 2 cartes';
  exception when check_violation then null; end;
  begin insert into public.battle_decks (battle_id, user_id, card_ids) values (bt, a, dk); assert false, 'second deck d''Alice';
  exception when unique_violation then null; end;
  delete from public.profiles where id = b;
  assert not exists (select from public.battles) and not exists (select from public.battle_decks),
    'bataille ou deck d''un profil supprimé';
end $$;

-- Contraintes de guilde et de succès (0008), en superutilisateur. Bob est déjà supprimé : la guilde des fixtures n'a plus
-- qu'Alice, qu'on supprime à son tour en dernier.
do $$ declare a uuid := (select id from public.profiles where username = 'Alice');
              g uuid := (select id from public.guilds);
              g2 uuid; ts bigint; begin
  assert (select count(*) from public.guild_members where guild_id = g) = 1, 'Bob membre après la suppression de son profil';
  assert not exists (select from public.guild_wishlists) and not exists (select from public.guild_donations),
    'souhait ou don d''un profil supprimé';
  begin insert into public.guilds (name) values (repeat('é', 41)); assert false, 'nom de 41 caractères';
  exception when check_violation then null; end;
  insert into public.guilds (name) values (repeat('é', 40)) returning id into g2;
  delete from public.guilds where id = g2;
  begin insert into public.guilds (name) values (''); assert false, 'nom vide';
  exception when check_violation then null; end;
  begin insert into public.guilds (name, description) values ('x', repeat('é', 281)); assert false, 'description de 281 caractères';
  exception when check_violation then null; end;
  begin insert into public.guild_chat_messages (guild_id, user_id, content) values (g, a, repeat('é', 1001));
    assert false, 'message de 1001 caractères';
  exception when check_violation then null; end;
  begin insert into public.guild_members (guild_id, user_id) values (g, a); assert false, 'Alice deux fois membre';
  exception when unique_violation then null; end;
  begin insert into public.guild_members (guild_id, user_id, role) values (g, a, 'x'); assert false, 'rôle inconnu';
  exception when invalid_text_representation then null; end;
  update public.guild_weekly_scores set score_battles = 1000, score_wb = 20 where guild_id = g;
  select total_score into ts from public.guild_weekly_scores where guild_id = g;
  assert ts = 1020, format('total_score = %s au lieu de 1020', ts);
  begin insert into public.achievements (id, title, description, wikibidous_reward, sort_order, category, threshold)
    values (gen_random_uuid(), 'x', 'x', 0, 1, 'x', 1);
    assert false, 'récompense nulle';
  exception when check_violation then null; end;
  -- Le chef supprimé, la guilde reste sans chef et son message disparaît.
  delete from public.profiles where id = a;
  assert (select leader_id from public.guilds where id = g) is null, 'chef supprimé : leader_id non nul';
  assert not exists (select from public.guild_chat_messages where guild_id = g), 'message d''un profil supprimé';
  assert not exists (select from public.user_achievements), 'succès débloqué d''un profil supprimé';
  assert exists (select from public.achievements where title = 'X fixture'), 'succès supprimé avec un profil';
end $$;

-- Cascade de la suppression d'une guilde : membres, souhaits, dons, messages et scores. Fixtures dédiées, profils intacts.
do $$ declare u uuid := tests.make_user('Dora'); v uuid := tests.make_user('Eve'); c uuid; g uuid; w uuid; begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
  values ('Lyon', 'https://fr.wikipedia.org/wiki/Lyon', 'R', 10, 10) returning id into c;
  insert into public.guilds (name, leader_id) values ('Cascade', u) returning id into g;
  insert into public.guild_members (guild_id, user_id, role) values (g, u, 'leader'), (g, v, 'member');
  insert into public.guild_wishlists (guild_id, user_id, card_id) values (g, v, c) returning id into w;
  insert into public.guild_donations (guild_id, wishlist_id, donor_id, recipient_id, user_card_id)
  values (g, w, u, v, gen_random_uuid());
  insert into public.guild_chat_messages (guild_id, user_id, content) values (g, u, 'Salut');
  insert into public.guild_weekly_scores (week_start, guild_id) values ('2026-10-26', g);
  delete from public.guilds where id = g;
  assert not exists (select from public.guild_members where guild_id = g), 'membres d''une guilde supprimée';
  assert not exists (select from public.guild_wishlists where guild_id = g), 'souhaits d''une guilde supprimée';
  assert not exists (select from public.guild_donations where guild_id = g), 'dons d''une guilde supprimée';
  assert not exists (select from public.guild_chat_messages where guild_id = g), 'messages d''une guilde supprimée';
  assert not exists (select from public.guild_weekly_scores where guild_id = g), 'scores d''une guilde supprimée';
end $$;
