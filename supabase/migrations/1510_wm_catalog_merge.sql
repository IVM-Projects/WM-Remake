-- ADDITIVE : catalogue réel (M2-9, M2-12, M2-20, P3, P6–P8) — source et médias des cartes, retraits, stage du chargement, fusion par lots
-- catalog_merge et catalog_finalize. Idempotente ; ne modifie aucune ligne existante (le seed sort du pool au premier catalog_finalize).
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

insert into wm.config (key, value, note) values
  ('catalog_frozen', 'false', 'Bascule : true → catalog_merge et catalog_finalize ne font rien (D§10.3.5)'),
  ('catalog_stats_frozen', 'false',
   'true → le chargement garde atk, def, q_score et qscore_refreshed_at des cartes existantes ; true en option A (D§10.1)'),
  ('sample_rate', '0.045',
   'Part de chaque rareté chargée sur le plan Free (C9, M2-3), mesurée le 2026-10-21 : 2 485 o/carte, 811 o/ligne de stage (mesure + 10 %), base 31 457 280 o')
on conflict do nothing;

-- Lien stable carte ↔ article : la correspondance par page_id survit aux renommages (M2-9).
create table if not exists wm.card_source (
  card_id uuid primary key references public.cards (id),
  page_id bigint not null unique
);

create table if not exists wm.card_media (
  card_id uuid primary key references public.cards (id),
  file text not null,
  author text,
  license text,
  license_url text
);

-- Retraits du staff (écrits au M6) : la fusion et la finalisation les respectent (D§10.3.3).
create table if not exists wm.card_removals (
  card_id uuid primary key references public.cards (id),
  reason text,
  removed_by uuid,
  removed_at timestamptz not null default now()
);

-- Colonnes de cards.csv dans son ordre (\copy les nomme).
create table if not exists wm.catalog_stage (
  page_id bigint primary key,
  wikipedia_title text not null,
  wikipedia_url text not null,
  lang text not null,
  rarity public.rarity not null,
  atk int not null,
  def int not null,
  q_score numeric(6, 2),
  pageviews int not null,
  pageviews_refreshed_at timestamptz,
  qscore_refreshed_at timestamptz,
  category text,
  summary text,
  image_url text
);

create table if not exists wm.catalog_stage_media (
  page_id bigint primary key,
  file text not null,
  author text,
  license text,
  license_url text
);

-- Résultat de chaque page fusionnée (P3), à part : le réécrire dans le stage doublerait son tas, sans autovacuum entre deux lots.
create table if not exists wm.catalog_stage_result (
  page_id bigint primary key,
  result text not null
);

create table if not exists wm.catalog_runs (
  id bigint generated always as identity primary key,
  mode text not null,
  finished_at timestamptz not null default now(),
  summary jsonb not null
);

-- Un lot = les p_limit premières pages du stage sans résultat (par page_id), en une transaction ; le chargement relance jusqu'à 0.
create or replace function wm.catalog_merge(p_mode text, p_limit int default 10000)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_stats boolean := (select value from wm.config where key = 'catalog_stats_frozen') = 'true'::jsonb;
  v_pages bigint[];
  v_card record;
begin
  if p_mode is null or p_mode not in ('full', 'sample') then
    perform wm.raise_err(400, 'invalid_request', 'Mode de chargement inconnu');
  end if;
  if p_limit is null or p_limit < 1 then
    perform wm.raise_err(400, 'invalid_request', 'Taille de lot invalide');
  end if;
  if (select value from wm.config where key = 'catalog_frozen') = 'true'::jsonb then
    return jsonb_build_object('processed', 0, 'frozen', true);
  end if;
  -- shortcut: chaque lot relit le stage depuis la première page (anti-jointure), négligeable pour l'échantillon ; au M8 (mode full), reprendre après le dernier page_id traité.
  v_pages := array(select s.page_id from wm.catalog_stage s
                   where not exists (select from wm.catalog_stage_result o where o.page_id = s.page_id) order by s.page_id limit p_limit);

  -- 1. Option A (D§10.3.1) : une carte sans card_source de même titre est celle de la page.
  insert into wm.card_source (card_id, page_id)
  select c.id, s.page_id from wm.catalog_stage s join public.cards c on c.lang = s.lang and c.wikipedia_title = s.wikipedia_title
  where s.page_id = any (v_pages) and not exists (select from wm.card_source x where x.page_id = s.page_id)
    and not exists (select from wm.card_source x where x.card_id = c.id);

  -- 2. Sans carte : un titre encore pris l'est par une carte liée à une autre page (P7), sinon nouvelle carte.
  insert into wm.catalog_stage_result (page_id, result)
  select s.page_id, 'conflict' from wm.catalog_stage s
  where s.page_id = any (v_pages) and not exists (select from wm.card_source x where x.page_id = s.page_id)
    and exists (select from public.cards c where c.lang = s.lang and c.wikipedia_title = s.wikipedia_title);
  with n as materialized (
    select gen_random_uuid() id, s.* from wm.catalog_stage s
    where s.page_id = any (v_pages) and not exists (select from wm.catalog_stage_result o where o.page_id = s.page_id)
      and not exists (select from wm.card_source x where x.page_id = s.page_id)
  ), ins as (
    insert into public.cards (id, wikipedia_title, wikipedia_url, lang, rarity, atk, def, q_score, pageviews, pageviews_refreshed_at,
      qscore_refreshed_at, category, summary, image_url)
    select id, wikipedia_title, wikipedia_url, lang, rarity, atk, def, q_score, pageviews, pageviews_refreshed_at,
      qscore_refreshed_at, category, summary, image_url from n
  ), res as (
    insert into wm.catalog_stage_result (page_id, result) select page_id, 'inserted' from n
  )
  insert into wm.card_source (card_id, page_id) select id, page_id from n;

  -- 3. Liste blanche (D§6.3), écrite seulement si elle change ; stats gardées si gelées, image si drapeau du staff (P6).
  -- Titre, URL et langue jamais réécrits : un titre différent compte comme renommage (M2-20).
  with v as (
    select x.card_id, s.page_id, s.wikipedia_title <> c.wikipedia_title renamed, s.rarity, s.pageviews, s.pageviews_refreshed_at,
      s.category, s.summary, case when v_stats then c.atk else s.atk end atk, case when v_stats then c.def else s.def end def,
      case when v_stats then c.q_score else s.q_score end q_score,
      case when v_stats then c.qscore_refreshed_at else s.qscore_refreshed_at end qscore_refreshed_at,
      case when c.hide_image or c.nsfw_image then c.image_url else s.image_url end image_url
    from wm.catalog_stage s join wm.card_source x on x.page_id = s.page_id join public.cards c on c.id = x.card_id
    where s.page_id = any (v_pages) and not exists (select from wm.catalog_stage_result o where o.page_id = s.page_id)
  ), upd as (
    update public.cards c set (rarity, pageviews, pageviews_refreshed_at, category, summary, atk, def, q_score, qscore_refreshed_at, image_url)
      = (v.rarity, v.pageviews, v.pageviews_refreshed_at, v.category, v.summary, v.atk, v.def, v.q_score, v.qscore_refreshed_at, v.image_url)
    from v
    where c.id = v.card_id and (c.rarity, c.pageviews, c.pageviews_refreshed_at, c.category, c.summary, c.atk, c.def, c.q_score,
      c.qscore_refreshed_at, c.image_url) is distinct from (v.rarity, v.pageviews, v.pageviews_refreshed_at, v.category, v.summary, v.atk,
      v.def, v.q_score, v.qscore_refreshed_at, v.image_url)
    returning c.id
  )
  insert into wm.catalog_stage_result (page_id, result)
  select page_id, case when renamed then 'renamed' when card_id in (select id from upd) then 'updated' else 'unchanged' end from v;

  -- 4. Médias, sauf drapeau image : upsert, ou suppression si la page n'en a plus ; un média changé fait une carte updated.
  with t as (
    select x.card_id, x.page_id from wm.card_source x join public.cards c on c.id = x.card_id
    where x.page_id = any (v_pages) and not (c.hide_image or c.nsfw_image)
  ), ups as (
    insert into wm.card_media as m (card_id, file, author, license, license_url)
    select t.card_id, sm.file, sm.author, sm.license, sm.license_url from t join wm.catalog_stage_media sm on sm.page_id = t.page_id
    on conflict (card_id) do update set file = excluded.file, author = excluded.author, license = excluded.license, license_url = excluded.license_url
    where (m.file, m.author, m.license, m.license_url) is distinct from (excluded.file, excluded.author, excluded.license, excluded.license_url)
    returning m.card_id
  ), del as (
    delete from wm.card_media m using t
    where m.card_id = t.card_id and not exists (select from wm.catalog_stage_media sm where sm.page_id = t.page_id)
    returning m.card_id
  )
  update wm.catalog_stage_result o set result = 'updated' from wm.card_source x
  where o.page_id = any (v_pages) and o.result = 'unchanged' and x.page_id = o.page_id
    and x.card_id in (select card_id from ups union all select card_id from del);

  -- 5. Pool par swap-with-last (M2-10), dans l'ordre des pages ; pool_add ne fait rien si la carte y est déjà dans sa rareté.
  -- shortcut: carte par carte, quadratique dans un lot (chaque appel ajoute une version à la ligne catalog_stats de sa rareté, d'où les
  -- lots de 10 000 : 2,1 s, contre 36 s pour 40 000) ; passer à une insertion groupée par rareté si le mode full (M8) est trop lent.
  for v_card in
    select c.id, c.rarity, exists (select from wm.card_removals k where k.card_id = c.id) removed
    from wm.card_source x join public.cards c on c.id = x.card_id where x.page_id = any (v_pages) order by x.page_id
  loop
    if v_card.removed then
      perform wm.pool_remove(v_card.id);
    else
      perform wm.pool_add(v_card.id, v_card.rarity);
    end if;
  end loop;
  return jsonb_build_object('processed', cardinality(v_pages), 'frozen', false);
end $$;

-- Fin d'un chargement : hors pool les cartes absentes du stage, seed compris (M2-12), sans supprimer de carte ; résumé ; stage vidé.
create or replace function wm.catalog_finalize(p_mode text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_out int := 0;
  v_sum jsonb;
  v_id uuid;
begin
  if p_mode is null or p_mode not in ('full', 'sample') then
    perform wm.raise_err(400, 'invalid_request', 'Mode de chargement inconnu');
  end if;
  if (select value from wm.config where key = 'catalog_frozen') = 'true'::jsonb then
    return jsonb_build_object('frozen', true);
  end if;
  -- Sinon un second appel, ou un stage inachevé, viderait le pool (P3).
  if not exists (select from wm.catalog_stage) then
    perform wm.raise_err(409, 'catalog_stage_empty', 'Aucun chargement à finaliser');
  end if;
  if exists (select from wm.catalog_stage s where not exists (select from wm.catalog_stage_result o where o.page_id = s.page_id)) then
    perform wm.raise_err(409, 'catalog_stage_pending', 'Chargement inachevé : relancer catalog_merge');
  end if;
  -- Carte sans card_source : page_id nul, donc jamais au stage. Lu d'avance par le curseur, que les retraits ne déplacent pas.
  -- shortcut: retraits carte par carte en une transaction, lent pour un gros retrait (sample_rate abaissé) ; retrait groupé par rareté s'il gêne.
  for v_id in
    select d.card_id from wm.draw_pool d left join wm.card_source x on x.card_id = d.card_id
    where not exists (select from wm.catalog_stage s where s.page_id = x.page_id) order by d.rarity, d.seq desc
  loop
    if wm.pool_remove(v_id) then
      v_out := v_out + 1;
    end if;
  end loop;
  v_sum := (select jsonb_build_object('mode', p_mode, 'staged', count(*), 'inserted', count(*) filter (where result = 'inserted'),
      'updated', count(*) filter (where result = 'updated'), 'unchanged', count(*) filter (where result = 'unchanged'),
      'renamed', count(*) filter (where result = 'renamed'), 'conflicts', count(*) filter (where result = 'conflict'), 'pool_out', v_out,
      'pool', (select jsonb_object_agg(k, coalesce(n.n, 0)) from unnest(enum_range(null::public.rarity)) k
               left join wm.catalog_stats n on n.rarity = k))
    from wm.catalog_stage join wm.catalog_stage_result using (page_id));
  insert into wm.catalog_runs (mode, summary) values (p_mode, v_sum);
  truncate wm.catalog_stage, wm.catalog_stage_media, wm.catalog_stage_result;
  return v_sum;
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
