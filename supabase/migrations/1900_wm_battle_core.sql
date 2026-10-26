-- ADDITIVE : socle des batailles du M5a (R§3.9, D§7.7, M5a-2, M5a-8, M5a-10, M5a-12, C2, C3, C18) — config battle, list_caps,
-- battles_won, banques et file de quiz, secrets des réponses, index, invariant battle_money. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

insert into wm.config (key, value, note) values
  ('battle', '{"questions": 3, "pool": 6, "quota_free": 3, "quota_pro": 10, "invite_ttl_h": 24, "idle_loss_h": 48, "reward_win": 50,
    "reward_loss": 10}',
    'Batailles (D§7.7, R§5.7) : 3 questions par attaque (prob.), banque de 3 à 6 (M5a-8), 3 défis par jour (prob.) et 10 en Pro ou VIP (D:557, inféré), invitation 24 h et inactivité 48 h (prob.), récompenses 50 et 10 (inc.)')
on conflict do nothing;

-- Plafond du M5a (C2) : les valeurs déjà posées gagnent.
update wm.config set value = '{"battles_closed": 50}'::jsonb || value where key = 'list_caps';

-- Victoires (M5a-2), écrites par wm.battle_finish.
alter table wm.user_stats add column if not exists battles_won int not null default 0;

-- Banque d'une carte (C3) : questions = [{kind, prompt, options: [4 textes], correct: 0..3, evidence}], jamais lue par un client (M5a-10).
create table if not exists wm.card_quizzes (
  card_id uuid primary key references public.cards (id) on delete cascade,
  prompt_version int not null,
  source text not null check (source in ('llm', 'template')),
  model text,
  questions jsonb not null,
  created_at timestamptz not null default now()
);

-- File du générateur de banques (C12).
create table if not exists wm.quiz_queue (
  card_id uuid primary key references public.cards (id) on delete cascade,
  priority int not null,
  enqueued_at timestamptz not null default now(),
  attempts int not null default 0,
  next_try_at timestamptz not null default now(),
  last_error text
);

-- Bonne option de chaque question tirée (D:267, C3), jamais lue par un client avant la réponse. Sans clé étrangère vers cards ni profiles :
-- aucun verrou de plus.
create table if not exists wm.battle_secrets (
  battle_id uuid not null references public.battles (id) on delete cascade,
  question_id uuid not null,
  turn_number smallint not null,
  defender_id uuid not null,
  card_id uuid not null,
  q_index smallint not null,
  correct_option_id text not null,
  answer_id text,
  correct boolean,
  answered_at timestamptz,
  primary key (battle_id, question_id)
);

-- Listes, clés étrangères vérifiées à la suppression d'un profil, une bataille ouverte par paire (M5a-12), échéances du cron (C18), file.
-- Option A : CONCURRENTLY par le runbook, qui annule d'abord les doublons ouverts d'une paire (C18).
create index if not exists battles_challenger_idx on public.battles (challenger_id, created_at desc);
create index if not exists battles_opponent_idx on public.battles (opponent_id, created_at desc);
create index if not exists battles_winner_idx on public.battles (winner_id) where winner_id is not null;
create index if not exists battle_decks_user_idx on public.battle_decks (user_id);
create unique index if not exists battles_open_pair_uidx on public.battles (least(challenger_id, opponent_id), greatest(challenger_id, opponent_id))
  where status in ('pending', 'deck_selection', 'generating_quizzes', 'active');
create index if not exists battles_pending_idx on public.battles (created_at) where status = 'pending';
create index if not exists battles_live_idx on public.battles (updated_at) where status in ('deck_selection', 'generating_quizzes', 'active');
create index if not exists quiz_queue_next_idx on wm.quiz_queue (priority desc, enqueued_at) where attempts < 3;

-- Redéfinie de 1700 : signature inchangée, réponse toujours un tableau de violations, plus battle_money (M5a, Task 2).
-- Violations (tableau vide = OK) ; lancée après chaque test monétaire et par le rapprochement (D§11.4).
-- ledger_balance : Σ delta + discard_wb = solde, pour les joueurs qui ont un grand livre ; rarity_counts : compteurs = group by réel.
-- Marché (M3-26) : market_money (argent des mises conservé), reservation (une mise débitée non remboursée = current_bid), escrow.
-- Échanges (P8) : trade_money (Σ delta nulle par référence trade:<id>).
-- Batailles (M4-4) : battle_money (une ligne battle:<id> par joueur d'une bataille completed, et aucune autre ligne battle).
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
  ) x
$$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
