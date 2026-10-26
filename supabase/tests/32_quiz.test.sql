-- Modèles de quiz (1910_wm_quiz_templates.sql) : quiz_norm, quiz_check (règles de quiz_check_one), template_quiz (T4 mot, T3 année,
-- T2 phrase, T1 description, T5 vues), quiz_ensure, quiz_draw.
-- Une seule transaction pour tout le fichier : le pool part vide (le seed n'est chargé qu'à la fin, comme 25_pool.test.sql:107-110), et
-- chaque bloc range ses cartes dans une rareté à lui (R : mini-catalogue et cartes pauvres ; L : vues du seed ; SR : titre long ;
-- C : égalités ; UR : cartes neuves de quiz_ensure). setseed(0.42) avant chaque bloc qui tire.

-- Carte du catalogue au titre unique, ajoutée au pool. Vues par défaut à 20 % d'écart d'une carte à la suivante, sur un cycle de 60 (au plus
-- 100 × 1,2^59, environ 4,7 millions : jamais de débordement de l'int). Un null explicite donne une carte sans category ou sans résumé ; le
-- résumé par défaut, court et sans année, ne donne que des questions de vues (T5).
create function pg_temp.bcard(p_title text, p_rarity public.rarity, p_atk int, p_def int, p_views int default null,
  p_category text default 'Catégorie bataille', p_summary text default 'Carte d''essai des batailles.') returns uuid language plpgsql as $$
declare c uuid; begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, pageviews, category, summary)
  values (p_title, 'https://fr.wikipedia.org/wiki/' || replace(p_title, ' ', '_'), p_rarity, p_atk, p_def,
    coalesce(p_views, round(100 * 1.2 ^ ((select count(*) from public.cards) % 60))::int), p_category, p_summary)
  returning id into c;
  perform wm.pool_add(c, p_rarity);
  return c;
end $$;

-- Question valide de bonne réponse p_answer (option 0), à trois distracteurs fixes.
create function pg_temp.vq(p_answer text, p_kind text default 'word') returns jsonb language sql as $$
  select jsonb_build_object('kind', p_kind, 'prompt', 'Quel mot complète la phrase : « Le ____ coule vers la mer. » ?',
    'options', jsonb_build_array(p_answer, 'montagne', 'colline', 'plateau'), 'correct', 0, 'evidence', 'Le fleuve coule vers la mer.')
$$;

-- Banque de 3 : p_first, puis deux questions valides.
create function pg_temp.bank3(p_first jsonb) returns jsonb language sql as $$
  select jsonb_build_array(p_first, pg_temp.vq('rivière'), pg_temp.vq('ruisseau'))
$$;

-- Kinds d'une banque dans l'ordre des modèles (sous-suite de word, year, sentence, description, views), tous connus.
create function pg_temp.ordered(p_b jsonb) returns boolean language sql as $$
  select array_agg(k order by i) = array_agg(k order by k, i) and bool_and(k is not null)
  from jsonb_array_elements(p_b) with ordinality e (q, i), array_position('{word,year,sentence,description,views}'::text[], q ->> 'kind') k
$$;

-- Positions et longueurs (finition de M5a-10), rangs fautifs d'une banque : year → 4 années de 4 chiffres, triées en suite de pas 1, 2, 5
-- ou 10, aucune après l'année courante ; word → longueurs à 3 près ; sentence → « … » dans la phrase (titre masqué) aux 4 options ou à
-- aucune, et « … » final (coupe) de même. Même texte dans quiz_fixtures.sql.
create function pg_temp.layout_bad(p_b jsonb) returns text language sql as $$
  select string_agg((i - 1)::text, ', ') from jsonb_array_elements(p_b) with ordinality e (q, i),
    lateral (select array_agg(x order by j) o from jsonb_array_elements_text(q -> 'options') with ordinality t (x, j)) t
  where case q ->> 'kind'
    when 'year' then array_to_string(o, ' ') !~ '^[0-9]{4} [0-9]{4} [0-9]{4} [0-9]{4}$'
      or not (o[2]::int - o[1]::int in (1, 2, 5, 10) and o[3]::int - o[2]::int = o[2]::int - o[1]::int
        and o[4]::int - o[3]::int = o[2]::int - o[1]::int and o[4]::int <= extract(year from now()))
    when 'word' then (select max(char_length(x)) - min(char_length(x)) from unnest(o) x) > 3
    when 'sentence' then (select count(*) from unnest(o) x where x ~ '….') not in (0, 4)
      or (select count(*) from unnest(o) x where x ~ '…$') not in (0, 4)
    else false end
$$;

-- Questions views fautives d'une banque, d'après public.cards.pageviews : bonne option à égalité avec une autre, sous les 10 % d'écart
-- (C9), ou à l'autre bout ; 4 titres connus. Même texte dans quiz_fixtures.sql.
create function pg_temp.views_bad(p_b jsonb) returns text language sql as $$
  select string_agg((i - 1)::text, ', ') from jsonb_array_elements(p_b) with ordinality e (q, i),
    lateral (select array_agg(c.pageviews::bigint order by c.pageviews desc) v,
        max(c.pageviews) filter (where t.j - 1 = (q ->> 'correct')::int) ok
      from jsonb_array_elements_text(q -> 'options') with ordinality t (x, j) join public.cards c on c.wikipedia_title = t.x) w
  where q ->> 'kind' = 'views' and not coalesce(cardinality(w.v) = 4 and case when q ->> 'prompt' like '%le plus consulté%'
    then w.ok = w.v[1] and w.v[1] > w.v[2] and 10 * w.v[1] >= 11 * w.v[2]
    else w.ok = w.v[4] and w.v[4] < w.v[3] and 11 * w.v[4] <= 10 * w.v[3] end, false)
$$;

-- C20.
do $$ begin
  assert wm.quiz_norm('Élise  (chanteuse) !') = 'elise chanteuse', wm.quiz_norm('Élise  (chanteuse) !');
  assert wm.quiz_norm('Œuvre') = 'oeuvre', wm.quiz_norm('Œuvre');
end $$;

-- quiz_check : une banque valide, puis un cas par règle, chacun à son nom exact.
do $$ declare bad text; begin
  select string_agg(format('%s → %s', v.label, coalesce(wm.quiz_check(v.bank, v.title), 'null')), ' ; ') into bad
  from (values
    ('valide', pg_temp.bank3(pg_temp.vq('fleuve')), 'Loire', null),
    ('2 questions', jsonb_build_array(pg_temp.vq('fleuve'), pg_temp.vq('rivière')), 'Loire', 'count'),
    ('7 questions', (select jsonb_agg(pg_temp.vq('réponse ' || i)) from generate_series(1, 7) i), 'Loire', 'count'),
    ('3 options', pg_temp.bank3(jsonb_set(pg_temp.vq('fleuve'), '{options}', '["fleuve", "montagne", "colline"]')), 'Loire', 'shape'),
    ('correct 4', pg_temp.bank3(jsonb_set(pg_temp.vq('fleuve'), '{correct}', '4')), 'Loire', 'shape'),
    ('clé hint', pg_temp.bank3(pg_temp.vq('fleuve') || '{"hint": "eau"}'), 'Loire', 'shape'),
    ('objet vide', pg_temp.bank3('{}'), 'Loire', 'shape'),
    ('énoncé de 9', pg_temp.bank3(jsonb_set(pg_temp.vq('fleuve'), '{prompt}', '"Question?"')), 'Loire', 'prompt_length'),
    ('option de 81', pg_temp.bank3(pg_temp.vq(repeat('x', 81))), 'Loire', 'option_length'),
    ('evidence de 601', pg_temp.bank3(jsonb_set(pg_temp.vq('fleuve'), '{evidence}', to_jsonb(repeat('x', 601)))), 'Loire', 'evidence_length'),
    ('option https', pg_temp.bank3(pg_temp.vq('https://x.fr')), 'Loire', 'no_link'),
    ('option www', pg_temp.bank3(pg_temp.vq('www.x.fr')), 'Loire', 'no_link'),
    ('option @', pg_temp.bank3(pg_temp.vq('a@b')), 'Loire', 'no_link'),
    ('énoncé https', pg_temp.bank3(jsonb_set(pg_temp.vq('fleuve'), '{prompt}', '"Voir https://x.fr : quel mot manque ?"')), 'Loire', 'no_link'),
    ('énoncé www', pg_temp.bank3(jsonb_set(pg_temp.vq('fleuve'), '{prompt}', '"Voir www.x.fr : quel mot manque ?"')), 'Loire', 'no_link'),
    ('énoncé @', pg_temp.bank3(jsonb_set(pg_temp.vq('fleuve'), '{prompt}', '"Écrire à a@b : quel mot manque ?"')), 'Loire', 'no_link'),
    ('Paris, paris !', pg_temp.bank3(jsonb_set(pg_temp.vq('Paris'), '{options}', '["Paris", "paris !", "colline", "plateau"]')), 'Loire',
      'options_distinct'),
    ('réponse dans l''énoncé', pg_temp.bank3(jsonb_set(pg_temp.vq('fleuve'), '{prompt}', '"Quel fleuve coule vers la mer ?"')), 'Loire',
      'answer_in_prompt'),
    ('Mercure, word', pg_temp.bank3(pg_temp.vq('Mercure')), 'Mercure (planète)', 'answer_is_title'),
    ('Mercure, views', pg_temp.bank3(pg_temp.vq('Mercure', 'views')), 'Mercure (planète)', null),
    ('aucune de ces réponses', pg_temp.bank3(jsonb_set(pg_temp.vq('fleuve'), '{options}',
      '["fleuve", "Aucune de ces réponses", "colline", "plateau"]')), 'Loire', 'catch_all'),
    ('même réponse', jsonb_build_array(pg_temp.vq('fleuve'), pg_temp.vq('fleuve'), pg_temp.vq('ruisseau')), 'Loire', 'answers_distinct')
  ) v (label, bank, title, want)
  where wm.quiz_check(v.bank, v.title) is distinct from v.want;
  assert bad is null, bad;
end $$;

-- Mini-catalogue : 8 cartes R aux vues à environ 30 % d'écart, catégories distinctes, trois phrases dont une année. La deuxième phrase
-- (40 à 79 caractères, sans titre) n'est jamais coupée, les deux autres le sont toujours : le « … » de T2 est le même chez tous les pairs.
create temp table mini as select pg_temp.bcard(t, 'R', 1000, 1000, v, c, s) id, t from (values
  ('Valcourt-sur-Lys', 100, 'commune française du Nord', 'La commune s''étend le long d''une rivière lente, entre des prairies humides '
    || 'et quelques fermes isolées. Elle possède une école, une église romane et une mairie. Le moulin, construit en 1784 par une famille '
    || 'de meuniers, abrite aujourd''hui une exposition sur la meunerie.'),
  ('Ostravie', 130, 'fleuve d''Europe centrale', 'Le fleuve prend sa source dans des montagnes boisées puis traverse plusieurs plaines '
    || 'agricoles très fertiles. Ses rives accueillent des oiseaux migrateurs au printemps. Un traité signé en 1856 garantit depuis la libre '
    || 'navigation des bateaux de commerce sur tout son parcours.'),
  ('Jan Verhoeven', 170, 'peintre flamand', 'Le peintre réalise surtout des portraits de marchands et des scènes de marché aux couleurs '
    || 'très lumineuses. Il voyage en Italie pour étudier les maîtres anciens. Sa première exposition publique, organisée en 1652 à Anvers, '
    || 'attire une foule nombreuse de collectionneurs.'),
  ('Le Voyage du Corsaire', 220, 'roman d''aventures', 'Le roman raconte la traversée périlleuse d''un jeune marin embarqué malgré lui '
    || 'sur un navire de contrebande. Le récit alterne tempêtes, mutineries et escales lointaines. Publié en feuilleton en 1868 dans un '
    || 'quotidien parisien, il connaît une diffusion considérable en librairie.'),
  ('Orphée aux Neiges', 290, 'opéra en trois actes', 'La partition mêle des chœurs puissants à de longues mélodies confiées aux cordes '
    || 'et aux instruments à vent. Le livret s''inspire d''une légende populaire du Nord. La création, donnée en 1907 devant un public '
    || 'enthousiaste, consacre durablement la réputation du compositeur.'),
  ('Pouillot des cimes', 380, 'espèce d''oiseau', 'Ce petit passereau insectivore niche dans les forêts de conifères et chante dès les '
    || 'premières lueurs de l''aube. Son plumage verdâtre le rend difficile à repérer. Décrit pour la première fois en 1827 par un '
    || 'naturaliste allemand, il fait aujourd''hui l''objet d''une protection.'),
  ('Château de Montbrac', 500, 'château fort', 'La forteresse domine la vallée depuis un éperon rocheux et conserve une enceinte flanquée '
    || 'de tours massives. Un pont-levis protège encore son entrée principale. Assiégée en 1590 pendant les guerres de Religion, elle '
    || 'résiste plusieurs semaines avant de capituler enfin.'),
  ('Cratère de Vélin', 650, 'cratère d''impact', 'Ce vaste cratère circulaire résulte de la chute d''une météorite géante sur un plateau '
    || 'désertique et aride. Ses bords érodés restent visibles depuis l''espace. Une mission scientifique, menée en 1961 par des géologues, '
    || 'confirme son origine extraterrestre indiscutable.')
) x (t, v, c, s);
-- Pas de wm.rebuild_draw_pool() : bcard les a déjà mises au pool, dans l'ordre d'insertion, alors que rebuild_draw_pool range les seq par id
-- (uuid tiré à chaque passage) ; les pairs, donc les banques et le χ² ci-dessous, changeraient d'un passage à l'autre malgré setseed.

select setseed(0.42);
create temp table mini_q as select m.id, m.t, wm.template_quiz(m.id) b from mini m order by m.t;

-- Chaque carte : 3 à 6 questions valides, dans l'ordre des modèles, aux positions et longueurs de M5a-10 ; chaque kind présent.
do $$ declare bad text; begin
  select string_agg(t, ', ') into bad from mini_q
  where jsonb_array_length(b) not between 3 and 6 or wm.quiz_check(b, t) is not null or not pg_temp.ordered(b)
    or pg_temp.layout_bad(b) is not null;
  assert bad is null, 'mini-catalogue : ' || bad;
  select string_agg(k, ', ') into bad from unnest('{word,year,sentence,description,views}'::text[]) k
  where not exists (select from mini_q, jsonb_array_elements(b) q where q ->> 'kind' = k);
  assert bad is null, 'kinds absents du mini-catalogue : ' || bad;
end $$;

-- Le même appel après le même setseed : la même banque.
select setseed(0.42);
create temp table mini_again as select m.id, wm.template_quiz(m.id) b from mini m order by m.t;
do $$ begin
  assert not exists (select from mini_q a join mini_again b using (id) where a.b is distinct from b.b), 'banque non reproductible';
end $$;

-- Position de la bonne année sur 1 000 banques d'une carte à année : χ² < 11,345 (3 ddl, p = 0,01 ; graine fixe, donc reproductible).
-- Une year par banque : T4 laisse la phrase à année à T3.
select setseed(0.42);
do $$ declare c uuid := (select id from mini where t = 'Valcourt-sur-Lys'); n int; chi float8; begin
  with t as materialized (select wm.template_quiz(c) b from generate_series(1, 1000)),
  k as (select (q ->> 'correct')::int k from t, jsonb_array_elements(t.b) q where q ->> 'kind' = 'year'),
  g as (select count(k.k) o from generate_series(0, 3) p left join k on k.k = p group by p)
  select (select count(*) from k), (select sum((o - (select count(*) from k) / 4.0) ^ 2 / ((select count(*) from k) / 4.0)) from g)
  into n, chi;
  assert n = 1000, format('%s questions year sur 1 000 banques', n);
  assert chi < 11.345, format('position de la bonne année : χ² = %s', chi);
end $$;

-- Cartes pauvres (Review Focus) : sans résumé ni category, titre à parenthèse, résumé sans année. La deuxième phrase de Mercure n'a qu'un
-- mot possible pour T4, « planète », pris dans le titre : seule la règle « absent du titre » l'écarte (les pairs ont assez de mots en -te).
-- Une phrase à l'année courante (aucun pas possible pour T3) reste à T4.
select setseed(0.42);
do $$ declare
  bare uuid := pg_temp.bcard('Carte nue', 'R', 1000, 1000, 900, null, null);
  merc uuid := pg_temp.bcard('Mercure (planète)', 'R', 1000, 1000, 1200, 'planète du Système solaire',
    'Mercure est la planète la plus proche du Soleil et la plus petite des huit planètes du Système solaire. Cette planète a peu d''air, '
    || 'un sol gris et des trous sans fin. La sonde Messenger, lancée en 2004, a cartographié la totalité de la surface de Mercure.');
  dry uuid := pg_temp.bcard('Lac de Sérane', 'R', 1000, 1000, 1600, 'lac de montagne',
    'Le lac occupe le fond d''une ancienne vallée glaciaire, au pied de sommets enneigés une grande partie de l''année. Ses eaux froides '
    || 'abritent truites et ombles. Un sentier suit une crête abrupte, puis une route étroite, et offre une vue parfaite sur toute la vallée.');
  s text := format('Le théâtre, rénové en %s pour accueillir de grands spectacles, rouvre ses portes au public.', extract(year from now()));
  th uuid := pg_temp.bcard('Théâtre de Valmont', 'R', 1000, 1000, 2100, 'salle de spectacle', s);
  b jsonb;
begin
  b := wm.template_quiz(bare);
  assert jsonb_array_length(b) >= 3 and wm.quiz_check(b, 'Carte nue') is null
    and not exists (select from jsonb_array_elements(b) q where q ->> 'kind' <> 'views'), 'carte nue : ' || b::text;
  b := wm.template_quiz(merc);
  assert wm.quiz_check(b, 'Mercure (planète)') is null and not exists (select from jsonb_array_elements(b) q
    where q ->> 'kind' <> 'views' and wm.quiz_norm(q -> 'options' ->> (q ->> 'correct')::int) = 'mercure'), 'Mercure : ' || b::text;
  assert not exists (select from jsonb_array_elements(b) q where q ->> 'kind' <> 'views'
    and strpos(wm.quiz_norm('Mercure (planète)'), wm.quiz_norm(q -> 'options' ->> (q ->> 'correct')::int)) > 0),
    'Mercure, réponse prise dans le titre : ' || b::text;
  b := wm.template_quiz(dry);
  assert wm.quiz_check(b, 'Lac de Sérane') is null and not exists (select from jsonb_array_elements(b) q where q ->> 'kind' = 'year'),
    'résumé sans année : ' || b::text;
  b := wm.template_quiz(th);
  assert exists (select from jsonb_array_elements(b) q where q ->> 'kind' = 'word' and q ->> 'evidence' = s),
    'phrase à l''année courante perdue pour T4 : ' || b::text;
end $$;

-- T5 sur 6 Légendaires aux vues du seed (13 % d'écart au plus serré) : 3 views chacune, bonnes réponses distinctes, écart de 10 % au
-- moins dans le bon sens, la carte parmi les 4 options.
create temp table leg as select pg_temp.bcard('Légendaire ' || i, 'L', 1000, 1000, v) id, 'Légendaire ' || i t
from unnest('{27919,35838,43757,51676,59595,67514}'::int[]) with ordinality u (v, i);
select setseed(0.42);
create temp table leg_q as select l.id, l.t, wm.template_quiz(l.id) b from leg l order by l.t;
do $$ declare bad text; begin
  select string_agg(t, ', ') into bad from leg_q
  where jsonb_array_length(b) <> 3 or wm.quiz_check(b, t) is not null or pg_temp.views_bad(b) is not null
    or exists (select from jsonb_array_elements(b) q where q ->> 'kind' <> 'views' or not (q -> 'options') ? t)
    or (select count(distinct q -> 'options' ->> (q ->> 'correct')::int) from jsonb_array_elements(b) q) <> 3;
  assert bad is null, 'Légendaires : ' || bad;
end $$;

-- Titre de 81 caractères, sans résumé ni category, et 5 autres SR : 3 views sur 4 pairs, aucune option de plus de 80 caractères, le titre
-- absent des options ; quiz_ensure lui pose une banque template.
select setseed(0.42);
do $$ declare
  t text := 'Titre de quatre-vingt-un caractères pour éprouver le repli des vues sur des pairs SR';
  c uuid; b jsonb;
begin
  t := left(t, 81);
  assert char_length(t) = 81, t;
  c := pg_temp.bcard(t, 'SR', 1000, 1000, null, null, null);
  perform pg_temp.bcard('Super rare ' || i, 'SR', 1000, 1000) from generate_series(1, 5) i;
  b := wm.template_quiz(c);
  assert jsonb_array_length(b) = 3 and wm.quiz_check(b, t) is null
    and (select count(distinct q -> 'options' ->> (q ->> 'correct')::int) from jsonb_array_elements(b) q) = 3
    and not exists (select from jsonb_array_elements(b) q, jsonb_array_elements_text(q -> 'options') o
      where q ->> 'kind' <> 'views' or char_length(o) > 80 or o = t), 'titre long : ' || b::text;
  perform wm.quiz_ensure(array[c]);
  assert (select source from wm.card_quizzes where card_id = c) = 'template', 'titre long : pas de banque';
end $$;

-- Égalités : une C à 0 vue, 3 pairs à 0 (les 4 options à 0 sont possibles) et 3 à 100, sur 20 banques : aucune question views dont la
-- bonne option a les vues d'une autre.
select setseed(0.42);
do $$ declare c uuid := pg_temp.bcard('Commune nulle', 'C', 1000, 1000, 0); b jsonb; begin
  perform pg_temp.bcard('Commune à zéro ' || i, 'C', 1000, 1000, 0) from generate_series(1, 3) i;
  perform pg_temp.bcard('Commune à cent ' || i, 'C', 1000, 1000, 100) from generate_series(1, 3) i;
  for i in 1..20 loop
    b := wm.template_quiz(c);
    assert jsonb_array_length(b) >= 3 and pg_temp.views_bad(b) is null, 'égalités : ' || b::text;
  end loop;
end $$;

-- T2 et ses « … » (PC) : quatre pairs dont la phrase 1 est coupée (« … » final) et la phrase 2 entière. Les phrases des cartes testées
-- n'ont aucun mot pour T4.
-- - Lorvan : phrase 1 entière, titre masqué (« … » dans la phrase) : jamais face à des phrases coupées.
-- - Sorbec : phrase 1 coupée ; le pair à la même category cite « Sorbec », masqué à son tour, donc écarté : aucune option ne montre le titre.
-- - Jan Ostval : sa phrase 2 garde « Ostval » (le masque ne prend que le titre entier) : jamais bonne réponse de T2.
create temp table pc as select pg_temp.bcard(t, 'PC', 1000, 1000, null, c, s) id, t from (values
  ('Lorvan', 'fleuve côtier', 'Le Lorvan naît dans les monts et file vers la mer du Nord.'),
  ('Sorbec', 'bourg du Quercy', 'Le bourg a un pont, une tour, un four, un puits, une halle et une forge du roi Jean II.'),
  ('Jan Ostval', 'peintre hollandais', 'Jan Ostval est un peintre. Ostval part en Italie, puis vit dix ans à Rome avec sa femme et ses fils.'),
  ('Marché de Pradel', 'bourg du Quercy', 'Le marché aux bestiaux du vendredi attire les éleveurs de Sorbec et de toute la vallée voisine '
    || 'depuis longtemps. La foire de printemps réunit chaque année les marchands du canton.'),
  ('Gorges de Lambre', 'rivière des Causses', 'La rivière traverse des gorges profondes creusées dans le calcaire avant de rejoindre '
    || 'un affluent plus large. Ses eaux claires abritent des écrevisses et des truites sauvages.'),
  ('Col de Maure', 'col des Pyrénées', 'Le passage, emprunté par les muletiers et les pèlerins, reste fermé par la neige pendant '
    || 'plusieurs mois chaque hiver. Une petite chapelle de pierre se dresse près du sommet du col.'),
  ('Abbaye de Sylvanès', 'abbaye cistercienne', 'Les moines défrichent les terres alentour et construisent un cloître dont subsistent '
    || 'aujourd''hui quelques arcades. Les bâtiments conventuels servent aujourd''hui de musée régional.')) v (t, c, s);
select setseed(0.42);
do $$ declare b jsonb := wm.template_quiz((select id from pc where t = 'Lorvan')); begin
  assert pg_temp.layout_bad(b) is null, 'Lorvan, « … » mêlés : ' || b::text;
end $$;
do $$ declare b jsonb := wm.template_quiz((select id from pc where t = 'Sorbec')); begin
  assert exists (select from jsonb_array_elements(b) q where q ->> 'kind' = 'sentence')
    and not exists (select from jsonb_array_elements(b) q, jsonb_array_elements_text(q -> 'options') o
      where q ->> 'kind' = 'sentence' and o ~ '\mSorbec\M'), 'Sorbec : ' || b::text;
end $$;
do $$ declare b jsonb := wm.template_quiz((select id from pc where t = 'Jan Ostval')); begin
  assert not exists (select from jsonb_array_elements(b) q where q ->> 'kind' = 'sentence'
    and q -> 'options' ->> (q ->> 'correct')::int ~ '\mOstval\M'), 'Jan Ostval : ' || b::text;
end $$;

-- quiz_ensure : banques template et file à 100 ; doublons du tableau ; rejeu sans effet ; banque llm intacte et hors file ; priorité
-- relevée à 100, jamais baissée.
select setseed(0.42);
do $$ declare
  l uuid[] := array(select id from leg order by t);
  a uuid := pg_temp.bcard('Neuve A', 'UR', 1000, 1000);
  b uuid := pg_temp.bcard('Neuve B', 'UR', 1000, 1000);
  s1 jsonb; s2 jsonb;
begin
  perform wm.quiz_ensure(l[1:3]);
  assert (select count(*) from wm.card_quizzes where card_id = any (l[1:3]) and source = 'template' and prompt_version = 1
    and model is null) = 3, 'banques template';
  assert (select count(*) from wm.quiz_queue where card_id = any (l[1:3]) and priority = 100) = 3, 'file à 100';
  perform wm.quiz_ensure(array[a, a, b]);
  assert (select count(*) from wm.card_quizzes where card_id in (a, b)) = 2, 'doublon : banques';
  assert (select count(*) from wm.quiz_queue where card_id in (a, b)) = 2, 'doublon : file';
  s1 := (select jsonb_build_array((select jsonb_agg(q order by card_id) from wm.card_quizzes q),
    (select jsonb_agg(f order by card_id) from wm.quiz_queue f)));
  perform wm.quiz_ensure(array[a, a, b] || l[1:3]);
  s2 := (select jsonb_build_array((select jsonb_agg(q order by card_id) from wm.card_quizzes q),
    (select jsonb_agg(f order by card_id) from wm.quiz_queue f)));
  assert s1 = s2, 'rejeu : ' || s1::text || ' → ' || s2::text;
  insert into wm.card_quizzes (card_id, prompt_version, source, model, questions)
  values (l[4], 1, 'llm', 'modèle d''essai', pg_temp.bank3(pg_temp.vq('fleuve')));
  s1 := (select to_jsonb(q) from wm.card_quizzes q where card_id = l[4]);
  perform wm.quiz_ensure(array[l[4]]);
  assert (select to_jsonb(q) from wm.card_quizzes q where card_id = l[4]) = s1, 'banque llm touchée';
  assert not exists (select from wm.quiz_queue where card_id = l[4]), 'banque llm en file';
  insert into wm.quiz_queue (card_id, priority) values (l[5], 60), (l[6], 120);
  perform wm.quiz_ensure(array[l[5], l[6]]);
  assert (select array_agg(priority order by card_id = l[6]) from wm.quiz_queue where card_id in (l[5], l[6])) = '{100,120}', 'priorités';
end $$;

-- Interblocage (M5a-9) : les deux insert de quiz_ensure sont triés.
do $$ declare s text := (select prosrc from pg_proc where oid = 'wm.quiz_ensure(uuid[])'::regprocedure); begin
  assert (select array_agg(x ~* '\morder\s+by\M' order by i) from unnest(regexp_split_to_array(s, '\minsert\s+into\M')) with ordinality t (x, i)
    where i > 1) = '{t,t}', s;
end $$;

-- quiz_draw (C7) : d'abord les q_index non tirés, puis des déjà tirés ; formes ; ids uuid distincts, options triées par id ; bonne option.
do $$ declare
  bank jsonb := (select jsonb_agg(pg_temp.vq('réponse ' || i) order by i) from generate_series(0, 5) i);
  d jsonb; bad text;
begin
  d := wm.quiz_draw(bank, '{0,1,2}', 3);
  assert (select array_agg((x ->> 'q_index')::int order by (x ->> 'q_index')::int) from jsonb_array_elements(d) x) = '{3,4,5}', d::text;
  d := wm.quiz_draw(bank, '{0,1,2,3,4,5}', 3);
  assert jsonb_array_length(d) = 3 and (select count(distinct (x ->> 'q_index')::int) filter (where (x ->> 'q_index')::int between 0 and 5)
    from jsonb_array_elements(d) x) = 3, d::text;
  select string_agg(x ->> 'q_index', ', ') into bad from jsonb_array_elements(d || wm.quiz_draw(bank, '{}', 6)) x,
    lateral (select bank -> (x ->> 'q_index')::int q) b
  where (select array_agg(k order by k) from jsonb_object_keys(x) k) <> '{correct_option_id,options,prompt,q_index}'
    or x ->> 'prompt' <> b.q ->> 'prompt' or jsonb_array_length(x -> 'options') <> 4
    or exists (select from jsonb_array_elements(x -> 'options') o where (select array_agg(k order by k) from jsonb_object_keys(o) k) <> '{id,text}'
      or o ->> 'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (select count(distinct o ->> 'id') from jsonb_array_elements(x -> 'options') o) <> 4
    or (select array_agg(o ->> 'id' order by i) <> array_agg(o ->> 'id' order by o ->> 'id')
      from jsonb_array_elements(x -> 'options') with ordinality u (o, i))
    or (select array_agg(o ->> 'text' order by o ->> 'text') from jsonb_array_elements(x -> 'options') o)
      <> (select array_agg(y order by y) from jsonb_array_elements_text(b.q -> 'options') y)
    or (select o ->> 'id' from jsonb_array_elements(x -> 'options') o where o ->> 'text' = b.q -> 'options' ->> (b.q ->> 'correct')::int)
      is distinct from x ->> 'correct_option_id';
  assert bad is null, 'tirages fautifs : ' || bad;
end $$;

-- Position de la bonne option sur 1 000 tirages : χ² < 16,266 (3 ddl, p = 0,001 : gen_random_uuid() échappe à setseed, C7).
do $$ declare chi float8; begin
  with d as materialized (select wm.quiz_draw(jsonb_build_array(pg_temp.vq('fleuve')), '{}', 1) -> 0 x from generate_series(1, 1000)),
  p as (select (select i - 1 from jsonb_array_elements(x -> 'options') with ordinality o (v, i) where v ->> 'id' = x ->> 'correct_option_id') k
    from d),
  g as (select count(p.k) o from generate_series(0, 3) s left join p on p.k = s group by s)
  select sum((o - 250) ^ 2 / 250.0) into chi from g;
  assert chi < 16.266, format('position de la bonne option : χ² = %s', chi);
end $$;

-- Volatilité.
do $$ begin
  assert (select provolatile from pg_proc where oid = 'wm.quiz_norm(text)'::regprocedure) = 'i', 'quiz_norm';
  assert (select provolatile from pg_proc where oid = 'wm.quiz_check(jsonb, text)'::regprocedure) = 's', 'quiz_check';
end $$;

-- Seed du banc (2 000 cartes, résumé et category communs par rareté, environ 20 C par valeur de vues, 0 compris) : template_quiz sans
-- exception, des views seules, sans égalité ni écart sous 10 %.
delete from wm.draw_pool;
delete from public.cards;
\ir ../seed.sql
select setseed(0.42);
create temp table seed_q as select c.id, wm.template_quiz(c.id) b from public.cards c order by c.id;
do $$ declare bad text; begin
  assert (select count(*) from seed_q) = 2000, 'seed incomplet';
  select string_agg(id::text, ', ') into bad from seed_q
  where jsonb_array_length(b) < 3 or exists (select from jsonb_array_elements(b) q where q ->> 'kind' <> 'views')
    or pg_temp.views_bad(b) is not null;
  assert bad is null, 'seed : ' || bad;
end $$;
