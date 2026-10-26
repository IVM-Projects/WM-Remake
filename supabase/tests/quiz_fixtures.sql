-- Modèles de quiz sur les cartes réelles (M5a-9), inclus par 19_quiz_fixtures.test.sh, qui charge fx (catalog/fixtures/expected/cards.csv,
-- 299 lignes) et annule tout à la fin. Les messages ne citent que des card_id (aucun texte de banque).

-- Mêmes textes que dans 32_quiz.test.sql.
create function pg_temp.layout_bad(p_b jsonb) returns text language sql as $$
  select string_agg((i - 1)::text, ', ') from jsonb_array_elements(p_b) with ordinality e (q, i),
    lateral (select array_agg(x order by j) o from jsonb_array_elements_text(q -> 'options') with ordinality t (x, j)) t
  where case q ->> 'kind'
    when 'year' then array_to_string(o, ' ') !~ '^[0-9]{4} [0-9]{4} [0-9]{4} [0-9]{4}$'
      or not (o[2]::int - o[1]::int in (1, 2, 5, 10) and o[3]::int - o[2]::int = o[2]::int - o[1]::int
        and o[4]::int - o[3]::int = o[2]::int - o[1]::int and o[4]::int <= extract(year from now()))
    when 'word' then (select max(char_length(x)) - min(char_length(x)) from unnest(o) x) > 3
    when 'sentence' then (select count(*) from unnest(o) x where strpos(x, '…') > 0) not in (0, 4)
    else false end
$$;

create function pg_temp.views_bad(p_b jsonb) returns text language sql as $$
  select string_agg((i - 1)::text, ', ') from jsonb_array_elements(p_b) with ordinality e (q, i),
    lateral (select array_agg(c.pageviews::bigint order by c.pageviews desc) v,
        max(c.pageviews) filter (where t.j - 1 = (q ->> 'correct')::int) ok
      from jsonb_array_elements_text(q -> 'options') with ordinality t (x, j) join public.cards c on c.wikipedia_title = t.x) w
  where q ->> 'kind' = 'views' and not coalesce(cardinality(w.v) = 4 and case when q ->> 'prompt' like '%le plus consulté%'
    then w.ok = w.v[1] and w.v[1] > w.v[2] and 10 * w.v[1] >= 11 * w.v[2]
    else w.ok = w.v[4] and w.v[4] < w.v[3] and 11 * w.v[4] <= 10 * w.v[3] end, false)
$$;

insert into public.cards (wikipedia_title, wikipedia_url, lang, rarity, atk, def, q_score, pageviews, pageviews_refreshed_at,
  qscore_refreshed_at, category, summary, image_url)
select wikipedia_title, wikipedia_url, lang, rarity, atk, def, q_score, pageviews, pageviews_refreshed_at, qscore_refreshed_at, category,
  summary, image_url
from fx;
select wm.rebuild_draw_pool();
select setseed(0.42);
create temp table fq as
select c.id, wm.quiz_norm(concat_ws(' ', c.wikipedia_title, c.category, c.summary)) txt, c.wikipedia_title t, wm.template_quiz(c.id) b
from public.cards c where c.wikipedia_title in (select wikipedia_title from fx) order by c.id;

do $$ declare bad text; begin
  assert (select count(*) from fq) = 299, 'cartes chargées : ' || (select count(*) from fq);
  select string_agg(id::text, ', ') into bad from fq where jsonb_array_length(b) < 3 or wm.quiz_check(b, t) is not null;
  assert bad is null, 'banques invalides : ' || bad;
  -- Aucun distracteur de word, year, sentence ou description dans le texte de la carte.
  select string_agg(distinct id::text, ', ') into bad
  from fq, jsonb_array_elements(b) q, jsonb_array_elements_text(q -> 'options') with ordinality o (x, j)
  where q ->> 'kind' in ('word', 'year', 'sentence', 'description') and j - 1 <> (q ->> 'correct')::int and strpos(txt, wm.quiz_norm(x)) > 0;
  assert bad is null, 'distracteur présent dans le texte de la carte : ' || bad;
  -- description : des pairs sous 0,6 de similarity (C9).
  select string_agg(distinct id::text, ', ') into bad
  from fq, jsonb_array_elements(b) q, jsonb_array_elements_text(q -> 'options') with ordinality o (x, j)
  where q ->> 'kind' = 'description' and j - 1 <> (q ->> 'correct')::int and extensions.similarity(x, q ->> 'evidence') >= 0.6;
  assert bad is null, 'description trop proche : ' || bad;
  select string_agg(id::text, ', ') into bad from fq where pg_temp.layout_bad(b) is not null;
  assert bad is null, 'positions ou longueurs : ' || bad;
  select string_agg(id::text, ', ') into bad from fq where pg_temp.views_bad(b) is not null;
  assert bad is null, 'vues à égalité ou trop proches : ' || bad;
  select string_agg(k, ', ') into bad from unnest('{word,year,sentence,description,views}'::text[]) k
  where not exists (select from fq, jsonb_array_elements(b) q where q ->> 'kind' = k);
  assert bad is null, 'kinds absents : ' || bad;
end $$;

-- Information, sans seuil (stderr : db-test.sh jette stdout, et PGOPTIONS cache les notices).
select count(*) filter (where jsonb_array_length(b) = 6) six, count(*) n from fq \gset
\warn 19_quiz_fixtures : :six cartes à 6 questions sur :n
