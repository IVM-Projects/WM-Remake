-- Paquets (1200_wm_packs.sql) : pool de tirage, ouverture et ses gardes, brillantes, Pro du jour, paquets spéciaux, grâce.
-- Mini-catalogue créé ici (le seed n'est pas chargé) ; now() est figé pour tout le fichier.

-- Exécute p_sql et renvoie le detail JSON de l'erreur P0001 levée (null si aucune) ; l'effet de p_sql n'est annulé que si p_sql lève.
create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare d text; begin
  execute p_sql;
  return null;
exception when sqlstate 'P0001' then
  get stacked diagnostics d = pg_exception_detail;
  return d::jsonb;
end $$;

-- Joueur vérifié avec p_stock paquets, horloge de régénération démarrée maintenant (sauf stock plein).
create function pg_temp.player(p_name text, p_stock int default 1) returns uuid language plpgsql as $$
declare u uuid := tests.make_user(p_name); begin
  perform wm.set_human_verified(u);
  update public.profiles set packs_remaining = p_stock, packs_last_regen_at = case when p_stock < pack_cap then now() end where id = u;
  return u;
end $$;

-- Ordre de révélation : rareté croissante, la brillante après la normale (la meilleure carte en dernier).
create function pg_temp.sorted(p_cards jsonb) returns boolean language sql as $$
  select array_agg(format('%s:%s', x ->> 'snapshot_rarity', x ->> 'is_shiny') order by i)
    = array_agg(format('%s:%s', x ->> 'snapshot_rarity', x ->> 'is_shiny') order by (x ->> 'snapshot_rarity')::public.rarity, (x ->> 'is_shiny')::boolean)
  from jsonb_array_elements(p_cards) with ordinality e (x, i)
$$;

-- Clés de config, chacune avec sa note.
do $$ begin
  assert (select jsonb_object_agg(key, value) from wm.config where key in ('pack_size', 'pro_daily', 'shiny', 'draw_weights',
    'open_min_interval_s', 'open_daily_cap', 'open_burst')) = '{"pack_size":5,"pro_daily":{"size":15,"exclude":["C"],"min_gap_h":20},
    "shiny":{"rate":0.01,"scope":["L"]},"draw_weights":{"free":null,"pro":null},"open_min_interval_s":1,"open_daily_cap":600,
    "open_burst":{"count":30,"window_s":600}}'::jsonb, 'config des paquets';
  assert not exists (select from wm.config where key in ('pack_size', 'pro_daily', 'shiny', 'draw_weights', 'open_min_interval_s',
    'open_daily_cap', 'open_burst') and coalesce(note, '') = ''), 'note manquante';
end $$;

-- Catalogue vide → 503.
do $$ declare u uuid := pg_temp.player('Empty1'); d jsonb; begin
  delete from wm.draw_pool;
  delete from wm.catalog_stats;
  d := pg_temp.err(format('select wm.open_pack(%L, %L)', u, 'Europe/Paris'));
  assert d = '{"status":503,"code":"catalog_empty","error":"Catalogue indisponible, réessaie dans un instant.","message":"Catalogue indisponible, réessaie dans un instant."}'::jsonb, coalesce(d::text, 'accepté');
end $$;

-- rebuild_draw_pool : 3 C, 2 R, 1 L → stats {C:3, R:2, L:1}, seq 1..n dans l'ordre des id ; rejouable.
do $$ begin
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, category, summary)
  select 'Essai ' || r || i, 'https://fr.wikipedia.org/wiki/Essai_' || r || i, r::public.rarity, 1000 + i, 2000 + i, 'Catégorie ' || r, 'Résumé ' || i
  from unnest(array['C', 'C', 'C', 'R', 'R', 'L']) with ordinality x (r, i);
  assert wm.rebuild_draw_pool() = 6;
  assert wm.rebuild_draw_pool() = 6, 'reconstruction non rejouable';
  assert (select jsonb_object_agg(rarity, n) from wm.catalog_stats) = '{"C":3,"R":2,"L":1}'::jsonb,
    (select jsonb_object_agg(rarity, n) from wm.catalog_stats)::text;
  assert not exists (select from (select seq, row_number() over (partition by rarity order by card_id) rn from wm.draw_pool) x where seq <> rn),
    'seq troués ou hors de l''ordre des id';
  assert (select count(*) from wm.draw_pool d join public.cards c on c.id = d.card_id and c.rarity = d.rarity) = 6, 'pool différent du catalogue';
end $$;

-- open_pack : stock 1 → 5 cartes triées au format CardInPack, 5 copies aux snapshots de la carte, stock 0, compteurs, état anti-abus.
do $$ declare u uuid := pg_temp.player('Open1'); r jsonb; begin
  r := wm.open_pack(u, 'Europe/Paris');
  assert r ?& array['cards', 'packs_remaining', 'packs_last_regen_at', 'next_regen_at', 'owned_copies'] and jsonb_array_length(r -> 'cards') = 5, r::text;
  -- Chaque carte = exactement sa copie et sa carte (union R§3.1), is_new mis à part.
  assert (select count(*) from jsonb_array_elements(r -> 'cards') x join public.user_cards uc on uc.id = (x ->> 'user_card_id')::uuid
    join public.cards c on c.id = uc.card_id
    where uc.user_id = u and uc.count = 1 and x - 'is_new' = jsonb_build_object('id', c.id, 'card_id', c.id, 'user_card_id', uc.id,
      'card', jsonb_build_object('id', c.id, 'wikipedia_title', c.wikipedia_title, 'rarity', c.rarity, 'is_shiny', uc.is_shiny),
      'wikipedia_title', c.wikipedia_title, 'rarity', c.rarity, 'snapshot_rarity', c.rarity, 'is_shiny', uc.is_shiny, 'image_url', c.image_url,
      'wikipedia_url', c.wikipedia_url, 'category', c.category, 'summary', c.summary, 'description', c.category, 'atk', c.atk, 'def', c.def,
      'hide_image', c.hide_image, 'nsfw_image', c.nsfw_image)
    and (uc.snapshot_title, uc.snapshot_rarity, uc.snapshot_category, uc.snapshot_atk, uc.snapshot_def) = (c.wikipedia_title, c.rarity, c.category, c.atk, c.def)) = 5,
    'cartes ou copies : ' || r::text;
  assert (select count(*) from public.user_cards where user_id = u) = 5, 'copies en trop';
  assert pg_temp.sorted(r -> 'cards'), 'cartes non triées : ' || r::text;
  assert (select count(*) filter (where (x ->> 'is_new')::boolean) from jsonb_array_elements(r -> 'cards') x)
    = (select count(*) from (select distinct card_id, is_shiny from public.user_cards where user_id = u) d), 'is_new';
  assert (select jsonb_agg(o order by o ->> 'card_id', o ->> 'is_shiny') from jsonb_array_elements(r -> 'owned_copies') o)
    = (select jsonb_agg(jsonb_build_object('card_id', card_id, 'is_shiny', is_shiny, 'count', n) order by card_id::text, is_shiny::text)
       from (select card_id, is_shiny, sum(count) n from public.user_cards where user_id = u group by 1, 2) g), 'owned_copies : ' || r::text;
  assert r -> 'packs_remaining' = '0' and (select packs_remaining from public.profiles where id = u) = 0, 'stock';
  assert (r ->> 'packs_last_regen_at')::timestamptz = now() and (r ->> 'next_regen_at')::timestamptz = now() + interval '600 seconds', r::text;
  assert (select packs_opened = 1 and cards_obtained = 5 from wm.user_stats where user_id = u), 'user_stats';
  assert (select last_open_at = now() and opens_day = (now() at time zone 'Europe/Paris')::date and opens_day_count = 1
    and open_window_start = now() and open_window_count = 1 from wm.user_state where user_id = u), 'user_state';
end $$;

-- Horloge à la consommation (D§7.2, R7) : stock plein (même daté d'avant) ou date nulle → now() ; stock entamé daté → inchangée.
do $$ declare v record; u uuid; r jsonb; begin
  for v in select * from (values (1, 10, now() - interval '1 hour', now()), (2, 10, null::timestamptz, now()), (3, 3, null, now()),
                                 (4, 5, now() - interval '5 minutes', now() - interval '5 minutes')) x (k, n, t, want) loop
    u := pg_temp.player('Last' || v.k);
    update public.profiles set packs_remaining = v.n, packs_last_regen_at = v.t where id = u;
    r := wm.open_pack(u, 'Europe/Paris');
    assert (r ->> 'packs_remaining')::int = v.n - 1 and (r ->> 'packs_last_regen_at')::timestamptz = v.want
      and (r ->> 'next_regen_at')::timestamptz = v.want + interval '600 seconds'
      and (select packs_last_regen_at from public.profiles where id = u) = v.want, format('%s/%s %s : %s', v.n, 10, v.t, r - 'cards' - 'owned_copies');
  end loop;
end $$;

-- Sans vérification humaine, ou expirée → 403 exact, sur les quatre paquets.
do $$ declare u uuid := tests.make_user('Human1'); d jsonb; f text; begin
  foreach f in array array[format('wm.open_pack(%L, %L)', u, 'Europe/Paris'), format('wm.pro_daily_claim(%L, %L)', u, 'Europe/Paris'),
                           format('wm.claim_special(%L, %L)', u, gen_random_uuid()), format('wm.claim_grace(%L)', u)] loop
    d := pg_temp.err('select ' || f);
    assert d = '{"status":403,"code":"human_verification_required","error":"Vérification anti-bot requise pour continuer à ouvrir des paquets.","message":"Vérification anti-bot requise pour continuer à ouvrir des paquets.","human_verification_required":true}'::jsonb,
      f || ' → ' || coalesce(d::text, 'accepté');
  end loop;
  perform wm.set_human_verified(u);
  update wm.user_state set human_verified_until = now() where user_id = u;
  assert pg_temp.err(format('select wm.open_pack(%L, %L)', u, 'Europe/Paris')) ->> 'code' = 'human_verification_required', 'vérification expirée acceptée';
end $$;

-- Rafale : 30 ouvertures dans la fenêtre de 600 s → la 31e reçoit le même 403 ; set_human_verified la remet à zéro. Fenêtre échue → repart à 1.
do $$ declare u uuid := pg_temp.player('Burst1', 5); d jsonb; begin
  update wm.user_state set open_window_start = now() - interval '5 minutes', open_window_count = 30 where user_id = u;
  d := pg_temp.err(format('select wm.open_pack(%L, %L)', u, 'Europe/Paris'));
  assert d ->> 'code' = 'human_verification_required' and d -> 'human_verification_required' = 'true', coalesce(d::text, 'accepté');
  perform wm.set_human_verified(u);
  perform wm.open_pack(u, 'Europe/Paris');
  assert (select open_window_start = now() - interval '5 minutes' and open_window_count = 1 from wm.user_state where user_id = u), 'rafale après vérification';
  update wm.user_state set open_window_start = now() - interval '601 seconds', open_window_count = 30, last_open_at = null where user_id = u;
  perform wm.open_pack(u, 'Europe/Paris');
  assert (select open_window_start = now() and open_window_count = 1 from wm.user_state where user_id = u), 'fenêtre échue non réouverte';
end $$;

-- Intervalle : dernière ouverture à now() → 429, retry_after = now() + 1 s ; il y a 1 s → passe.
do $$ declare u uuid := pg_temp.player('Gap1', 5); d jsonb; begin
  update wm.user_state set last_open_at = now() where user_id = u;
  d := pg_temp.err(format('select wm.open_pack(%L, %L)', u, 'Europe/Paris'));
  assert d - 'retry_after' = '{"status":429,"error":"Le site demande de ralentir","message":"Le site demande de ralentir","rate_limited":true}'::jsonb
    and (d ->> 'retry_after')::timestamptz = now() + interval '1 second', coalesce(d::text, 'accepté');
  update wm.user_state set last_open_at = now() - interval '1 second' where user_id = u;
  assert pg_temp.err(format('select wm.open_pack(%L, %L)', u, 'Europe/Paris')) is null, 'ouverture 1 s après refusée';
end $$;

-- Plafond quotidien dans le fuseau : 600 ce jour-là → 429 jusqu'au minuit local suivant ; la veille, ou un fuseau déjà au lendemain → passe.
-- Etc/GMT+12 (UTC−12) et Etc/GMT-14 (UTC+14) : 26 h d'écart, jamais le même jour.
do $$ declare u uuid := pg_temp.player('Cap1', 5); w text := 'Etc/GMT+12'; dw date := (now() at time zone 'Etc/GMT+12')::date;
  dp date := (now() at time zone 'Europe/Paris')::date; d jsonb; begin
  update wm.user_state set opens_day = dw, opens_day_count = 600 where user_id = u;
  d := pg_temp.err(format('select wm.open_pack(%L, %L)', u, w));
  assert d - 'retry_after' = '{"status":429,"error":"Limite quotidienne de paquets atteinte","message":"Limite quotidienne de paquets atteinte","rate_limit_daily":true}'::jsonb
    and (d ->> 'retry_after')::timestamptz = (dw + 1)::timestamp at time zone w, coalesce(d::text, 'accepté');
  assert pg_temp.err(format('select wm.open_pack(%L, %L)', u, 'Etc/GMT-14')) is null, 'plafond d''un autre jour appliqué';
  update wm.user_state set opens_day = dp - 1, opens_day_count = 600, last_open_at = null where user_id = u;
  perform wm.open_pack(u, 'Europe/Paris');
  assert (select opens_day = dp and opens_day_count = 1 from wm.user_state where user_id = u), 'compteur du jour non remis à 1';
end $$;

-- Fuseau connu de PG → tel quel ; null ou inconnu de PG → Europe/Paris : le plafond suit le jour de Paris, sans erreur.
do $$ declare u uuid := pg_temp.player('Tz1', 5); dp date := (now() at time zone 'Europe/Paris')::date; d jsonb; tz text; begin
  assert wm.safe_tz('Etc/GMT+12') = 'Etc/GMT+12' and wm.safe_tz(null) = 'Europe/Paris' and wm.safe_tz('Mars/Olympus') = 'Europe/Paris', 'safe_tz';
  update wm.user_state set opens_day = dp, opens_day_count = 600 where user_id = u;
  foreach tz in array array[null, 'Mars/Olympus'] loop
    d := pg_temp.err(format('select wm.open_pack(%L, %L)', u, tz));
    assert d -> 'rate_limit_daily' = 'true' and (d ->> 'retry_after')::timestamptz = (dp + 1)::timestamp at time zone 'Europe/Paris',
      coalesce(tz, 'null') || ' → ' || coalesce(d::text, 'accepté');
  end loop;
  update wm.user_state set opens_day = dp - 1 where user_id = u;
  perform wm.open_pack(u, 'Mars/Olympus');
  assert (select opens_day = dp and opens_day_count = 1 from wm.user_state where user_id = u), 'jour de Paris non utilisé';
end $$;

-- Stock vide → 403 avec next_regen_at.
do $$ declare u uuid := pg_temp.player('Stock0', 0); d jsonb; begin
  update public.profiles set packs_last_regen_at = now() - interval '1 minute' where id = u;
  d := pg_temp.err(format('select wm.open_pack(%L, %L)', u, 'Europe/Paris'));
  assert d - 'next_regen_at' = '{"status":403,"error":"Plus de paquets disponibles","message":"Plus de paquets disponibles","packs_remaining":0}'::jsonb
    and (d ->> 'next_regen_at')::timestamptz = now() + interval '540 seconds', coalesce(d::text, 'accepté');
end $$;

-- Restriction : activity_blocked_until → 403 de wm.actor ; packs_blocked_until → 403 sur les quatre paquets.
do $$ declare u uuid := pg_temp.player('Block1'); t timestamptz := now() + interval '1 hour'; d jsonb; f text; begin
  update public.profiles set activity_blocked_until = t where id = u;
  d := pg_temp.err(format('select wm.open_pack(%L, %L)', u, 'Europe/Paris'));
  assert d ->> 'status' = '403' and d ->> 'error' = 'Ton compte est temporairement restreint.' and (d ->> 'activity_blocked_until')::timestamptz = t,
    coalesce(d::text, 'accepté');
  update public.profiles set activity_blocked_until = null, packs_blocked_until = t where id = u;
  foreach f in array array[format('wm.open_pack(%L, %L)', u, 'Europe/Paris'), format('wm.pro_daily_claim(%L, %L)', u, 'Europe/Paris'),
                           format('wm.claim_special(%L, %L)', u, gen_random_uuid()), format('wm.claim_grace(%L)', u)] loop
    d := pg_temp.err('select ' || f);
    assert d ->> 'status' = '403' and (d ->> 'packs_blocked_until')::timestamptz = t, f || ' → ' || coalesce(d::text, 'accepté');
  end loop;
end $$;

-- Idempotency-Key rejouée → même réponse, aucune nouvelle copie, un seul paquet consommé.
do $$ declare u uuid := pg_temp.player('Idem1', 3); a jsonb; begin
  a := wm.open_pack(u, 'Europe/Paris', 'k1');
  assert wm.open_pack(u, 'Europe/Paris', 'k1') = a, 'réponse rejouée différente';
  assert (select count(*) from public.user_cards where user_id = u) = 5 and (select packs_remaining from public.profiles where id = u) = 2, 'rejeu exécuté';
end $$;

-- Poids {"L":1} et shiny.rate = 1 → 5 L brillantes, seule la première nouvelle (la L normale déjà possédée est un autre couple) ;
-- {"C":1} → 5 C normales ; un Pro tire avec les poids pro ; ordre sur un paquet mêlé. grant_copy d'une carte inconnue → 404.
do $$ declare u uuid := pg_temp.player('Shiny1'); v uuid := pg_temp.player('Shiny2'); p uuid := pg_temp.player('Shiny3');
  l uuid := (select id from public.cards where rarity = 'L'); r jsonb; d jsonb; begin
  update wm.config set value = '{"rate":1,"scope":["L"]}' where key = 'shiny';
  update wm.config set value = '{"free":{"L":1},"pro":null}' where key = 'draw_weights';
  perform wm.grant_copy(u, l, false);
  r := wm.open_pack(u, 'Europe/Paris');
  assert (select array_agg(format('%s:%s:%s:%s', (x ->> 'card_id' = l::text)::text, x ->> 'rarity', x ->> 'is_shiny', x ->> 'is_new') order by i)
          from jsonb_array_elements(r -> 'cards') with ordinality e (x, i))
    = array['true:L:true:true', 'true:L:true:false', 'true:L:true:false', 'true:L:true:false', 'true:L:true:false'], r::text;
  assert r -> 'owned_copies' = jsonb_build_array(jsonb_build_object('card_id', l, 'is_shiny', true, 'count', 5)), r::text;
  update wm.config set value = '{"free":{"C":1},"pro":{"R":1}}' where key = 'draw_weights';
  r := wm.open_pack(v, 'Europe/Paris');
  assert (select bool_and(x ->> 'rarity' = 'C' and x ->> 'is_shiny' = 'false') from jsonb_array_elements(r -> 'cards') x), r::text;
  update public.profiles set is_pro = true where id = p;
  r := wm.open_pack(p, 'Europe/Paris');
  assert (select bool_and(x ->> 'rarity' = 'R') from jsonb_array_elements(r -> 'cards') x), 'poids pro ignorés : ' || r::text;
  -- Tri sur 20 cartes C, L et L brillantes (taux 0,5) : l'assertion tient pour tout tirage, le mélange est quasi certain.
  update wm.config set value = '{"rate":0.5,"scope":["L"]}' where key = 'shiny';
  update wm.config set value = '{"free":{"C":1,"L":1},"pro":null}' where key = 'draw_weights';
  insert into wm.grace_grants (user_id, size) values (v, 20);
  r := wm.claim_grace(v);
  assert jsonb_array_length(r -> 'cards') = 20 and pg_temp.sorted(r -> 'cards'), 'tri : ' || r::text;
  update wm.config set value = '{"rate":0.01,"scope":["L"]}' where key = 'shiny';
  update wm.config set value = '{"free":null,"pro":null}' where key = 'draw_weights';
  d := pg_temp.err(format('select wm.grant_copy(%L, %L, false)', u, gen_random_uuid()));
  assert d = '{"status":404,"error":"Carte introuvable","message":"Carte introuvable"}'::jsonb, coalesce(d::text, 'accepté');
end $$;

-- Paquet Pro du jour : non-Pro → 403 ; Pro → 15 cartes sans C, stock intact ; même jour → 409 ; fuseau déjà au lendemain mais < 20 h → 409 ;
-- 21 h plus tard, jour suivant → succès. pro_daily_status suit chaque état ; VIP seul = Pro.
do $$ declare n uuid := pg_temp.player('ProNo'); u uuid := pg_temp.player('ProYes'); w text := 'Etc/GMT+12'; e text := 'Etc/GMT-14';
  dw date := (now() at time zone 'Etc/GMT+12')::date; r jsonb; s jsonb; d jsonb; begin
  assert wm.pro_daily_status(n, w) = '{"eligible":false,"claimed_today":false,"size":15,"is_pro":false,"next_claim_at":null}'::jsonb, wm.pro_daily_status(n, w)::text;
  d := pg_temp.err(format('select wm.pro_daily_claim(%L, %L)', n, w));
  assert d = '{"status":403,"code":"pro_required","error":"Fonction réservée aux membres Pro","message":"Fonction réservée aux membres Pro"}'::jsonb, coalesce(d::text, 'accepté');
  update public.profiles set is_pro = true where id = u;
  assert wm.pro_daily_status(u, w) = '{"eligible":true,"claimed_today":false,"size":15,"is_pro":true,"next_claim_at":null}'::jsonb, wm.pro_daily_status(u, w)::text;
  r := wm.pro_daily_claim(u, w);
  assert jsonb_array_length(r -> 'cards') = 15 and not jsonb_path_exists(r, '$.cards[*] ? (@.rarity == "C")'), r::text;
  assert (select count(*) from public.user_cards where user_id = u) = 15 and (select packs_remaining from public.profiles where id = u) = 1, 'copies ou stock';
  assert pg_temp.sorted(r -> 'cards'), 'cartes non triées';
  assert exists (select from wm.pro_daily_claims where user_id = u and day = dw and claimed_at = now()), 'réclamation non enregistrée';
  s := wm.pro_daily_status(u, w);
  assert s = jsonb_build_object('eligible', false, 'claimed_today', true, 'size', 15, 'is_pro', true,
    'next_claim_at', greatest((dw + 1)::timestamp at time zone w, now() + interval '20 hours')), s::text;
  d := pg_temp.err(format('select wm.pro_daily_claim(%L, %L)', u, w));
  assert d - 'next_claim_at' = '{"status":409,"code":"already_claimed","error":"Paquet Pro du jour déjà récupéré","message":"Paquet Pro du jour déjà récupéré"}'::jsonb
    and d -> 'next_claim_at' = s -> 'next_claim_at', coalesce(d::text, 'accepté');
  assert wm.pro_daily_status(u, e) = jsonb_build_object('eligible', false, 'claimed_today', false, 'size', 15, 'is_pro', true,
    'next_claim_at', now() + interval '20 hours'), wm.pro_daily_status(u, e)::text;
  d := pg_temp.err(format('select wm.pro_daily_claim(%L, %L)', u, e));
  assert d ->> 'code' = 'already_claimed' and (d ->> 'next_claim_at')::timestamptz = now() + interval '20 hours', coalesce(d::text, 'accepté');
  update wm.pro_daily_claims set day = day - 1, claimed_at = now() - interval '21 hours' where user_id = u;
  assert wm.pro_daily_status(u, w) ->> 'eligible' = 'true', wm.pro_daily_status(u, w)::text;
  assert jsonb_array_length(wm.pro_daily_claim(u, w) -> 'cards') = 15, 'réclamation du lendemain refusée';
  update public.profiles set is_vip = true where id = n;
  assert wm.pro_daily_status(n, w) ->> 'eligible' = 'true', 'VIP non éligible';
end $$;

-- Paquet Pro du jour sans fuseau → réclamé au jour de Paris.
do $$ declare u uuid := pg_temp.player('ProTz'); begin
  update public.profiles set is_pro = true where id = u;
  assert jsonb_array_length(wm.pro_daily_claim(u, null) -> 'cards') = 15, 'réclamation sans fuseau';
  assert exists (select from wm.pro_daily_claims where user_id = u and day = (now() at time zone 'Europe/Paris')::date), 'jour de la réclamation';
  assert wm.pro_daily_status(u, 'Mars/Olympus') ->> 'claimed_today' = 'true', wm.pro_daily_status(u, 'Mars/Olympus')::text;
end $$;

-- Paquets spéciaux : aucun actif → vide ; actif → listé, réclamé (size cartes sans les exclues, stock intact), puis 409 et retiré de la liste ;
-- inconnu ou terminé → 404.
do $$ declare u uuid := pg_temp.player('Spec1', 4); a uuid; r jsonb; d jsonb; begin
  insert into wm.special_packs (name, starts_at) values ('Futur', now() + interval '1 day');
  insert into wm.special_packs (name, ends_at) values ('Fini', now());
  assert wm.special_packs(u) = '{"packs":[],"available":false}'::jsonb, wm.special_packs(u)::text;
  insert into wm.special_packs (name, description, size, exclude, starts_at, ends_at)
  values ('Halloween', 'Effrayant', 3, '{C}', now() - interval '1 day', now() + interval '1 day') returning id into a;
  assert wm.special_packs(u) = jsonb_build_object('packs', jsonb_build_array(jsonb_build_object('id', a, 'name', 'Halloween', 'title', 'Halloween',
    'description', 'Effrayant', 'size', 3)), 'available', true), wm.special_packs(u)::text;
  r := wm.claim_special(u, a);
  assert jsonb_array_length(r -> 'cards') = 3 and not jsonb_path_exists(r, '$.cards[*] ? (@.rarity == "C")') and r -> 'packs_remaining' = '4', r::text;
  d := pg_temp.err(format('select wm.claim_special(%L, %L)', u, a));
  assert d = '{"status":409,"code":"already_claimed","error":"Paquet déjà récupéré","message":"Paquet déjà récupéré"}'::jsonb, coalesce(d::text, 'accepté');
  assert wm.special_packs(u) = '{"packs":[],"available":false}'::jsonb, 'paquet réclamé encore proposé';
  d := pg_temp.err(format('select wm.claim_special(%L, %L)', u, gen_random_uuid()));
  assert d = '{"status":404,"error":"Paquet introuvable","message":"Paquet introuvable"}'::jsonb, coalesce(d::text, 'accepté');
  assert pg_temp.err(format('select wm.claim_special(%L, %L)', u, (select id from wm.special_packs where name = 'Fini'))) = d, 'paquet terminé réclamable';
end $$;

-- Grâce : sans dotation → 404 ; deux dotations → la plus ancienne d'abord, claimed_at posé ; puis la suivante ; puis 404.
do $$ declare u uuid := pg_temp.player('Grace1'); g1 bigint; g2 bigint; d jsonb; begin
  d := pg_temp.err(format('select wm.claim_grace(%L)', u));
  assert d = '{"status":404,"code":"no_grace","error":"Aucun paquet de grâce disponible","message":"Aucun paquet de grâce disponible"}'::jsonb, coalesce(d::text, 'accepté');
  insert into wm.grace_grants (user_id, size, reason) values (u, 2, 'compensation') returning id into g1;
  insert into wm.grace_grants (user_id, size, reason) values (u, 4, 'compensation') returning id into g2;
  assert jsonb_array_length(wm.claim_grace(u) -> 'cards') = 2, 'la plus ancienne n''est pas prise d''abord';
  assert (select claimed_at = now() from wm.grace_grants where id = g1) and (select claimed_at is null from wm.grace_grants where id = g2), 'claimed_at';
  assert jsonb_array_length(wm.claim_grace(u) -> 'cards') = 4, 'seconde dotation';
  assert pg_temp.err(format('select wm.claim_grace(%L)', u)) = d, 'dotation réclamée deux fois';
end $$;

-- Idempotency-Key rejouée sur le Pro du jour, un paquet spécial et la grâce → même réponse, une seule réclamation, un seul jeu de copies.
-- Deux dotations de grâce : un rejeu exécuté prendrait la seconde au lieu de lever.
do $$ declare u uuid := pg_temp.player('IdemPro'); v uuid := pg_temp.player('IdemSpec'); g uuid := pg_temp.player('IdemGrace');
  sp uuid; a jsonb; begin
  update public.profiles set is_pro = true where id = u;
  a := wm.pro_daily_claim(u, 'Europe/Paris', 'kp');
  assert wm.pro_daily_claim(u, 'Europe/Paris', 'kp') = a, 'Pro du jour : réponse rejouée différente';
  assert (select count(*) from wm.pro_daily_claims where user_id = u) = 1 and (select count(*) from public.user_cards where user_id = u) = 15,
    'Pro du jour : rejeu exécuté';
  insert into wm.special_packs (name, size) values ('Rejeu', 3) returning id into sp;
  a := wm.claim_special(v, sp, 'ks');
  assert wm.claim_special(v, sp, 'ks') = a, 'paquet spécial : réponse rejouée différente';
  assert (select count(*) from wm.special_pack_claims where user_id = v) = 1 and (select count(*) from public.user_cards where user_id = v) = 3,
    'paquet spécial : rejeu exécuté';
  insert into wm.grace_grants (user_id, size) values (g, 2), (g, 4);
  a := wm.claim_grace(g, 'kg');
  assert wm.claim_grace(g, 'kg') = a, 'grâce : réponse rejouée différente';
  assert (select count(*) from wm.grace_grants where user_id = g and claimed_at is not null) = 1
    and (select count(*) from public.user_cards where user_id = g) = 2, 'grâce : rejeu exécuté';
end $$;

-- Taille d'un paquet spécial ou d'une dotation de grâce : strictement positive.
do $$ declare u uuid := tests.make_user('Size0'); begin
  begin insert into wm.special_packs (name, size) values ('Vide', 0); assert false, 'paquet spécial de taille 0 accepté';
  exception when check_violation then null; end;
  begin insert into wm.grace_grants (user_id, size) values (u, 0); assert false, 'dotation de taille 0 acceptée';
  exception when check_violation then null; end;
end $$;
