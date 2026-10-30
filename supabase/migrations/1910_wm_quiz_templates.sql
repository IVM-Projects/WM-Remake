-- ADDITIVE : modèles de quiz du M5a (M5a-8, M5a-9, M5a-10, C7, C9, C20) — normalisation, contrôle d'une banque et d'une question,
-- modèles de secours T4, T3, T2, T1 et T5, banques et file des cartes d'un deck (quiz_ensure), tirage d'une attaque (quiz_draw). Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- C20 : sans accents ni casse, toute suite hors [:alnum:] → une espace. immutable (unaccent n'est que stable), comme wm_index.search_text.
create or replace function wm.quiz_norm(p text)
returns text language sql immutable security definer set search_path = '' as $$
  select btrim(regexp_replace(lower(extensions.unaccent('extensions.unaccent'::regdictionary, p)), '[^[:alnum:]]+', ' ', 'g'))
$$;

-- Règles d'une question, de shape à catch_all (PF17) : null si valide, sinon la première enfreinte. Appelée par quiz_check et par
-- template_quiz (C9), pour que chaque candidat passe par le même code. Un IF par garde : jsonb_object_keys et jsonb_array_length lèvent
-- hors d'un objet ou d'un tableau.
create or replace function wm.quiz_check_one(p_q jsonb, p_title text)
returns text language plpgsql immutable security definer set search_path = '' as $$
declare o text[]; n text[]; ok text;
begin
  if jsonb_typeof(p_q) is distinct from 'object' then
    return 'shape';
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(p_q) k) is distinct from '{correct,evidence,kind,options,prompt}'
     or jsonb_typeof(p_q -> 'kind') <> 'string' or jsonb_typeof(p_q -> 'prompt') <> 'string'
     or jsonb_typeof(p_q -> 'evidence') <> 'string' or jsonb_typeof(p_q -> 'options') <> 'array'
     or (p_q -> 'correct')::text !~ '^[0-3]$' then
    return 'shape';
  end if;
  if jsonb_array_length(p_q -> 'options') <> 4
     or exists (select from jsonb_array_elements(p_q -> 'options') e where jsonb_typeof(e) <> 'string') then
    return 'shape';
  end if;
  o := array(select x from jsonb_array_elements_text(p_q -> 'options') with ordinality t (x, i) order by i);
  n := array(select wm.quiz_norm(x) from unnest(o) with ordinality t (x, i) order by i);
  if char_length(p_q ->> 'prompt') not between 10 and 200 then
    return 'prompt_length';
  end if;
  if exists (select from unnest(o, n) t (x, y) where char_length(x) not between 1 and 80 or y = '') then
    return 'option_length';
  end if;
  if char_length(p_q ->> 'evidence') not between 1 and 600 then
    return 'evidence_length';
  end if;
  -- Un article vandalisé ne fait afficher aucun lien.
  if exists (select from unnest(o || (p_q ->> 'prompt')) x where x ~* 'https?://|www\.|@') then
    return 'no_link';
  end if;
  if (select count(distinct y) from unnest(n) y) <> 4 then
    return 'options_distinct';
  end if;
  ok := n[(p_q ->> 'correct')::int + 1];
  if strpos(wm.quiz_norm(p_q ->> 'prompt'), ok) > 0 then
    return 'answer_in_prompt';
  end if;
  -- La bonne réponse de views est la carte une fois sur quatre : l'exclure ferait du titre un indice (C9).
  if p_q ->> 'kind' <> 'views' and ok = wm.quiz_norm(regexp_replace(p_title, '\s*\([^()]*\)\s*$', '')) then
    return 'answer_is_title';
  end if;
  if exists (select from unnest(n) y where y in ('toutes ces reponses', 'aucune de ces reponses', 'toutes les reponses', 'aucune')) then
    return 'catch_all';
  end if;
  return null;
end $$;

-- Banque d'une carte (M5a-8) : null si valide, sinon la première règle enfreinte, dans l'ordre count, règles de quiz_check_one,
-- answers_distinct.
create or replace function wm.quiz_check(p_questions jsonb, p_title text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare b jsonb := (select value from wm.config where key = 'battle'); r text;
begin
  if jsonb_typeof(p_questions) is distinct from 'array' then
    return 'count';
  end if;
  if jsonb_array_length(p_questions) not between (b ->> 'questions')::int and (b ->> 'pool')::int then
    return 'count';
  end if;
  select x into r from jsonb_array_elements(p_questions) q, wm.quiz_check_one(q, p_title) x where x is not null
  order by array_position('{shape,prompt_length,option_length,evidence_length,no_link,options_distinct,answer_in_prompt,answer_is_title,
    catch_all}'::text[], x)
  limit 1;
  if r is not null then
    return r;
  end if;
  if (select count(distinct wm.quiz_norm(q -> 'options' ->> (q ->> 'correct')::int)) from jsonb_array_elements(p_questions) q)
     < jsonb_array_length(p_questions) then
    return 'answers_distinct';
  end if;
  return null;
end $$;

-- Phrases d'un résumé et leur rang : coupe après . ! ? ou … suivi d'une espace, sauf après une initiale (« J. », « J.-C. ») ou devant une
-- minuscule (« etc. et »).
create or replace function wm.quiz_sentences(p text)
returns table (rk int, s text) language sql immutable security definer set search_path = '' as $$
  select o::int, btrim(x) from regexp_split_to_table(p, '(?<=[^[:upper:]][.!?…])\s+(?![[:lower:]])') with ordinality t (x, o)
$$;

-- Titre masqué : toute occurrence (casse ignorée, mot entier) du titre privé de sa parenthèse finale remplacée par « … ».
create or replace function wm.quiz_mask(p_s text, p_title text)
returns text language sql immutable security definer set search_path = '' as $$
  select case when b = '' then p_s
    else regexp_replace(p_s, '(?<![[:alnum:]])' || regexp_replace(b, '([^[:alnum:][:space:]])', '\\\1', 'g') || '(?![[:alnum:]])', '…', 'gi') end
  from (select btrim(regexp_replace(coalesce(p_title, ''), '\s*\([^()]*\)\s*$', '')) b) t
$$;

-- Phrase coupée à 79 caractères sur une frontière de mot, puis « … » (80 au plus).
create or replace function wm.quiz_cut(p text)
returns text language sql immutable security definer set search_path = '' as $$
  select case when char_length(p) <= 79 then p else rtrim(regexp_replace(left(p, 80), '\s+\S*$', ''), ' ,;:') || '…' end
$$;

-- Pas de T3 possibles pour l'année p_y : ceux qui laissent possibles les 4 positions de la bonne année (entre 1000 et l'année courante,
-- aucune année Y + j·s du texte de la carte, j de −3 à 3 et j ≠ 0), sinon elle se devinerait. stable : now().
create or replace function wm.quiz_steps(p_y int, p_text text)
returns int[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(s order by s), '{}') from unnest('{1,2,5,10}'::int[]) s
  where p_y + 3 * s <= extract(year from now()) and p_y - 3 * s >= 1000
    and not exists (select from generate_series(-3, 3) j where j <> 0 and strpos(p_text, (p_y + j * s)::text) > 0)
$$;

-- Candidat gardable (C9) : les règles de quiz_check_one, et ni la bonne réponse ni l'evidence (la phrase source de T4, T3 et T2) d'une
-- question déjà gardée.
create or replace function wm.quiz_fits(p_out jsonb, p_q jsonb, p_title text)
returns boolean language sql immutable security definer set search_path = '' as $$
  select case when wm.quiz_check_one(p_q, p_title) is not null then false
    else not exists (select from jsonb_array_elements(p_out) e where e ->> 'evidence' = p_q ->> 'evidence'
      or wm.quiz_norm(e -> 'options' ->> (e ->> 'correct')::int) = wm.quiz_norm(p_q -> 'options' ->> (p_q ->> 'correct')::int)) end
$$;

-- Banque de secours d'une carte (M5a-9, C9) : candidats T4 (mot, 2 au plus), T3 (année, 2), T2 (phrase, 1), T1 (description, 1) puis
-- T5 (vues, 3), chacun gardé s'il passe quiz_fits, coupés à battle.pool. Hasard par random() seul : la même banque après le même setseed.
create or replace function wm.template_quiz(p_card_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.cards;
  b jsonb := (select value from wm.config where key = 'battle');
  v_long boolean;                 -- titre de plus de 80 caractères : hors des options de T5, 4 pairs par question (C9)
  v_text text;                    -- texte de la carte
  v_peers uuid[];
  v_pt text[]; v_pc text[]; v_ps text[]; v_pv int[];  -- titres, category, résumés et vues des pairs, dans l'ordre du tirage
  v_out jsonb := '[]';
  v_pw text[]; v_pn text[];       -- mots des pairs, distracteurs possibles de T4 (forme, quiz_norm)
  v_tt text[]; v_tv int[];        -- titres et vues des pairs, options possibles de T5
  v_t4 text[]; v_v4 bigint[];     -- les 4 titres d'une question de T5, par vues décroissantes
  -- Mots vides, après quiz_norm : jamais bonne réponse ni distracteur de T4.
  v_stop text[] := '{les,des,une,aux,par,pour,dans,sur,avec,sans,sous,est,sont,ete,etait,etaient,ont,avait,avaient,sera,seront,serait,
    seraient,peut,peuvent,qui,que,quoi,dont,cette,ces,son,ses,leur,leurs,elle,elles,ils,nous,vous,mais,donc,car,comme,plus,moins,tres,
    tout,tous,toute,toutes,meme,memes,aussi,encore,entre,vers,chez,depuis,avant,apres,pendant,lors,alors,ainsi,selon,celui,celle,ceux,
    celles,cela,ceci,lequel,laquelle,lesquels,lesquelles,auquel,auxquels,auxquelles,duquel,desquels,desquelles,notamment,egalement,puis,
    fait,faire,etre,avoir,plusieurs,autre,autres,quelque,quelques,chaque,certain,certains,certaine,certaines,beaucoup,toujours,jamais,
    souvent,parmi,contre,durant,environ,jusqu,lorsque,lorsqu,puisque,puisqu,quelqu,tandis,quand,cependant,pourtant,toutefois,neanmoins,
    desormais,aujourd,hui,presque,surtout,seulement,vraiment,ensuite,enfin,devant,derriere,autour,partir,nombreux,nombreuses,votre,notre}';
  r record; v_w text; v_n text; v_d text[]; v_b int; v_s int; v_k int; v_q jsonb; v_m int; v_try int; v_hi boolean; v_lo boolean;
  v_most boolean;
  v_pre jsonb;                    -- banque avant T5, d'où T5 est rejoué
begin
  select * into c from public.cards where id = p_card_id;
  if not found then
    raise exception 'template_quiz : carte % introuvable', p_card_id using errcode = 'XX000';
  end if;
  v_long := char_length(c.wikipedia_title) > 80;
  v_text := wm.quiz_norm(concat_ws(' ', c.wikipedia_title, c.category, c.summary));

  -- Pairs (C9) : jusqu'à 30 cartes de sa rareté par des seq tirés dans 1..n, toute sa rareté si elle en a 31 au plus (30 tirages avec
  -- remise y oublient souvent une carte : 2 % des appels sur 6 cartes), ou de tout le pool quand elle en a trop peu.
  v_m := coalesce((select n from wm.catalog_stats where rarity = c.rarity), 0);
  if v_m < (case when v_long then 5 else 4 end) then
    v_peers := array(select card_id from wm.draw_pool where card_id <> p_card_id order by random() limit 30);
  elsif v_m <= 31 then
    v_peers := array(select card_id from wm.draw_pool where rarity = c.rarity and card_id <> p_card_id order by random());
  else
    v_peers := array(select p.card_id from (select o, 1 + floor(random() * v_m)::int s from generate_series(1, 30) o) x
      join wm.draw_pool p on p.rarity = c.rarity and p.seq = x.s where p.card_id <> p_card_id group by p.card_id order by min(x.o));
  end if;
  -- Lus une fois : aucune requête des modèles ne joint public.cards (un plan générique mis en cache quand la table était petite y
  -- appliquait similarity ou quiz_sentences à toutes les cartes, 2 000 fois par appel sur le seed).
  select array_agg(pc.wikipedia_title order by u.i), array_agg(pc.category order by u.i), array_agg(pc.summary order by u.i),
    array_agg(pc.pageviews order by u.i)
  into v_pt, v_pc, v_ps, v_pv
  from unnest(v_peers) with ordinality u (id, i) join public.cards pc on pc.id = u.id;

  -- T4 (mot) : phrases sans année utilisable par T3 (une banque mot et année vaut mieux que deux mots). Mots de 6 lettres ou
  -- plus, en minuscule (un nom propre parmi des noms communs se devinerait), seuls dans la phrase, absents du titre ; 3 mots des pairs de
  -- même terminaison, de longueur dans une fenêtre [b, b + 3] tirée autour de la leur.
  select array_agg(w order by n), array_agg(n order by n) into v_pw, v_pn
  from (select distinct on (n) x.w, n from (select distinct m[1] w from unnest(v_ps) s,
      regexp_matches(s, '\m[[:lower:]][[:alpha:]]{2,}\M', 'g') m) x, wm.quiz_norm(x.w) n
    order by n, x.w) y
  where strpos(v_text, n) = 0 and n <> all (v_stop);
  v_m := 0;
  for r in select t.s, wm.quiz_mask(t.s, c.wikipedia_title) m from wm.quiz_sentences(c.summary) t
           where char_length(t.s) between 40 and 150
             and not exists (select from regexp_matches(t.s, '\m(1[0-9]{3}|20[0-2][0-9])\M', 'g') y
               where strpos(c.wikipedia_title, y[1]) = 0 and wm.quiz_steps(y[1]::int, v_text) <> '{}')
           order by random() loop
    exit when v_m = 2;
    for v_w in select x[1] from regexp_matches(r.m, '\m[[:lower:]][[:alpha:]]{5,}\M', 'g') x order by random() loop
      v_n := wm.quiz_norm(v_w);
      continue when v_n = any (v_stop) or strpos(wm.quiz_norm(c.wikipedia_title), v_n) > 0
        or char_length(replace(wm.quiz_norm(r.m), v_n, '')) <> char_length(wm.quiz_norm(r.m)) - char_length(v_n);
      v_b := char_length(v_w) - 3 + floor(random() * 4)::int;
      v_d := array(select w from unnest(v_pw, v_pn) u (w, n) where right(n, 2) = right(v_n, 2) and char_length(w) between v_b and v_b + 3
        order by random() limit 3);
      continue when cardinality(v_d) < 3;
      v_k := floor(random() * 4)::int;
      v_q := jsonb_build_object('kind', 'word',
        'prompt', format('Quel mot complète la phrase : « %s » ?', regexp_replace(r.m, '\m' || v_w || '\M', '____')),
        'options', to_jsonb(v_d[1:v_k] || v_w || v_d[v_k + 1:3]), 'correct', v_k, 'evidence', r.s);
      if wm.quiz_fits(v_out, v_q, c.wikipedia_title) then
        v_out := v_out || v_q;
        v_m := v_m + 1;
        exit;
      end if;
    end loop;
  end loop;

  -- T3 (année) : pas s tiré parmi ceux de quiz_steps, puis position k.
  v_m := 0;
  for r in select t.s, x.y::int y from wm.quiz_sentences(c.summary) t,
             lateral (select distinct m[1] y from regexp_matches(t.s, '\m(1[0-9]{3}|20[0-2][0-9])\M', 'g') m) x
           where char_length(t.s) between 40 and 150 and strpos(c.wikipedia_title, x.y) = 0
             and not exists (select from jsonb_array_elements(v_out) e where e ->> 'evidence' = t.s)
           order by random() loop
    exit when v_m = 2;
    v_s := (select s from unnest(wm.quiz_steps(r.y, v_text)) s order by random() limit 1);
    continue when v_s is null;
    v_k := floor(random() * 4)::int;
    v_q := jsonb_build_object('kind', 'year',
      'prompt', format('Quelle année complète la phrase : « %s » ?', regexp_replace(r.s, '\m' || r.y || '\M', '____', 'g')),
      'options', (select jsonb_agg((r.y + (i - v_k) * v_s)::text order by i) from generate_series(0, 3) i), 'correct', v_k, 'evidence', r.s);
    if wm.quiz_fits(v_out, v_q, c.wikipedia_title) then
      v_out := v_out || v_q;
      v_m := v_m + 1;
    end if;
  end loop;

  -- T2 (phrase) : une phrase de la carte contre la phrase de même rang des pairs à la category la plus proche, masquées (titre du pair, puis
  -- celui de la carte) et coupées de même. Le « … » d'un titre masqué (dans la phrase) et celui d'une coupe (en fin) sont chacun aux 4
  -- options ou à aucune (brief, PF2), sinon un autre pair. Une phrase de la carte qui garde un mot du titre (majuscule, 4 lettres ou plus,
  -- « Verhoeven » pour « Jan Verhoeven ») est sautée.
  for r in select t.rk, t.s, wm.quiz_cut(wm.quiz_mask(t.s, c.wikipedia_title)) o from wm.quiz_sentences(c.summary) t
           where char_length(t.s) between 40 and 150 and not exists (select from jsonb_array_elements(v_out) e where e ->> 'evidence' = t.s)
           order by random() loop
    continue when exists (select from regexp_matches(c.wikipedia_title, '\m[[:upper:]][[:alpha:]]{3,}\M', 'g') w
      where r.o ~ ('\m' || w[1] || '\M'));
    v_d := array(select y.o from (
        select distinct on (n) o, coalesce(extensions.similarity(p.cat, c.category), 0) sim, p.i
        from unnest(v_pt, v_pc, v_ps) with ordinality p (t, cat, s, i), wm.quiz_sentences(p.s) ps,
          wm.quiz_cut(wm.quiz_mask(wm.quiz_mask(ps.s, p.t), c.wikipedia_title)) o, wm.quiz_norm(o) n
        where ps.rk = r.rk and char_length(ps.s) between 40 and 150 and strpos(v_text, n) = 0
          and (o ~ '….') = (r.o ~ '….') and (o ~ '…$') = (r.o ~ '…$')
        order by n, sim desc, p.i) y
      order by y.sim desc, y.i limit 3);
    continue when cardinality(v_d) < 3;
    v_k := floor(random() * 4)::int;
    v_q := jsonb_build_object('kind', 'sentence', 'prompt', format('Laquelle de ces phrases est tirée de l''article « %s » ?', c.wikipedia_title),
      'options', to_jsonb(v_d[1:v_k] || r.o || v_d[v_k + 1:3]), 'correct', v_k, 'evidence', r.s);
    if wm.quiz_fits(v_out, v_q, c.wikipedia_title) then
      v_out := v_out || v_q;
      exit;
    end if;
  end loop;

  -- T1 (description) : la category contre celle de 3 pairs, les plus proches sous 0,6, sans inclusion de l'une dans l'autre.
  if char_length(c.category) <= 80 then
    v_d := '{}';
    for r in select p.x, wm.quiz_norm(p.x) n from unnest(v_pc) with ordinality p (x, i)
             where char_length(p.x) <= 80 and extensions.similarity(p.x, c.category) < 0.6
             order by extensions.similarity(p.x, c.category) desc, p.i loop
      exit when cardinality(v_d) = 3;
      continue when r.n = '' or strpos(v_text, r.n) > 0
        or exists (select from unnest(v_d || c.category) e, wm.quiz_norm(e) m where strpos(m, r.n) > 0 or strpos(r.n, m) > 0);
      v_d := v_d || r.x;
    end loop;
    if cardinality(v_d) = 3 then
      v_k := floor(random() * 4)::int;
      v_q := jsonb_build_object('kind', 'description', 'prompt', format('Comment Wikidata décrit-il « %s » ?', c.wikipedia_title),
        'options', to_jsonb(v_d[1:v_k] || c.category || v_d[v_k + 1:3]), 'correct', v_k, 'evidence', c.category);
      if wm.quiz_fits(v_out, v_q, c.wikipedia_title) then
        v_out := v_out || v_q;
      end if;
    end if;
  end if;

  -- T5 (vues, C9) : la carte et 3 pairs, ou 4 pairs pour un titre long ; « le plus » si la bonne réponse dépasse la suivante de 10 % au
  -- moins (entiers), « le moins » de même, jamais une égalité ; jusqu'à 200 combinaisons par question. Le tirage, glouton, peut prendre
  -- la seule combinaison d'une bonne réponse (quiz_fits refuse les mêmes 4 titres deux fois) : T5 est rejoué depuis la banque d'avant
  -- lui, 10 fois au plus, jusqu'à battle.questions (le premier tour est le tirage d'avant ce rejeu).
  select array_agg(p.t order by p.i), array_agg(p.v order by p.i) into v_tt, v_tv
  from unnest(v_pt, v_pv) with ordinality p (t, v, i) where char_length(p.t) <= 80;
  v_pre := v_out;
  for v_round in 1..10 loop
    v_out := v_pre;
    v_m := 0;
    while v_m < 3 and jsonb_array_length(v_out) < (b ->> 'pool')::int loop
      v_try := 0;
      loop
        v_try := v_try + 1;
        exit when v_try > 200;
        select array_agg(t order by v desc), array_agg(v order by v desc) into v_t4, v_v4 from (
          select c.wikipedia_title t, c.pageviews::bigint v where not v_long
          union all
          select v_tt[i], v_tv[i] from (select i from generate_series(1, coalesce(cardinality(v_tt), 0)) i order by random()
            limit case when v_long then 4 else 3 end) x) y;
        exit when cardinality(v_t4) is distinct from 4;
        v_hi := v_v4[1] > v_v4[2] and 10 * v_v4[1] >= 11 * v_v4[2];
        v_lo := v_v4[4] < v_v4[3] and 11 * v_v4[4] <= 10 * v_v4[3];
        continue when not (v_hi or v_lo);
        v_most := case when v_hi and v_lo then random() < 0.5 else v_hi end;
        v_w := case when v_most then v_t4[1] else v_t4[4] end;
        v_q := jsonb_build_object('kind', 'views',
          'prompt', format('Lequel de ces articles a été le %s consulté sur Wikipédia le mois dernier ?', case when v_most then 'plus' else 'moins' end),
          'evidence', (select string_agg(format('« %s » : %s vues', t, v), ' ; ' order by i) from unnest(v_t4, v_v4) with ordinality x (t, v, i)));
        v_t4 := array(select t from unnest(v_t4) t order by random());
        v_q := v_q || jsonb_build_object('options', to_jsonb(v_t4), 'correct', array_position(v_t4, v_w) - 1);
        if wm.quiz_fits(v_out, v_q, c.wikipedia_title) then
          v_out := v_out || v_q;
          v_m := v_m + 1;
          exit;
        end if;
      end loop;
      exit when v_try > 200 or cardinality(v_t4) is distinct from 4;
    end loop;
    exit when jsonb_array_length(v_out) >= (b ->> 'questions')::int;
  end loop;

  v_out := (select coalesce(jsonb_agg(e order by i), '[]') from jsonb_array_elements(v_out) with ordinality t (e, i)
    where i <= (b ->> 'pool')::int);
  if jsonb_array_length(v_out) < (b ->> 'questions')::int then
    -- shortcut: une carte sans texte utile n'a que T5, dont chaque question demande une autre combinaison de 4 titres aux vues
    -- distinctes : un pool de moins de 5 cartes, ou une rareté de 4 (5 pour un titre de plus de 80 caractères, qui prend 4 pairs), n'en
    -- a qu'une. À 5 et 6 cartes, pairs sans remise et rejeu de T5 n'ont manqué aucun des 14 000 appels mesurés (13 % de manques avant
    -- eux à 5 cartes) ; jamais sur la démo, dont la plus petite rareté compte environ 77 cartes.
    raise exception 'template_quiz : % questions pour la carte %', jsonb_array_length(v_out), p_card_id using errcode = 'XX000';
  end if;
  return v_out;
end $$;

-- Banques et file des cartes d'un deck (M5a-9) : deux instructions sur les cartes distinctes (une carte en double lèverait 21000), triées
-- par card_id (deux quiz_ensure croisés s'attendraient sinon sur l'unicité). (1) une banque template à chaque carte sans banque ; (2) la
-- file à 100 pour chaque carte sans banque llm, une priorité plus haute gardée.
create or replace function wm.quiz_ensure(p_card_ids uuid[])
returns void language sql security definer set search_path = '' as $$
  insert into wm.card_quizzes (card_id, prompt_version, source, model, questions)
  select x.id, 1, 'template', null, wm.template_quiz(x.id)
  from (select distinct unnest(p_card_ids) id) x
  where not exists (select from wm.card_quizzes q where q.card_id = x.id)
  order by x.id
  on conflict do nothing;
  insert into wm.quiz_queue (card_id, priority)
  select x.id, 100
  from (select distinct unnest(p_card_ids) id) x
  where not exists (select from wm.card_quizzes q where q.card_id = x.id and q.source = 'llm')
  order by x.id
  on conflict (card_id) do update set priority = excluded.priority where wm.quiz_queue.priority < excluded.priority;
$$;

-- Tirage de p_n questions d'une banque (C7) : d'abord des q_index absents de p_used, au hasard, puis des déjà tirés ; options aux ids
-- gen_random_uuid() rendues triées par id (aléa fort, insensible à setseed), et l'id de la bonne.
create or replace function wm.quiz_draw(p_questions jsonb, p_used int[], p_n int)
returns jsonb language sql volatile security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('q_index', x.i, 'prompt', x.q ->> 'prompt', 'options', o.opts, 'correct_option_id', o.ok)
    order by x.r), '[]')
  from (select q, i::int - 1 i, row_number() over (order by i::int - 1 = any (coalesce(p_used, '{}')), random()) r
    from jsonb_array_elements(p_questions) with ordinality t (q, i)) x
  cross join lateral (select jsonb_agg(jsonb_build_object('id', y.id, 'text', y.t) order by y.id) opts,
      max(y.id) filter (where y.j::int - 1 = (x.q ->> 'correct')::int) ok
    from (select gen_random_uuid()::text id, t, j from jsonb_array_elements_text(x.q -> 'options') with ordinality u (t, j)) y) o
  where x.r <= p_n
$$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
