-- ADDITIVE : suppression de compte (A3, G1, M6a-3) — account_auth_done (G12) ; handle_new_user : même signature, même corps et même
-- réponse qu'en 1870 (déployée, non retouchée), plus le report d'un bannissement à l'inscription d'un e-mail banni (anti-évasion, G1) ;
-- tombstone_guard et son trigger profiles_tombstone_guard (plan B de G1) ; check_invariants : même signature, même corps et même
-- réponse qu'en 2000 (déployée, non retouchée), plus pool_removed et deleted_account. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.
-- Aucune des fonctions redéfinies ici ne porte de réglage dans proconfig (leçon de 1960).

-- Suppression douce GoTrue faite (G1, G12) : sans actor (le compte est supprimé), appelée par la route seulement. Rejouée → inchangée.
create or replace function wm.account_auth_done(p_uid uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('lock_timeout', '2s', true);
  update wm.deleted_accounts set auth_done_at = coalesce(auth_done_at, now()) where user_id = p_uid;
  return '{"ok": true}'::jsonb;
end $$;

-- Inscription GoTrue (D§7.1) : un refus lève P0001, que GoTrue relaie en 500 avec message et detail.
-- 2250 : un e-mail dont l'empreinte est dans wm.banned_emails (compte supprimé sous bannissement, G1) repart banni, audit système.
create or replace function wm.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}');
begin
  if m -> 'age_confirmed' is distinct from 'true'::jsonb or coalesce(btrim(m ->> 'terms_version'), '') = '' then
    perform wm.raise_err(400, 'consent_required', 'Confirme avoir au moins 18 ans et accepte les conditions.');
  end if;
  perform wm.raise_username(wm.username_problem(m ->> 'username'));
  begin
    insert into public.profiles (id, username) values (new.id, m ->> 'username');
  exception when unique_violation then  -- inscription concurrente passée entre la vérification et l'insertion
    perform wm.raise_username('taken');
  end;
  -- Dotation (1870) sur le pack_cap de la ligne ; clé absente → défaut du miroir.
  update public.profiles set packs_remaining = least(s.n, pack_cap), packs_last_regen_at = case when s.n < pack_cap then now() end
  from (select value::int n from wm.config where key = 'start_packs') s
  where id = new.id;
  perform wm.lock_user(new.id);  -- crée les lignes wm
  if exists (select from wm.banned_emails where email_hash = wm.email_hash(new.email)) then
    insert into wm.sanctions (user_id, kind, reason) values (new.id, 'ban', 'Compte lié à un compte banni supprimé');
    perform wm.staff_log(null, 'ban_carryover', 'user', new.id::text, 'Compte lié à un compte banni supprimé', '{}');
  end if;
  return null;
end $$;

-- Plan B de G1 : si GoTrue supprimait la ligne auth.users (suppression « dure »), la cascade emporterait la pierre tombale et
-- l'historique d'autrui ; elle échoue donc, sauf sous wm.allow_tombstone_delete = 'on' (nettoyages des tests seulement).
create or replace function wm.tombstone_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select from wm.deleted_accounts where user_id = old.id)
    and coalesce(current_setting('wm.allow_tombstone_delete', true), '') <> 'on' then
    raise exception 'pierre tombale protégée : %', old.id using errcode = 'XX000';
  end if;
  return old;
end $$;

create or replace trigger profiles_tombstone_guard before delete on public.profiles
  for each row execute function wm.tombstone_guard();

-- Redéfinie de 2000 : même signature, même corps et même réponse qu'en 2000 (déployée, non retouchée), plus pool_removed et
-- deleted_account (M6a, Task 6a).
-- Violations (tableau vide = OK) ; lancée après chaque test monétaire et par le rapprochement (D§11.4).
-- ledger_balance : Σ delta + discard_wb = solde, pour les joueurs qui ont un grand livre ; rarity_counts : compteurs = group by réel.
-- Marché (M3-26) : market_money (argent des mises conservé), reservation (une mise débitée non remboursée = current_bid), escrow.
-- Échanges (P8) : trade_money (Σ delta nulle par référence trade:<id>).
-- Batailles (M4-4) : battle_money (une ligne battle:<id> par joueur d'une bataille completed, et aucune autre ligne battle).
-- Succès (D:611, D-C16) : ach_money (une ligne ach:<id> par succès réclamé, et aucune autre ligne achievement).
-- Retraits (M6a) : pool_removed (aucune carte retirée dans wm.draw_pool).
-- Suppression (G1) : deleted_account (une pierre tombale sans copie, enchère active, échange pending, bataille ouverte, adhésion de
-- guilde, abonnement push ni amitié).
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
    -- la rend non nulle. La suppression de compte du M6a garde la ligne profiles (G1) : la limite ne vaut plus que pour un delete manuel
    -- de auth.users.
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
    -- référence. La suppression de compte du M6a garde la ligne profiles (G1) : la limite ne vaut plus que pour un delete manuel de
    -- auth.users.
    select jsonb_build_object('check', 'trade_money', 'ref', ref, 'sum', sum(delta))
    from wm.wb_ledger where reason = 'trade' group by ref having sum(delta) <> 0
    union all
    -- shortcut: même limite que market_money : la suppression d'un seul joueur déséquilibre la référence. La suppression de compte du
    -- M6a garde la ligne profiles (G1) : la limite ne vaut plus que pour un delete manuel de auth.users.
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
    -- shortcut: même limite que market_money : la suppression d'un seul joueur déséquilibre la référence. La suppression de compte du
    -- M6a garde la ligne profiles (G1) : la limite ne vaut plus que pour un delete manuel de auth.users.
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
    union all
    -- Carte retirée par le staff (wm.card_removals) encore tirable.
    select jsonb_build_object('check', 'pool_removed', 'card_id', p.card_id)
    from wm.draw_pool p join wm.card_removals r using (card_id)
    union all
    -- Pierre tombale (G1) qui garde une donnée propre ou un engagement ouvert.
    select jsonb_build_object('check', 'deleted_account', 'user_id', d.user_id, 'problem', k.problem)
    from wm.deleted_accounts d
    cross join lateral (
      select 'cards' problem where exists (select from public.user_cards uc where uc.user_id = d.user_id)
      union all
      select 'auction' where exists (select from public.auctions a where a.status = 'active'
        and d.user_id in (a.seller_id, a.current_bidder_id))
      union all
      select 'trade' where exists (select from public.trades t where t.status = 'pending' and d.user_id in (t.initiator_id, t.recipient_id))
      union all
      select 'battle' where exists (select from public.battles b
        where b.status in ('pending', 'deck_selection', 'generating_quizzes', 'active') and d.user_id in (b.challenger_id, b.opponent_id))
      union all
      select 'guild' where exists (select from public.guild_members gm where gm.user_id = d.user_id)
      union all
      select 'push' where exists (select from public.push_subscriptions ps where ps.user_id = d.user_id)
      union all
      select 'friend' where exists (select from public.friendships f where d.user_id in (f.requester_id, f.addressee_id))
    ) k
  ) x
$$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
