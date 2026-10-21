-- ADDITIVE : catalogue = cartes du pool, recherche comprise (M2-13) ; page partagée sans joueur et overlay joueur (M2-14) ; crédits d'une image
-- (M2-16). Idempotente, sans écriture de données. Appliquée par le MCP (P9) : le mot SQL de suppression n'y figure pas, commentaires compris.

-- Corps de la page de 1400 sans overlay, limité au pool : join au lieu de left join, plus de carte hors pool en fin de rareté.
-- Recherche ou manquantes : total null et searchHasMore sans rarityCounts, d'où le bandeau « Recherche active » (D§7.4).
create or replace function wm.cards_list(p_uid uuid, p_page int, p_q text, p_rarity public.rarity[], p_wishlist boolean, p_missing boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_q text := nullif(btrim(p_q), '');
  v_rar public.rarity[] := nullif(p_rarity, '{}');
  v_off bigint := 50 * greatest(coalesce(p_page, 0), 0)::bigint;
  v_pat text;
  v_where text;
  v_ids uuid[];
  v_n bigint;
  v_meta jsonb;
begin
  if char_length(v_q) < 2 then
    perform wm.raise_err(400, 'invalid_request', 'La recherche demande au moins 2 caractères');
  end if;
  if v_q is null and p_wishlist is not true and p_missing is not true then
    -- limit : sous-requête latérale non aplatie, donc un parcours d'intervalle de la PK par rareté quelle que soit la taille du pool (D§7.4).
    v_ids := array(select d.card_id
      from (select rarity, sum(n) over (order by rarity desc) - n before from wm.catalog_stats where v_rar is null or rarity = any (v_rar)) k
      cross join lateral (select card_id, seq from wm.draw_pool
                          where rarity = k.rarity and seq between v_off - k.before + 1 and v_off - k.before + 50 order by seq limit 50) d
      order by k.rarity desc, d.seq);
    v_meta := jsonb_build_object('total', (select coalesce(sum(n), 0) from wm.catalog_stats where v_rar is null or rarity = any (v_rar)),
      'rarityCounts', (select jsonb_object_agg(r, coalesce(s.n, 0)) from unnest(enum_range(null::public.rarity)) r
                       left join wm.catalog_stats s on s.rarity = r));
  else
    -- Jokers LIKE pris à la lettre ; 2 caractères : préfixe du titre (index text_pattern_ops), sinon trigramme sans accents ni casse.
    v_pat := replace(replace(replace(case when char_length(v_q) = 2 then lower(v_q) else extensions.unaccent('extensions.unaccent', lower(v_q)) end,
      '\', '\\'), '%', '\%'), '_', '\_');
    -- Valeurs en littéraux : le plan ne garde que les filtres posés, et le préfixe LIKE constant peut prendre l'index.
    v_where := concat_ws(' and ',
      case when char_length(v_q) = 2 then format('lower(c.wikipedia_title) like %L', v_pat || '%')
           -- Ni lettre ni chiffre : aucun trigramme, l'index rendrait tout le catalogue à trier ; 'false' coupe le plan sans lecture.
           when v_q !~ '[[:alnum:]]' then 'false'
           when v_q is not null then format('wm_index.search_text(c.wikipedia_title, c.category) like %L', '%' || v_pat || '%') end,
      case when v_rar is not null then format('c.rarity = any (%L)', v_rar) end,
      case when p_wishlist then format('exists (select from public.wishlist_items w where w.user_id = %L and w.card_id = c.id)', p_uid) end,
      -- shortcut: anti-jointure, tri complet et offset ; à revoir au M8 sur le catalogue complet (2,77 M cartes).
      case when p_missing then format('not exists (select from public.user_cards uc where uc.user_id = %L and uc.card_id = c.id)', p_uid) end);
    -- 51 lues : la 51e décide searchHasMore. Ordre du catalogue dans chaque rareté (seq, D§7.4).
    execute format('select array(select c.id from public.cards c join wm.draw_pool d on d.card_id = c.id where %s
      order by c.rarity desc, d.seq, c.id limit 51 offset %s)', v_where, v_off) into v_ids;
    if v_q is null and p_missing is not true then
      execute format('select count(*) from public.cards c join wm.draw_pool d on d.card_id = c.id where %s', v_where) into v_n;
      v_meta := jsonb_build_object('total', v_n);
    else
      v_meta := jsonb_build_object('total', null, 'searchHasMore', cardinality(v_ids) > 50);
    end if;
  end if;
  v_ids := v_ids[1:50];
  return v_meta || jsonb_build_object(
    'cards', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'atk', c.atk, 'def', c.def, 'lang', c.lang, 'rarity', c.rarity,
        'q_score', c.q_score, 'category', c.category, 'image_url', c.image_url, 'pageviews', c.pageviews, 'hide_image', c.hide_image,
        'nsfw_image', c.nsfw_image, 'wikipedia_url', c.wikipedia_url, 'wikipedia_title', c.wikipedia_title, 'summary', c.summary,
        'pageviews_refreshed_at', c.pageviews_refreshed_at, 'qscore_refreshed_at', c.qscore_refreshed_at) order by p.o), '[]')
      from unnest(v_ids) with ordinality p (id, o) join public.cards c on c.id = p.id));
end $$;

-- Partie mise en cache par /api/cards (M2-14) : aucune donnée de joueur, donc la même pour tous.
create or replace function wm.cards_page_shared(p_page int default 0, p_sort text default 'rarity', p_q text default null,
  p_rarity public.rarity[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_sort is distinct from 'rarity' then
    perform wm.raise_err(400, 'invalid_request', 'Tri inconnu');
  end if;
  return wm.cards_list(null, p_page, p_q, p_rarity, false, false);
end $$;

-- Overlay non caché : ce que le joueur possède ou souhaite parmi p_card_ids, dans leur ordre.
create or replace function wm.cards_overlay(p_uid uuid, p_card_ids uuid[])
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'ownedCardIds', (select coalesce(jsonb_agg(p.id order by p.o), '[]') from unnest(p_card_ids) with ordinality p (id, o)
      where exists (select from public.user_cards uc where uc.card_id = p.id and uc.user_id = p_uid)),
    'wishlistCardIds', (select coalesce(jsonb_agg(p.id order by p.o), '[]') from unnest(p_card_ids) with ordinality p (id, o)
      where exists (select from public.wishlist_items w where w.user_id = p_uid and w.card_id = p.id)),
    -- shortcut: pas d'amis au M2, friendOwners vide ; le remplir avec la table d'amitié.
    'friendOwners', '{}'::jsonb)
$$;

-- Même signature et même réponse qu'en 1400 (l'app déployée l'appelle encore) ; souhaits et manquantes restent par joueur, sans cache.
create or replace function wm.cards_page(p_uid uuid, p_page int default 0, p_q text default null, p_rarity public.rarity[] default null,
  p_wishlist boolean default false, p_missing boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v jsonb := case when p_wishlist or p_missing then wm.cards_list(p_uid, p_page, p_q, p_rarity, p_wishlist, p_missing)
                  else wm.cards_page_shared(p_page, 'rarity', p_q, p_rarity) end;
begin
  return v || wm.cards_overlay(p_uid, array(select (e ->> 'id')::uuid from jsonb_array_elements(v -> 'cards') with ordinality x (e, o) order by o));
end $$;

-- Licence de l'image d'une carte (M2-16) ; sans média, la route rend 404.
create or replace function wm.card_credits(p_card_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v jsonb := (select jsonb_build_object('file', file, 'image_author', author, 'image_license', license, 'license_url', license_url)
              from wm.card_media where card_id = p_card_id);
begin
  if v is null then
    perform wm.raise_err(404, null, 'Carte introuvable');
  end if;
  return v;
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
