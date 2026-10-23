-- ADDITIVE : socle social du M4b (R§3.7, M4b-3, M4b-6, M4b-7, M4b-9, M4b-12, M4b-13, M4b-17, M4b-20, B3) — config, rafale des
-- messages, préférences push, outbox, index, avatar_url effacé avec sa copie, trade_move qui vide la vitrine. Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.

insert into wm.config (key, value, note) values
  ('chat_burst', '{"count": 30, "window_s": 60}', 'Messages privés par fenêtre, par expéditeur (D:595, C17, M4b-3)'),
  ('push_origins', '{"origins": ["https://fcm.googleapis.com", "https://updates.push.services.mozilla.com", "https://web.push.apple.com"],
    "suffixes": [".notify.windows.com"]}', 'Services de push acceptés, contre le SSRF ; le banc y ajoute son origine (M4b-12)'),
  ('push_max_subscriptions', '10', 'Abonnements par joueur ; écart à C30 (M4b-20)'),
  -- Relu par lib/notifications.test.ts (Task 10) : garder le littéral juste après sa clé.
  ('push_types', '["auction_outbid","auction_sold","auction_unsold","auction_won","chat_message","friend_accepted","friend_request",
    "trade_accepted","trade_cancelled","trade_countered","trade_declined","trade_received","wishlist_listed"]',
    'Types qu''un joueur peut activer en push (M4b-13)'),
  ('push_wake_url', 'null'::jsonb, 'URL de /api/cron/push pour pg_net, posée par deploy-m4b.sql (C30, M4b-17)')
on conflict do nothing;

-- Plafonds du M4b (B3) : les valeurs déjà posées gagnent.
update wm.config set value = '{"conversations": 50, "messages": 100, "friend_owners": 3}'::jsonb || value where key = 'list_caps';

-- Débit des messages (M4b-3), sur le modèle de bid_window_* (1600).
alter table wm.user_state
  add column if not exists chat_window_start timestamptz,
  add column if not exists chat_window_count int not null default 0;

-- Types qu'un joueur reçoit en push, opt-in (M4b-13, D:259, D:600).
create table if not exists wm.notification_prefs (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  push_types text[] not null default '{}'
);

-- Une ligne par couple (notification, abonnement) à envoyer. Sans clé étrangère : aucun verrou pris, et une ligne orpheline est jetée à la
-- réservation.
create table if not exists wm.push_outbox (
  id bigint generated always as identity primary key,
  subscription_id uuid not null,
  notification_id uuid not null,
  created_at timestamptz not null default now()
);

-- Fils (M4b-9, D:811), vitrine (M4b-7), abonnements, signalements (cascade d'une suppression de compte, M6). Option A : CONCURRENTLY par
-- le runbook.
create index if not exists chat_messages_pair_idx on public.chat_messages (sender_id, recipient_id, created_at desc);
create index if not exists chat_messages_recipient_pair_idx on public.chat_messages (recipient_id, sender_id, created_at desc);
create index if not exists chat_messages_unread_idx on public.chat_messages (recipient_id) where not read;
create index if not exists showcase_user_card_idx on public.showcase (user_card_id);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
create index if not exists reports_reported_idx on public.reports (reported_user_id);

-- avatar_url suit sa copie (M4b-6) : l'id qui passe d'une copie à null l'efface, y compris par l'on delete set null (défausse, séquestre).
-- La clause when garde l'avatar_url d'un profil migré sans copie, quand une écriture remet la colonne à null.
create or replace function wm.avatar_url_clear()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.avatar_url := null;
  return new;
end $$;

create or replace trigger profiles_avatar_url_clear before update of avatar_user_card_id on public.profiles
  for each row when (old.avatar_user_card_id is not null and new.avatar_user_card_id is null) execute function wm.avatar_url_clear();

-- Redéfinie de 1730, signature et réponse inchangées.
-- Seul update … set user_id permis hors défausse et enchères (M4-3) ; copies déjà verrouillées et vérifiées par l'appelant. k = éléments par
-- copie : k = n déplace la ligne (même id, même count), k < n crée une ligne de count k chez l'autre joueur et décrémente la source, sans fusion.
-- Ce qui arrive est sans étoile ni étiquette ; l'avatar et l'emplacement de vitrine d'une copie déplacée en entier sont effacés, une pile
-- donnée en partie garde les siens (M4b-7).
create or replace function wm.trade_move(p_trade public.trades)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_full uuid[];
  v_part uuid[];
  v_k int[];
begin
  select array_agg(x.id order by x.id) filter (where x.k = uc.count), array_agg(x.id order by x.id) filter (where x.k < uc.count),
    array_agg(x.k order by x.id) filter (where x.k < uc.count)
  into v_full, v_part, v_k
  from (select user_card_id id, count(*)::int k from public.trade_items where trade_id = p_trade.id group by user_card_id) x
  join public.user_cards uc on uc.id = x.id;
  update public.user_cards set user_id = case user_id when p_trade.initiator_id then p_trade.recipient_id else p_trade.initiator_id end,
    starred = false
  where id = any (v_full);
  insert into public.user_cards (user_id, card_id, count, starred, is_shiny, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk,
    snapshot_def, obtained_at)
  select case uc.user_id when p_trade.initiator_id then p_trade.recipient_id else p_trade.initiator_id end, uc.card_id, x.k, false, uc.is_shiny,
    uc.snapshot_title, uc.snapshot_rarity, uc.snapshot_category, uc.snapshot_atk, uc.snapshot_def, uc.obtained_at
  from unnest(v_part, v_k) x (id, k) join public.user_cards uc on uc.id = x.id;
  update public.user_cards set count = count - x.k from unnest(v_part, v_k) x (id, k) where user_cards.id = x.id;
  -- shortcut: un lien posé par l'ancien propriétaire pendant l'acceptation (insert concurrent qui attend la clé étrangère) survit sur la copie
  -- déplacée, invisible par RLS ; pour l'exclure, trigger after insert sur user_card_tags qui relit la copie for key share.
  delete from public.user_card_tags where user_card_id = any (v_full);
  update public.profiles set avatar_user_card_id = null
  where avatar_user_card_id = any (v_full) and id in (p_trade.initiator_id, p_trade.recipient_id);
  delete from public.showcase where user_card_id = any (v_full);
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
