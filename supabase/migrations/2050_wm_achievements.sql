-- ADDITIVE : succès (D§7.10, R§5.8, M5b-5, M5b-12, G8, D-C16) — amorce de 51 succès (12 connus, 39 inférés) et de leurs règles, métriques
-- calculées au check depuis les tables sources, check limité à 1 par 5 min, réclamation créditée une fois (ach:<id>). Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

-- Amorce : id = md5('wm-ach:' || code) (stable d'une base à l'autre, G8) ; les valeurs déjà posées gagnent (on conflict do nothing) ;
-- sort_order = 10, 20… dans l'ordre d'écriture. inferred : règle et titre déduits, non lus dans l'origine (D:612).
-- Les rows des tables sont insérées dans une seule instruction : la clé étrangère de la règle est vérifiée en fin d'instruction.
with src as (
  select row_number() over () * 10 as sort_order, v.*
  from (values
    -- Cartes et rareté
    ('first_c', 'Cartes et rareté', 'Première commune', 'first_rarity', 1, 'C', 10, true),
    ('first_pc', 'Cartes et rareté', 'Première peu commune', 'first_rarity', 1, 'PC', 10, true),
    ('first_r', 'Cartes et rareté', 'Première rare', 'first_rarity', 1, 'R', 10, true),
    ('first_sr', 'Cartes et rareté', 'Super rare', 'first_rarity', 1, 'SR', 10, false),
    ('first_ur', 'Cartes et rareté', 'Ultra rare', 'first_rarity', 1, 'UR', 25, false),
    ('first_l', 'Cartes et rareté', 'Légendaire !', 'first_rarity', 1, 'L', 75, false),
    ('shiny_1', 'Cartes et rareté', 'Éclat naissant', 'shiny_copies', 1, null, 25, true),
    ('shiny_5', 'Cartes et rareté', 'Chasseur d''éclats', 'shiny_copies', 5, null, 50, true),
    ('shiny_25', 'Cartes et rareté', 'Collectionneur d''éclats', 'shiny_copies', 25, null, 75, true),
    ('shiny_100', 'Cartes et rareté', 'Maître des éclats', 'shiny_copies', 100, null, 100, true),
    -- Collection
    ('cards_50', 'Collection', 'Débutant', 'cards_total', 50, null, 10, false),
    ('cards_100', 'Collection', 'Amateur', 'cards_total', 100, null, 15, false),
    ('cards_250', 'Collection', 'Collectionneur', 'cards_total', 250, null, 25, false),
    ('cards_500', 'Collection', 'Grand collectionneur', 'cards_total', 500, null, 30, true),
    ('cards_1000', 'Collection', 'Archiviste', 'cards_total', 1000, null, 40, true),
    ('cards_2000', 'Collection', 'Bibliothécaire', 'cards_total', 2000, null, 50, true),
    ('cards_5000', 'Collection', 'Conservateur', 'cards_total', 5000, null, 75, true),
    ('cards_10000', 'Collection', 'Gardien du savoir', 'cards_total', 10000, null, 100, true),
    ('distinct_25', 'Collection', 'Curieux', 'distinct_cards', 25, null, 15, true),
    ('distinct_100', 'Collection', 'Explorateur', 'distinct_cards', 100, null, 30, true),
    ('distinct_500', 'Collection', 'Encyclopédiste', 'distinct_cards', 500, null, 60, true),
    ('showcase', 'Collection', 'Exposition', 'showcase_full', 4, null, 25, false),
    -- Combat
    ('wins_1', 'Combat', 'Première victoire', 'battles_won', 1, null, 10, true),
    ('wins_3', 'Combat', 'Sur la bonne voie', 'battles_won', 3, null, 20, true),
    ('wins_5', 'Combat', 'Combattant', 'battles_won', 5, null, 50, false),
    ('wins_10', 'Combat', 'Stratège', 'battles_won', 10, null, 100, false),
    ('wins_25', 'Combat', 'Vétéran', 'battles_won', 25, null, 200, false),
    ('wins_50', 'Combat', 'Champion', 'battles_won', 50, null, 500, false),
    ('wins_100', 'Combat', 'Invincible', 'battles_won', 100, null, 750, false),
    ('wins_200', 'Combat', 'Légende de l''arène', 'battles_won', 200, null, 100, true),
    ('played_1', 'Combat', 'Premier duel', 'battles_played', 1, null, 10, true),
    ('played_10', 'Combat', 'Habitué de l''arène', 'battles_played', 10, null, 20, true),
    ('played_50', 'Combat', 'Duelliste', 'battles_played', 50, null, 40, true),
    ('played_100', 'Combat', 'Gladiateur', 'battles_played', 100, null, 60, true),
    ('played_250', 'Combat', 'Pilier de l''arène', 'battles_played', 250, null, 100, true),
    -- Échanges
    ('trades_1', 'Échanges', 'Premier troc', 'trades_done', 1, null, 10, true),
    ('trades_5', 'Échanges', 'Négociateur', 'trades_done', 5, null, 20, true),
    ('trades_25', 'Échanges', 'Marchand', 'trades_done', 25, null, 50, true),
    ('trades_50', 'Échanges', 'Grand négociant', 'trades_done', 50, null, 75, true),
    ('trades_100', 'Échanges', 'Maître du troc', 'trades_done', 100, null, 100, true),
    ('donations_1', 'Échanges', 'Main tendue', 'guild_donations', 1, null, 15, true),
    ('donations_10', 'Échanges', 'Généreux', 'guild_donations', 10, null, 40, true),
    ('donations_50', 'Échanges', 'Mécène', 'guild_donations', 50, null, 80, true),
    -- Enchères
    ('sold_1', 'Enchères', 'Première vente', 'auctions_sold', 1, null, 10, true),
    ('sold_5', 'Enchères', 'Commissaire', 'auctions_sold', 5, null, 20, true),
    ('sold_10', 'Enchères', 'Vendeur averti', 'auctions_sold', 10, null, 30, true),
    ('sold_25', 'Enchères', 'Crieur', 'auctions_sold', 25, null, 50, true),
    ('sold_50', 'Enchères', 'Maître des enchères', 'auctions_sold', 50, null, 75, true),
    ('sold_100', 'Enchères', 'Magnat des ventes', 'auctions_sold', 100, null, 100, true),
    ('won_1', 'Enchères', 'Première enchère', 'auctions_won', 1, null, 10, true),
    ('won_10', 'Enchères', 'Enchérisseur chevronné', 'auctions_won', 10, null, 40, true)
  ) as v (code, category, title, metric, threshold, rarity, reward, inferred)
), a as (
  insert into public.achievements (id, title, description, wikibidous_reward, sort_order, category, threshold)
  select md5('wm-ach:' || code)::uuid, title,
    -- n en chiffres, espace simple des milliers ; à 1, la forme singulière.
    case metric
      when 'first_rarity' then 'Obtiens ta première carte ' || case rarity when 'C' then 'commune' when 'PC' then 'peu commune' when 'R' then 'rare'
        when 'SR' then 'super rare' when 'UR' then 'ultra rare' else 'légendaire' end || '.'
      when 'cards_total' then 'Possède ' || regexp_replace(threshold::text, '(\d)(?=(\d{3})+$)', '\1 ', 'g') || ' cartes.'
      when 'shiny_copies' then case when threshold = 1 then 'Possède une carte brillante.' else 'Possède ' || threshold || ' cartes brillantes.' end
      when 'distinct_cards' then 'Possède ' || threshold || ' cartes différentes.'
      when 'showcase_full' then 'Remplis les 4 emplacements de ta vitrine.'
      when 'battles_won' then case when threshold = 1 then 'Gagne ta première bataille.' else 'Gagne ' || threshold || ' batailles.' end
      when 'battles_played' then case when threshold = 1 then 'Termine ta première bataille.' else 'Termine ' || threshold || ' batailles.' end
      when 'trades_done' then case when threshold = 1 then 'Conclus ton premier échange.' else 'Conclus ' || threshold || ' échanges.' end
      when 'guild_donations' then case when threshold = 1 then 'Fais ton premier don à ta guilde.' else 'Fais ' || threshold || ' dons à ta guilde.' end
      when 'auctions_sold' then case when threshold = 1 then 'Vends ta première carte aux enchères.'
        else 'Vends ' || threshold || ' cartes aux enchères.' end
      else case when threshold = 1 then 'Remporte ta première enchère.' else 'Remporte ' || threshold || ' enchères.' end
    end, reward, sort_order::int, category, threshold
  from src
  on conflict (id) do nothing
)
insert into wm.achievement_rules (achievement_id, metric, threshold, rarity, inferred)
select md5('wm-ach:' || code)::uuid, metric, threshold, rarity::public.rarity, inferred from src
on conflict (achievement_id) do nothing;

-- Valeur d'une métrique pour un joueur, 0 si rien ; calculée depuis les tables sources (D-C16). Métrique inconnue : XX000.
create or replace function wm.achievement_value(p_uid uuid, p_metric text, p_rarity public.rarity default null)
returns bigint language plpgsql stable security definer set search_path = '' as $$
begin
  if p_metric is null or p_metric not in ('cards_total', 'first_rarity', 'shiny_copies', 'distinct_cards', 'showcase_full', 'battles_won',
    'battles_played', 'trades_done', 'guild_donations', 'auctions_sold', 'auctions_won') then
    raise exception 'wm.achievement_value : métrique inconnue (%)', p_metric using errcode = 'XX000';
  end if;
  return coalesce(case p_metric
    when 'cards_total' then (select sum(copies) from wm.user_rarity_counts where user_id = p_uid)
    when 'first_rarity' then (select sum(copies) from wm.user_rarity_counts where user_id = p_uid and snapshot_rarity = p_rarity)
    when 'shiny_copies' then (select sum(copies) from wm.user_rarity_counts where user_id = p_uid and is_shiny)
    when 'distinct_cards' then (select count(distinct card_id) from public.user_cards where user_id = p_uid)
    when 'showcase_full' then (select count(*) from public.showcase where user_id = p_uid)
    when 'battles_won' then (select battles_won from wm.user_stats where user_id = p_uid)
    when 'battles_played' then (select count(*) from public.battles where status = 'completed' and p_uid in (challenger_id, opponent_id))
    when 'trades_done' then (select count(*) from public.trades where status = 'accepted' and p_uid in (initiator_id, recipient_id))
    when 'guild_donations' then (select count(*) from public.guild_donations where donor_id = p_uid)
    when 'auctions_sold' then (select count(*) from public.auctions where status = 'settled_sold' and seller_id = p_uid)
    when 'auctions_won' then (select count(*) from public.auctions where status = 'settled_sold' and winner_id = p_uid)
    end, 0);
end $$;

-- POST /api/achievements/check : crée les lignes user_achievements des règles atteintes (jamais claim), au plus une fois par
-- achievements.check_interval_s ; un check sans déblocage compte (M5b-5). Un 429 n'écrit rien (l'exception annule idem_claim).
create or replace function wm.achievements_check(p_uid uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_int int := (select (value ->> 'check_interval_s')::int from wm.config where key = 'achievements');
  v_win interval := make_interval(secs => v_int);
  v_at timestamptz;
  n int;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_user(p_uid);
  select achievements_checked_at into v_at from wm.user_state where user_id = p_uid;
  if v_at > now() - v_win then
    perform wm.raise_err(429, null, 'Le site demande de ralentir',
      jsonb_build_object('retry_after', least(v_int, greatest(1, ceil(extract(epoch from v_at + v_win - now())))::int)));
  end if;
  insert into public.user_achievements (user_id, achievement_id)
  select p_uid, r.achievement_id from wm.achievement_rules r
  where wm.achievement_value(p_uid, r.metric, r.rarity) >= r.threshold
  on conflict do nothing;
  get diagnostics n = row_count;
  update wm.user_state set achievements_checked_at = now() where user_id = p_uid;
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('ok', true, 'unlocked', n));
end $$;

-- POST /api/achievements/claim : crédite la récompense une seule fois (ach:<id>). La ligne est relue sous le verrou du profil : de deux
-- réclamations concurrentes, la seconde voit claimed_at posé.
create or replace function wm.achievements_claim(p_uid uuid, p_achievement_id uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_reward int;
  ua public.user_achievements;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  select wikibidous_reward into v_reward from public.achievements where id = p_achievement_id;
  if not found then
    perform wm.raise_err(404, null, 'Succès introuvable');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_user(p_uid);
  select * into ua from public.user_achievements where user_id = p_uid and achievement_id = p_achievement_id;
  if not found then
    perform wm.raise_err(409, null, 'Ce succès n''est pas encore débloqué');
  end if;
  if ua.claimed_at is not null then
    perform wm.raise_err(409, null, 'Ce succès a déjà été réclamé');
  end if;
  update public.user_achievements set claimed_at = now()
  where user_id = p_uid and achievement_id = p_achievement_id and claimed_at is null;
  perform wm.wallet_apply(p_uid, v_reward, 'achievement', 'ach:' || p_achievement_id);
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('ok', true));
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
