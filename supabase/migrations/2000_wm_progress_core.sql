-- ADDITIVE : socle des guildes et des succès du M5b (R§3.8, R§3.10, D§7.8, D§7.10, G9, M5b-5, M16, D-C10, D-C12, D-C14, D-C16) — config
-- guild et achievements, list_caps et battle, achievements_checked_at, invitations et règles de succès, index, week_start, notify_guild,
-- guild_score_add, invariant ach_money. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

insert into wm.config (key, value, note) values
  ('guild', '{"max_members": 200, "donations_per_day": 1}',
    'Guildes (D§7.8, R§5.8) : 200 membres (D:582, R:628 inconnu), 1 don reçu par jour UTC du receveur (D:584, D-C13) ; création gratuite (D:583), sans clé'),
  ('achievements', '{"check_interval_s": 300}',
    'Succès (D§7.10) : un check par 5 min et par joueur (D:610, M5b-5)')
on conflict do nothing;

-- Plafonds et points de guilde du M5b (G9) : les valeurs déjà posées gagnent.
update wm.config set value = '{"guild_messages": 100, "guild_members": 50, "leaderboard": 100, "karma_donors": 10}'::jsonb || value
where key = 'list_caps';
update wm.config set value = '{"guild_points_win": 500}'::jsonb || value where key = 'battle';

-- Dernier check de succès réussi (M5b-5).
alter table wm.user_state add column if not exists achievements_checked_at timestamptz;

-- Invitations en attente (D-C10), jamais lues par un client.
create table if not exists wm.guild_invites (
  guild_id uuid not null references public.guilds (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  inviter_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (guild_id, user_id)
);

-- Règle de déblocage d'un succès (D-C16) ; rarity seulement pour first_rarity ; inferred : règle déduite, pas lue dans l'origine.
create table if not exists wm.achievement_rules (
  achievement_id uuid primary key references public.achievements (id) on delete cascade,
  metric text not null check (metric in ('cards_total', 'first_rarity', 'shiny_copies', 'distinct_cards', 'showcase_full', 'battles_won',
    'battles_played', 'trades_done', 'guild_donations', 'auctions_sold', 'auctions_won')),
  threshold int not null check (threshold > 0),
  rarity public.rarity,
  inferred boolean not null,
  check ((rarity is not null) = (metric = 'first_rarity'))
);

-- Appartenance (un joueur, une guilde ; un chef par guilde), listes, clés étrangères vérifiées à la suppression d'un profil, classements.
-- Option A : CONCURRENTLY par le runbook (M16, D-C14).
create unique index if not exists guild_members_user_key on public.guild_members (user_id);
create unique index if not exists guild_members_leader_key on public.guild_members (guild_id) where role = 'leader';
create index if not exists guilds_leader_idx on public.guilds (leader_id);
create unique index if not exists guild_wishlists_open_key on public.guild_wishlists (user_id) where fulfilled_at is null;
create index if not exists guild_wishlists_guild_idx on public.guild_wishlists (guild_id, created_at) where fulfilled_at is null;
create index if not exists guild_wishlists_card_idx on public.guild_wishlists (card_id);
create index if not exists guild_donations_recipient_idx on public.guild_donations (recipient_id, created_at desc);
create index if not exists guild_donations_donor_idx on public.guild_donations (donor_id, created_at desc);
create index if not exists guild_donations_guild_idx on public.guild_donations (guild_id, created_at desc);
create index if not exists guild_donations_wishlist_idx on public.guild_donations (wishlist_id);
create index if not exists guild_chat_messages_guild_idx on public.guild_chat_messages (guild_id, created_at desc);
create index if not exists guild_chat_messages_user_idx on public.guild_chat_messages (user_id);
create index if not exists guild_weekly_scores_rank_idx on public.guild_weekly_scores (week_start, total_score desc);
create index if not exists guild_weekly_scores_guild_idx on public.guild_weekly_scores (guild_id);
create index if not exists guild_invites_user_idx on wm.guild_invites (user_id, created_at desc);
create index if not exists guild_invites_inviter_idx on wm.guild_invites (inviter_id);
create index if not exists user_stats_battles_won_idx on wm.user_stats (battles_won desc) where battles_won > 0;
create index if not exists battles_completed_idx on public.battles (updated_at) where status = 'completed';
create index if not exists user_cards_obtained_idx on public.user_cards (obtained_at);
-- Clés étrangères seules (les index partiels ci-dessus ne servent pas une cascade) : profil, guilde ou succès supprimé sans balayage.
create index if not exists guild_wishlists_user_idx on public.guild_wishlists (user_id);
create index if not exists guild_wishlists_guild_fk_idx on public.guild_wishlists (guild_id);
create index if not exists user_achievements_achievement_idx on public.user_achievements (achievement_id);

-- Lundi 00:00 UTC de la semaine de p_at (D-C12), sans dépendre du TimeZone de session. Immutable : timezone(text, timestamptz) et
-- date_trunc(text, timestamp) le sont.
create or replace function wm.week_start(p_at timestamptz)
returns timestamptz language sql immutable security definer set search_path = '' as $$
  select date_trunc('week', p_at at time zone 'UTC') at time zone 'UTC'
$$;

-- data des notifications de guilde (M5b-11) : la guilde et l'acteur, sans autre texte libre. Une instruction triée par user_id (P28).
create or replace function wm.notify_guild(p_users uuid[], p_type text, p_guild_id uuid, p_actor uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_data jsonb := jsonb_build_object('guild_id', p_guild_id, 'guild_name', (select name from public.guilds where id = p_guild_id),
    'user_id', p_actor, 'username', (select username from public.profiles where id = p_actor));
  n int;
begin
  insert into public.notifications (user_id, type, data)
  select u, p_type, v_data from unnest(p_users) u where u is not null order by u;
  get diagnostics n = row_count;
  return n;
end $$;

-- Points de la semaine de p_at à la guilde actuelle de p_user_id ; rend les points ajoutés (0 sans guilde). Appelée sous les verrous et le
-- lock_timeout de l'appelant (battle_finish, settle_auction, et leurs crons en maintenance) : ni lock_timeout ni actor ici.
create or replace function wm.guild_score_add(p_user_id uuid, p_kind text, p_amount int, p_at timestamptz)
returns int language plpgsql security definer set search_path = '' as $$
declare g uuid;
begin
  if p_kind is null or p_kind not in ('battles', 'wb') then
    raise exception 'wm.guild_score_add : type de score inconnu (%)', p_kind using errcode = 'XX000';
  end if;
  if coalesce(p_amount, 0) <= 0 then
    return 0;
  end if;
  -- Lecture sans verrou : un battle_finish concomitant d'un leave ou d'un kick non validé peut créditer la guilde que le joueur vient de
  -- quitter (aucun argent, accepté par C4 ; scénario à regarder à la Task 10).
  select guild_id into g from public.guild_members where user_id = p_user_id;
  if g is null then
    return 0;
  end if;
  -- Une dissolution concurrente est attendue, puis la guilde n'est plus là : 0 (sans ce verrou, l'insertion lèverait 23503).
  -- shortcut: lots non triés par guilde (G4) ; trier les lignes de score avant la boucle si les avertissements apparaissent.
  perform from public.guilds where id = g for key share;
  if not found then
    return 0;
  end if;
  insert into public.guild_weekly_scores (week_start, guild_id, score_battles, score_wb)
  values (wm.week_start(p_at), g, case when p_kind = 'battles' then p_amount else 0 end, case when p_kind = 'wb' then p_amount else 0 end)
  on conflict (week_start, guild_id) do update
    set score_battles = public.guild_weekly_scores.score_battles + excluded.score_battles,
      score_wb = public.guild_weekly_scores.score_wb + excluded.score_wb;
  return p_amount;
end $$;

-- Redéfinie de 1900 : même signature, même corps et même réponse qu'en 1900 (déployée, non retouchée), plus ach_money (M5b, Task 2).
-- Violations (tableau vide = OK) ; lancée après chaque test monétaire et par le rapprochement (D§11.4).
-- ledger_balance : Σ delta + discard_wb = solde, pour les joueurs qui ont un grand livre ; rarity_counts : compteurs = group by réel.
-- Marché (M3-26) : market_money (argent des mises conservé), reservation (une mise débitée non remboursée = current_bid), escrow.
-- Échanges (P8) : trade_money (Σ delta nulle par référence trade:<id>).
-- Batailles (M4-4) : battle_money (une ligne battle:<id> par joueur d'une bataille completed, et aucune autre ligne battle).
-- Succès (D:611, D-C16) : ach_money (une ligne ach:<id> par succès réclamé, et aucune autre ligne achievement).
create or replace function wm.check_invariants()
returns jsonb language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(v), '[]') from (
    select jsonb_build_object('check', 'ledger_balance', 'user_id', p.id, 'balance', p.wikibidous_balance, 'ledger_sum', l.s,
      'discard_wb', coalesce(s.discard_wb, 0)) v
    from public.profiles p
    join (select user_id, sum(delta) s from wm.wb_ledger group by user_id) l on l.user_id = p.id
    left join wm.user_stats s on s.user_id = p.id
    where l.s + coalesce(s.discard_wb, 0) <> p.wikibidous_balance
    union all
    select jsonb_build_object('check', 'negative_balance', 'user_id', p.id)
    from public.profiles p where p.wikibidous_balance < 0
    union all
    select jsonb_build_object('check', 'rarity_counts', 'user_id', user_id, 'snapshot_rarity', snapshot_rarity, 'is_shiny', is_shiny,
      'rows', k.rows, 'copies', k.copies, 'actual_rows', a.n, 'actual_copies', a.c)
    from (select user_id, snapshot_rarity, is_shiny, count(*) n, sum(count) c from public.user_cards group by 1, 2, 3) a
    full join wm.user_rarity_counts k using (user_id, snapshot_rarity, is_shiny)
    where coalesce(a.n, 0) <> coalesce(k.rows, 0) or coalesce(a.c, 0) <> coalesce(k.copies, 0)
    union all
    -- shortcut: somme globale ; le grand livre cascade par joueur (1000_wm_core.sql:39), donc supprimer un seul côté d'une vente réglée
    -- la rend non nulle. À revoir avec la suppression de compte (M6).
    select jsonb_build_object('check', 'market_money', 'ledger', l.s, 'held', h.s)
    from (select coalesce(sum(delta), 0) s from wm.wb_ledger where reason in ('bid', 'refund', 'settle')) l,
      (select coalesce(sum(current_bid), 0) s from public.auctions where status = 'active' and current_bidder_id is not null) h
    where l.s + h.s <> 0
    union all
    -- Réservations d'après le grand livre : débit bid:<id> du miseur sans refund:<id>, montant = −delta. Une seule, du meneur, = current_bid.
    select jsonb_build_object('check', 'reservation', 'auction_id', a.id, 'current_bid', a.current_bid, 'unrefunded', r.amounts)
    from public.auctions a
    cross join lateral (select coalesce(jsonb_agg(-l.delta order by -l.delta), '[]') amounts, count(*) n, min(-l.delta) amount,
        bool_and(b.bidder_id = a.current_bidder_id) leader
      from public.auction_bids b
      join wm.wb_ledger l on l.reason = 'bid' and l.ref = 'bid:' || b.id and l.user_id = b.bidder_id
      where b.auction_id = a.id
        and not exists (select from wm.wb_ledger f where f.reason = 'refund' and f.ref = 'refund:' || b.id and f.user_id = b.bidder_id)) r
    where a.status = 'active' and a.current_bidder_id is not null
      and not coalesce(r.n = 1 and r.amount = a.current_bid and r.leader, false)
    union all
    select jsonb_build_object('check', 'escrow', 'auction_id', a.id, 'problem', 'missing')
    from public.auctions a where a.status = 'active' and not exists (select from wm.auction_escrow e where e.auction_id = a.id)
    union all
    select jsonb_build_object('check', 'escrow', 'auction_id', a.id, 'problem', 'orphan')
    from wm.auction_escrow e join public.auctions a on a.id = e.auction_id where a.status <> 'active'
    union all
    select jsonb_build_object('check', 'escrow', 'auction_id', e.auction_id, 'problem', 'owned')
    from wm.auction_escrow e where exists (select from public.user_cards uc where uc.id = (e.user_card ->> 'id')::uuid)
    union all
    -- shortcut: même limite que market_money : le grand livre cascade par joueur, supprimer un seul des deux joueurs déséquilibre la
    -- référence. À revoir avec la suppression de compte (M6).
    select jsonb_build_object('check', 'trade_money', 'ref', ref, 'sum', sum(delta))
    from wm.wb_ledger where reason = 'trade' group by ref having sum(delta) <> 0
    union all
    -- shortcut: même limite que market_money : la suppression d'un seul joueur déséquilibre la référence. À revoir avec la suppression de
    -- compte (M6).
    -- Ligne battle hors d'une bataille completed de son auteur ; jointure sur le texte : une ref mal formée est une violation, pas un 22P02.
    select jsonb_build_object('check', 'battle_money', 'ref', l.ref, 'user_id', l.user_id)
    from wm.wb_ledger l
    where l.reason = 'battle'
      and not exists (select from public.battles b where l.ref = 'battle:' || b.id::text and b.status = 'completed'
        and l.user_id in (b.challenger_id, b.opponent_id))
    union all
    -- Joueur d'une bataille completed sans sa ligne battle:<id> (unique (reason, ref, user_id) : au plus une).
    select jsonb_build_object('check', 'battle_money', 'battle_id', b.id, 'user_id', u.id)
    from public.battles b
    cross join lateral (values (b.challenger_id), (b.opponent_id)) u (id)
    where b.status = 'completed'
      and not exists (select from wm.wb_ledger l where l.reason = 'battle' and l.ref = 'battle:' || b.id::text and l.user_id = u.id)
    union all
    -- shortcut: même limite que market_money : la suppression d'un seul joueur déséquilibre la référence. À revoir avec la suppression de
    -- compte (M6).
    -- Ligne achievement hors d'un succès réclamé de son auteur ; jointure sur le texte : une ref mal formée est une violation, pas un 22P02.
    select jsonb_build_object('check', 'ach_money', 'ref', l.ref, 'user_id', l.user_id)
    from wm.wb_ledger l
    where l.reason = 'achievement'
      and not exists (select from public.user_achievements ua where l.ref = 'ach:' || ua.achievement_id::text and ua.user_id = l.user_id
        and ua.claimed_at is not null)
    union all
    -- Succès réclamé sans sa ligne ach:<id> (unique (reason, ref, user_id) : au plus une).
    -- shortcut: réclamations migrées sans ligne ach:<id> (D:612, R:515) : le rapprochement du M7 les exclut (ligne d'ouverture ach ou filtre sur claimed_at avant la migration).
    select jsonb_build_object('check', 'ach_money', 'achievement_id', ua.achievement_id, 'user_id', ua.user_id)
    from public.user_achievements ua
    where ua.claimed_at is not null
      and not exists (select from wm.wb_ledger l where l.reason = 'achievement' and l.ref = 'ach:' || ua.achievement_id::text
        and l.user_id = ua.user_id)
  ) x
$$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
