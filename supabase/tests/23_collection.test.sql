-- Collection (1300_wm_collection.sql) : compteurs par rareté tenus par triggers, index, pages stables, tris, filtres, stats, collection d'un profil.
-- Catalogue et copies créés ici (le seed n'est pas chargé) ; now() est figé pour tout le fichier.

-- Exécute p_sql et renvoie le detail JSON de l'erreur P0001 levée (null si aucune).
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare d text; begin
  execute p_sql;
  return null;
exception when sqlstate 'P0001' then
  get stacked diagnostics d = pg_exception_detail;
  return d::jsonb;
end $$;

create function pg_temp.uid(p_name text) returns uuid language sql as $$ select id from public.profiles where username = p_name $$;
create function pg_temp.card(i int) returns uuid language sql as $$ select id from public.cards where wikipedia_url = 'https://fr.wikipedia.org/wiki/Coll_' || i $$;
create function pg_temp.tag(p_name text) returns uuid language sql as $$ select id from public.tags where name = p_name $$;

-- Ids d'une réponse, dans l'ordre ; pages 0, 1 et 2 bout à bout pour un tri.
create function pg_temp.ids(r jsonb) returns uuid[] language sql as $$
  select coalesce(array_agg((x ->> 'id')::uuid order by i), '{}') from jsonb_array_elements(r -> 'collection') with ordinality e (x, i)
$$;
create function pg_temp.pages(p_uid uuid, p_sort text) returns uuid[] language sql as $$
  select pg_temp.ids(wm.my_collection(p_uid, 0, 50, p_sort)) || pg_temp.ids(wm.my_collection(p_uid, 1, 50, p_sort))
    || pg_temp.ids(wm.my_collection(p_uid, 2, 50, p_sort))
$$;

-- La réponse (une page) contient exactement les copies de p_uid qui vérifient p_where, et total le confirme.
create function pg_temp.exactly(r jsonb, p_uid uuid, p_where text) returns boolean language plpgsql as $$
declare want uuid[]; begin
  execute format('select coalesce(array_agg(id order by id), ''{}'') from public.user_cards uc where uc.user_id = $1 and %s', p_where)
  into want using p_uid;
  return (select coalesce(array_agg(x order by x), '{}') from unnest(pg_temp.ids(r)) x) = want and (r ->> 'total')::int = cardinality(want);
end $$;

create function pg_temp.inv(p_label text) returns void language plpgsql as $$ begin
  assert wm.check_invariants() = '[]'::jsonb, p_label || ' : ' || wm.check_invariants()::text;
end $$;

-- Index du D§9.4 ; wm.search_text immutable et parallel safe, sans accents ni casse.
do $$ declare p text; begin
  foreach p in array array['user_cards USING btree (user_id, obtained_at DESC, id)',
    'user_cards USING btree (user_id, snapshot_rarity DESC, obtained_at DESC, id)', 'user_cards USING btree (card_id, user_id)',
    'user_cards USING btree (user_id) WHERE starred', 'wishlist_items USING btree (card_id)'] loop
    assert exists (select from pg_indexes where schemaname = 'public' and indexdef like '%ON public.' || p), 'index absent : ' || p;
  end loop;
  assert wm.search_text('Électricité STATIQUE', 'Géographie') = 'electricite statique geographie', wm.search_text('Électricité STATIQUE', 'Géographie');
  assert wm.search_text('Œuvre', null) = 'oeuvre ', wm.search_text('Œuvre', null);
  assert (select provolatile = 'i' and proparallel = 's' from pg_proc where oid = 'wm.search_text(text, text)'::regprocedure), 'search_text non immutable';
end $$;

-- Coll1 : 60 cartes (10 par rareté), 2 copies chacune = 120 lignes, obtenues par groupes de 3 à la même date (départage par id).
-- Favorites, brillantes (L, 2e copie), une copie à count = 3, un catalogue modifié après le tirage (carte 3), deux étiquettes, une liste de souhaits.
-- Coll2 public (5 copies, une étiquette), Coll3 privé (2 copies).
do $$ declare u uuid := tests.make_user('Coll1'); v uuid := tests.make_user('Coll2'); w uuid := tests.make_user('Coll3'); x uuid[]; begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, category, summary)
  select case i when 1 then 'Électricité statique' when 2 then 'Zoologie' else format('Carte %s', lpad(i::text, 2, '0')) end,
    'https://fr.wikipedia.org/wiki/Coll_' || i, (enum_range(null::public.rarity))[1 + i % 6], 100 * (i % 7), 100 * (i % 5),
    case i when 2 then 'Géographie humaine' else 'Catégorie ' || i % 3 end, 'Résumé ' || i
  from generate_series(1, 60) i;
  insert into public.user_cards (user_id, card_id, is_shiny, starred, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk,
    snapshot_def, obtained_at)
  select u, c.id, k = 2 and c.rarity = 'L', k = 1 and i % 4 = 0, c.wikipedia_title, c.rarity, c.category, c.atk, c.def,
    now() - make_interval(mins => (row_number() over (order by i, k))::int / 3)
  from generate_series(1, 60) i join public.cards c on c.wikipedia_url = 'https://fr.wikipedia.org/wiki/Coll_' || i, generate_series(1, 2) k;
  update public.user_cards set count = 3 where id = (select id from public.user_cards where user_id = u and card_id = pg_temp.card(9) limit 1);
  update public.cards set atk = atk + 1, category = 'Changée' where id = pg_temp.card(3);
  insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
  select o, c.id, c.wikipedia_title, c.rarity, c.category, c.atk, c.def
  from (values (v, 5), (w, 2)) p (o, n), generate_series(1, p.n) i join public.cards c on c.wikipedia_url = 'https://fr.wikipedia.org/wiki/Coll_' || i;
  update public.profiles set is_public = false where id = w;
  insert into public.tags (user_id, name, color) values (u, 'alpha', '#fb7185'), (u, 'beta', null), (v, 'secret', '#000000');
  x := array(select id from public.user_cards where user_id = u order by obtained_at desc, id limit 4);
  insert into public.user_card_tags (user_card_id, tag_id)
  values (x[1], pg_temp.tag('alpha')), (x[2], pg_temp.tag('alpha')), (x[3], pg_temp.tag('alpha')), (x[1], pg_temp.tag('beta')),
    (x[4], pg_temp.tag('beta')), ((select id from public.user_cards where user_id = v limit 1), pg_temp.tag('secret'));
  insert into public.wishlist_items (user_id, card_id) values (u, pg_temp.card(1)), (u, pg_temp.card(5)), (v, pg_temp.card(7));
end $$;

-- Pages de 50 en base 0, limit plafonné à 50 ; total 120 lu dans user_rarity_counts (un écart volontaire s'y voit, rareté comprise).
do $$ declare u uuid := pg_temp.uid('Coll1'); r jsonb := wm.my_collection(pg_temp.uid('Coll1')); begin
  assert r ?& array['collection', 'total', 'pendingTradeCardIds'] and r -> 'pendingTradeCardIds' = '[]'
    and jsonb_array_length(r -> 'collection') = 50, r - 'collection';
  assert r -> 'total' = '120' and (r ->> 'total')::int = (select sum(rows) from wm.user_rarity_counts where user_id = u), r -> 'total';
  assert jsonb_array_length(wm.my_collection(u, 1) -> 'collection') = 50 and jsonb_array_length(wm.my_collection(u, 2) -> 'collection') = 20
    and wm.my_collection(u, 3) -> 'collection' = '[]', 'pages 1 à 3';
  assert jsonb_array_length(wm.my_collection(u, 0, 500) -> 'collection') = 50, 'limit non plafonné';
  update wm.user_rarity_counts set rows = rows + 1000 where user_id = u and snapshot_rarity = 'L' and not is_shiny;
  assert wm.my_collection(u) -> 'total' = '1120' and wm.my_collection(u, p_rarity => '{L,UR}') -> 'total' = '1040'
    and wm.my_collection(u, p_rarity => '{C}') -> 'total' = '20', 'total hors compteurs';
  update wm.user_rarity_counts set rows = rows - 1000 where user_id = u and snapshot_rarity = 'L' and not is_shiny;
end $$;

-- Ordre stable : pages 0 à 2 = chaque id une fois, dans l'ordre du tri puis obtained_at desc, id ; défaut = rarity ; obtained_at = added.
do $$ declare u uuid := pg_temp.uid('Coll1'); s record; a uuid[]; b uuid[]; d jsonb; begin
  for s in select * from (values ('rarity', 'snapshot_rarity desc,'), ('obtained_at', ''), ('added', ''), ('name', 'snapshot_title,'),
                                 ('atk', 'snapshot_atk desc,'), ('def', 'snapshot_def desc,'), ('starred', 'starred desc,')) v (sort, k) loop
    a := pg_temp.pages(u, s.sort);
    execute format('select array_agg(id order by %s obtained_at desc, id) from public.user_cards where user_id = $1', s.k) into b using u;
    assert cardinality(a) = 120 and (select count(distinct x) from unnest(a) x) = 120 and a = b, s.sort || ' : ' || a::text;
  end loop;
  assert pg_temp.ids(wm.my_collection(u)) = (pg_temp.pages(u, 'rarity'))[1:50]
    and pg_temp.ids(wm.my_collection(u, p_sort => null)) = (pg_temp.pages(u, 'rarity'))[1:50], 'tri par défaut ou null';
  d := pg_temp.err(format('select wm.my_collection(%L, p_sort => %L)', u, 'xyz'));
  assert d = '{"status":400,"code":"invalid_request","error":"Tri inconnu","message":"Tri inconnu"}'::jsonb, coalesce(d::text, 'accepté');
end $$;

-- Item : copie, carte du catalogue (actuelle) et snapshots (figés), count de la colonne, étiquettes de la copie triées par nom.
do $$ declare u uuid := pg_temp.uid('Coll1'); r jsonb; x uuid[] := array(select id from public.user_cards where user_id = pg_temp.uid('Coll1')
    order by obtained_at desc, id limit 4); begin
  for p in 0 .. 2 loop
    r := wm.my_collection(u, p);
    assert (select count(*) from jsonb_array_elements(r -> 'collection') e join public.user_cards uc on uc.id = (e ->> 'id')::uuid
      join public.cards c on c.id = uc.card_id
      where e - 'tags' = jsonb_build_object('id', uc.id, 'user_id', uc.user_id, 'card_id', uc.card_id,
        'card', jsonb_build_object('id', c.id, 'wikipedia_title', c.wikipedia_title, 'rarity', c.rarity, 'category', c.category, 'atk', c.atk,
          'def', c.def, 'image_url', c.image_url, 'hide_image', c.hide_image, 'nsfw_image', c.nsfw_image, 'wikipedia_url', c.wikipedia_url,
          'description', c.category, 'summary', c.summary),
        'snapshot_title', uc.snapshot_title, 'snapshot_rarity', uc.snapshot_rarity, 'snapshot_category', uc.snapshot_category,
        'snapshot_atk', uc.snapshot_atk, 'snapshot_def', uc.snapshot_def, 'is_shiny', uc.is_shiny, 'starred', uc.starred, 'count', uc.count,
        'obtained_at', uc.obtained_at)) = jsonb_array_length(r -> 'collection'), 'items de la page ' || p;
  end loop;
  r := wm.my_collection(u, 0, 50, 'obtained_at');
  assert (select jsonb_object_agg(e ->> 'id', e -> 'tags') from jsonb_array_elements(r -> 'collection') e where (e ->> 'id')::uuid = any (x))
    = jsonb_build_object(x[1], jsonb_build_array(jsonb_build_object('id', pg_temp.tag('alpha'), 'name', 'alpha', 'color', '#fb7185'),
        jsonb_build_object('id', pg_temp.tag('beta'), 'name', 'beta', 'color', null)),
      x[2], jsonb_build_array(jsonb_build_object('id', pg_temp.tag('alpha'), 'name', 'alpha', 'color', '#fb7185')),
      x[3], jsonb_build_array(jsonb_build_object('id', pg_temp.tag('alpha'), 'name', 'alpha', 'color', '#fb7185')),
      x[4], jsonb_build_array(jsonb_build_object('id', pg_temp.tag('beta'), 'name', 'beta', 'color', null))), 'étiquettes';
  assert (select count(*) filter (where e -> 'tags' = '[]') from jsonb_array_elements(r -> 'collection') e) = 46, 'copies sans étiquette';
  assert (select count(*) from generate_series(0, 2) p, jsonb_array_elements(wm.my_collection(u, p) -> 'collection') e where e -> 'count' = '3') = 1, 'count';
end $$;

-- Filtres (ET) : recherche sans accents ni casse sur titre et catégorie (espaces rognés), raretés, étiquette, sans étiquette, ma liste de souhaits.
do $$ declare u uuid := pg_temp.uid('Coll1'); r jsonb; a uuid[]; d jsonb; begin
  assert pg_temp.exactly(wm.my_collection(u, p_q => 'ELECTRICITE'), u, $w$snapshot_title = 'Électricité statique'$w$), 'q titre';
  assert pg_temp.exactly(wm.my_collection(u, p_q => 'géographie'), u, $w$snapshot_title = 'Zoologie'$w$), 'q catégorie';
  assert pg_temp.exactly(wm.my_collection(u, p_q => '  ZOOLOGIE '), u, $w$snapshot_title = 'Zoologie'$w$), 'q rogné';
  assert pg_temp.exactly(wm.my_collection(u, p_q => 'categorie 1'), u, $w$snapshot_category = 'Catégorie 1'$w$), 'q 40 copies';
  assert pg_temp.exactly(wm.my_collection(u, p_q => 'zzz'), u, 'false'), 'q sans résultat';
  assert pg_temp.exactly(wm.my_collection(u, p_rarity => '{L,UR}'), u, $w$snapshot_rarity in ('L', 'UR')$w$), 'raretés';
  assert pg_temp.exactly(wm.my_collection(u, p_q => 'categorie 1', p_rarity => '{PC}'), u,
    $w$snapshot_category = 'Catégorie 1' and snapshot_rarity = 'PC'$w$), 'q ET rareté';
  assert pg_temp.exactly(wm.my_collection(u, p_tag_id => pg_temp.tag('alpha')), u,
    format('id in (select user_card_id from public.user_card_tags where tag_id = %L)', pg_temp.tag('alpha'))), 'étiquette';
  assert pg_temp.exactly(wm.my_collection(u, p_tag_id => pg_temp.tag('alpha'), p_untagged => true), u, 'false'), 'étiquette ET sans étiquette';
  assert pg_temp.exactly(wm.my_collection(u, p_wishlisted_by => u), u, format('card_id in (%L, %L)', pg_temp.card(1), pg_temp.card(5))), 'souhaits';
  assert pg_temp.exactly(wm.my_collection(u, p_wishlisted_by => u, p_rarity => '{L}'), u,
    format('card_id in (%L, %L) and snapshot_rarity = %L', pg_temp.card(1), pg_temp.card(5), 'L')), 'souhaits ET rareté';
  r := wm.my_collection(u, p_untagged => true);
  a := pg_temp.ids(r) || pg_temp.ids(wm.my_collection(u, 1, p_untagged => true)) || pg_temp.ids(wm.my_collection(u, 2, p_untagged => true));
  assert r -> 'total' = '116' and cardinality(a) = 116 and not exists (select from public.user_card_tags where user_card_id = any (a)), 'sans étiquette';
  d := pg_temp.err(format('select wm.my_collection(%L, p_wishlisted_by => %L)', u, pg_temp.uid('Coll2')));
  assert d = '{"status":403,"code":"FORBIDDEN","error":"Vous devez être amis pour voir sa liste de souhaits","message":"Vous devez être amis pour voir sa liste de souhaits"}'::jsonb,
    coalesce(d::text, 'accepté');
end $$;

-- owned_by : profil public → sa collection, sans ses étiquettes ; privé ou inconnu → 403 ; soi-même privé → la mienne.
do $$ declare u uuid := pg_temp.uid('Coll1'); v uuid := pg_temp.uid('Coll2'); r jsonb; d jsonb; o uuid; begin
  r := wm.my_collection(u, p_owned_by => v);
  assert pg_temp.exactly(r, v, 'true') and r -> 'total' = '5' and not exists (select from jsonb_array_elements(r -> 'collection') e
    where e ->> 'user_id' <> v::text or e -> 'tags' <> '[]'), r::text;
  -- Ses étiquettes (privées) ne filtrent rien pour moi : sans étiquette = ses 5 copies, son étiquette = aucune, page comme stats.
  assert pg_temp.exactly(wm.my_collection(u, p_owned_by => v, p_untagged => true), v, 'true')
    and wm.my_collection_stats(u, p_owned_by => v, p_untagged => true) -> 'total' = '5', 'sans étiquette chez un autre';
  assert pg_temp.exactly(wm.my_collection(u, p_owned_by => v, p_tag_id => pg_temp.tag('secret')), v, 'false')
    and wm.my_collection_stats(u, p_owned_by => v, p_tag_id => pg_temp.tag('secret')) -> 'total' = '0', 'étiquette d''un autre';
  foreach o in array array[pg_temp.uid('Coll3'), gen_random_uuid()] loop
    d := pg_temp.err(format('select wm.my_collection(%L, p_owned_by => %L)', u, o));
    assert d = '{"status":403,"code":"FORBIDDEN","error":"Cette collection est privée","message":"Cette collection est privée"}'::jsonb,
      coalesce(d::text, 'accepté');
    d := pg_temp.err(format('select wm.my_collection_stats(%L, p_owned_by => %L)', u, o));
    assert d ->> 'error' = 'Cette collection est privée', 'stats : ' || coalesce(d::text, 'accepté');
  end loop;
  update public.profiles set is_public = false where id = u;
  assert wm.my_collection(u, p_owned_by => u) -> 'total' = '120', 'ma collection privée';
  update public.profiles set is_public = true where id = u;
end $$;

-- Stats : total et comptes par rareté (ordre L…C, libellés) = count(*) filtrés, et = total de my_collection.
do $$ declare u uuid := pg_temp.uid('Coll1'); f record; s jsonb; want jsonb; begin
  for f in select * from (values ('', 'true'), (', p_q => ''categorie 1''', $w$snapshot_category = 'Catégorie 1'$w$),
      (', p_rarity => ''{L,UR}''', $w$snapshot_rarity in ('L', 'UR')$w$),
      (format(', p_tag_id => %L', pg_temp.tag('alpha')), format('id in (select user_card_id from public.user_card_tags where tag_id = %L)', pg_temp.tag('alpha'))),
      (', p_untagged => true', 'id not in (select user_card_id from public.user_card_tags)'),
      (format(', p_wishlisted_by => %L, p_rarity => ''{R,L}''', u), format('card_id in (%L, %L) and snapshot_rarity in (''R'', ''L'')', pg_temp.card(1), pg_temp.card(5))))
      v (args, cond) loop
    execute format('select wm.my_collection_stats(%L%s)', u, f.args) into s;
    execute format($q$select jsonb_build_object('total', sum(c), 'rarities', jsonb_agg(jsonb_build_object('rarity', r, 'key', r, 'name', n,
        'count', c, 'total', c, 'value', c) order by o))
      from (select r, n, o, (select count(*) from public.user_cards where user_id = $1 and snapshot_rarity = r::public.rarity and %s) c
            from unnest(array['L', 'UR', 'SR', 'R', 'PC', 'C'], array['Légendaire', 'Ultra rare', 'Super rare', 'Rare', 'Peu commune', 'Commune'])
              with ordinality x (r, n, o)) y$q$, f.cond) into want using u;
    assert s = want, f.args || ' : ' || s::text || ' ≠ ' || want::text;
    execute format('select wm.my_collection(%L%s) -> ''total''', u, f.args) into want;
    assert s -> 'total' = want, f.args || ' : total de la collection ' || want::text;
  end loop;
  assert wm.my_collection_stats(u) -> 'total' = '120', 'total des stats';
end $$;

-- profile_collection : pseudo inconnu → 404, privé d'un autre → 403, le sien privé → OK ; pseudo sans casse, items réduits, rarityCounts en cartes uniques.
do $$ declare u uuid := pg_temp.uid('Coll1'); v uuid := pg_temp.uid('Coll2'); w uuid := pg_temp.uid('Coll3'); r jsonb; d jsonb; begin
  d := pg_temp.err(format('select wm.profile_collection(%L, %L)', u, 'Personne'));
  assert d = '{"status":404,"error":"Joueur introuvable","message":"Joueur introuvable"}'::jsonb, coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.profile_collection(%L, %L)', u, 'Coll3'));
  assert d = '{"status":403,"code":"FORBIDDEN","error":"Ce profil est privé","message":"Ce profil est privé"}'::jsonb, coalesce(d::text, 'accepté');
  assert wm.profile_collection(w, 'coll3') -> 'total' = '2', 'son propre profil privé';
  r := wm.profile_collection(v, 'COLL1', 0, null, true);
  assert r ?& array['collection', 'total', 'rarityCounts'] and r -> 'total' = '120'
    and r -> 'rarityCounts' = '{"C":10,"PC":10,"R":10,"SR":10,"UR":10,"L":10}', r - 'collection';
  assert pg_temp.ids(r) = pg_temp.ids(wm.my_collection(u)), 'ordre du profil';
  assert (select count(*) from jsonb_array_elements(r -> 'collection') e join public.user_cards uc on uc.id = (e ->> 'id')::uuid
    where e - 'card' = jsonb_build_object('id', uc.id, 'count', uc.count, 'is_shiny', uc.is_shiny, 'snapshot_rarity', uc.snapshot_rarity)
      and e -> 'card' ->> 'id' = uc.card_id::text) = 50, 'items du profil : ' || (r -> 'collection' -> 0)::text;
  assert not (wm.profile_collection(v, 'Coll1') ? 'rarityCounts') and jsonb_array_length(wm.profile_collection(v, 'Coll1', 2) -> 'collection') = 20,
    'sans stats, page 2';
  assert wm.profile_collection(v, 'Coll1', 0, 'zoologie') -> 'total' = '2', 'q du profil';
end $$;

-- Triggers : insertion (grant_copy), count, cession (user_id), rareté et brillance, suppression, compte supprimé → invariants vides ;
-- starred seul ne réécrit pas les compteurs ; un écart est signalé. Tout ça avec une colonne ajoutée aux compteurs (la table peut grandir).
do $$ declare u uuid := pg_temp.uid('Coll1'); v uuid := pg_temp.uid('Coll2'); c uuid := pg_temp.card(7); k text; d jsonb; begin
  perform pg_temp.inv('insertion en masse');
  alter table wm.user_rarity_counts add column extra text;
  perform wm.grant_copy(u, c, false);
  perform wm.grant_copy(u, c, true);
  perform pg_temp.inv('grant_copy');
  assert (select rows = 1 and copies = 1 from wm.user_rarity_counts where user_id = u and snapshot_rarity = 'PC' and is_shiny), 'brillante PC';
  update public.user_cards set count = count + 2 where user_id = u and card_id = c;
  perform pg_temp.inv('count');
  update public.user_cards set user_id = v where user_id = u and card_id = c;
  perform pg_temp.inv('cession');
  update public.user_cards set snapshot_rarity = 'L', is_shiny = not is_shiny where user_id = v and card_id = c;
  perform pg_temp.inv('rareté et brillance');
  k := (select string_agg(ctid::text, ',' order by user_id, snapshot_rarity, is_shiny) from wm.user_rarity_counts);
  update public.user_cards set starred = not starred where user_id = u;
  assert k = (select string_agg(ctid::text, ',' order by user_id, snapshot_rarity, is_shiny) from wm.user_rarity_counts), 'starred seul a écrit';
  delete from public.user_cards where user_id = v and card_id = c;
  perform pg_temp.inv('suppression');
  delete from auth.users where id = v;
  assert not exists (select from wm.user_rarity_counts where user_id = v), 'compteurs d''un compte supprimé';
  perform pg_temp.inv('compte supprimé');
  update wm.user_rarity_counts set copies = copies + 1 where user_id = u and snapshot_rarity = 'C' and not is_shiny;
  d := wm.check_invariants();
  assert d = jsonb_build_array(jsonb_build_object('check', 'rarity_counts', 'user_id', u, 'snapshot_rarity', 'C', 'is_shiny', false,
    'rows', 20, 'copies', 21, 'actual_rows', 20, 'actual_copies', 20)), d::text;
end $$;
