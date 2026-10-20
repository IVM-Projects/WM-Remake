-- ADDITIVE : paquets (D§7.2, D§7.0, C8, C10, C17) — pool de tirage, ouverture et ses gardes, Pro du jour, paquets spéciaux, grâce. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE, `where true` pour vider une table.

insert into wm.config (key, value, note) values
  ('pack_size', '5', 'Cartes par paquet (R§5.1)'),
  ('pro_daily', '{"size":15,"exclude":["C"],"min_gap_h":20}',
   'Paquet Pro du jour : taille, raretés exclues, heures minimum entre deux réclamations (contre le saut de fuseau). R§5.1, D§7.2'),
  ('shiny', '{"rate":0.01,"scope":["L"]}', 'Brillante : probabilité par carte tirée d''une rareté de scope (conflit n° 13, D§7.2)'),
  ('draw_weights', '{"free":null,"pro":null}',
   'Poids de rareté par offre ({"L":1,…}, rareté absente = 0) ; null = part de la rareté dans le catalogue (C8). Pro = gratuit (C27)'),
  ('open_min_interval_s', '1', 'Secondes minimum entre deux ouvertures ; 0 désactive (D§7.0)'),
  ('open_daily_cap', '600', 'Ouvertures par jour calendaire du fuseau du joueur (D§7.0)'),
  ('open_burst', '{"count":30,"window_s":600}', 'Ouvertures dans la fenêtre avant une nouvelle vérification humaine (D§7.0)')
on conflict do nothing;

create table if not exists wm.catalog_stats (
  rarity public.rarity primary key,
  n int not null
);

-- Dense par rareté (seq 1..n) : un tirage = une lecture par PK (C8).
create table if not exists wm.draw_pool (
  rarity public.rarity,
  seq int,
  card_id uuid not null unique references public.cards (id),
  primary key (rarity, seq)
);

create table if not exists wm.pro_daily_claims (
  user_id uuid references public.profiles (id) on delete cascade,
  day date,
  claimed_at timestamptz not null default now(),
  primary key (user_id, day)
);

create table if not exists wm.special_packs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  size int not null default 5 check (size > 0),
  exclude public.rarity[] not null default '{}',
  starts_at timestamptz,
  ends_at timestamptz
);

create table if not exists wm.special_pack_claims (
  pack_id uuid references wm.special_packs (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete cascade,
  claimed_at timestamptz not null default now(),
  primary key (pack_id, user_id)
);

create table if not exists wm.grace_grants (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  size int not null default 5 check (size > 0),
  reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  claimed_at timestamptz
);
create index if not exists grace_grants_unclaimed_idx on wm.grace_grants (user_id, id) where claimed_at is null;

-- shortcut: reconstruction complète (seed, chargement du catalogue) ; le M2 apporte le swap-with-last incrémental.
create or replace function wm.rebuild_draw_pool()
returns int language plpgsql security definer set search_path = '' as $$
begin
  delete from wm.draw_pool where true;
  insert into wm.draw_pool (rarity, seq, card_id)
  select rarity, row_number() over (partition by rarity order by id), id from public.cards;
  delete from wm.catalog_stats where true;
  insert into wm.catalog_stats (rarity, n) select rarity, count(*) from wm.draw_pool group by rarity;
  return (select count(*) from wm.draw_pool);
end $$;

-- Seul créateur de copies tirées (C10) : une ligne count = 1, snapshots figés au tirage.
create or replace function wm.grant_copy(p_uid uuid, p_card_id uuid, p_shiny boolean)
returns public.user_cards language plpgsql security definer set search_path = '' as $$
declare u public.user_cards;
begin
  insert into public.user_cards (user_id, card_id, is_shiny, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
  select p_uid, id, p_shiny, wikipedia_title, rarity, category, atk, def from public.cards where id = p_card_id
  returning * into u;
  if not found then
    perform wm.raise_err(404, null, 'Carte introuvable');
  end if;
  return u;
end $$;

-- Un appel = un paquet (compteurs compris). Tirages indépendants, doublons possibles ; la meilleure carte en dernier.
create or replace function wm.draw_cards(p_uid uuid, p_n int, p_exclude public.rarity[] default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_w jsonb := (select value -> case when p.is_pro or p.is_vip then 'pro' else 'free' end
                from wm.config, public.profiles p where key = 'draw_weights' and p.id = p_uid);
  v_shiny jsonb := (select value from wm.config where key = 'shiny');
  v_out jsonb := '[]';
  v_x float8;
  v_r public.rarity;
  v_n int;
  v_s boolean;
  v_new boolean;
  c public.cards;
  u public.user_cards;
begin
  for k in 1 .. p_n loop
    -- Rareté au prorata de n_r (ou des poids), puis numéro uniforme lu par PK. random() hors des requêtes : volatile, il serait tiré par ligne.
    v_x := random();
    select s.rarity, s.n into v_r, v_n from (
      select rarity, n, sum(w) over (order by rarity) cum, sum(w) over () tot
      from (select rarity, n, case when jsonb_typeof(v_w) = 'object' then coalesce((v_w ->> rarity::text)::numeric, 0) else n end w
            from wm.catalog_stats where n > 0 and rarity <> all (p_exclude)) a
      where w > 0
    ) s where s.cum > v_x * s.tot order by s.rarity limit 1;
    if found then
      v_n := 1 + floor(random() * v_n)::int;
      select cd.* into c from wm.draw_pool d join public.cards cd on cd.id = d.card_id where d.rarity = v_r and d.seq = v_n;
    end if;
    if not found then  -- aucune rareté tirable, ou pool en cours de reconstruction
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

-- Gardes communes aux paquets, sans écriture (le verrou de user_state est déjà tenu) : vérification humaine valide, rafale non pleine.
create or replace function wm.pack_guard(p_uid uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  b jsonb := (select value from wm.config where key = 'open_burst');
  s wm.user_state;
begin
  select * into s from wm.user_state where user_id = p_uid;
  if s.human_verified_until is null or s.human_verified_until <= now()
     or (s.open_window_start > now() - make_interval(secs => (b ->> 'window_s')::int) and s.open_window_count >= (b ->> 'count')::int) then
    perform wm.raise_err(403, 'human_verification_required', 'Vérification anti-bot requise pour continuer à ouvrir des paquets.',
      '{"human_verification_required": true}');
  end if;
end $$;

-- Fuseau que PG ne connaît pas (Intl en accepte d'autres) ou null : Europe/Paris, comme route(), au lieu d'un 500 ou d'un jour null.
-- Sondé par `at time zone` : pg_timezone_names relit toute la base tz (10 ms mesurés) à chaque appel.
create or replace function wm.safe_tz(p_tz text)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  perform now() at time zone p_tz;
  return coalesce(p_tz, 'Europe/Paris');
exception when invalid_parameter_value then
  return 'Europe/Paris';
end $$;

create or replace function wm.open_pack(p_uid uuid, p_tz text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_tz text := wm.safe_tz(p_tz);
  v_day date := (now() at time zone v_tz)::date;
  v_min int := (select value::int from wm.config where key = 'open_min_interval_s');
  v_cap int := (select value::int from wm.config where key = 'open_daily_cap');
  v_win interval := (select make_interval(secs => (value ->> 'window_s')::int) from wm.config where key = 'open_burst');
  v_resp jsonb;
  v_cards jsonb;
  p public.profiles;
  s wm.user_state;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid, 'packs');
  perform wm.lock_user(p_uid);
  p := wm.apply_regen(p_uid);
  perform wm.pack_guard(p_uid);
  -- Gardes calculées sur l'état stocké, sans écriture : l'exception annulerait tout compteur posé avant elle.
  select * into s from wm.user_state where user_id = p_uid;
  if v_min > 0 and s.last_open_at > now() - make_interval(secs => v_min) then
    perform wm.raise_err(429, null, 'Le site demande de ralentir',
      jsonb_build_object('rate_limited', true, 'retry_after', s.last_open_at + make_interval(secs => v_min)));
  end if;
  if s.opens_day = v_day and s.opens_day_count >= v_cap then
    perform wm.raise_err(429, null, 'Limite quotidienne de paquets atteinte',
      jsonb_build_object('rate_limit_daily', true, 'retry_after', (v_day + 1)::timestamp at time zone v_tz));
  end if;
  if p.packs_remaining < 1 then
    perform wm.raise_err(403, null, 'Plus de paquets disponibles',
      jsonb_build_object('packs_remaining', 0, 'next_regen_at', wm.next_regen_at(p)));
  end if;
  -- Stock plein, ou horloge jamais démarrée (donnée migrée) : la régénération part de maintenant (D§7.2, R7).
  update public.profiles set packs_remaining = packs_remaining - 1,
    packs_last_regen_at = case when packs_remaining >= pack_cap or packs_last_regen_at is null then now() else packs_last_regen_at end
  where id = p_uid
  returning * into p;
  update wm.user_state set last_open_at = now(),
    opens_day_count = case when opens_day = v_day then opens_day_count + 1 else 1 end, opens_day = v_day,
    open_window_count = case when open_window_start > now() - v_win then open_window_count + 1 else 1 end,
    open_window_start = case when open_window_start > now() - v_win then open_window_start else now() end
  where user_id = p_uid;
  v_cards := wm.draw_cards(p_uid, (select value::int from wm.config where key = 'pack_size'));
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('cards', v_cards, 'packs_remaining', p.packs_remaining,
    'packs_last_regen_at', p.packs_last_regen_at, 'next_regen_at', wm.next_regen_at(p),
    'owned_copies', (select jsonb_agg(jsonb_build_object('card_id', k.card_id, 'is_shiny', k.is_shiny, 'count',
        (select sum(uc.count) from public.user_cards uc where uc.user_id = p_uid and uc.card_id = k.card_id and uc.is_shiny = k.is_shiny)))
      from (select distinct (x ->> 'card_id')::uuid card_id, (x ->> 'is_shiny')::boolean is_shiny from jsonb_array_elements(v_cards) x) k)));
end $$;

-- Lecture seule. Jour du fuseau ET écart minimal depuis la dernière réclamation : changer de fuseau ne donne pas deux paquets (D§7.2).
create or replace function wm.pro_daily_status(p_uid uuid, p_tz text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_cfg jsonb := (select value from wm.config where key = 'pro_daily');
  v_tz text := wm.safe_tz(p_tz);
  v_day date := (now() at time zone v_tz)::date;
  v_pro boolean := (select is_pro or is_vip from public.profiles where id = p_uid);
  v_today boolean := exists (select from wm.pro_daily_claims where user_id = p_uid and day = v_day);
  v_next timestamptz;
begin
  if v_pro is null then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  v_next := greatest(case when v_today then (v_day + 1)::timestamp at time zone v_tz end,
    (select max(claimed_at) from wm.pro_daily_claims where user_id = p_uid) + make_interval(hours => (v_cfg ->> 'min_gap_h')::int));
  if v_next <= now() then
    v_next := null;
  end if;
  return jsonb_build_object('eligible', v_pro and v_next is null, 'claimed_today', v_today, 'size', (v_cfg ->> 'size')::int,
    'is_pro', v_pro, 'next_claim_at', v_next);
end $$;

create or replace function wm.pro_daily_claim(p_uid uuid, p_tz text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_cfg jsonb := (select value from wm.config where key = 'pro_daily');
  v_tz text := wm.safe_tz(p_tz);
  v_resp jsonb;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid, 'packs');
  perform wm.lock_user(p_uid);
  perform wm.apply_regen(p_uid);
  perform wm.pack_guard(p_uid);
  v_resp := wm.pro_daily_status(p_uid, v_tz);  -- sous le verrou du profil : deux réclamations concurrentes se suivent
  if not (v_resp ->> 'is_pro')::boolean then
    perform wm.raise_err(403, 'pro_required', 'Fonction réservée aux membres Pro');
  end if;
  if not (v_resp ->> 'eligible')::boolean then
    perform wm.raise_err(409, 'already_claimed', 'Paquet Pro du jour déjà récupéré',
      jsonb_build_object('next_claim_at', v_resp -> 'next_claim_at'));
  end if;
  insert into wm.pro_daily_claims (user_id, day) values (p_uid, (now() at time zone v_tz)::date);
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('cards', wm.draw_cards(p_uid, (v_cfg ->> 'size')::int,
    array(select jsonb_array_elements_text(v_cfg -> 'exclude'))::public.rarity[])));
end $$;

-- Paquets actifs que le joueur n'a pas encore réclamés.
create or replace function wm.special_packs(p_uid uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('packs', coalesce(jsonb_agg(jsonb_build_object('id', sp.id, 'name', sp.name, 'title', sp.name,
      'description', sp.description, 'size', sp.size) order by sp.starts_at nulls first, sp.id), '[]'), 'available', count(*) > 0)
  from wm.special_packs sp
  where (sp.starts_at is null or sp.starts_at <= now()) and (sp.ends_at is null or sp.ends_at > now())
    and not exists (select from wm.special_pack_claims c where c.pack_id = sp.id and c.user_id = p_uid)
$$;

-- Ne consomme pas le stock ; packs_remaining est renvoyé tel quel (R§3.1).
create or replace function wm.claim_special(p_uid uuid, p_pack_id uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  p public.profiles;
  sp wm.special_packs;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid, 'packs');
  perform wm.lock_user(p_uid);
  p := wm.apply_regen(p_uid);
  perform wm.pack_guard(p_uid);
  select * into sp from wm.special_packs
  where id = p_pack_id and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now());
  if not found then
    perform wm.raise_err(404, null, 'Paquet introuvable');
  end if;
  insert into wm.special_pack_claims (pack_id, user_id) values (p_pack_id, p_uid) on conflict do nothing;
  if not found then
    perform wm.raise_err(409, 'already_claimed', 'Paquet déjà récupéré');
  end if;
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('cards', wm.draw_cards(p_uid, sp.size, sp.exclude),
    'packs_remaining', p.packs_remaining));
end $$;

create or replace function wm.claim_grace(p_uid uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_size int;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid, 'packs');
  perform wm.lock_user(p_uid);
  perform wm.apply_regen(p_uid);
  perform wm.pack_guard(p_uid);
  -- La plus ancienne d'abord ; le verrou du profil sérialise les réclamations concurrentes.
  update wm.grace_grants set claimed_at = now()
  where id = (select id from wm.grace_grants where user_id = p_uid and claimed_at is null order by id limit 1)
  returning size into v_size;
  if not found then
    perform wm.raise_err(404, 'no_grace', 'Aucun paquet de grâce disponible');
  end if;
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('cards', wm.draw_cards(p_uid, v_size)));
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
