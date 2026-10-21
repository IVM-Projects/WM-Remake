-- Fusion du catalogue (1510_wm_catalog_merge.sql) : stage, correspondance par page_id puis par titre, liste blanche, gels, drapeau image,
-- renommage et titre repris, carte possédée, retraits, lots, finalisation. Mini-catalogue créé ici (le seed n'est pas chargé).

-- Exécute p_sql et renvoie le detail JSON de l'erreur P0001 levée (null si aucune) ; l'effet de p_sql n'est annulé que si p_sql lève.
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare d text; begin
  execute p_sql;
  return null;
exception when sqlstate 'P0001' then
  get stacked diagnostics d = pg_exception_detail;
  return d::jsonb;
end $$;

-- Premier chargement : pages 1 à 6, une par rareté, médias sur les pages 1 à 3.
create function pg_temp.base() returns void language sql as $$
  insert into wm.catalog_stage (page_id, wikipedia_title, wikipedia_url, lang, rarity, atk, def, q_score, pageviews,
    pageviews_refreshed_at, qscore_refreshed_at, category, summary, image_url)
  select i, 'Fusion ' || r, 'https://fr.wikipedia.org/wiki/Fusion_' || r, 'fr', r::public.rarity, 100 * i, 50 * i, 10.5 * i, 1000 * i,
    '2026-10-01', '2026-10-02', 'Catégorie ' || r, 'Résumé ' || r, case when i <= 3 then format('https://upload.wikimedia.org/%s.jpg', i) end
  from unnest('{L,UR,SR,R,PC,C}'::text[]) with ordinality u (r, i);
  insert into wm.catalog_stage_media (page_id, file, author, license, license_url)
  select i, format('Fusion_%s.jpg', i), 'Auteur ' || i, 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0'
  from generate_series(1, 3) i;
$$;
-- Stage = catalogue lié tel quel (cartes et médias), donc un passage sans changement ; chaque test y modifie ses lignes.
create function pg_temp.restage() returns void language sql as $$
  insert into wm.catalog_stage (page_id, wikipedia_title, wikipedia_url, lang, rarity, atk, def, q_score, pageviews,
    pageviews_refreshed_at, qscore_refreshed_at, category, summary, image_url)
  select x.page_id, c.wikipedia_title, c.wikipedia_url, c.lang, c.rarity, c.atk, c.def, c.q_score, c.pageviews,
    c.pageviews_refreshed_at, c.qscore_refreshed_at, c.category, c.summary, c.image_url
  from wm.card_source x join public.cards c on c.id = x.card_id;
  insert into wm.catalog_stage_media (page_id, file, author, license, license_url)
  select x.page_id, m.file, m.author, m.license, m.license_url from wm.card_source x join wm.card_media m on m.card_id = x.card_id;
$$;
create function pg_temp.card(p_page bigint) returns uuid language sql as $$ select card_id from wm.card_source where page_id = p_page $$;
create function pg_temp.result(p_page bigint) returns text language sql as $$ select result from wm.catalog_stage_result where page_id = p_page $$;
create function pg_temp.ids() returns uuid[] language sql as $$ select array_agg(card_id order by page_id) from wm.card_source $$;
-- Colonnes de cards.csv où la carte diffère encore de sa ligne de stage.
create function pg_temp.diff(p_page bigint) returns text[] language sql as $$
  select array(select k from jsonb_each(to_jsonb(s) - 'page_id') e (k, v) where v is distinct from to_jsonb(c) -> k order by k collate "C")
  from wm.catalog_stage s, public.cards c where s.page_id = p_page and c.id = pg_temp.card(p_page)
$$;
create function pg_temp.media(p_card uuid) returns jsonb language sql as $$ select to_jsonb(m) - 'card_id' from wm.card_media m where card_id = p_card $$;
create function pg_temp.pooled(p_card uuid) returns public.rarity language sql as $$ select rarity from wm.draw_pool where card_id = p_card $$;
-- Empreinte de public.cards, card_media et draw_pool.
create function pg_temp.state() returns text language sql as $$
  select concat_ws(' ', (select md5(string_agg(c::text, ',' order by c.id)) from public.cards c),
    (select md5(string_agg(m::text, ',' order by m.card_id)) from wm.card_media m),
    (select md5(string_agg(d::text, ',' order by d.rarity, d.seq)) from wm.draw_pool d))
$$;
-- Pool dense (M2-10), comme 25_pool : par rareté seq = 1..n avec n = catalog_stats.n, card_id uniques, total = taille du pool.
create function pg_temp.dense() returns boolean language sql as $$
  select bool_and(coalesce((select array_agg(seq order by seq) from wm.draw_pool d where d.rarity = r), '{}')
                  = array(select generate_series(1, coalesce((select n from wm.catalog_stats s where s.rarity = r), 0))))
    and (select count(distinct card_id) = count(*) from wm.draw_pool)
    and (select coalesce(sum(n), 0) from wm.catalog_stats) = (select count(*) from wm.draw_pool)
  from unnest(enum_range(null::public.rarity)) r
$$;

-- Interface du chargement (Task 12) : colonnes des stages = celles des CSV, dans leur ordre ; lots de 10 000 par défaut ; clés de wm.config.
create function pg_temp.cols(p_table regclass) returns text[] language sql as $$
  select array(select attname::text from pg_attribute where attrelid = p_table and attnum > 0 and not attisdropped order by attnum)
$$;
do $$ begin
  assert pg_temp.cols('wm.catalog_stage')
    = '{page_id,wikipedia_title,wikipedia_url,lang,rarity,atk,def,q_score,pageviews,pageviews_refreshed_at,qscore_refreshed_at,category,summary,image_url}';
  assert pg_temp.cols('wm.catalog_stage_media') = '{page_id,file,author,license,license_url}'
    and pg_temp.cols('wm.catalog_stage_result') = '{page_id,result}';
  assert pg_get_function_arguments('wm.catalog_merge'::regproc) = 'p_mode text, p_limit integer DEFAULT 10000';
  assert (select jsonb_object_agg(key, value) from wm.config where key in ('catalog_frozen', 'catalog_stats_frozen', 'sample_rate'))
    = '{"catalog_frozen":false,"catalog_stats_frozen":false,"sample_rate":0.09}';
end $$;

-- Premier passage : 6 cartes, 6 card_source, 3 card_media, une carte par rareté au pool, sans réécrire le stage (son tas doublerait) ;
-- finalize compte 6 insertions, l'écrit dans catalog_runs et vide le stage.
do $$ declare m jsonb; f jsonb; w bigint; begin
  perform pg_temp.base();
  w := pg_stat_get_xact_tuples_updated('wm.catalog_stage'::regclass);
  m := wm.catalog_merge('sample');
  assert m = '{"processed":6,"frozen":false}', m::text;
  assert pg_stat_get_xact_tuples_updated('wm.catalog_stage'::regclass) = w, 'stage réécrit';
  assert (select count(*) from public.cards) = 6 and (select count(*) from wm.card_source) = 6 and (select count(*) from wm.card_media) = 3,
    'cartes, sources ou médias manquants';
  assert (select bool_and(pg_temp.diff(page_id) = '{}' and pg_temp.result(page_id) = 'inserted') from wm.catalog_stage), 'carte insérée différente du stage';
  assert (select bool_and(pg_temp.media(pg_temp.card(page_id)) = to_jsonb(s) - 'page_id') from wm.catalog_stage_media s), 'média différent';
  assert (select jsonb_object_agg(rarity, n) from wm.catalog_stats) = '{"L":1,"UR":1,"SR":1,"R":1,"PC":1,"C":1}'
    and not exists (select from public.cards c where pg_temp.pooled(c.id) is distinct from c.rarity) and pg_temp.dense(), 'pool';
  f := wm.catalog_finalize('sample');
  assert f = '{"mode":"sample","staged":6,"inserted":6,"updated":0,"unchanged":0,"renamed":0,"conflicts":0,"pool_out":0,
               "pool":{"L":1,"UR":1,"SR":1,"R":1,"PC":1,"C":1}}', f::text;
  assert not exists (select from wm.catalog_stage) and not exists (select from wm.catalog_stage_media)
    and not exists (select from wm.catalog_stage_result), 'stage non vidé';
  assert (select jsonb_agg(jsonb_build_array(mode, summary)) from wm.catalog_runs) = jsonb_build_array(jsonb_build_array('sample', f)), 'catalog_runs';
end $$;

-- Idempotence (M2-9) : le même stage rechargé → 6 unchanged, mêmes ids, même état.
do $$ declare i uuid[] := pg_temp.ids(); s text := pg_temp.state(); f jsonb; begin
  perform pg_temp.base();
  assert wm.catalog_merge('sample') = '{"processed":6,"frozen":false}';
  f := wm.catalog_finalize('sample');
  assert f - 'pool' = '{"mode":"sample","staged":6,"inserted":0,"updated":0,"unchanged":6,"renamed":0,"conflicts":0,"pool_out":0}', f::text;
  assert pg_temp.ids() = i and pg_temp.state() = s, 'second passage différent';
end $$;

-- Liste blanche (D§6.3) : titre, URL et langue du stage ignorés (renommage compté), drapeaux image d'une autre carte gardés ;
-- toutes les colonnes de la liste blanche suivent le stage.
do $$ declare k text; f jsonb; begin
  update public.cards set hide_image = true, nsfw_image = true where id = pg_temp.card(2);
  k := (select md5(string_agg((id, wikipedia_title, wikipedia_url, lang, hide_image, nsfw_image, created_at)::text, ',' order by id)) from public.cards);
  perform pg_temp.restage();
  update wm.catalog_stage set wikipedia_title = 'Fusion L renommée', wikipedia_url = 'https://fr.wikipedia.org/wiki/Autre', lang = 'en',
    rarity = 'UR', atk = 1, def = 2, q_score = 3, pageviews = 4, pageviews_refreshed_at = '2026-10-15', qscore_refreshed_at = '2026-10-16',
    category = 'Autre catégorie', summary = 'Autre résumé', image_url = 'https://upload.wikimedia.org/autre.jpg' where page_id = 1;
  perform wm.catalog_merge('sample');
  assert (select md5(string_agg((id, wikipedia_title, wikipedia_url, lang, hide_image, nsfw_image, created_at)::text, ',' order by id))
          from public.cards) = k, 'colonne hors liste blanche modifiée';
  assert pg_temp.diff(1) = '{lang,wikipedia_title,wikipedia_url}', pg_temp.diff(1)::text;
  assert pg_temp.result(1) = 'renamed' and pg_temp.pooled(pg_temp.card(1)) = 'UR' and pg_temp.dense(), pg_temp.result(1);
  f := wm.catalog_finalize('sample');
  assert f ->> 'renamed' = '1' and f ->> 'unchanged' = '5' and f ->> 'updated' = '0', f::text;
end $$;

-- catalog_stats_frozen (D§10.1) : atk, def, q_score et qscore_refreshed_at gardés, rareté et vues suivies ; une différence sur les
-- seules colonnes gelées laisse la carte unchanged.
do $$ begin
  update wm.config set value = 'true' where key = 'catalog_stats_frozen';
  perform pg_temp.restage();
  update wm.catalog_stage set atk = 9, def = 9, q_score = 9, qscore_refreshed_at = '2026-10-17', rarity = 'SR', pageviews = 77 where page_id = 4;
  update wm.catalog_stage set atk = 8 where page_id = 5;
  perform wm.catalog_merge('sample');
  assert pg_temp.diff(4) = '{atk,def,q_score,qscore_refreshed_at}' and pg_temp.diff(5) = '{atk}', pg_temp.diff(4)::text;
  assert pg_temp.result(4) = 'updated' and pg_temp.result(5) = 'unchanged', pg_temp.result(5);
  assert pg_temp.pooled(pg_temp.card(4)) = 'SR' and pg_temp.dense(), 'pool';
  perform wm.catalog_finalize('sample');
  update wm.config set value = 'false' where key = 'catalog_stats_frozen';
end $$;

-- Drapeau image (P6) : image_url et card_media d'une carte masquée restent, avec un autre média ou sans média au stage ;
-- ailleurs, un média ajouté ou retiré suit le stage et compte comme mise à jour.
do $$ declare m2 jsonb := pg_temp.media(pg_temp.card(2)); m3 jsonb := pg_temp.media(pg_temp.card(3)); begin
  update public.cards set hide_image = true where id = pg_temp.card(3);
  perform pg_temp.restage();
  update wm.catalog_stage set image_url = 'https://upload.wikimedia.org/autre3.jpg' where page_id = 3;
  update wm.catalog_stage_media set file = 'Autre.jpg', author = 'Autre auteur' where page_id = 3;
  delete from wm.catalog_stage_media where page_id in (1, 2);
  insert into wm.catalog_stage_media (page_id, file, author, license) values (5, 'Fusion_5.jpg', 'Auteur 5', 'CC0');
  perform wm.catalog_merge('sample');
  assert pg_temp.diff(3) = '{image_url}' and pg_temp.media(pg_temp.card(3)) = m3 and pg_temp.media(pg_temp.card(2)) = m2, 'drapeau image ignoré';
  assert pg_temp.media(pg_temp.card(1)) is null
    and pg_temp.media(pg_temp.card(5)) = '{"file":"Fusion_5.jpg","author":"Auteur 5","license":"CC0","license_url":null}', 'médias';
  assert (select array_agg(result order by page_id) from wm.catalog_stage_result) = '{updated,unchanged,unchanged,unchanged,updated,unchanged}',
    (select array_agg(result order by page_id) from wm.catalog_stage_result)::text;
  perform wm.catalog_finalize('sample');
end $$;

-- Média modifié d'une carte sans drapeau image (auteur, licence) : card_media suit le stage, et la carte compte comme mise à jour.
do $$ begin
  perform pg_temp.restage();
  update wm.catalog_stage_media set author = 'Nouvel auteur', license = 'CC BY 4.0' where page_id = 5;
  perform wm.catalog_merge('sample');
  assert pg_temp.media(pg_temp.card(5)) = '{"file":"Fusion_5.jpg","author":"Nouvel auteur","license":"CC BY 4.0","license_url":null}'
    and pg_temp.result(5) = 'updated' and pg_temp.diff(5) = '{}', coalesce(pg_temp.media(pg_temp.card(5))::text, 'aucun média');
  perform wm.catalog_finalize('sample');
end $$;

-- Renommage (M2-20) et titre repris (P7) : la carte de 101 garde son id et le titre « Ancien » (renamed) ; la nouvelle page 202
-- « Ancien » n'a ni carte, ni card_source, ni média (conflict), sans erreur.
do $$ declare c uuid; n bigint; k bigint; f jsonb; begin
  perform pg_temp.restage();
  insert into wm.catalog_stage (page_id, wikipedia_title, wikipedia_url, lang, rarity, atk, def, pageviews)
  values (101, 'Ancien', 'https://fr.wikipedia.org/wiki/Ancien', 'fr', 'C', 1, 1, 1);
  perform wm.catalog_merge('sample');
  perform wm.catalog_finalize('sample');
  c := pg_temp.card(101);
  n := (select count(*) from public.cards);
  k := (select count(*) from wm.card_media);
  perform pg_temp.restage();
  update wm.catalog_stage set wikipedia_title = 'Nouveau', wikipedia_url = 'https://fr.wikipedia.org/wiki/Nouveau' where page_id = 101;
  insert into wm.catalog_stage (page_id, wikipedia_title, wikipedia_url, lang, rarity, atk, def, pageviews)
  values (202, 'Ancien', 'https://fr.wikipedia.org/wiki/Ancien', 'fr', 'R', 2, 2, 2);
  insert into wm.catalog_stage_media (page_id, file) values (202, 'Ancien.jpg');
  assert wm.catalog_merge('sample') = '{"processed":8,"frozen":false}';
  assert pg_temp.card(101) = c and (select wikipedia_title from public.cards where id = c) = 'Ancien' and pg_temp.result(101) = 'renamed', 'renommage';
  assert pg_temp.result(202) = 'conflict' and pg_temp.card(202) is null and (select count(*) from public.cards) = n
    and (select count(*) from wm.card_media) = k, 'titre repris';
  f := wm.catalog_finalize('sample');
  assert f ->> 'staged' = '8' and f ->> 'renamed' = '1' and f ->> 'conflicts' = '1' and f ->> 'unchanged' = '6', f::text;
end $$;

-- Option A (D§10.3.1) : une carte sans card_source de même titre que le stage est reprise (même id) et reçoit son card_source.
do $$ declare o uuid; n bigint; begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
  values ('Orpheline', 'https://fr.wikipedia.org/wiki/Orpheline', 'C', 5, 5) returning id into o;
  n := (select count(*) from public.cards);
  perform pg_temp.restage();
  insert into wm.catalog_stage (page_id, wikipedia_title, wikipedia_url, lang, rarity, atk, def, pageviews)
  values (303, 'Orpheline', 'https://fr.wikipedia.org/wiki/Orpheline', 'fr', 'C', 6, 6, 6);
  perform wm.catalog_merge('sample');
  assert pg_temp.card(303) = o and (select count(*) from public.cards) = n, 'carte orpheline non reprise';
  assert pg_temp.result(303) = 'updated' and pg_temp.diff(303) = '{}' and pg_temp.pooled(o) = 'C' and pg_temp.dense(), pg_temp.result(303);
  perform wm.catalog_finalize('sample');
end $$;

-- Rareté qui change sur une carte possédée : la copie garde sa rareté figée, les compteurs du joueur ne bougent pas,
-- la carte change de rareté au pool, qui reste dense ; invariants intacts.
do $$ declare u uuid := tests.make_user('Fusion1'); x uuid := pg_temp.card(6); k jsonb; begin
  perform wm.grant_copy(u, x, false);
  k := (select jsonb_agg(to_jsonb(r) order by snapshot_rarity, is_shiny) from wm.user_rarity_counts r where user_id = u);
  perform pg_temp.restage();
  update wm.catalog_stage set rarity = 'R' where page_id = 6;
  perform wm.catalog_merge('sample');
  assert (select rarity from public.cards where id = x) = 'R'
    and (select snapshot_rarity from public.user_cards where user_id = u and card_id = x) = 'C', 'rareté de la carte ou de la copie';
  assert k is not null and (select jsonb_agg(to_jsonb(r) order by snapshot_rarity, is_shiny) from wm.user_rarity_counts r where user_id = u) = k,
    'compteurs du joueur modifiés';
  assert pg_temp.pooled(x) = 'R' and pg_temp.dense(), 'pool';
  assert wm.check_invariants() = '[]', wm.check_invariants()::text;
  perform wm.catalog_finalize('sample');
end $$;

-- Retrait du staff (P8) : la carte présente au stage suit la liste blanche mais sort du pool.
do $$ declare x uuid := pg_temp.card(5); begin
  insert into wm.card_removals (card_id, reason) values (x, 'Essai');
  assert pg_temp.pooled(x) is not null;
  perform pg_temp.restage();
  update wm.catalog_stage set pageviews = 55 where page_id = 5;
  perform wm.catalog_merge('sample');
  assert pg_temp.pooled(x) is null and pg_temp.dense() and pg_temp.result(5) = 'updated' and pg_temp.diff(5) = '{}', 'retrait ignoré';
  perform wm.catalog_finalize('sample');
end $$;

-- catalog_frozen (D§10.3.5) : merge et finalize ne font rien et le disent ; le stage reste tel quel.
do $$ declare s text; r bigint := (select count(*) from wm.catalog_runs); begin
  update wm.config set value = 'true' where key = 'catalog_frozen';
  perform pg_temp.restage();
  update wm.catalog_stage set pageviews = pageviews + 1 where true;
  s := pg_temp.state();
  assert wm.catalog_merge('sample') = '{"processed":0,"frozen":true}' and wm.catalog_finalize('sample') = '{"frozen":true}', 'gel ignoré';
  assert pg_temp.state() = s and (select count(*) from wm.catalog_runs) = r
    and exists (select from wm.catalog_stage) and not exists (select from wm.catalog_stage_result), 'gel : quelque chose a changé';
  update wm.config set value = 'false' where key = 'catalog_frozen';
  truncate wm.catalog_stage, wm.catalog_stage_media;
end $$;

-- Lots : 5 lignes par 2 → 2, 2, 1 puis 0, et finalize refuse le stage inachevé (409). finalize sort du pool les cartes absentes
-- du stage et celle sans card_source (seed, M2-12) sans supprimer de carte ; un second finalize trouve le stage vide (409).
do $$ declare g uuid; n bigint; o uuid[]; d jsonb; f jsonb; begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
  values ('Graine', 'https://fr.wikipedia.org/wiki/Graine', 'PC', 1, 1) returning id into g;
  perform wm.pool_add(g, 'PC');
  n := (select count(*) from public.cards);
  o := array[pg_temp.card(101), pg_temp.card(303), g];
  assert (select count(*) from wm.draw_pool where card_id = any (o)) = 3;
  perform pg_temp.restage();
  delete from wm.catalog_stage where page_id not in (1, 2, 3, 4, 6);
  delete from wm.catalog_stage_media where page_id not in (1, 2, 3, 4, 6);
  assert wm.catalog_merge('sample', 2) = '{"processed":2,"frozen":false}' and wm.catalog_merge('sample', 2) = '{"processed":2,"frozen":false}';
  d := pg_temp.err($q$select wm.catalog_finalize('sample')$q$);
  assert d = '{"status":409,"code":"catalog_stage_pending","error":"Chargement inachevé : relancer catalog_merge","message":"Chargement inachevé : relancer catalog_merge"}',
    coalesce(d::text, 'accepté');
  assert wm.catalog_merge('sample', 2) = '{"processed":1,"frozen":false}' and wm.catalog_merge('sample', 2) = '{"processed":0,"frozen":false}';
  f := wm.catalog_finalize('full');
  assert f = '{"mode":"full","staged":5,"inserted":0,"updated":0,"unchanged":5,"renamed":0,"conflicts":0,"pool_out":3,
               "pool":{"L":0,"UR":2,"SR":2,"R":1,"PC":0,"C":0}}', f::text;
  assert (select summary from wm.catalog_runs order by id desc limit 1) = f, 'catalog_runs';
  assert not exists (select from wm.draw_pool where card_id = any (o)) and (select count(*) from public.cards) = n and pg_temp.dense(), 'finalize';
  d := pg_temp.err($q$select wm.catalog_finalize('sample')$q$);
  assert d = '{"status":409,"code":"catalog_stage_empty","error":"Aucun chargement à finaliser","message":"Aucun chargement à finaliser"}',
    coalesce(d::text, 'accepté');
end $$;

-- Mode inconnu ou absent → 400, pour la fusion comme pour la finalisation ; taille de lot absente ou < 1 → 400.
do $$ declare d jsonb := pg_temp.err($q$select wm.catalog_merge('x')$q$); begin
  assert d = '{"status":400,"code":"invalid_request","error":"Mode de chargement inconnu","message":"Mode de chargement inconnu"}',
    coalesce(d::text, 'accepté');
  assert pg_temp.err('select wm.catalog_merge(null)') = d and pg_temp.err($q$select wm.catalog_finalize('x')$q$) = d, 'mode absent accepté';
  d := pg_temp.err($q$select wm.catalog_merge('sample', null)$q$);
  assert d = '{"status":400,"code":"invalid_request","error":"Taille de lot invalide","message":"Taille de lot invalide"}', coalesce(d::text, 'accepté');
  assert pg_temp.err($q$select wm.catalog_merge('sample', 0)$q$) = d and pg_temp.err($q$select wm.catalog_merge('sample', -1)$q$) = d,
    'taille de lot < 1 acceptée';
end $$;
