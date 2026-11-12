-- ADDITIVE : exploitation Stripe du M6b (G10, G24, G25, G35, G8) — check_invariants, account_export, staff_dashboard (redéfinies,
-- en-tête de chacune ci-dessous) ; stripe_cancel_targets (lecture stable), stripe_cancel_done, admin_stripe_cancel (nouvelles). Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.
-- Aucune des fonctions redéfinies ici ne porte de réglage dans proconfig autre que search_path (leçon de 1960) : security definer et
-- set search_path = '' redits tels quels.

-- Redéfinie de 2250 : même signature, même corps et même réponse qu'en 2250 (déployée, non retouchée), plus stripe_purchase et
-- stripe_pro en fin d'union (G25 a, b ; l'unicité des événements, G25 c, est prouvée par contrainte, C3).
-- ledger_balance : Σ delta + discard_wb = solde, pour les joueurs qui ont un grand livre ; rarity_counts : compteurs = group by réel.
-- Marché (M3-26) : market_money (argent des mises conservé), reservation (une mise débitée non remboursée = current_bid), escrow.
-- Échanges (P8) : trade_money (Σ delta nulle par référence trade:<id>).
-- Batailles (M4-4) : battle_money (une ligne battle:<id> par joueur d'une bataille completed, et aucune autre ligne battle).
-- Succès (D:611, D-C16) : ach_money (une ligne ach:<id> par succès réclamé, et aucune autre ligne achievement).
-- Retraits (M6a) : pool_removed (aucune carte retirée dans wm.draw_pool).
-- Suppression (G1) : deleted_account (une pierre tombale sans copie, enchère active, échange pending, bataille ouverte, adhésion de
-- guilde, abonnement push ni amitié).
-- Stripe (M6b) : stripe_purchase (une ligne stripe:<session_id> ↔ un achat wb_2500 de la même session et du même joueur, delta = wb) ;
-- stripe_pro (un abonnement active ou trialing → is_pro).
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
    union all
    -- Ligne stripe sans achat wb_2500 de même session et même joueur, ou d'un autre montant ; jointure sur le texte (pas de cast).
    select jsonb_build_object('check', 'stripe_purchase', 'ref', l.ref, 'user_id', l.user_id,
      'problem', case when u.session_id is null then 'no_purchase' else 'amount' end)
    from wm.wb_ledger l
    left join wm.purchases u on l.ref = 'stripe:' || u.session_id and u.user_id = l.user_id and u.item = 'wb_2500'
    where l.reason = 'stripe' and (u.session_id is null or l.delta <> u.wb)
    union all
    -- Achat wb_2500 sans sa ligne stripe:<session_id> (unique (reason, ref, user_id) : au plus une).
    select jsonb_build_object('check', 'stripe_purchase', 'session_id', u.session_id, 'user_id', u.user_id, 'problem', 'no_ledger')
    from wm.purchases u
    where u.item = 'wb_2500'
      and not exists (select from wm.wb_ledger l where l.reason = 'stripe' and l.ref = 'stripe:' || u.session_id and l.user_id = u.user_id)
    union all
    -- Abonnement active ou trialing dont le profil n'est pas Pro (G4) ; l'inverse (Pro sans abonnement) est permis : is_pro posé à la
    -- main (fixtures, G23) ou d'avant le M6b.
    select jsonb_build_object('check', 'stripe_pro', 'subscription_id', s.id, 'user_id', s.user_id)
    from wm.subscriptions s join public.profiles p on p.id = s.user_id
    where s.status in ('active', 'trialing') and not p.is_pro
  ) x
$$;

-- Redéfinie de 2260 : même signature, même corps et même réponse qu'en 2260 (déployée, non retouchée), plus stripe_customer_id,
-- subscriptions et purchases (G24) : ni price_id ni customer_id répété, aucun moyen de paiement (rien n'en est stocké).
create or replace function wm.account_export(p_uid uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_int int := (select (value ->> 'interval_s')::int from wm.config where key = 'account_export');
  v_at timestamptz;
  v_email text;
begin
  perform wm.access_check(p_uid);  -- avant le verrou : une suppression concurrente ne fait que rendre au propriétaire ses propres données (sans risque)
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_user(p_uid);
  select export_at into v_at from wm.user_state where user_id = p_uid;
  if v_at > now() - make_interval(secs => v_int) then
    perform wm.raise_err(429, null, 'Le site demande de ralentir',
      jsonb_build_object('retry_after', least(v_int, greatest(1, ceil(extract(epoch from v_at + make_interval(secs => v_int) - now()))::int))));
  end if;
  update wm.user_state set export_at = now() where user_id = p_uid;
  select email into v_email from auth.users where id = p_uid;
  return jsonb_build_object(
    'format', 'export-compte', 'version', 1, 'generated_at', now(),
    'account', (select jsonb_build_object('id', p.id, 'email', v_email, 'username', p.username, 'bio', p.bio, 'avatar_url', p.avatar_url,
        'is_public', p.is_public, 'created_at', p.created_at, 'last_seen_at', p.last_seen_at, 'is_pro', p.is_pro, 'is_vip', p.is_vip,
        'pack_cap', p.pack_cap, 'packs_remaining', p.packs_remaining, 'packs_last_regen_at', p.packs_last_regen_at,
        'wikibidous_balance', p.wikibidous_balance) from public.profiles p where p.id = p_uid),
    'state', (select to_jsonb(s) from wm.user_state s where s.user_id = p_uid),
    'stats', (select to_jsonb(s) from wm.user_stats s where s.user_id = p_uid),
    'preferences', (select to_jsonb(s) from wm.user_prefs s where s.user_id = p_uid),
    'notification_prefs', (select to_jsonb(s) from wm.notification_prefs s where s.user_id = p_uid),
    'push_subscriptions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'created_at', s.created_at)
      order by s.created_at, s.id) from public.push_subscriptions s where s.user_id = p_uid), '[]'),
    'notifications', coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at, n.id)
      from public.notifications n where n.user_id = p_uid), '[]'),
    'cards', coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object('tags', coalesce((select jsonb_agg(t.name order by t.name, t.id)
        from public.user_card_tags x join public.tags t on t.id = x.tag_id where x.user_card_id = c.id), '[]')) order by c.obtained_at, c.id)
      from public.user_cards c where c.user_id = p_uid), '[]'),
    'tags', coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at, t.id) from public.tags t where t.user_id = p_uid), '[]'),
    'wishlist', coalesce((select jsonb_agg(to_jsonb(w) order by w.created_at, w.card_id)
      from public.wishlist_items w where w.user_id = p_uid), '[]'),
    'showcase', coalesce((select jsonb_agg(to_jsonb(s) order by s.position, s.user_card_id) from public.showcase s where s.user_id = p_uid), '[]'),
    'ledger', coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at, l.id) from wm.wb_ledger l where l.user_id = p_uid), '[]'),
    'auctions_sold', coalesce((select jsonb_agg(to_jsonb(a) - 'snapshot_search_document' order by a.created_at, a.id)
      from public.auctions a where a.seller_id = p_uid), '[]'),
    'bids', coalesce((select jsonb_agg(to_jsonb(b) order by b.placed_at, b.id) from public.auction_bids b where b.bidder_id = p_uid), '[]'),
    'trades', coalesce((select jsonb_agg(to_jsonb(t) || jsonb_build_object('items', coalesce((select jsonb_agg(to_jsonb(i) order by i.id)
        from public.trade_items i where i.trade_id = t.id), '[]')) order by t.created_at, t.id)
      from public.trades t where p_uid in (t.initiator_id, t.recipient_id)), '[]'),
    'friends', coalesce((select jsonb_agg(jsonb_build_object('friendship_id', f.id, 'status', f.status, 'other_username', o.username,
        'created_at', f.created_at) order by f.created_at, f.id)
      from public.friendships f join public.profiles o on o.id = case when f.requester_id = p_uid then f.addressee_id else f.requester_id end
      where p_uid in (f.requester_id, f.addressee_id)), '[]'),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'direction', case when m.sender_id = p_uid then 'sent' else 'received' end,
        'other_username', o.username, 'content', m.content, 'read', m.read, 'created_at', m.created_at) order by m.created_at, m.id)
      from public.chat_messages m join public.profiles o on o.id = case when m.sender_id = p_uid then m.recipient_id else m.sender_id end
      where p_uid in (m.sender_id, m.recipient_id)), '[]'),
    'reports_filed', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'reported_username', o.username, 'reason', r.reason,
        'details', r.details, 'created_at', r.created_at) order by r.created_at, r.id)
      from public.reports r join public.profiles o on o.id = r.reported_user_id where r.reporter_id = p_uid), '[]'),
    'battles', coalesce((select jsonb_agg(wm.battle_json(b, p_uid) || jsonb_build_object('my_deck',
        (select d.card_ids from public.battle_decks d where d.battle_id = b.id and d.user_id = p_uid)) order by b.created_at, b.id)
      from public.battles b where p_uid in (b.challenger_id, b.opponent_id)), '[]'),
    'guild', jsonb_build_object(
      'membership', (select to_jsonb(m) || jsonb_build_object('guild_name', g.name) from public.guild_members m
        join public.guilds g on g.id = m.guild_id where m.user_id = p_uid),
      'wishes', coalesce((select jsonb_agg(to_jsonb(w) order by w.created_at, w.id) from public.guild_wishlists w where w.user_id = p_uid), '[]'),
      'donations_given', coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at, d.id)
        from public.guild_donations d where d.donor_id = p_uid), '[]'),
      'donations_received', coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at, d.id)
        from public.guild_donations d where d.recipient_id = p_uid), '[]'),
      'messages', coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at, m.id)
        from public.guild_chat_messages m where m.user_id = p_uid), '[]'),
      'invites_received', coalesce((select jsonb_agg(jsonb_build_object('guild_id', i.guild_id, 'guild_name', g.name, 'inviter_username', o.username,
          'created_at', i.created_at) order by i.created_at, i.guild_id)
        from wm.guild_invites i join public.guilds g on g.id = i.guild_id left join public.profiles o on o.id = i.inviter_id
        where i.user_id = p_uid), '[]')),
    'achievements', coalesce((select jsonb_agg(to_jsonb(a) order by a.unlocked_at, a.achievement_id)
      from public.user_achievements a where a.user_id = p_uid), '[]'),
    'pro_daily_claims', coalesce((select jsonb_agg(to_jsonb(c) order by c.claimed_at, c.day)
      from wm.pro_daily_claims c where c.user_id = p_uid), '[]'),
    'special_pack_claims', coalesce((select jsonb_agg(to_jsonb(c) order by c.claimed_at, c.pack_id)
      from wm.special_pack_claims c where c.user_id = p_uid), '[]'),
    'grace_grants', coalesce((select jsonb_agg(to_jsonb(g) - 'created_by' order by g.created_at, g.id)
      from wm.grace_grants g where g.user_id = p_uid), '[]'),
    'sanctions', coalesce((select jsonb_agg(jsonb_build_object('kind', s.kind, 'reason', s.reason, 'starts_at', s.starts_at,
        'ends_at', s.ends_at, 'revoked_at', s.revoked_at) order by s.created_at, s.id) from wm.sanctions s where s.user_id = p_uid), '[]'),
    'image_reports', coalesce((select jsonb_agg(jsonb_build_object('card_id', r.card_id, 'created_at', r.created_at)
      order by r.created_at, r.card_id) from wm.card_image_reports r where r.user_id = p_uid), '[]'),
    'staff_role', (select s.role from wm.staff s where s.user_id = p_uid),
    'stripe_customer_id', (select c.customer_id from wm.stripe_customers c where c.user_id = p_uid),
    'subscriptions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'status', s.status, 'current_period_end', s.current_period_end,
        'cancel_at_period_end', s.cancel_at_period_end, 'cancel_at', s.cancel_at, 'canceled_at', s.canceled_at,
        'latest_invoice_status', s.latest_invoice_status, 'updated_at', s.updated_at) order by s.updated_at, s.id)
      from wm.subscriptions s where s.user_id = p_uid), '[]'),
    'purchases', coalesce((select jsonb_agg(jsonb_build_object('session_id', u.session_id, 'item', u.item, 'amount', u.amount,
        'currency', u.currency, 'consent', u.consent, 'wb', u.wb, 'created_at', u.created_at) order by u.created_at, u.session_id)
      from wm.purchases u where u.user_id = p_uid), '[]'));
end $$;

-- Redéfinie de 2240 : même signature, même corps et même réponse qu'en 2240 (déployée, non retouchée), plus les litiges ouverts (G8,
-- statuts de stripe_disputes_open_idx), les résiliations en attente (G10, G35) et les achats sur comptes supprimés (crédit inerte, G38 :
-- argent pris pour rien, seul un remboursement au Dashboard Stripe le répare).
-- Tableau de bord : compteurs globaux et wm.health() (D:644, G18).
create or replace function wm.staff_dashboard(p_uid uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform wm.staff_actor(p_uid);
  return jsonb_build_object(
    'open_reports', (select count(*) from public.reports r where not exists (select from wm.report_reviews v where v.report_id = r.id)),
    'image_reports', (select count(distinct card_id) from wm.card_image_reports),
    -- Masquée d'office : hide_image encore vrai et aucune décision du staff sur la carte depuis l'auto-masquage.
    'auto_hidden_cards', (select count(*) from public.cards c
      where c.hide_image and (select a.action from wm.staff_actions a where a.target_type = 'card' and a.target_id = c.id::text
        order by a.created_at desc, a.id desc limit 1) = 'image_auto_hide'),
    'active_sanctions', (select count(*) from wm.sanctions s
      where s.revoked_at is null and s.starts_at <= now() and (s.ends_at is null or s.ends_at > now())),
    'removed_cards', (select count(*) from wm.card_removals),
    'auth_pending', (select count(*) from wm.deleted_accounts where auth_done_at is null),
    'health', wm.health(),
    'stripe_disputes_open', (select count(*) from wm.stripe_disputes where status not in ('won', 'lost', 'warning_closed', 'prevented')),
    'stripe_disputes', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'amount', d.amount, 'currency', d.currency, 'reason', d.reason,
        'status', d.status, 'created_at', d.created_at) order by d.created_at desc, d.id)
      from (select * from wm.stripe_disputes where status not in ('won', 'lost', 'warning_closed', 'prevented')
        order by created_at desc, id limit 20) d), '[]'),
    'stripe_pending', (select count(*) from wm.deleted_accounts where stripe_pending),
    'stripe_pending_users', coalesce((select jsonb_agg(jsonb_build_object('user_id', d.user_id, 'username', p.username,
        'deleted_at', d.deleted_at) order by d.deleted_at, d.user_id)
      from (select * from wm.deleted_accounts where stripe_pending order by deleted_at, user_id
        limit coalesce((select (value ->> 'page')::int from wm.config where key = 'admin'), 50)) d
      join public.profiles p on p.id = d.user_id), '[]'),
    -- Achat enregistré après la suppression du compte (created_at = insertion par le webhook : un paiement d'avant la suppression dont
    -- le webhook arrive après compte aussi, son crédit est inerte) ; le compte et les 20 plus récents.
    'purchases_on_deleted', (select count(*) from wm.purchases u join wm.deleted_accounts d on d.user_id = u.user_id
      where u.created_at >= d.deleted_at),
    'purchases_on_deleted_list', coalesce((select jsonb_agg(jsonb_build_object('session_id', u.session_id, 'user_id', u.user_id,
        'item', u.item, 'amount', u.amount, 'currency', u.currency, 'created_at', u.created_at) order by u.created_at desc, u.session_id)
      from (select u.* from wm.purchases u join wm.deleted_accounts d on d.user_id = u.user_id where u.created_at >= d.deleted_at
        order by u.created_at desc, u.session_id limit 20) u), '[]'));
end $$;

-- Abonnements à résilier chez Stripe (G9, G10) : non terminaux, triés. Sans verrou : la route résilie puis appelle stripe_cancel_done.
create or replace function wm.stripe_cancel_targets(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('subscription_ids', coalesce(jsonb_agg(id order by id), '[]'))
  from wm.subscriptions
  -- Liste non terminale de G9, recopiée telle quelle dans 2300 (trigger stripe_pending_on_delete, garde de stripe_checkout_prepare),
  -- 2310 (stripe_apply) et stripe_cancel_done ci-dessous : changer l'une, c'est changer toutes.
  where user_id = p_user_id and status in ('active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused')
$$;

-- Après une résiliation réussie (G35) : stripe_pending recalculé en excluant les seuls ids résiliés ; un second abonnement créé pendant
-- les appels Stripe (G41, webhook en retard) le garde vrai. La ligne est prise d'abord (seul verrou, C4) : l'exists lu ensuite, dans une
-- nouvelle instruction, voit un stripe_apply qui la tenait (sinon un instantané d'avant son commit écraserait son true).
create or replace function wm.stripe_cancel_done(p_user_id uuid, p_subscription_ids text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v boolean;
begin
  perform set_config('lock_timeout', '2s', true);
  perform from wm.deleted_accounts where user_id = p_user_id for update;
  -- Liste non terminale de G9 (mêmes copies que stripe_cancel_targets ci-dessus : 2300, 2310).
  update wm.deleted_accounts set stripe_pending = exists (select from wm.subscriptions where user_id = p_user_id
    and status in ('active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused')
    and id <> all (coalesce(p_subscription_ids, '{}')))
  where user_id = p_user_id
  returning stripe_pending into v;
  return jsonb_build_object('ok', true, 'stripe_pending', coalesce(v, false));
end $$;

-- « Résilier » du tableau de bord (G10, admin) : chemin staff du M6a ; la pierre tombale tenue for update ; rend les abonnements que la
-- route résilie chez Stripe avant stripe_cancel_done. Rejouable : rien n'est écrit ici que l'audit.
create or replace function wm.admin_stripe_cancel(p_uid uuid, p_user_id uuid, p_reason text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_reason text;
  v_pending boolean;
  v_ids jsonb;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.staff_actor(p_uid, 'admin');
  v_reason := wm.admin_reason(p_reason);
  perform set_config('lock_timeout', '2s', true);
  select stripe_pending into v_pending from wm.deleted_accounts where user_id = p_user_id for update;
  if not coalesce(v_pending, false) then
    perform wm.raise_err(409, null, 'Aucune résiliation en attente');
  end if;
  v_ids := wm.stripe_cancel_targets(p_user_id) -> 'subscription_ids';
  perform wm.staff_log(p_uid, 'stripe_cancel', 'user', p_user_id::text, v_reason, jsonb_build_object('subscription_ids', v_ids));
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('stripe', jsonb_build_object('user_id', p_user_id, 'subscription_ids', v_ids)));
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
