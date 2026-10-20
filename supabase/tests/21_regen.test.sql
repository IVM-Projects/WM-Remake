-- Régénération paresseuse (wm.apply_regen, wm.next_regen_at) et RPC du miroir (0003_mirror_rpc.sql).
-- Horloge simulée : packs_last_regen_at écrit dans le passé ; now() est figé pour toute la transaction du test.

-- Gratuit, stock 0, il y a 25 min → 2 paquets, last avancé de 2 périodes, prochain 600 s après ; la ligne est écrite.
do $$ declare u uuid := tests.make_user('Regen1'); t timestamptz := now() - interval '25 minutes'; p public.profiles; begin
  update public.profiles set packs_remaining = 0, packs_last_regen_at = t where id = u;
  p := wm.apply_regen(u);
  assert p.packs_remaining = 2 and p.packs_last_regen_at = t + interval '1200 seconds', format('%s %s', p.packs_remaining, p.packs_last_regen_at);
  assert wm.next_regen_at(p) = p.packs_last_regen_at + interval '600 seconds', 'next_regen_at gratuit';
  assert (select pr from public.profiles pr where pr.id = u) = p, 'régénération non écrite';
end $$;

-- Gratuit, il y a 3 jours → plafonné à pack_cap, last et prochain à null.
do $$ declare u uuid := tests.make_user('Regen2'); p public.profiles; begin
  update public.profiles set packs_remaining = 0, packs_last_regen_at = now() - interval '3 days' where id = u;
  p := wm.apply_regen(u);
  assert p.packs_remaining = 10 and p.packs_last_regen_at is null and wm.next_regen_at(p) is null,
    format('%s %s', p.packs_remaining, p.packs_last_regen_at);
end $$;

-- Pro, et VIP seul, il y a 9 min → 3 paquets en 180 s.
do $$ declare a uuid := tests.make_user('Regen3'); b uuid := tests.make_user('Regen4'); p public.profiles; u uuid; begin
  update public.profiles set packs_remaining = 0, packs_last_regen_at = now() - interval '9 minutes', is_pro = (id = a), is_vip = (id = b)
  where id in (a, b);
  foreach u in array array[a, b] loop
    p := wm.apply_regen(u);
    assert p.packs_remaining = 3 and p.packs_last_regen_at = now() and wm.next_regen_at(p) = now() + interval '180 seconds',
      format('pro=%s vip=%s : %s %s', p.is_pro, p.is_vip, p.packs_remaining, p.packs_last_regen_at);
  end loop;
end $$;

-- Rien ne change, et la ligne n'est pas réécrite (même ctid) : stock plein, moins d'une période, plein daté, date future.
do $$ declare u uuid := tests.make_user('Regen5'); v record; c tid; p public.profiles; begin
  for v in select * from (values (10, null::timestamptz, null::timestamptz), (0, now() - interval '5 minutes', now() + interval '5 minutes'),
                                 (10, now() - interval '1 hour', null), (0, now() + interval '1 hour', now() + interval '70 minutes')) x (n, t, nxt) loop
    update public.profiles set packs_remaining = v.n, packs_last_regen_at = v.t where id = u returning ctid into c;
    p := wm.apply_regen(u);
    assert (select ctid from public.profiles where id = u) = c and p.packs_remaining = v.n and p.packs_last_regen_at is not distinct from v.t
      and wm.next_regen_at(p) is not distinct from v.nxt, format('%s %s : %s %s %s', v.n, v.t, p.packs_remaining, p.packs_last_regen_at, wm.next_regen_at(p));
  end loop;
end $$;

-- Stock incomplet sans date (donnée migrée) : l'horloge démarre à now(), sans crédit, et n'est écrite qu'une fois.
do $$ declare u uuid := tests.make_user('Regen6'); c tid; p public.profiles; begin
  update public.profiles set packs_remaining = 3, packs_last_regen_at = null where id = u;
  p := wm.apply_regen(u);
  assert p.packs_remaining = 3 and p.packs_last_regen_at = now() and wm.next_regen_at(p) = now() + interval '600 seconds',
    format('%s %s', p.packs_remaining, p.packs_last_regen_at);
  c := (select ctid from public.profiles where id = u);
  p := wm.apply_regen(u);
  assert (select ctid from public.profiles where id = u) = c and p.packs_remaining = 3 and p.packs_last_regen_at = now(), 'horloge réécrite';
end $$;

-- Nouveau compte (trigger : 1/10, sans date) : la première synchro démarre l'horloge ; une période plus tard, 2 paquets.
do $$ declare u uuid := tests.make_user('Newbie'); r record; begin
  assert (select packs_remaining = 1 and packs_last_regen_at is null from public.profiles where id = u), 'état de départ inattendu';
  perform tests.login(u);
  select * into strict r from public.sync_profile_packs(u);
  assert r.packs_remaining = 1 and r.packs_last_regen_at = now() and r.next_regen_at = now() + interval '600 seconds', r::text;
  perform tests.reset_role();
  update public.profiles set packs_last_regen_at = packs_last_regen_at - interval '600 seconds' where id = u;
  perform tests.login(u);
  select * into strict r from public.sync_profile_packs(u);
  assert r.packs_remaining = 2 and r.packs_last_regen_at = now() and r.next_regen_at = now() + interval '600 seconds', r::text;
  perform tests.reset_role();
end $$;

-- RPC du miroir : security definer, search_path vide, EXECUTE à authenticated et pas à anon (ni PUBLIC).
do $$ begin
  assert not exists (select from pg_proc p where p.oid in ('public.sync_profile_packs(uuid)'::regprocedure, 'public.get_my_profile()'::regprocedure)
    and (not p.prosecdef or p.proconfig is distinct from array['search_path=""'] or has_function_privilege('anon', p.oid, 'execute')
         or not has_function_privilege('authenticated', p.oid, 'execute'))), 'RPC du miroir mal verrouillées';
end $$;

-- sync_profile_packs : Alice reçoit sa ligne régénérée ; sur l'uid de Bob, 42501.
do $$ declare a uuid := tests.make_user('Alice'); b uuid := tests.make_user('Bob'); r record; begin
  update public.profiles set packs_remaining = 0, packs_last_regen_at = now() - interval '25 minutes' where id = a;
  perform tests.login(a);
  select * into strict r from public.sync_profile_packs(a);
  assert r.username = 'Alice' and r.packs_remaining = 2 and r.pack_cap = 10 and not r.is_pro and not r.is_vip and r.wikibidous_balance = 0
    and r.packs_last_regen_at = now() - interval '300 seconds' and r.next_regen_at = now() + interval '300 seconds', r::text;
  begin perform public.sync_profile_packs(b); assert false, 'sync_profile_packs sur le profil de Bob';
  exception when insufficient_privilege then null; end;
  perform tests.reset_role();
  assert (select packs_remaining from public.profiles where id = a) = 2, 'régénération de sync_profile_packs non écrite';
end $$;

-- get_my_profile : le profil d'Alice, régénéré.
do $$ declare a uuid := (select id from public.profiles where username = 'Alice'); p public.profiles; begin
  update public.profiles set packs_remaining = 0, packs_last_regen_at = now() - interval '3 days' where id = a;
  perform tests.login(a);
  select * into strict p from public.get_my_profile();
  assert p.id = a and p.packs_remaining = 10 and p.packs_last_regen_at is null, format('%s %s %s', p.id, p.packs_remaining, p.packs_last_regen_at);
  perform tests.reset_role();
end $$;

-- anon : lit le catalogue, pas les copies (0 ligne ou refus), et n'appelle aucune des deux RPC.
do $$ declare a uuid := (select id from public.profiles where username = 'Alice'); c uuid; begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
  values ('Lyon', 'https://fr.wikipedia.org/wiki/Lyon', 'C', 1, 1) returning id into c;
  insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_atk, snapshot_def)
  values (a, c, 'Lyon', 'C', 1, 1);
  perform tests.logout();
  assert (select count(*) from public.cards where id = c) = 1, 'anon ne lit pas le catalogue';
  begin assert (select count(*) from public.user_cards) = 0, 'anon lit user_cards';
  exception when insufficient_privilege then null; end;
  -- Le refus doit venir du droit EXECUTE, pas du contrôle d'uid (qui lève aussi 42501).
  begin perform public.sync_profile_packs(a); assert false, 'anon appelle sync_profile_packs';
  exception when insufficient_privilege then assert sqlerrm like 'permission denied for function%', 'anon : ' || sqlerrm; end;
  begin perform public.get_my_profile(); assert false, 'anon appelle get_my_profile';
  exception when insufficient_privilege then null; end;
  perform tests.reset_role();
end $$;
