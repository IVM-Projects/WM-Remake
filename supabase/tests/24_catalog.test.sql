-- Catalogue (1400_wm_catalog.sql) : index de recherche, pages arithmétiques sur draw_pool, recherche par préfixe et trigramme,
-- liste de souhaits, « pas encore à moi », overlay joueur. Catalogue de 130 cartes créé ici (le seed n'est pas chargé).

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
create function pg_temp.card(i int) returns uuid language sql as $$ select id from public.cards where wikipedia_url = 'https://fr.wikipedia.org/wiki/Cat_' || i $$;
create function pg_temp.uuids(j jsonb) returns uuid[] language sql as $$
  select coalesce(array_agg(x::uuid order by o), '{}') from jsonb_array_elements_text(j) with ordinality e (x, o)
$$;
create function pg_temp.ids(r jsonb) returns uuid[] language sql as $$
  select coalesce(array_agg((x ->> 'id')::uuid order by o), '{}') from jsonb_array_elements(r -> 'cards') with ordinality e (x, o)
$$;
-- Pages 0 à n − 1 bout à bout.
create function pg_temp.pages(p_uid uuid, n int, p_q text default null, p_rarity public.rarity[] default null, p_wishlist boolean default false,
  p_missing boolean default false) returns uuid[] language sql as $$
  select coalesce(array_agg(x order by p, o), '{}')
  from generate_series(0, n - 1) p, unnest(pg_temp.ids(wm.cards_page(p_uid, p, p_q, p_rarity, p_wishlist, p_missing))) with ordinality u (x, o)
$$;
-- Ordre du catalogue dans tous les modes (D§7.4) : rareté desc, seq du pool (carte hors pool en dernier), id.
create function pg_temp.sorted(p_where text) returns uuid[] language plpgsql as $$
declare a uuid[]; begin
  execute format('select coalesce(array_agg(c.id order by c.rarity desc, d.seq nulls last, c.id), ''{}'') from public.cards c
    left join wm.draw_pool d on d.card_id = c.id where %s', p_where) into a;
  return a;
end $$;

-- Index du D§9.4 sur public.cards ; search_path vide : indexdef qualifie alors extensions.gin_trgm_ops quel que soit le chemin (Supabase).
do $$ declare sp text := current_setting('search_path'); begin
  perform set_config('search_path', '', true);
  assert exists (select from pg_indexes where schemaname = 'public' and indexname = 'cards_title_prefix_idx'
    and indexdef like '%ON public.cards USING btree (lower(wikipedia_title) text_pattern_ops)'), 'index préfixe absent';
  assert exists (select from pg_indexes where schemaname = 'public' and indexname = 'cards_search_trgm_idx'
    and indexdef like '%ON public.cards USING gin (wm_index.search_text(wikipedia_title, category) extensions.gin_trgm_ops)'), 'index trigramme absent';
  perform set_config('search_path', sp, true);
end $$;

-- 130 cartes : L 1-3, UR 4-58, SR 59-65, R 66-85, PC 86-90, C 91-130 ; catégorie « Géographie humaine » pour 61-120 (60 cartes).
-- Cat1 possède 1 à 10 et 100 (deux copies de la 1) et souhaite 1, 70, 100, 120 ; Cat2 possède 11 et souhaite 12.
do $$ declare u uuid := tests.make_user('Cat1'); v uuid := tests.make_user('Cat2'); begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, q_score, category, summary, image_url, pageviews_refreshed_at)
  select case i when 1 then 'Électricité statique' when 2 then 'Zoologie' when 3 then 'Le zoo de Vincennes' else format('Carte %s', lpad(i::text, 3, '0')) end,
    'https://fr.wikipedia.org/wiki/Cat_' || i,
    (case when i <= 3 then 'L' when i <= 58 then 'UR' when i <= 65 then 'SR' when i <= 85 then 'R' when i <= 90 then 'PC' else 'C' end)::public.rarity,
    i, 2 * i, i / 4.0, case when i between 61 and 120 then 'Géographie humaine' else 'Divers' end, 'Résumé ' || i,
    case when i % 2 = 0 then 'https://upload.wikimedia.org/' || i || '.jpg' end, now() - make_interval(days => i)
  from generate_series(1, 130) i;
  assert wm.rebuild_draw_pool() = 130;
  insert into public.user_cards (user_id, card_id, is_shiny, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
  select x.o, c.id, x.shiny, c.wikipedia_title, c.rarity, c.category, c.atk, c.def
  from (select u, i, false from generate_series(1, 10) i union all values (u, 100, false), (u, 1, true), (v, 11, false)) x (o, i, shiny)
  join public.cards c on c.id = pg_temp.card(x.i);
  insert into public.wishlist_items (user_id, card_id) select u, pg_temp.card(i) from unnest(array[1, 70, 100, 120]) i;
  insert into public.wishlist_items (user_id, card_id) values (v, pg_temp.card(12));
end $$;

-- Sans recherche, page 0 : 50 cartes dans l'ordre L, UR, SR, R, PC, C puis seq ; total = N, rarityCounts = catalog_stats ; Card = rest/v1/cards.
do $$ declare r jsonb := wm.cards_page(pg_temp.uid('Cat1')); want uuid[] := array(select card_id from wm.draw_pool order by rarity desc, seq); begin
  assert r ?& array['cards', 'total', 'rarityCounts', 'ownedCardIds', 'wishlistCardIds', 'friendOwners'] and not r ? 'searchHasMore'
    and r -> 'friendOwners' = '{}', r - 'cards';
  assert r -> 'total' = '130' and r -> 'rarityCounts' = (select jsonb_object_agg(rarity, n) from wm.catalog_stats)
    and r -> 'rarityCounts' = '{"L":3,"UR":55,"SR":7,"R":20,"PC":5,"C":40}', r - 'cards';
  assert pg_temp.ids(r) = want[1:50], 'page 0 : ' || pg_temp.ids(r)::text;
  assert (select count(*) from jsonb_array_elements(r -> 'cards') e join public.cards c on c.id = (e ->> 'id')::uuid
    where e = jsonb_build_object('id', c.id, 'atk', c.atk, 'def', c.def, 'lang', c.lang, 'rarity', c.rarity, 'q_score', c.q_score,
      'category', c.category, 'image_url', c.image_url, 'pageviews', c.pageviews, 'hide_image', c.hide_image, 'nsfw_image', c.nsfw_image,
      'wikipedia_url', c.wikipedia_url, 'wikipedia_title', c.wikipedia_title, 'summary', c.summary,
      'pageviews_refreshed_at', c.pageviews_refreshed_at, 'qscore_refreshed_at', c.qscore_refreshed_at)) = 50, 'forme des cartes';
end $$;

-- Pages bout à bout : chaque carte une fois, dans l'ordre du pool ; la page 1 enchaîne UR, SR, R, PC et C sans trou ni doublon.
do $$ declare u uuid := pg_temp.uid('Cat1'); a uuid[] := pg_temp.pages(pg_temp.uid('Cat1'), 3); begin
  assert a = array(select card_id from wm.draw_pool order by rarity desc, seq) and (select count(distinct x) from unnest(a) x) = 130, a::text;
  assert (select string_agg(r, ',' order by f) from (select c.rarity::text r, min(o) f from unnest(a) with ordinality x (id, o)
    join public.cards c on c.id = x.id group by 1) y) = 'L,UR,SR,R,PC,C', 'ordre des raretés';
  assert (select string_agg(distinct e ->> 'rarity', ',' order by e ->> 'rarity') from jsonb_array_elements(wm.cards_page(u, 1) -> 'cards') e) = 'C,PC,R,SR,UR',
    'page 1 à cheval';
  assert wm.cards_page(u, 3) -> 'cards' = '[]' and wm.cards_page(u, 3) -> 'total' = '130', 'page 3';
  assert pg_temp.ids(wm.cards_page(u, -1)) = a[1:50] and pg_temp.ids(wm.cards_page(u, null)) = a[1:50], 'page négative ou nulle';
  assert wm.cards_page(u, 2147483647) -> 'cards' = '[]', 'page énorme';
end $$;

-- Filtre de rareté : même arithmétique, total = somme des raretés choisies ; rarityCounts reste la taille du pool ; '{}' = toutes.
do $$ declare u uuid := pg_temp.uid('Cat1'); r jsonb := wm.cards_page(pg_temp.uid('Cat1'), p_rarity => '{UR,C}'); begin
  assert pg_temp.pages(u, 3, p_rarity => '{C,UR}') = array(select card_id from wm.draw_pool where rarity in ('UR', 'C') order by rarity desc, seq),
    'pages UR + C';
  assert jsonb_array_length(wm.cards_page(u, 1, p_rarity => '{UR,C}') -> 'cards') = 45, 'page 1 UR + C';
  assert r -> 'total' = '95' and r -> 'rarityCounts' = (select jsonb_object_agg(rarity, n) from wm.catalog_stats), r - 'cards';
  assert wm.cards_page(u, p_rarity => '{}') = wm.cards_page(u), 'rareté vide';
end $$;

-- Recherche : 1 caractère → 400 ; 2 → préfixe du titre ; 3 et plus → titre et catégorie sans accents ni casse ; total null, rarityCounts absent.
do $$ declare u uuid := pg_temp.uid('Cat1'); r jsonb; d jsonb; q text; begin
  foreach q in array array['a', ' é '] loop
    d := pg_temp.err(format('select wm.cards_page(null, p_q => %L)', q));
    assert d = '{"status":400,"code":"invalid_request","error":"La recherche demande au moins 2 caractères",
      "message":"La recherche demande au moins 2 caractères"}'::jsonb, coalesce(d::text, 'accepté : ' || q);
  end loop;
  assert wm.cards_page(u, p_q => '   ') = wm.cards_page(u), 'q blanc = sans recherche';
  r := wm.cards_page(u, p_q => 'ZO');
  assert pg_temp.ids(r) = array[pg_temp.card(2)], 'préfixe : ' || r::text;
  assert r -> 'total' = 'null' and not r ? 'rarityCounts' and r -> 'searchHasMore' = 'false', r - 'cards';
  assert pg_temp.ids(wm.cards_page(u, p_q => 'ÉL')) = array[pg_temp.card(1)], 'préfixe accentué';
  assert pg_temp.ids(wm.cards_page(u, p_q => 'gé')) = '{}', 'préfixe sur la catégorie';
  assert pg_temp.ids(wm.cards_page(u, p_q => ' ZOO ')) = pg_temp.sorted(format('c.id in (%L, %L)', pg_temp.card(2), pg_temp.card(3))),
    'trigramme dans le titre';
  assert pg_temp.ids(wm.cards_page(u, p_q => 'ELECTRICITE')) = array[pg_temp.card(1)]
    and pg_temp.ids(wm.cards_page(u, p_q => 'électricité statique')) = array[pg_temp.card(1)], 'sans accents ni casse';
  r := wm.cards_page(u, p_q => 'GÉOGRAPHIE');
  assert jsonb_array_length(r -> 'cards') = 50 and r -> 'searchHasMore' = 'true' and r -> 'total' = 'null' and not r ? 'rarityCounts', r - 'cards';
  r := wm.cards_page(u, 1, 'geographie');
  assert jsonb_array_length(r -> 'cards') = 10 and r -> 'searchHasMore' = 'false', r - 'cards';
  assert pg_temp.pages(u, 2, 'geographie') = pg_temp.sorted($w$category = 'Géographie humaine'$w$), 'catégorie, ordre rareté desc puis seq';
  assert pg_temp.pages(u, 1, 'geographie', '{C,PC}') = pg_temp.sorted($w$category = 'Géographie humaine' and c.rarity in ('C', 'PC')$w$)
    and cardinality(pg_temp.sorted($w$category = 'Géographie humaine' and c.rarity in ('C', 'PC')$w$)) = 35, 'recherche et rareté';
  assert pg_temp.pages(u, 3, 'carte') = pg_temp.sorted($w$wikipedia_title like 'Carte %'$w$), 'recherche sur trois pages';
  assert wm.cards_page(u, p_q => '__') -> 'cards' = '[]' and wm.cards_page(u, p_q => '%%%') -> 'cards' = '[]'
    and wm.cards_page(u, p_q => 'zo%') -> 'cards' = '[]', 'jokers LIKE pris à la lettre';
end $$;

-- Liste de souhaits : seulement la mienne, total = sa taille ; avec une recherche, total null.
do $$ declare u uuid := pg_temp.uid('Cat1'); r jsonb := wm.cards_page(pg_temp.uid('Cat1'), p_wishlist => true);
    want uuid[] := pg_temp.sorted(format('id in (select card_id from public.wishlist_items where user_id = %L)', pg_temp.uid('Cat1'))); begin
  assert cardinality(want) = 4 and pg_temp.ids(r) = want and r -> 'total' = '4' and not r ? 'searchHasMore', r::text;
  assert pg_temp.uuids(r -> 'wishlistCardIds') = want, 'wishlistCardIds';
  r := wm.cards_page(u, p_rarity => '{C}', p_wishlist => true);
  assert pg_temp.ids(r) = pg_temp.sorted(format('c.id in (%L, %L)', pg_temp.card(100), pg_temp.card(120))) and r -> 'total' = '2', r::text;
  r := wm.cards_page(u, p_q => 'carte', p_wishlist => true);
  assert pg_temp.ids(r) = pg_temp.sorted(format('id in (%L, %L, %L)', pg_temp.card(70), pg_temp.card(100), pg_temp.card(120)))
    and r -> 'total' = 'null' and r -> 'searchHasMore' = 'false', r::text;
  assert wm.cards_page(null, p_wishlist => true) -> 'cards' = '[]', 'sans joueur';
end $$;

-- « Pas encore à moi » : les cartes sans copie à moi (celle de Cat2 en fait partie), total null, searchHasMore présent.
do $$ declare u uuid := pg_temp.uid('Cat1'); r jsonb := wm.cards_page(pg_temp.uid('Cat1'), p_missing => true);
    a uuid[] := pg_temp.pages(pg_temp.uid('Cat1'), 3, p_missing => true); begin
  assert cardinality(a) = 119 and pg_temp.card(11) = any (a)
    and a = pg_temp.sorted(format('not exists (select from public.user_cards uc where uc.user_id = %L and uc.card_id = c.id)', u)), a::text;
  assert r -> 'total' = 'null' and r -> 'searchHasMore' = 'true' and not r ? 'rarityCounts' and r -> 'ownedCardIds' = '[]', r - 'cards';
  r := wm.cards_page(u, 2, p_missing => true);
  assert jsonb_array_length(r -> 'cards') = 19 and r -> 'searchHasMore' = 'false', r - 'cards';
  assert pg_temp.ids(wm.cards_page(u, p_q => 'zoo', p_missing => true)) = '{}', 'recherche parmi les manquantes';
end $$;

-- Overlay : ownedCardIds et wishlistCardIds = cartes de la page renvoyée, dans son ordre, une fois chacune, à moi seulement.
do $$ declare u uuid := pg_temp.uid('Cat1'); r jsonb; owned uuid[] := '{}'; wished uuid[] := '{}'; begin
  for p in 0 .. 2 loop
    r := wm.cards_page(u, p);
    assert pg_temp.uuids(r -> 'ownedCardIds') = array(select x from unnest(pg_temp.ids(r)) with ordinality t (x, o)
      where exists (select from public.user_cards where user_id = u and card_id = x) order by o), 'possédées, page ' || p;
    assert pg_temp.uuids(r -> 'wishlistCardIds') = array(select x from unnest(pg_temp.ids(r)) with ordinality t (x, o)
      where exists (select from public.wishlist_items where user_id = u and card_id = x) order by o), 'souhaitées, page ' || p;
    owned := owned || pg_temp.uuids(r -> 'ownedCardIds');
    wished := wished || pg_temp.uuids(r -> 'wishlistCardIds');
  end loop;
  assert cardinality(owned) = 11 and (select count(distinct x) from unnest(owned) x) = 11 and not pg_temp.card(11) = any (owned), owned::text;
  assert cardinality(wished) = 4 and not pg_temp.card(12) = any (wished), wished::text;
  assert pg_temp.uuids(wm.cards_page(u, p_q => 'zoo') -> 'ownedCardIds') = pg_temp.sorted(format('c.id in (%L, %L)', pg_temp.card(2), pg_temp.card(3))),
    'overlay de recherche';
  assert wm.cards_page(null) -> 'ownedCardIds' = '[]' and wm.cards_page(null) -> 'wishlistCardIds' = '[]', 'sans joueur';
end $$;

-- Option A : un rôle sans autre droit que ceux de la table écrit public.cards (l'index évalue wm_index.search_text, exécutable par tous).
-- La carte, hors pool, sort en fin de rareté ; une recherche sans lettre ni chiffre rend une page vide, même si un titre contient « !!! ».
do $$ declare r jsonb; q text; begin
  create role tests_cards_writer nologin bypassrls;
  grant select, insert, update on public.cards to tests_cards_writer;
  set local role tests_cards_writer;
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, category)
  values ('Tardive !!! - -', 'https://fr.wikipedia.org/wiki/Cat_131', 'L', 1, 1, 'Divers');
  update public.cards set category = 'Géographie tardive' where wikipedia_url = 'https://fr.wikipedia.org/wiki/Cat_131';
  reset role;
  assert pg_temp.ids(wm.cards_page(null, p_q => 'GEOGRAPHIE TARDIVE')) = array[pg_temp.card(131)], 'carte écrite par le rôle de table';
  r := wm.cards_page(null, p_q => 'géographie', p_rarity => '{L}');
  assert pg_temp.ids(r) = array[pg_temp.card(131)] and not exists (select from wm.draw_pool where card_id = pg_temp.card(131)), r::text;
  assert pg_temp.ids(wm.cards_page(null, p_rarity => '{L}', p_missing => true))
    = array(select card_id from wm.draw_pool where rarity = 'L' order by seq) || pg_temp.card(131), 'hors pool en dernier';
  foreach q in array array['!!!', '- -', '!!! - -'] loop
    r := wm.cards_page(null, p_q => q);
    assert r -> 'cards' = '[]' and r -> 'total' = 'null' and r -> 'searchHasMore' = 'false' and not r ? 'rarityCounts', q || ' : ' || r::text;
  end loop;
end $$;
