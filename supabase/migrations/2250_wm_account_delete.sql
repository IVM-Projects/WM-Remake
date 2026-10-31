-- ADDITIVE : suppression de compte (A3, G1, M6a-3) — account_delete (Task 6b), account_auth_done (G12) ; handle_new_user : même
-- signature, même corps et même réponse qu'en 1870 (déployée, non retouchée), plus le report d'un bannissement à l'inscription d'un
-- e-mail banni (anti-évasion, G1) ; tombstone_guard et son trigger profiles_tombstone_guard (plan B de G1) ; check_invariants : même
-- signature, même corps et même réponse qu'en 2000 (déployée, non retouchée), plus pool_removed et deleted_account ; friend_request et
-- friend_search : mêmes signatures, mêmes corps et mêmes réponses qu'en 1710 (déployée, non retouchée), plus le refus et l'exclusion
-- d'un compte supprimé (Task 6b) ; lock_user et lock_users : mêmes signatures, mêmes corps et mêmes réponses qu'en 1100 et 1600
-- (déployées, non retouchées), plus le refus de l'acteur supprimé entre wm.actor et son verrou (revue finale). Idempotente.
-- Compatible pg-safeupdate (préchargé par le PostgREST hébergé, même dans les fonctions) : tout DELETE/UPDATE garde un WHERE.
-- Aucune des fonctions redéfinies ici ne porte de réglage dans proconfig (leçon de 1960).

-- Suppression douce GoTrue faite (G1, G12) : sans actor (le compte est supprimé), appelée par la route seulement. Rejouée → inchangée.
create or replace function wm.account_auth_done(p_uid uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('lock_timeout', '2s', true);
  update wm.deleted_accounts set auth_done_at = coalesce(auth_done_at, now()) where user_id = p_uid;
  -- G1 : le journal GoTrue garde l'e-mail d'origine (traits.user_email de user_signedup et user_deleted, actor_username de login),
  -- que la suppression douce n'efface pas ; l'e-mail est déjà remplacé, donc ses lignes se retrouvent par l'id : actor_id (actions du
  -- joueur) ou traits.user_id (actions admin sur lui). Au mieux seulement (G12) : toute erreur de la purge (privilège, schéma, délai,
  -- verrou…) est ignorée dans son propre point de sauvegarde, auth_done_at reste posé ; query_canceled est nommé, others ne le couvre pas.
  begin
    delete from auth.audit_log_entries
    where exists (select from wm.deleted_accounts where user_id = p_uid)
      and (payload ->> 'actor_id' = p_uid::text or payload -> 'traits' ->> 'user_id' = p_uid::text);
  exception when query_canceled or others then
    raise warning 'purge audit GoTrue ignorée (%)', sqlstate;
  end;
  return '{"ok": true}'::jsonb;
end $$;

-- Inscription GoTrue (D§7.1) : un refus lève P0001, que GoTrue relaie en 500 avec message et detail.
-- 2250 : un e-mail dont l'empreinte est dans wm.banned_emails (compte supprimé sous bannissement, G1) repart banni, audit système, et
-- banned_until GoTrue posé au mieux.
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
    -- Ban GoTrue posé tout de suite (G4 : connexion et renouvellement refusés), la valeur de banDuration ('876000h', lib/admin-auth.ts).
    -- Au mieux : un privilège refusé (hébergé) ne fait jamais échouer l'inscription ; « Resynchroniser la session » rattrape.
    begin
      update auth.users set banned_until = now() + interval '876000 hours' where id = new.id;
    exception when insufficient_privilege then
      raise warning 'ban GoTrue reporté non posé (%)', sqlstate;
    end;
  end if;
  return null;
end $$;

-- Plan B de G1 : si GoTrue supprimait la ligne auth.users (suppression « dure »), la cascade emporterait la pierre tombale et
-- l'historique d'autrui ; elle échoue donc, sauf sous wm.allow_tombstone_delete = 'on' (nettoyages des tests seulement ; un nettoyage
-- hors bloc de transaction le pose par set_config(..., false), sinon le réglage local tombe avant le delete).
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

-- Pseudo d'un compte supprimé recopié dans les notifications d'autrui (account_delete) ; sert aussi aux lectures de 1860 par expéditeur.
-- Option A : CONCURRENTLY par le runbook.
create index if not exists notifications_actor_idx on public.notifications ((data ->> 'user_id'));

-- Redéfinie de 1100 : même signature, même corps et même réponse qu'en 1100 (déployée, non retouchée), plus le refus de l'acteur
-- (wm.actor_uid, posé par wm.actor) supprimé pendant qu'il attendait ce verrou : wm.actor l'a laissé passer avant que la suppression
-- valide (open_pack, guild_create…). Le staff (staff_actor vide wm.actor_uid) et les contreparties ne sont pas visés.
-- Étapes 2 et 3 de C4 pour un joueur ; les lignes wm manquantes (profil migré, sans trigger) sont créées au passage.
create or replace function wm.lock_user(p_uid uuid)
returns public.profiles language plpgsql security definer set search_path = '' as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = p_uid for update;
  if not found then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  if p_uid::text = current_setting('wm.actor_uid', true) and exists (select from wm.deleted_accounts where user_id = p_uid) then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  insert into wm.user_state (user_id) values (p_uid) on conflict do nothing;
  insert into wm.user_stats (user_id) values (p_uid) on conflict do nothing;
  insert into wm.user_prefs (user_id) values (p_uid) on conflict do nothing;
  perform from wm.user_state where user_id = p_uid for update;
  return p;
end $$;

-- Redéfinie de 1600 : même signature, même corps et même réponse qu'en 1600 (déployée, non retouchée), plus le même refus de l'acteur
-- supprimé que wm.lock_user (place_bid, create_trade…).
-- Étapes 2 et 3 de C4 pour plusieurs joueurs (M3-12). `= any` ignore null et doublons ; LockRows passe après le tri, donc verrous dans l'ordre
-- des id. Un id inconnu est ignoré.
create or replace function wm.lock_users(p_uids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform from public.profiles where id = any (p_uids) order by id for update;
  if exists (select from wm.deleted_accounts where user_id = any (p_uids) and user_id::text = current_setting('wm.actor_uid', true)) then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  insert into wm.user_state (user_id) select id from public.profiles where id = any (p_uids) order by id on conflict do nothing;
  perform from wm.user_state where user_id = any (p_uids) order by user_id for update;
end $$;

-- Suppression de compte immédiate (A3, M6a-3), une transaction. Politique d'effacement (G1) :
--   gardé (données partagées, preuves, argent) : la ligne profiles et son id, messages privés et de guilde, échanges clos, batailles
--   finies, dons de guilde, signalements déposés et reçus, sanctions, grand livre, solde inerte, succès, statistiques, audit ; aussi
--   ses signalements d'image (wm.card_image_reports : ils comptent pour le seuil de 10 signaleurs) et ses decks de bataille
--   (public.battle_decks : historique des batailles finies) ;
--   effacé (données propres) : pseudo « Joueur supprimé <8 hex> » (16 hex en cas de collision), bio, avatar, profil privé, collection
--   (vitrine et étiquettes de copie en cascade), étiquettes, liste de souhaits, notifications, abonnements push, amitiés, invitations de
--   guilde reçues et envoyées, souhait de guilde ouvert, rôle staff, préférences (wm.user_prefs, wm.notification_prefs) ;
--   dénoué d'abord : enchères actives dont il est vendeur ou meneur (auction_void), échanges en attente (trade_void), batailles ouvertes
--   (annulées, ou finies au profit de l'adversaire si active), guilde (départ, transmission au plus ancien membre relu sous le verrou de
--   la guilde, dissolution s'il n'en reste aucun) ;
--   relu sous les verrous : un engagement (souhait de guilde ouvert compris) absent du premier relevé → 503 BUSY, tout est annulé ;
--   anti-évasion : empreinte de l'e-mail seulement sous bannissement actif ;
--   pseudo recopié dans les notifications des autres joueurs (data.username des notify_*, battle_won écrit ici compris) : remplacé par
--   le pseudo de la pierre tombale.
-- Sans wm.actor : un banni exerce ce droit tant que sa session vit.
-- M6b : la résiliation de l'abonnement Stripe se branche dans la route, avant la suppression GoTrue (A3).
-- shortcut: collection effacée en une transaction ; au-delà d'environ 488 000 copies (N mesuré par la Task 6b sur un banc local sans
-- fsync : 20 000 copies en 328 ms ; en production, sans doute moins), 503 : effacement par lots au M8.
create or replace function wm.account_delete(p_uid uuid, p_username text, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  v_name text;
  v_wishes uuid[];
  v_trades uuid[];
  v_auctions uuid[];
  v_battles uuid[];
  v_friends uuid[];
  v_users uuid[];
  v_id uuid;
  b public.battles;
  v_finished int := 0;
  v_cancelled int := 0;
  g uuid;
  v_role public.guild_role;
  v_heir uuid;
  v_guild text;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  if (select value from wm.config where key = 'maintenance') = 'true'::jsonb then
    perform wm.raise_err(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.');
  end if;
  select username into v_name from public.profiles where id = p_uid;
  if not found or exists (select from wm.deleted_accounts where user_id = p_uid) then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  if lower(btrim(p_username)) is distinct from lower(v_name) then
    perform wm.raise_err(400, 'invalid_request', 'Tape ton pseudo exactement pour confirmer');
  end if;
  perform set_config('lock_timeout', '2s', true);
  -- Ordre C4 : amitiés d'abord (wm.friend_remove tient l'amitié puis annule les échanges en attente de la paire : prises après les
  -- échanges, elles fermeraient un cycle, 40P01), puis souhait ouvert, échanges, enchères, batailles (l'ordre de wm.admin_card_remove,
  -- qui ne prend aucune amitié), puis les profils, puis la guilde.
  select coalesce(array_agg(x.id order by x.id), '{}') into v_friends
  from (select id from public.friendships where p_uid in (requester_id, addressee_id) order by id for update) x;
  select coalesce(array_agg(x.id order by x.id), '{}') into v_wishes
  from (select id from public.guild_wishlists where user_id = p_uid and fulfilled_at is null order by id for update) x;
  select coalesce(array_agg(x.id order by x.id), '{}') into v_trades
  from (select id from public.trades where status = 'pending' and p_uid in (initiator_id, recipient_id) order by id for update) x;
  select coalesce(array_agg(x.id order by x.id), '{}') into v_auctions
  from (select id from public.auctions where status = 'active' and p_uid in (seller_id, current_bidder_id) order by id for update) x;
  select coalesce(array_agg(x.id order by x.id), '{}') into v_battles
  from (select id from public.battles where status in ('pending', 'deck_selection', 'generating_quizzes', 'active')
    and p_uid in (challenger_id, opponent_id) order by id for update) x;
  -- Contreparties, plus les autres membres de sa guilde s'il en est chef (le successeur doit être tenu) ; lock_users ignore null.
  v_users := array(select p_uid
    union select unnest(array[seller_id, current_bidder_id]) from public.auctions where id = any (v_auctions)
    union select unnest(array[initiator_id, recipient_id]) from public.trades where id = any (v_trades)
    union select unnest(array[challenger_id, opponent_id]) from public.battles where id = any (v_battles)
    union select o.user_id from public.guild_members m join public.guild_members o on o.guild_id = m.guild_id
      where m.user_id = p_uid and m.role = 'leader');
  perform wm.lock_users(v_users);
  -- Relu sous le verrou (G1) : une suppression concurrente, ou un engagement créé entre le relevé et le verrou du profil.
  if exists (select from wm.deleted_accounts where user_id = p_uid) then
    perform wm.raise_err(401, 'unauthorized', 'Session expirée, reconnecte-toi.');
  end if;
  if exists (select from public.guild_wishlists where user_id = p_uid and fulfilled_at is null and id <> all (v_wishes))
    or exists (select from public.trades where status = 'pending' and p_uid in (initiator_id, recipient_id) and id <> all (v_trades))
    or exists (select from public.auctions where status = 'active' and p_uid in (seller_id, current_bidder_id) and id <> all (v_auctions))
    or exists (select from public.battles where status in ('pending', 'deck_selection', 'generating_quizzes', 'active')
      and p_uid in (challenger_id, opponent_id) and id <> all (v_battles))
    or exists (select from public.friendships where p_uid in (requester_id, addressee_id) and id <> all (v_friends)) then
    perform wm.raise_err(503, 'BUSY', 'Le site est très sollicité, réessaie dans un instant.');
  end if;
  select guild_id into g from public.guild_members where user_id = p_uid;
  if g is not null then
    perform from public.guilds where id = g for no key update;
    select role into v_role from public.guild_members where user_id = p_uid and guild_id = g;
    if v_role = 'leader' then
      select user_id into v_heir from public.guild_members where guild_id = g and user_id <> p_uid order by joined_at, user_id limit 1;
      if v_heir is null then
        v_guild := 'dissolved';
      elsif v_heir = any (v_users) then
        v_guild := 'transferred';
      else
        -- Arrivé après le relevé des membres : son profil n'est pas tenu, et le prendre maintenant romprait l'ordre C4.
        perform wm.raise_err(503, 'BUSY', 'Le site est très sollicité, réessaie dans un instant.');
      end if;
    elsif v_role is not null then
      v_guild := 'left';
    end if;
  end if;
  -- Écritures.
  -- Condition de ban actif : doit rester identique à celle de wm.auth_state (2200).
  insert into wm.banned_emails (email_hash, user_id)
  select wm.email_hash(u.email), p_uid from auth.users u
  where u.id = p_uid and u.email is not null and exists (select from wm.sanctions s where s.user_id = p_uid and s.kind = 'ban'
    and s.revoked_at is null and s.starts_at <= now() and (s.ends_at is null or s.ends_at > now()))
  on conflict do nothing;
  foreach v_id in array v_auctions loop
    perform wm.auction_void(v_id);
  end loop;
  foreach v_id in array v_trades loop
    perform wm.trade_void(v_id, p_uid);
  end loop;
  foreach v_id in array v_battles loop
    select * into b from public.battles where id = v_id;
    if b.status = 'active' then
      perform wm.battle_finish(b.id, case when b.challenger_id = p_uid then b.opponent_id else b.challenger_id end);
      v_finished := v_finished + 1;
    else
      update public.battles set status = 'cancelled', updated_at = clock_timestamp() where id = b.id;
      v_cancelled := v_cancelled + 1;
    end if;
  end loop;
  if v_guild = 'dissolved' then
    perform from public.guilds where id = g for update;
    delete from public.guilds where id = g;
  elsif v_guild = 'transferred' then
    -- L'ancien chef passe member avant le successeur (index unique guild_members_leader_key).
    update public.guild_members set role = 'member' where user_id = p_uid and guild_id = g;
    update public.guild_members set role = 'leader' where user_id = v_heir and guild_id = g;
    update public.guilds set leader_id = v_heir where id = g;
  end if;
  delete from public.guild_members where user_id = p_uid;
  delete from public.guild_wishlists where id = any (v_wishes) and fulfilled_at is null;
  delete from wm.guild_invites where p_uid in (user_id, inviter_id);
  delete from public.friendships where id = any (v_friends);
  delete from public.notifications where user_id = p_uid;
  delete from public.push_subscriptions where user_id = p_uid;
  delete from public.wishlist_items where user_id = p_uid;
  delete from public.tags where user_id = p_uid;
  delete from public.user_cards where user_id = p_uid;
  delete from wm.staff where user_id = p_uid;
  delete from wm.user_prefs where user_id = p_uid;
  delete from wm.notification_prefs where user_id = p_uid;
  begin
    update public.profiles set username = 'Joueur supprimé ' || substr(md5(p_uid::text), 1, 8), bio = null, avatar_user_card_id = null,
      avatar_url = null, is_public = false
    where id = p_uid;
  exception when unique_violation then
    update public.profiles set username = 'Joueur supprimé ' || substr(md5(p_uid::text), 1, 16), bio = null, avatar_user_card_id = null,
      avatar_url = null, is_public = false
    where id = p_uid;
  end;
  -- Après le renommage (le battle_won écrit plus haut par battle_finish compris), relu de la ligne : 8 ou 16 hex. Lignes d'autrui, jsonb
  -- seul : aucun verrou de profil (index notifications_actor_idx).
  update public.notifications set data = jsonb_set(data, '{username}', to_jsonb((select username from public.profiles where id = p_uid)))
  where data ->> 'user_id' = p_uid::text and data ? 'username';
  insert into wm.deleted_accounts (user_id) values (p_uid);
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('ok', true, 'voided_auctions', cardinality(v_auctions),
    'cancelled_trades', cardinality(v_trades), 'finished_battles', v_finished, 'cancelled_battles', v_cancelled, 'guild', v_guild));
end $$;

-- Redéfinie de 1710 : même signature, même corps et même réponse qu'en 1710 (déployée, non retouchée), plus le refus d'un compte supprimé
-- relu après lock_users (G1 : une demande en attente sur le profil pendant une suppression ne crée rien après coup).
-- Demande (M4-11) : les deux profils tenus (P4) sérialisent deux demandes croisées, qui sinon finiraient en 23505 sur l'index de paire.
-- Une demande vers qui m'a déjà demandé reste un 409 : pas d'acceptation implicite.
create or replace function wm.friend_request(p_uid uuid, p_addressee_id uuid, p_idem text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_resp jsonb;
  f public.friendships;
begin
  v_resp := wm.idem_claim(p_uid, p_idem);
  if v_resp is not null then
    return v_resp;
  end if;
  perform wm.actor(p_uid);
  if p_addressee_id = p_uid then
    perform wm.raise_err(400, 'invalid_request', 'Tu ne peux pas t''ajouter toi-même en ami');
  end if;
  if not exists (select from public.profiles where id = p_addressee_id) then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  perform set_config('lock_timeout', '2s', true);
  perform wm.lock_users(array[p_uid, p_addressee_id]);
  if exists (select from wm.deleted_accounts where user_id in (p_uid, p_addressee_id)) then
    perform wm.raise_err(404, null, 'Joueur introuvable');
  end if;
  select * into f from public.friendships where least(requester_id, addressee_id) = least(p_uid, p_addressee_id)
    and greatest(requester_id, addressee_id) = greatest(p_uid, p_addressee_id);
  if f.status = 'accepted' then
    perform wm.raise_err(409, 'ALREADY_FRIENDS', 'Vous êtes déjà amis');
  elsif found then
    perform wm.raise_err(409, 'REQUEST_PENDING', 'Une demande d''ami est déjà en attente');
  end if;
  perform wm.friend_limit_check(array[p_uid]);
  insert into public.friendships (requester_id, addressee_id) values (p_uid, p_addressee_id) returning * into f;
  perform wm.notify_friend(array[f.id], 'friend_request', p_uid);
  return wm.idem_store(p_uid, p_idem, jsonb_build_object('friendship', wm.friendship_json(f)));
end $$;

-- Redéfinie de 1710 : même signature, même corps et même réponse qu'en 1710 (déployée, non retouchée), plus l'exclusion des comptes
-- supprimés (G1).
-- Préfixe de lower(btrim(q)), \ % _ échappés (échappement par défaut de LIKE), soi-même exclu (P12). Motif en littéral, comme
-- collection_filter : un paramètre d'un plan générique ne se sert pas de l'index de préfixe.
create or replace function wm.friend_search(p_uid uuid, p_q text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_q text := lower(btrim(p_q));
  r jsonb;
begin
  if coalesce(char_length(v_q), 0) < 2 then
    perform wm.raise_err(400, 'invalid_request', 'La recherche demande au moins 2 caractères');
  end if;
  execute format('select coalesce(jsonb_agg(jsonb_build_object(''id'', id, ''username'', username, ''avatar_url'', avatar_url)
      order by lower(username), id), ''[]'') from (select id, username, avatar_url from public.profiles
      where lower(username) like %L and id <> %L and not exists (select from wm.deleted_accounts d where d.user_id = id)
      order by lower(username), id limit %s) x',
    replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%', p_uid,
    (select (value ->> 'friend_search')::int from wm.config where key = 'list_caps'))
  into r;
  return jsonb_build_object('users', r);
end $$;

revoke all on schema wm from public, anon, authenticated;
grant usage on schema wm to service_role;
revoke all on all tables in schema wm from public, anon, authenticated;
revoke execute on all functions in schema wm from public, anon, authenticated;
grant execute on all functions in schema wm to service_role;
