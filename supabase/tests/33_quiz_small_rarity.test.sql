-- template_quiz sur les petites raretés (1910_wm_quiz_templates.sql, flake du bloc seed de 32_quiz.test.sql, ses 6 L) : cartes sans texte,
-- donc T5 seul, aux vues à 20 % d'écart. 5 L : 4 pairs, 4 combinaisons, dont une peut être la seule source d'une bonne réponse ; 6 SR
-- dont un titre de 81 caractères : 5 pairs, 4 par question. Avant le correctif (pairs sans remise, T5 rejoué), 13 % (5 L) et 6 % (titre
-- long) des appels levaient XX000. setseed : les pairs viennent de pool_add, dans l'ordre.

create function pg_temp.card(p_title text, p_rarity public.rarity, p_views int) returns uuid language plpgsql as $$
declare c uuid; begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, pageviews, category, summary)
  values (p_title, 'https://fr.wikipedia.org/wiki/' || replace(p_title, ' ', '_'), p_rarity, 1000, 1000, p_views, null, null)
  returning id into c;
  perform wm.pool_add(c, p_rarity);
  return c;
end $$;

select pg_temp.card('Petite ' || i, 'L', round(1000 * 1.2 ^ i)::int) from generate_series(1, 5) i;
select pg_temp.card('Moyenne ' || i, 'SR', round(1000 * 1.2 ^ i)::int) from generate_series(1, 5) i;
select pg_temp.card(left('Titre de quatre-vingt-un caractères pour éprouver le repli des vues sur des pairs SR', 81), 'SR', 5000);

-- 100 appels par carte L et 100 sur le titre long : 600 banques d'au moins 3 questions, toutes views, valides.
select setseed(0.42);
create temp table small_q as select c.wikipedia_title t, wm.template_quiz(c.id) b
from public.cards c, generate_series(1, 100) g where c.rarity = 'L' or char_length(c.wikipedia_title) > 80;
do $$ declare bad text; begin
  assert (select count(*) from small_q) = 600, 'appels : ' || (select count(*) from small_q);
  select string_agg(distinct t, ', ') into bad from small_q
  where jsonb_array_length(b) < 3 or wm.quiz_check(b, t) is not null or exists (select from jsonb_array_elements(b) q where q ->> 'kind' <> 'views');
  assert bad is null, 'petites raretés : ' || bad;
end $$;
