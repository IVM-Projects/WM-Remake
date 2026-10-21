-- ADDITIVE : pool de tirage incrémental (M2-10, M2-11) — swap-with-last (pool_add, pool_remove), tirage pur pick_card, draw_cards qui l'appelle. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- Swap-with-last : la dernière carte de la rareté prend la place libérée, le pool reste dense (seq 1..n).
create or replace function wm.pool_remove(p_card_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_r public.rarity := (select rarity from wm.draw_pool where card_id = p_card_id);
  v_k int;
  v_n int;
begin
  if v_r is null then
    return false;
  end if;
  select n into v_n from wm.catalog_stats where rarity = v_r for update;
  -- seq relu sous le verrou : un retrait concurrent a pu déplacer la carte, ou la retirer.
  select seq into v_k from wm.draw_pool where card_id = p_card_id and rarity = v_r for update;
  if not found then
    return false;
  end if;
  delete from wm.draw_pool where rarity = v_r and seq = v_k;
  if v_k < v_n then
    update wm.draw_pool set seq = v_k where rarity = v_r and seq = v_n;
  end if;
  update wm.catalog_stats set n = v_n - 1 where rarity = v_r;
  return true;
end $$;

create or replace function wm.pool_add(p_card_id uuid, p_rarity public.rarity)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_r public.rarity := (select rarity from wm.draw_pool where card_id = p_card_id);
  v_n int;
begin
  if v_r = p_rarity then
    return;
  end if;
  if not exists (select from public.cards where id = p_card_id) then
    perform wm.raise_err(404, null, 'Carte introuvable');
  end if;
  -- Une rareté verrouillée à la fois ; un déplacement verrouille l'ancienne puis la nouvelle, sans risque tant que le merge est seul à déplacer.
  if v_r is not null then
    perform wm.pool_remove(p_card_id);
  end if;
  insert into wm.catalog_stats (rarity, n) values (p_rarity, 0) on conflict do nothing;
  select n into v_n from wm.catalog_stats where rarity = p_rarity for update;
  -- Relu sous le verrou : un ajout concurrent de la même carte a pu passer le contrôle du début.
  if exists (select from wm.draw_pool where card_id = p_card_id and rarity = p_rarity) then
    return;
  end if;
  insert into wm.draw_pool (rarity, seq, card_id) values (p_rarity, v_n + 1, p_card_id);
  update wm.catalog_stats set n = v_n + 1 where rarity = p_rarity;
end $$;

-- Sans écriture. Rareté au prorata des poids (non objet : n_r ; valeur non numérique : 0), puis numéro uniforme lu par PK ; null si rien n'est tirable.
-- Une seule instruction : catalog_stats et draw_pool lus dans le même instantané. CTE materialized : chaque random() tiré une fois, pas par ligne.
create or replace function wm.pick_card(p_weights jsonb, p_exclude public.rarity[] default '{}')
returns uuid language sql security definer set search_path = '' as $$
  with x as materialized (select random() a, random() b),
  s as (
    select rarity, n, sum(w) over (order by rarity) cum, sum(w) over () tot
    from (select rarity, n, case when jsonb_typeof(p_weights) is distinct from 'object' then n
                                 when jsonb_typeof(p_weights -> rarity::text) = 'number' then (p_weights ->> rarity::text)::numeric else 0 end w
          from wm.catalog_stats where n > 0 and rarity <> all (p_exclude)) a
    where w > 0
  ),
  r as (select s.rarity, s.n from s, x where s.cum > x.a * s.tot order by s.rarity limit 1)
  select d.card_id from r, x, wm.draw_pool d where d.rarity = r.rarity and d.seq = 1 + floor(x.b * r.n)::int
$$;

-- Un appel = un paquet (compteurs compris). Tirages indépendants, doublons possibles ; la meilleure carte en dernier.
create or replace function wm.draw_cards(p_uid uuid, p_n int, p_exclude public.rarity[] default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_w jsonb := (select value -> case when p.is_pro or p.is_vip then 'pro' else 'free' end
                from wm.config, public.profiles p where key = 'draw_weights' and p.id = p_uid);
  v_shiny jsonb := (select value from wm.config where key = 'shiny');
  v_out jsonb := '[]';
  v_id uuid;
  v_s boolean;
  v_new boolean;
  c public.cards;
  u public.user_cards;
begin
  for k in 1 .. p_n loop
    v_id := wm.pick_card(v_w, p_exclude);
    select * into c from public.cards where id = v_id;
    if not found then  -- aucune rareté tirable, ou pool manqué
      perform wm.raise_err(503, 'catalog_empty', 'Catalogue indisponible, réessaie dans un instant.');
    end if;
    v_s := (v_shiny -> 'scope') ? c.rarity::text and random() < (v_shiny ->> 'rate')::float8;
    v_new := not exists (select from public.user_cards where user_id = p_uid and card_id = c.id and is_shiny = v_s);
    u := wm.grant_copy(p_uid, c.id, v_s);
    v_out := v_out || jsonb_build_object('id', c.id, 'card_id', c.id, 'user_card_id', u.id,
      'card', jsonb_build_object('id', c.id, 'wikipedia_title', u.snapshot_title, 'rarity', u.snapshot_rarity, 'is_shiny', u.is_shiny),
      'wikipedia_title', u.snapshot_title, 'rarity', u.snapshot_rarity, 'snapshot_rarity', u.snapshot_rarity, 'is_shiny', u.is_shiny,
      'image_url', c.image_url, 'wikipedia_url', c.wikipedia_url, 'category', u.snapshot_category, 'summary', c.summary,
      'description', u.snapshot_category, 'atk', u.snapshot_atk, 'def', u.snapshot_def, 'hide_image', c.hide_image,
      'nsfw_image', c.nsfw_image, 'is_new', v_new);
  end loop;
  update wm.user_stats set packs_opened = packs_opened + 1, cards_obtained = cards_obtained + p_n where user_id = p_uid;
  return (select coalesce(jsonb_agg(x order by (x ->> 'snapshot_rarity')::public.rarity, (x ->> 'is_shiny')::boolean, ord), '[]')
          from jsonb_array_elements(v_out) with ordinality e (x, ord));
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
