-- RLS et droits de la surface PostgREST d'origine (0002_mirror_rls.sql).
-- Fixtures communes posées en superutilisateur : Alice et Bob ont chacun une copie, une étiquette, une liaison, un souhait.

do $$ declare a uuid := tests.make_user('Alice'); b uuid := tests.make_user('Bob'); c uuid; begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
  values ('Paris', 'https://fr.wikipedia.org/wiki/Paris', 'R', 10, 10) returning id into c;
  insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_atk, snapshot_def)
  values (a, c, 'Paris', 'R', 10, 10), (b, c, 'Paris', 'R', 10, 10);
  insert into public.tags (user_id, name) values (a, 'deck'), (b, 'deck');
  insert into public.user_card_tags (user_card_id, tag_id)
  select uc.id, t.id from public.user_cards uc join public.tags t using (user_id);
  insert into public.wishlist_items (user_id, card_id) values (a, c), (b, c);
end $$;

do $$ begin
  assert (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity) = 0, 'table de public sans RLS';
end $$;

-- Droits exacts : anon lit le catalogue seul (0003), rien pour PUBLIC (grantee 0) ; en écriture, seuls starred, tags.name/color et les insert/delete listés.
do $$ declare got text; begin
  select string_agg(g, ', ' order by g) into got from (
    select format('%s %s %s', coalesce(nullif(a.grantee, 0)::regrole::text, 'public'), c.relname, a.privilege_type) g
    from pg_class c, aclexplode(c.relacl) a
    where c.relnamespace = 'public'::regnamespace and a.grantee in ('anon'::regrole::oid, 'authenticated'::regrole::oid, 0)
      and c.relname in ('profiles', 'cards', 'user_cards', 'tags', 'user_card_tags', 'wishlist_items')
    union all
    select format('%s %s.%s %s', coalesce(nullif(a.grantee, 0)::regrole::text, 'public'), c.relname, att.attname, a.privilege_type)
    from pg_class c join pg_attribute att on att.attrelid = c.oid, aclexplode(att.attacl) a
    where c.relnamespace = 'public'::regnamespace and a.grantee in ('anon'::regrole::oid, 'authenticated'::regrole::oid, 0)
      and c.relname in ('profiles', 'cards', 'user_cards', 'tags', 'user_card_tags', 'wishlist_items')
  ) s;
  assert got = 'anon cards SELECT, authenticated cards SELECT, authenticated profiles SELECT, authenticated tags DELETE, '
    'authenticated tags INSERT, authenticated tags SELECT, authenticated tags.color UPDATE, '
    'authenticated tags.name UPDATE, authenticated user_card_tags DELETE, authenticated user_card_tags INSERT, '
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
  assert (select count(*) from public.profiles) = 2, 'service_role ne voit pas tous les profils';
  assert (select count(distinct user_id) from public.user_cards) = 2, 'service_role ne voit pas toutes les copies';
  assert (select count(distinct user_id) from public.tags) = 2, 'service_role ne voit pas toutes les étiquettes';
  assert (select count(*) from public.user_card_tags) = 2, 'service_role ne voit pas toutes les liaisons';
  assert (select count(distinct user_id) from public.wishlist_items) = 2, 'service_role ne voit pas tous les souhaits';
  perform tests.reset_role();
end $$;
