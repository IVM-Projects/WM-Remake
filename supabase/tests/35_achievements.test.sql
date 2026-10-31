-- Succès (2050_wm_achievements.sql) : amorce de 51, wm.achievement_value, check limité à 5 min, claim crédité une fois (ach:<id>).
-- Une seule transaction pour tout le fichier : chaque bloc crée ses joueurs et ne filtre que sur eux ; check_invariants est global.

create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare d text; begin
  execute p_sql;
  return null;
exception when sqlstate 'P0001' then
  get stacked diagnostics d = pg_exception_detail;
  return d::jsonb;
end $$;

create function pg_temp.e(p_status int, p_code text, p_message text) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('status', p_status, 'code', p_code, 'error', p_message, 'message', p_message))
$$;

create function pg_temp.inv(p_label text) returns void language plpgsql as $$ begin
  assert wm.check_invariants() = '[]'::jsonb, p_label || ' : ' || wm.check_invariants()::text;
end $$;

create function pg_temp.card(p_title text, p_rarity public.rarity default 'R') returns uuid language sql as $$
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, category)
  values (p_title, 'https://fr.wikipedia.org/wiki/' || replace(p_title, ' ', '_'), p_rarity, 1200, 800, 'Catégorie succès')
  returning id
$$;

create function pg_temp.player(p_name text, p_balance int default 0) returns uuid language plpgsql as $$
declare u uuid := tests.make_user(p_name, p_balance); begin
  perform wm.set_human_verified(u);
  return u;
end $$;

-- Une ligne user_cards aux snapshots de la carte ; p_shiny pose is_shiny.
create function pg_temp.copy(p_uid uuid, p_card uuid, p_count int default 1, p_shiny boolean default false) returns uuid language sql as $$
  insert into public.user_cards (user_id, card_id, count, is_shiny, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
  select p_uid, id, p_count, p_shiny, wikipedia_title, rarity, category, atk, def from public.cards where id = p_card
  returning id
$$;

create function pg_temp.friends(p_a uuid, p_b uuid) returns void language sql as $$
  insert into public.friendships (requester_id, addressee_id, status) values (p_a, p_b, 'accepted')
$$;

-- Aides de 31_battles.test.sql:43-54 et :526-560, telles quelles.
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

create function pg_temp.bcards(p_prefix text, p_atk int[], p_def int[]) returns uuid[] language plpgsql as $$
declare r uuid[] := '{}'; begin
  for i in 1 .. cardinality(p_atk) loop
    r := r || pg_temp.bcard(p_prefix || ' ' || i, 'R', p_atk[i], p_def[i]);
  end loop;
  return r;
end $$;

create function pg_temp.fill() returns void language plpgsql as $$ begin
  perform pg_temp.bcards('Bataille pool', array[1, 1], array[1, 1]);
end $$;

create function pg_temp.own(p_uid uuid, p_cards uuid[]) returns uuid[] language plpgsql as $$
declare r uuid[] := '{}'; c uuid; begin
  foreach c in array p_cards loop
    r := r || pg_temp.copy(p_uid, c);
  end loop;
  return r;
end $$;

create function pg_temp.active(p_a uuid, p_b uuid, p_a_cards uuid[], p_b_cards uuid[]) returns uuid language plpgsql as $$
declare x uuid; begin
  if not wm.are_friends(p_a, p_b) then
    perform pg_temp.friends(p_a, p_b);
  end if;
  x := (wm.battle_create(p_a, p_b) ->> 'id')::uuid;
  perform wm.battle_action(p_b, x, 'accept');
  perform wm.battle_action(p_a, x, 'submit_deck', jsonb_build_object('card_ids', p_a_cards));
  perform wm.battle_action(p_b, x, 'submit_deck', jsonb_build_object('card_ids', p_b_cards));
  return x;
end $$;

-- Amorce : 51 succès et 51 règles, par catégorie, connus et inférés.
do $$ begin
  assert (select count(*) from public.achievements) = 51 and (select count(*) from wm.achievement_rules) = 51, 'deux fois 51';
  assert (select array_agg(distinct category collate "C" order by category collate "C") from public.achievements)
    = array['Cartes et rareté', 'Collection', 'Combat', 'Enchères', 'Échanges'], 'cinq catégories';  -- ordre C : « Enchères » avant « Échanges »
  assert (select jsonb_object_agg(category, n) from (select category, count(*) n from public.achievements group by 1) c)
    = '{"Cartes et rareté": 10, "Collection": 12, "Combat": 13, "Échanges": 8, "Enchères": 8}'::jsonb, 'effectif par catégorie';
  -- Les 12 connus, exacts : (code, titre, récompense, catégorie, métrique, seuil, rareté).
  assert (select count(*) from (values
    ('first_sr', 'Super rare', 10, 'Cartes et rareté', 'first_rarity', 1, 'SR'),
    ('first_ur', 'Ultra rare', 25, 'Cartes et rareté', 'first_rarity', 1, 'UR'),
    ('first_l', 'Légendaire !', 75, 'Cartes et rareté', 'first_rarity', 1, 'L'),
    ('cards_50', 'Débutant', 10, 'Collection', 'cards_total', 50, null),
    ('cards_100', 'Amateur', 15, 'Collection', 'cards_total', 100, null),
    ('cards_250', 'Collectionneur', 25, 'Collection', 'cards_total', 250, null),
    ('showcase', 'Exposition', 25, 'Collection', 'showcase_full', 4, null),
    ('wins_5', 'Combattant', 50, 'Combat', 'battles_won', 5, null),
    ('wins_10', 'Stratège', 100, 'Combat', 'battles_won', 10, null),
    ('wins_25', 'Vétéran', 200, 'Combat', 'battles_won', 25, null),
    ('wins_50', 'Champion', 500, 'Combat', 'battles_won', 50, null),
    ('wins_100', 'Invincible', 750, 'Combat', 'battles_won', 100, null)) k (code, title, reward, category, metric, threshold, rarity)
    join public.achievements a on a.id = md5('wm-ach:' || k.code)::uuid
    join wm.achievement_rules r on r.achievement_id = a.id
    where (a.title, a.wikibidous_reward, a.category, a.threshold) = (k.title, k.reward, k.category, k.threshold)
      and (r.metric, r.threshold, r.rarity::text, r.inferred) is not distinct from (k.metric, k.threshold, k.rarity, false)) = 12, 'les 12 connus';
  assert (select count(*) from wm.achievement_rules where not inferred) = 12, 'douze non inférés';
  assert (select count(*) from wm.achievement_rules where inferred) = 39, '39 inférés';
  assert (select count(*) from public.achievements a join wm.achievement_rules r on r.achievement_id = a.id
    where r.inferred and a.wikibidous_reward between 10 and 100) = 39, 'récompenses des inférés';
  assert (select count(distinct sort_order) = 51 from public.achievements), 'sort_order distincts';
  -- Croissants dans l'ordre des catégories : Cartes et rareté, Collection, Combat, Échanges, Enchères.
  assert (select array_agg(category order by sort_order) from (select category, min(sort_order) sort_order from public.achievements
      group by 1) c) = array['Cartes et rareté', 'Collection', 'Combat', 'Échanges', 'Enchères'], 'ordre des catégories';
  assert (select count(distinct title) = 51 and max(char_length(title)) <= 40 from public.achievements), 'titres distincts, 40 au plus';
  assert (select id from public.achievements where title = 'Légendaire !') = md5('wm-ach:first_l')::uuid, 'id stable';
  assert (select count(*) from public.achievements a join wm.achievement_rules r on r.achievement_id = a.id
    where a.threshold = r.threshold) = 51, 'seuil recopié';
  -- Chaque métrique de la contrainte sert au moins une fois.
  assert (select count(distinct metric) from wm.achievement_rules) = 11, 'onze métriques';
  assert (select count(*) from wm.achievement_rules where (metric = 'first_rarity') = (rarity is not null)) = 51, 'rareté seulement first_rarity';
end $$;

-- Rejeu de 2050 : rien ne change, une récompense modifiée survit.
create temp table ach_before as select a.*, r.metric, r.threshold r_threshold, r.rarity, r.inferred
  from public.achievements a join wm.achievement_rules r on r.achievement_id = a.id;
update public.achievements set wikibidous_reward = 999 where id = md5('wm-ach:first_l')::uuid;
update wm.achievement_rules set threshold = 7 where achievement_id = md5('wm-ach:wins_5')::uuid;
\ir ../migrations/2050_wm_achievements.sql
do $$ begin
  assert (select count(*) from public.achievements) = 51 and (select count(*) from wm.achievement_rules) = 51, 'rejeu : 51';
  assert (select wikibidous_reward from public.achievements where id = md5('wm-ach:first_l')::uuid) = 999, 'récompense modifiée survit';
  assert (select threshold from wm.achievement_rules where achievement_id = md5('wm-ach:wins_5')::uuid) = 7, 'règle modifiée survit';
  assert not exists (select from ach_before b join public.achievements a using (id)
    where (a.title, a.description, a.sort_order, a.category) is distinct from (b.title, b.description, b.sort_order, b.category)), 'rejeu : champs';
end $$;
update public.achievements set wikibidous_reward = 75 where id = md5('wm-ach:first_l')::uuid;
update wm.achievement_rules set threshold = 5 where achievement_id = md5('wm-ach:wins_5')::uuid;

-- Descriptions : modèles fixes.
do $$ begin
  assert (select description from public.achievements where id = md5('wm-ach:first_pc')::uuid) = 'Obtiens ta première carte peu commune.';
  assert (select description from public.achievements where id = md5('wm-ach:first_l')::uuid) = 'Obtiens ta première carte légendaire.';
  assert (select description from public.achievements where id = md5('wm-ach:cards_10000')::uuid) = 'Possède 10 000 cartes.';
  assert (select description from public.achievements where id = md5('wm-ach:shiny_1')::uuid) = 'Possède une carte brillante.';
  assert (select description from public.achievements where id = md5('wm-ach:shiny_5')::uuid) = 'Possède 5 cartes brillantes.';
  assert (select description from public.achievements where id = md5('wm-ach:showcase')::uuid) = 'Remplis les 4 emplacements de ta vitrine.';
  assert (select description from public.achievements where id = md5('wm-ach:wins_1')::uuid) = 'Gagne ta première bataille.';
  assert (select description from public.achievements where id = md5('wm-ach:played_100')::uuid) = 'Termine 100 batailles.';
  assert (select description from public.achievements where id = md5('wm-ach:trades_1')::uuid) = 'Conclus ton premier échange.';
  assert (select description from public.achievements where id = md5('wm-ach:donations_10')::uuid) = 'Fais 10 dons à ta guilde.';
  assert (select description from public.achievements where id = md5('wm-ach:sold_1')::uuid) = 'Vends ta première carte aux enchères.';
  assert (select description from public.achievements where id = md5('wm-ach:won_10')::uuid) = 'Remporte 10 enchères.';
  assert (select description from public.achievements where id = md5('wm-ach:distinct_25')::uuid) = 'Possède 25 cartes différentes.';
end $$;

-- achievement_value : un joueur construit pour toutes les métriques.
-- Alice : copies C (x2, une même carte), R, L brillante ; vitrine pleine ; une bataille gagnée (contre Bob) et une perdue ; un échange accepté,
-- une vente réglée, une enchère gagnée, un don.
do $$ declare a uuid; b uuid; g uuid; c uuid[]; own uuid[]; cc uuid; cr uuid; cl uuid; x uuid; u1 uuid; u2 uuid; u3 uuid; u4 uuid; begin
  a := pg_temp.player('AchValA'); b := pg_temp.player('AchValB');
  assert wm.achievement_value(a, 'cards_total') = 0 and wm.achievement_value(a, 'first_rarity', 'C') = 0
    and wm.achievement_value(a, 'battles_played') = 0 and wm.achievement_value(a, 'distinct_cards') = 0, 'zéro sans rien';
  cc := pg_temp.card('AchVal C', 'C'); cr := pg_temp.card('AchVal R', 'R'); cl := pg_temp.card('AchVal L', 'L');
  u1 := pg_temp.copy(a, cc, 2);
  u2 := pg_temp.copy(a, cr, 1);
  u3 := pg_temp.copy(a, cl, 1, true);
  u4 := pg_temp.copy(a, pg_temp.card('AchVal R2', 'R'), 1);
  assert wm.achievement_value(a, 'cards_total') = 5, 'cards_total';
  assert wm.achievement_value(a, 'first_rarity', 'C') = 2 and wm.achievement_value(a, 'first_rarity', 'R') = 2
    and wm.achievement_value(a, 'first_rarity', 'L') = 1 and wm.achievement_value(a, 'first_rarity', 'SR') = 0, 'first_rarity';
  assert wm.achievement_value(a, 'shiny_copies') = 1, 'shiny_copies';
  assert wm.achievement_value(a, 'distinct_cards') = 4, 'distinct_cards';
  assert wm.achievement_value(a, 'showcase_full') = 0, 'vitrine vide';
  insert into public.showcase (user_id, position, user_card_id) values (a, 0, u1), (a, 1, u2), (a, 2, u3), (a, 3, u4);
  assert wm.achievement_value(a, 'showcase_full') = 4, 'showcase_full';
  -- Batailles : A gagne contre B (B abandonne), puis A abandonne contre B.
  c := pg_temp.bcards('AchValB', array[1000, 400, 400, 400, 400, 400], array[500, 500, 500, 500, 500, 500]);
  perform pg_temp.fill();
  x := pg_temp.active(a, b, pg_temp.own(a, c[1:3]), pg_temp.own(b, c[4:6]));
  perform wm.battle_action(b, x, 'forfeit');
  x := pg_temp.active(a, b, pg_temp.own(a, c[1:3]), pg_temp.own(b, c[4:6]));
  perform wm.battle_action(a, x, 'forfeit');
  assert wm.achievement_value(a, 'battles_won') = 1 and wm.achievement_value(b, 'battles_won') = 1, 'battles_won';
  assert wm.achievement_value(a, 'battles_played') = 2 and wm.achievement_value(b, 'battles_played') = 2, 'battles_played';
  -- Échange accepté (initiateur A, puis destinataire pour B), un en attente ignoré.
  insert into public.trades (status, initiator_id, recipient_id, expires_at) values
    ('accepted', a, b, now() + interval '1 day'), ('pending', a, b, now() + interval '1 day');
  assert wm.achievement_value(a, 'trades_done') = 1 and wm.achievement_value(b, 'trades_done') = 1, 'trades_done';
  -- Vente réglée (A vendeur, B gagnant), une invendue ignorée.
  insert into public.auctions (seller_id, card_id, snapshot_rarity, base_amount, listing_base_amount, status, end_at, winner_id)
  values (a, cc, 'C', 10, 10, 'settled_sold', now(), b), (a, cc, 'C', 10, 10, 'settled_unsold', now(), null);
  assert wm.achievement_value(a, 'auctions_sold') = 1 and wm.achievement_value(b, 'auctions_sold') = 0, 'auctions_sold';
  assert wm.achievement_value(b, 'auctions_won') = 1 and wm.achievement_value(a, 'auctions_won') = 0, 'auctions_won';
  -- Don : A donneur.
  insert into public.guilds (name, leader_id) values ('AchValG', a) returning id into g;
  insert into public.guild_members (guild_id, user_id, role) values (g, a, 'leader');
  insert into public.guild_wishlists (guild_id, user_id, card_id) values (g, a, cc);
  insert into public.guild_donations (guild_id, wishlist_id, donor_id, recipient_id, user_card_id)
  values (g, (select id from public.guild_wishlists where guild_id = g), a, b, gen_random_uuid());
  assert wm.achievement_value(a, 'guild_donations') = 1 and wm.achievement_value(b, 'guild_donations') = 0, 'guild_donations';
  begin
    perform wm.achievement_value(a, 'x');
    assert false, 'métrique inconnue acceptée';
  exception when sqlstate 'XX000' then null; end;
  assert (select provolatile = 's' from pg_proc where oid = 'wm.achievement_value(uuid,text,public.rarity)'::regprocedure), 'stable';
end $$;

-- check : 50 copies C → cards_50 et first_c ; 429 ; fenêtre échue ; défausse sans effet ; maintenance ; même clé.
do $$ declare a uuid; cc uuid; u uuid; d jsonb; t timestamptz; k jsonb; n int; begin
  a := pg_temp.player('AchChk'); cc := pg_temp.card('AchChk C', 'C');
  u := pg_temp.copy(a, cc, 50);
  assert not exists (select from public.user_achievements where user_id = a), 'aucune ligne avant le check';
  d := wm.achievements_check(a);
  assert d = '{"ok": true, "unlocked": 2}'::jsonb, d::text;
  assert (select count(*) from public.user_achievements where user_id = a and claimed_at is null) = 2
    and exists (select from public.user_achievements where user_id = a and achievement_id = md5('wm-ach:cards_50')::uuid)
    and exists (select from public.user_achievements where user_id = a and achievement_id = md5('wm-ach:first_c')::uuid), 'lignes créées';
  t := (select achievements_checked_at from wm.user_state where user_id = a);
  assert t is not null, 'instant posé';
  d := pg_temp.err(format('select wm.achievements_check(%L)', a));
  assert d ->> 'status' = '429' and d ->> 'error' = 'Le site demande de ralentir' and d ->> 'message' = d ->> 'error'
    and (d ->> 'retry_after')::int between 1 and 300 and d - 'retry_after' = pg_temp.e(429, null, 'Le site demande de ralentir'),
    coalesce(d::text, 'accepté');
  assert (select achievements_checked_at from wm.user_state where user_id = a) = t, '429 sans écriture';
  -- Exactement 300 s : une retry_after de 300 au plus, 1 au moins.
  update wm.user_state set achievements_checked_at = achievements_checked_at - interval '299.5 seconds' where user_id = a;
  d := pg_temp.err(format('select wm.achievements_check(%L)', a));
  assert (d ->> 'retry_after')::int = 1, d::text;
  update wm.user_state set achievements_checked_at = now() - interval '301 seconds' where user_id = a;
  d := wm.achievements_check(a);
  assert d = '{"ok": true, "unlocked": 0}'::jsonb, d::text;
  assert (select achievements_checked_at from wm.user_state where user_id = a) = now(), 'instant avancé même sans déblocage';
  -- Défausse des 50 copies : les lignes débloquées restent (M5b-12).
  delete from public.user_cards where id = u;
  update wm.user_state set achievements_checked_at = now() - interval '301 seconds' where user_id = a;
  d := wm.achievements_check(a);
  assert d = '{"ok": true, "unlocked": 0}'::jsonb and (select count(*) from public.user_achievements where user_id = a) = 2, 'débloqué reste';
  -- Maintenance → 503.
  update wm.user_state set achievements_checked_at = null where user_id = a;
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format('select wm.achievements_check(%L)', a));
  update wm.config set value = 'false' where key = 'maintenance';
  assert d = pg_temp.e(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.'), coalesce(d::text, 'accepté');
  -- Même clé : la réponse stockée, un seul effet (pas de 429).
  perform pg_temp.copy(a, cc, 100);
  d := wm.achievements_check(a, 'chk-1');
  assert d = '{"ok": true, "unlocked": 1}'::jsonb, d::text;  -- cards_100 seule : cards_50 et first_c existent déjà
  k := wm.achievements_check(a, 'chk-1');
  assert k = d, k::text;
  assert (select count(*) from wm.idempotency_keys where user_id = a and key = 'chk-1') = 1, 'une clé';
end $$;

-- claim (Review Focus, la réclamation rejouée, D:1084) : crédité une seule fois.
do $$ declare a uuid; cc uuid; d jsonb; ach uuid := md5('wm-ach:cards_50')::uuid; bal int; locked uuid := md5('wm-ach:cards_100')::uuid; begin
  a := pg_temp.player('AchClm', 100); cc := pg_temp.card('AchClm C', 'C');
  perform pg_temp.copy(a, cc, 50);
  perform wm.achievements_check(a);
  d := wm.achievements_claim(a, ach, 'clm-1');
  assert d = '{"ok": true}'::jsonb, d::text;
  assert (select wikibidous_balance from public.profiles where id = a) = 110, 'solde + 10';
  assert (select count(*) from wm.wb_ledger where user_id = a and reason = 'achievement' and ref = 'ach:' || ach and delta = 10) = 1, 'une ligne';
  assert (select claimed_at is not null from public.user_achievements where user_id = a and achievement_id = ach), 'claimed_at';
  perform pg_temp.inv('claim');
  -- Rejeu sans clé : 409, rien de plus.
  d := pg_temp.err(format('select wm.achievements_claim(%L, %L)', a, ach));
  assert d = pg_temp.e(409, null, 'Ce succès a déjà été réclamé'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.achievements_claim(%L, %L, %L)', a, ach, 'clm-2'));
  assert d = pg_temp.e(409, null, 'Ce succès a déjà été réclamé'), coalesce(d::text, 'accepté');
  assert (select wikibidous_balance from public.profiles where id = a) = 110
    and (select count(*) from wm.wb_ledger where user_id = a and reason = 'achievement') = 1, 'rejeu sans clé';
  -- Rejeu avec la clé du premier : la réponse stockée, rien de plus.
  d := wm.achievements_claim(a, ach, 'clm-1');
  assert d = '{"ok": true}'::jsonb, d::text;
  assert (select wikibidous_balance from public.profiles where id = a) = 110
    and (select count(*) from wm.wb_ledger where user_id = a and reason = 'achievement') = 1, 'rejeu avec clé';
  -- Verrouillé (ligne absente), inconnu.
  d := pg_temp.err(format('select wm.achievements_claim(%L, %L)', a, locked));
  assert d = pg_temp.e(409, null, 'Ce succès n''est pas encore débloqué'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.achievements_claim(%L, %L)', a, gen_random_uuid()));
  assert d = pg_temp.e(404, null, 'Succès introuvable'), coalesce(d::text, 'accepté');
  assert not exists (select from public.user_achievements where user_id = a and achievement_id = locked), 'claim ne crée aucune ligne';
  -- Maintenance → 503.
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format('select wm.achievements_claim(%L, %L)', a, ach));
  update wm.config set value = 'false' where key = 'maintenance';
  assert d = pg_temp.e(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.'), coalesce(d::text, 'accepté');
  perform pg_temp.inv('claim, fin');
end $$;

-- Volatilité, lock_timeout avant le premier verrou, ordre dans achievements_claim (relecture sous le verrou, puis crédit).
do $$ declare v text; s text; p1 int; p2 int; p3 int; p4 int; begin
  v := tests.lock_timeout_violations(array['achievements_check', 'achievements_claim']);
  assert v is null, 'lock_timeout : ' || v;
  select prosrc into s from pg_proc where oid = to_regproc('wm.achievements_claim');
  p1 := strpos(s, 'wm.lock_user(');
  p2 := strpos(s, 'from public.user_achievements');
  p3 := strpos(s, 'claimed_at is null');
  p4 := strpos(s, 'wm.wallet_apply(');
  assert p1 > 0 and p1 < p2 and p2 < p3 and p3 < p4, format('claim : verrou, relecture, garde, crédit (%s %s %s %s)', p1, p2, p3, p4);
end $$;
