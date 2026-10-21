-- Pool de tirage (1500_wm_pool.sql) : swap-with-last (pool_add, pool_remove), tirage pur pick_card, draw_cards, χ² sur le seed du banc.
-- Mini-catalogue créé ici ; le seed n'est chargé qu'à la fin, pour le χ².

-- Exécute p_sql et renvoie le detail JSON de l'erreur P0001 levée (null si aucune) ; l'effet de p_sql n'est annulé que si p_sql lève.
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare d text; begin
  execute p_sql;
  return null;
exception when sqlstate 'P0001' then
  get stacked diagnostics d = pg_exception_detail;
  return d::jsonb;
end $$;

-- Carte du catalogue, hors pool tant que pool_add ne l'y met pas.
create function pg_temp.card(p_title text, p_rarity public.rarity, p_hide boolean default false, p_nsfw boolean default false)
returns uuid language sql as $$
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, category, summary, hide_image, nsfw_image)
  values (p_title, 'https://fr.wikipedia.org/wiki/' || replace(p_title, ' ', '_'), p_rarity, 1000, 2000, 'Essai', 'Résumé', p_hide, p_nsfw)
  returning id
$$;
create function pg_temp.id(p_title text) returns uuid language sql as $$ select id from public.cards where wikipedia_title = p_title $$;
-- Cartes d'une rareté dans l'ordre de seq.
create function pg_temp.ids(p_rarity public.rarity) returns uuid[] language sql as $$
  select coalesce(array_agg(card_id order by seq), '{}') from wm.draw_pool where rarity = p_rarity
$$;
create function pg_temp.state() returns jsonb language sql as $$
  select jsonb_build_object('pool', (select jsonb_agg(jsonb_build_array(rarity, seq, card_id) order by rarity, seq) from wm.draw_pool),
    'stats', (select jsonb_object_agg(rarity, n) from wm.catalog_stats))
$$;
-- Pool dense (M2-10) : par rareté seq = 1..n avec n = catalog_stats.n, card_id uniques, total = taille du pool.
create function pg_temp.dense() returns boolean language sql as $$
  select bool_and(coalesce((select array_agg(seq order by seq) from wm.draw_pool d where d.rarity = r), '{}')
                  = array(select generate_series(1, coalesce((select n from wm.catalog_stats s where s.rarity = r), 0))))
    and (select count(distinct card_id) = count(*) from wm.draw_pool)
    and (select coalesce(sum(n), 0) from wm.catalog_stats) = (select count(*) from wm.draw_pool)
  from unnest(enum_range(null::public.rarity)) r
$$;

-- Densité : 5 C, 3 R, 2 L ; retrait d'une C du milieu (la dernière prend sa place), R passée en L, retrait de la dernière C (seq = n,
-- rien ne bouge), remise de la C retirée en premier (seq n + 1).
do $$ declare c uuid[]; r uuid[]; l uuid[]; x uuid; begin
  c := array(select pg_temp.card('Pool C' || i, 'C') from generate_series(1, 5) i order by i);
  r := array(select pg_temp.card('Pool R' || i, 'R') from generate_series(1, 3) i order by i);
  l := array(select pg_temp.card('Pool L' || i, 'L') from generate_series(1, 2) i order by i);
  foreach x in array c loop perform wm.pool_add(x, 'C'); end loop;
  foreach x in array r loop perform wm.pool_add(x, 'R'); end loop;
  foreach x in array l loop perform wm.pool_add(x, 'L'); end loop;
  assert pg_temp.ids('C') = c and pg_temp.ids('R') = r and pg_temp.ids('L') = l and pg_temp.dense(), pg_temp.state()::text;
  assert wm.pool_remove(c[3]), 'retrait refusé';
  assert pg_temp.ids('C') = array[c[1], c[2], c[5], c[4]] and pg_temp.dense(), pg_temp.state()::text;
  perform wm.pool_add(r[2], 'L');
  assert pg_temp.ids('R') = array[r[1], r[3]] and pg_temp.ids('L') = l || r[2] and pg_temp.dense(), pg_temp.state()::text;
  assert wm.pool_remove(c[4]), 'retrait refusé';
  assert pg_temp.ids('C') = array[c[1], c[2], c[5]] and pg_temp.dense(), pg_temp.state()::text;
  perform wm.pool_add(c[3], 'C');
  assert pg_temp.ids('C') = array[c[1], c[2], c[5], c[3]] and pg_temp.dense()
    and (select jsonb_object_agg(rarity, n) from wm.catalog_stats) = '{"C":4,"R":2,"L":3}'::jsonb, pg_temp.state()::text;
end $$;

-- Plus aucune L : stats L = 0, pick_card et draw_cards n'en tirent pas (503), le catalogue en compte 0 ; une L remise reprend seq 1.
do $$ declare u uuid := tests.make_user('Pool1'); x uuid; d jsonb; begin
  foreach x in array pg_temp.ids('L') loop assert wm.pool_remove(x), 'retrait refusé'; end loop;
  assert (select n from wm.catalog_stats where rarity = 'L') = 0 and pg_temp.ids('L') = '{}' and pg_temp.dense(), pg_temp.state()::text;
  assert wm.pick_card('{"L":1}') is null, 'L tirée d''un pool sans L';
  assert wm.cards_page(null) -> 'rarityCounts' -> 'L' = '0', (wm.cards_page(null) - 'cards')::text;
  update wm.config set value = '{"free":{"L":1},"pro":null}' where key = 'draw_weights';
  d := pg_temp.err(format('select wm.draw_cards(%L, 1)', u));
  assert d = '{"status":503,"code":"catalog_empty","error":"Catalogue indisponible, réessaie dans un instant.","message":"Catalogue indisponible, réessaie dans un instant."}'::jsonb, coalesce(d::text, 'accepté');
  update wm.config set value = '{"free":null,"pro":null}' where key = 'draw_weights';
  perform wm.pool_add(pg_temp.id('Pool L2'), 'L');
  assert pg_temp.ids('L') = array[pg_temp.id('Pool L2')] and pg_temp.dense(), pg_temp.state()::text;
end $$;

-- Carte absente → false, rien ne bouge ; pool_add répété → une seule ligne, rien ne bouge au second appel.
do $$ declare s jsonb := pg_temp.state(); x uuid := pg_temp.card('Pool absente', 'C'); begin
  assert not wm.pool_remove(x) and not wm.pool_remove(gen_random_uuid()) and pg_temp.state() = s, pg_temp.state()::text;
  perform wm.pool_add(x, 'C');
  s := pg_temp.state();
  perform wm.pool_add(x, 'C');
  assert pg_temp.state() = s and (select count(*) from wm.draw_pool where card_id = x) = 1 and pg_temp.dense(), pg_temp.state()::text;
end $$;

-- pick_card : une carte du pool, de la rareté pondérée ; toutes raretés exclues → null.
do $$ declare x uuid := wm.pick_card(null); begin
  assert exists (select from wm.draw_pool where card_id = x), coalesce(x::text, 'null');
  x := wm.pick_card('{"R":1}');
  assert (select rarity from wm.draw_pool where card_id = x) = 'R', coalesce(x::text, 'null');
  assert wm.pick_card(null, '{C,PC,R,SR,UR,L}') is null, 'tirage malgré toutes les raretés exclues';
end $$;

-- Image masquée ou sensible : la carte reste tirable (seul l'affichage la traite).
do $$ declare h uuid := pg_temp.card('Pool masquée', 'C', true, false); s uuid := pg_temp.card('Pool sensible', 'R', false, true); x uuid; begin
  foreach x in array array(select card_id from wm.draw_pool) loop perform wm.pool_remove(x); end loop;
  perform wm.pool_add(h, 'C');
  perform wm.pool_add(s, 'R');
  assert (select count(*) from wm.draw_pool) = 2 and pg_temp.dense(), pg_temp.state()::text;
  assert wm.pick_card('{"C":1}') = h and wm.pick_card('{"R":1}') = s, 'carte masquée ou sensible écartée du tirage';
end $$;

-- χ² (M2-11) sur le pool du banc seul (cartes de ce fichier retirées), graine fixe : une lecture de la vue = 100 000 tirages.
delete from wm.draw_pool;
delete from public.cards;
\ir ../seed.sql
select setseed(0.42);
\ir chi2.sql
do $$ declare r record; begin
  select * into r from chi2;
  assert r.chi2_rarity < 20.515 and r.df_rarity = 5, format('rareté : χ² = %s, %s ddl, %s tirages', r.chi2_rarity, r.df_rarity, r.draws);
  assert r.chi2_seq < 43.82 and r.df_seq = 19, format('seq : χ² = %s, %s ddl, %s tirages', r.chi2_seq, r.df_seq, r.draws);
end $$;
