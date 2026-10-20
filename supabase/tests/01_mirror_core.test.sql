-- Tables miroir du cœur (0001_mirror_core.sql) : une règle par bloc, fixtures insérées dans le bloc.

do $$ begin assert enum_range(null::public.rarity)::text = '{C,PC,R,SR,UR,L}'; end $$;

-- L'index lui-même (le trigger d'inscription refuse avant lui, 20_accounts) : un renommage direct bute dessus.
do $$ declare a uuid := tests.make_user('Alice'); m uuid := tests.make_user('Mallory'); begin
  begin update public.profiles set username = 'alice' where id = m; assert false, 'pseudo en double accepté';
  exception when unique_violation then null; end;
end $$;

do $$ begin
  begin perform tests.make_user('Bob', -1); assert false, 'solde négatif accepté';
  exception when check_violation then null; end;
end $$;

do $$ declare u uuid := tests.make_user('Carol'); c uuid; begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
  values ('Carol', 'https://fr.wikipedia.org/wiki/Carol', 'C', 10, 10) returning id into c;
  begin
    insert into public.user_cards (user_id, card_id, count, snapshot_title, snapshot_rarity, snapshot_atk, snapshot_def)
    values (u, c, 0, 'Carol', 'C', 10, 10);
    assert false, 'count = 0 accepté';
  exception when check_violation then null; end;
end $$;

do $$ declare u uuid := tests.make_user('Dave'); begin
  insert into public.tags (user_id, name) values (u, repeat('a', 48));
  begin insert into public.tags (user_id, name) values (u, repeat('a', 49)); assert false, 'étiquette de 49 caractères acceptée';
  exception when check_violation then null; end;
end $$;

do $$ declare u uuid := tests.make_user('Erin'); begin
  insert into public.tags (user_id, name, color) values (u, '[LOCKED]', '#fb7185');
  begin insert into public.tags (user_id, name, color) values (u, 'rouge', 'red'); assert false, 'couleur red acceptée';
  exception when check_violation then null; end;
end $$;

do $$ declare u uuid := tests.make_user('Frank'); c uuid; uc uuid; t uuid; begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
  values ('Frank', 'https://fr.wikipedia.org/wiki/Frank', 'R', 10, 10) returning id into c;
  insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_atk, snapshot_def)
  values (u, c, 'Frank', 'R', 10, 10) returning id into uc;
  insert into public.tags (user_id, name) values (u, 'deck') returning id into t;
  insert into public.user_card_tags (user_card_id, tag_id) values (uc, t);
  begin insert into public.user_card_tags (user_card_id, tag_id) values (uc, t); assert false, 'étiquetage en double accepté';
  exception when unique_violation then null; end;
end $$;

do $$ declare u uuid := tests.make_user('Grace'); c uuid; begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
  values ('Grace', 'https://fr.wikipedia.org/wiki/Grace', 'L', 10, 10) returning id into c;
  insert into public.wishlist_items (user_id, card_id) values (u, c);
  begin insert into public.wishlist_items (user_id, card_id) values (u, c); assert false, 'souhait en double accepté';
  exception when unique_violation then null; end;
end $$;

do $$ declare u uuid := tests.make_user('Heidi'); c uuid; uc uuid; t uuid; begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
  values ('Heidi', 'https://fr.wikipedia.org/wiki/Heidi', 'SR', 10, 10) returning id into c;
  insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_atk, snapshot_def)
  values (u, c, 'Heidi', 'SR', 10, 10) returning id into uc;
  insert into public.tags (user_id, name) values (u, 'deck') returning id into t;
  insert into public.user_card_tags (user_card_id, tag_id) values (uc, t);
  delete from public.tags where id = t;
  assert not exists (select from public.user_card_tags where tag_id = t), 'liens de l''étiquette supprimée restés';
end $$;

do $$ declare u uuid := tests.make_user('Ivan'); c uuid; uc uuid; t uuid; begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
  values ('Ivan', 'https://fr.wikipedia.org/wiki/Ivan', 'UR', 10, 10) returning id into c;
  insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_atk, snapshot_def)
  values (u, c, 'Ivan', 'UR', 10, 10) returning id into uc;
  insert into public.tags (user_id, name) values (u, 'deck') returning id into t;
  insert into public.user_card_tags (user_card_id, tag_id) values (uc, t);
  update public.profiles set avatar_user_card_id = uc where id = u;
  delete from public.user_cards where id = uc;
  assert not exists (select from public.user_card_tags where user_card_id = uc), 'liens de la copie supprimée restés';
  assert (select avatar_user_card_id from public.profiles where id = u) is null, 'avatar pointe sur une copie supprimée';
end $$;

-- Suppression du compte : toute la chaîne de cascades passe, y compris l'avatar sur une copie du même profil.
do $$ declare u uuid := tests.make_user('Judy'); c uuid; uc uuid; begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
  values ('Judy', 'https://fr.wikipedia.org/wiki/Judy', 'PC', 10, 10) returning id into c;
  insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_atk, snapshot_def)
  values (u, c, 'Judy', 'PC', 10, 10) returning id into uc;
  update public.profiles set avatar_user_card_id = uc where id = u;
  insert into public.wishlist_items (user_id, card_id) values (u, c);
  delete from auth.users where id = u;
  assert not exists (select from public.profiles where id = u);
  assert not exists (select from public.user_cards where user_id = u);
  assert not exists (select from public.wishlist_items where user_id = u);
end $$;
