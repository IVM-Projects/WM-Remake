-- Suppression de compte (2250_wm_account_delete.sql) : report d'un bannissement à l'inscription d'un e-mail banni, garde de la pierre
-- tombale, account_auth_done, invariants pool_removed et deleted_account ; la Task 6b ajoute ses blocs (account_delete…).
-- Une seule transaction pour tout le fichier (now() figé) : chaque bloc crée ses joueurs et ne filtre que sur eux.
-- check_invariants est global : une violation voulue se fait dans une sous-transaction annulée (WMT00, 27_market.test.sql:278-285).

-- Rejeu de 2250 : la migration passe une seconde fois sur la base déjà migrée.
\ir ../migrations/2250_wm_account_delete.sql

create function pg_temp.inv(p_label text) returns void language plpgsql as $$ begin
  assert wm.check_invariants() = '[]'::jsonb, p_label || ' : ' || wm.check_invariants()::text;
end $$;

-- Inscription GoTrue, gabarit de tests.make_user, sans l'insert du profil (le trigger le crée).
create function pg_temp.signup(p_username text, p_email text) returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid(); begin
  insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', p_email, now(), now(), now(),
    jsonb_build_object('username', p_username, 'age_confirmed', true, 'terms_version', 'test'), '', '', '', '');
  return v_id;
end $$;

select pg_temp.inv('début de 39');

-- Anti-évasion (G1) : l'empreinte est posée par insert (account_delete arrive en Task 6b).
do $$ declare old uuid := gen_random_uuid(); u uuid; v uuid; s wm.sanctions; a wm.staff_actions; begin
  insert into wm.banned_emails (email_hash, user_id) values (wm.email_hash('D@test.local'), old);
  u := pg_temp.signup('AccEvade', ' d@TEST.local ');
  assert exists (select from public.profiles where id = u and username = 'AccEvade'), 'profil';
  assert (select count(*) from wm.sanctions where user_id = u) = 1, 'une sanction';
  select * into s from wm.sanctions where user_id = u;
  assert s.kind = 'ban' and s.reason = 'Compte lié à un compte banni supprimé' and s.ends_at is null and s.revoked_at is null
    and s.starts_at <= now() and s.created_by is null, to_jsonb(s)::text;
  assert (select count(*) from wm.staff_actions where target_type = 'user' and target_id = u::text) = 1, 'une ligne d''audit';
  select * into a from wm.staff_actions where target_type = 'user' and target_id = u::text;
  assert a.staff_id is null and a.action = 'ban_carryover' and a.reason = 'Compte lié à un compte banni supprimé' and a.payload = '{}',
    to_jsonb(a)::text;
  v := pg_temp.signup('AccClean', 'autre@test.local');
  assert exists (select from public.profiles where id = v), 'profil propre';
  assert not exists (select from wm.sanctions where user_id = v), 'aucune sanction';
  assert not exists (select from wm.staff_actions where target_id = v::text), 'aucun audit';
end $$;

-- Garde de la pierre tombale (plan B de G1).
do $$ declare u uuid := tests.make_user('AccTomb'); v uuid := tests.make_user('AccPlain'); raised boolean := false; begin
  insert into wm.deleted_accounts (user_id) values (u);
  begin
    delete from auth.users where id = u;
  exception when sqlstate 'XX000' then
    raised := sqlerrm = format('pierre tombale protégée : %s', u);
  end;
  assert raised, 'XX000 attendu';
  assert exists (select from public.profiles where id = u) and exists (select from auth.users where id = u), 'pierre tombale gardée';
  perform set_config('wm.allow_tombstone_delete', 'on', true);
  delete from auth.users where id = u;
  assert not exists (select from public.profiles where id = u), 'supprimée sous réglage';
  perform set_config('wm.allow_tombstone_delete', 'off', true);
  delete from auth.users where id = v;
  assert not exists (select from public.profiles where id = v), 'profil ordinaire supprimé sans réglage';
end $$;

-- account_auth_done : pose auth_done_at une fois ; rejouée → inchangée.
do $$ declare u uuid := tests.make_user('AccAuth'); t timestamptz; begin
  insert into wm.deleted_accounts (user_id, deleted_at) values (u, now() - interval '1 hour');
  assert wm.account_auth_done(u) = '{"ok": true}'::jsonb, 'réponse';
  select auth_done_at into t from wm.deleted_accounts where user_id = u;
  assert t = now(), 'auth_done_at posé';
  update wm.deleted_accounts set auth_done_at = now() - interval '1 minute' where user_id = u;
  assert wm.account_auth_done(u) = '{"ok": true}'::jsonb, 'réponse rejouée';
  assert (select auth_done_at from wm.deleted_accounts where user_id = u) = now() - interval '1 minute', 'inchangé';
end $$;

-- Invariants neufs : pool_removed, deleted_account 'cards', 'friend', 'guild' (sous-transaction annulée).
do $$ declare c uuid := tests.image_card('Acc Pool'); u uuid := tests.make_user('AccInv1'); w uuid := tests.make_user('AccInv2');
  g uuid; d jsonb; begin
  perform wm.pool_add(c, 'R');
  perform pg_temp.inv('pool');
  begin
    insert into wm.card_removals (card_id, reason) values (c, 'test');
    insert into wm.deleted_accounts (user_id) values (u);
    insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_atk, snapshot_def)
    values (u, c, 'Acc Pool', 'R', 10, 10);
    insert into public.friendships (requester_id, addressee_id, status) values (w, u, 'accepted');
    insert into public.guilds (name, leader_id) values ('AccInvGuild', w) returning id into g;
    insert into public.guild_members (guild_id, user_id, role) values (g, w, 'leader'), (g, u, 'member');
    d := wm.check_invariants();
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert d @> jsonb_build_array(jsonb_build_object('check', 'pool_removed', 'card_id', c)), d::text;
  assert (select jsonb_agg(e ->> 'problem' order by e ->> 'problem') from jsonb_array_elements(d) e
    where e ->> 'check' = 'deleted_account' and e ->> 'user_id' = u::text) = '["cards", "friend", "guild"]'::jsonb, d::text;
  assert (select count(*) from jsonb_array_elements(d) e where e ->> 'check' in ('pool_removed', 'deleted_account')) = 4, d::text;
end $$;

-- ===== Task 6b : account_delete, friend_request, friend_search =====

create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare d text; begin
  execute p_sql;
  return null;
exception when sqlstate 'P0001' then
  get stacked diagnostics d = pg_exception_detail;
  return d::jsonb;
end $$;

create function pg_temp.e(p_status int, p_code text, p_msg text) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('status', p_status, 'code', p_code, 'error', p_msg, 'message', p_msg))
$$;

-- Joueur vérifié (marché, batailles).
create function pg_temp.player(p_name text, p_balance int default 0) returns uuid language plpgsql as $$
declare u uuid := tests.make_user(p_name, p_balance); begin
  perform wm.set_human_verified(u);
  return u;
end $$;

-- Recopiés de 31_battles.test.sql (copy, friends, bcard, bcards, fill, own, active).
create function pg_temp.copy(p_uid uuid, p_card uuid, p_count int default 1) returns uuid language sql as $$
  insert into public.user_cards (user_id, card_id, count, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
  select p_uid, id, p_count, wikipedia_title, rarity, category, atk, def from public.cards where id = p_card
  returning id
$$;

create function pg_temp.friends(p_a uuid, p_b uuid) returns void language sql as $$
  insert into public.friendships (requester_id, addressee_id, status) values (p_a, p_b, 'accepted')
$$;

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

-- Guilde de p_leader puis p_members, arrivés dans cet ordre (joined_at croissant).
create function pg_temp.guild(p_name text, p_leader uuid, p_members uuid[] default '{}') returns uuid language plpgsql as $$
declare g uuid; begin
  insert into public.guilds (name, leader_id) values (p_name, p_leader) returning id into g;
  insert into public.guild_members (guild_id, user_id, role, joined_at) values (g, p_leader, 'leader', now() - interval '10 days');
  insert into public.guild_members (guild_id, user_id, role, joined_at)
  select g, u, 'member', now() - interval '9 days' + o * interval '1 hour' from unnest(p_members) with ordinality x (u, o);
  return g;
end $$;

create function pg_temp.tomb(p_uid uuid) returns text language sql as $$
  select 'Joueur supprimé ' || substr(md5(p_uid::text), 1, 8)
$$;

-- Review Focus, l'historique des autres, puis compte inatteignable et clé rejouée.
do $$ declare
  d uuid := pg_temp.player('d_user', 1000); m uuid := pg_temp.player('AccM', 500); s uuid := pg_temp.player('AccS');
  e uuid := pg_temp.player('AccE'); f uuid := pg_temp.player('AccF'); h uuid := pg_temp.player('AccH'); i uuid := pg_temp.player('AccI');
  j uuid := pg_temp.player('AccJ');
  c uuid[]; kd uuid[]; kx uuid; ks uuid; ke uuid; au1 uuid; au2 uuid; tr uuid; bf uuid; be uuid; g uuid; tg uuid;
  led bigint[]; r jsonb; r2 jsonb; n text; pr public.profiles; begin
  c := pg_temp.bcards('AccDel', array[1000, 1100, 1200, 900, 800, 700, 10, 10, 10], array[500, 600, 700, 400, 300, 200, 10, 10, 10]);
  perform pg_temp.fill();
  kd := pg_temp.own(d, c[1:3]);
  bf := pg_temp.active(f, d, pg_temp.own(f, c[4:6]), kd);
  kx := pg_temp.copy(d, c[7]); ks := pg_temp.copy(s, c[8]); ke := pg_temp.copy(e, c[9]);
  au1 := (wm.create_auction(d, kx, 50, 60) ->> 'id')::uuid;
  perform wm.place_bid(m, au1, 100);
  au2 := (wm.create_auction(s, ks, 50, 60) ->> 'id')::uuid;
  perform wm.place_bid(d, au2, 80);
  perform pg_temp.friends(d, e);
  tr := (wm.create_trade(d, e, jsonb_build_array(jsonb_build_object('user_card_id', ke, 'card_id', c[9], 'offered_by', e)), 10) ->> 'id')::uuid;
  be := (wm.battle_create(d, e) ->> 'id')::uuid;
  g := pg_temp.guild('AccDelGuild', d, array[h, i]);
  insert into public.guild_chat_messages (guild_id, user_id, content) values (g, d, 'Salut la guilde');
  insert into wm.guild_invites (guild_id, user_id, inviter_id) values (g, j, d);
  insert into public.guild_wishlists (guild_id, user_id, card_id) values (g, d, c[7]);
  insert into public.chat_messages (sender_id, recipient_id, content) values (d, e, 'un'), (e, d, 'deux'), (d, e, 'trois');
  insert into public.reports (reporter_id, reported_user_id, reason) values (d, e, 'spam'), (f, d, 'cheating');
  insert into wm.sanctions (user_id, kind, reason) values (d, 'warning', 'Avertissement d''essai');
  insert into public.showcase (user_id, position, user_card_id) values (d, 0, kd[1]);
  update public.profiles set avatar_user_card_id = kd[2], bio = 'Ma bio', is_public = true where id = d;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (d, 'https://push.test/acc-del', 'k', 'a');
  insert into public.wishlist_items (user_id, card_id) values (d, c[5]);
  insert into public.tags (user_id, name) values (d, 'Favoris') returning id into tg;
  insert into public.user_card_tags (user_card_id, tag_id) values (kd[3], tg);
  perform pg_temp.inv('avant la suppression');
  assert exists (select from public.notifications where user_id = d), 'notifications de D';
  led := array(select id from wm.wb_ledger where user_id = d order by id);

  r := wm.account_delete(d, 'd_user', 'acc-del-1');
  assert r = '{"ok": true, "voided_auctions": 2, "cancelled_trades": 1, "finished_battles": 1, "cancelled_battles": 1,
    "guild": "transferred"}'::jsonb, r::text;
  -- Gardé.
  select * into pr from public.profiles where id = d;
  assert pr.username = pg_temp.tomb(d) and pr.bio is null and pr.avatar_user_card_id is null and pr.avatar_url is null
    and not pr.is_public, to_jsonb(pr)::text;
  assert (select count(*) from public.chat_messages where d in (sender_id, recipient_id) and e in (sender_id, recipient_id)) = 3,
    'messages privés';
  assert exists (select from public.guild_chat_messages where user_id = d and guild_id = g), 'message de guilde';
  assert (select count(*) from public.reports where d in (reporter_id, reported_user_id)) = 2, 'signalements';
  assert exists (select from wm.sanctions where user_id = d and kind = 'warning'), 'sanction';
  assert (select count(*) from wm.wb_ledger where id = any (led)) = cardinality(led), 'grand livre gardé';
  assert pr.wikibidous_balance = (select balance_after from wm.wb_ledger where user_id = d order by id desc limit 1), 'solde';
  -- Dénoué.
  assert (select status from public.auctions where id = au1) = 'cancelled', 'enchère de D';
  assert (select wikibidous_balance from public.profiles where id = m) = 500, 'M remboursé';
  assert (select status from public.auctions where id = au2) = 'cancelled', 'enchère de S';
  assert exists (select from wm.wb_ledger where user_id = d and reason = 'refund'), 'D remboursé';
  assert exists (select from public.user_cards where user_id = s and card_id = c[8]), 'copie rendue à S';
  assert (select status from public.trades where id = tr) = 'cancelled', 'échange';
  assert (select count(*) from public.notifications where type = 'trade_voided' and data ->> 'trade_id' = tr::text) = 1
    and exists (select from public.notifications where type = 'trade_voided' and data ->> 'trade_id' = tr::text and user_id = e),
    'trade_voided chez E seulement';
  assert (select status = 'completed' and winner_id = f from public.battles where id = bf), 'bataille contre F';
  assert (select count(*) from wm.wb_ledger where reason = 'battle' and ref = 'battle:' || bf) = 2, 'lignes battle';
  assert (select status from public.battles where id = be) = 'cancelled', 'défi à E';
  assert (select leader_id from public.guilds where id = g) = h, 'leader_id';
  assert (select array_agg(user_id) from public.guild_members where guild_id = g and role = 'leader') = array[h], 'un seul chef';
  assert exists (select from public.guild_members where guild_id = g and user_id = i and role = 'member'), 'I membre';
  assert not exists (select from public.guild_members where user_id = d), 'D plus membre';
  -- Effacé.
  assert not exists (select from public.user_cards where user_id = d), 'copies';
  assert not exists (select from public.showcase where user_id = d), 'vitrine';
  assert not exists (select from public.tags where user_id = d) and not exists (select from public.user_card_tags where tag_id = tg), 'étiquettes';
  assert not exists (select from public.wishlist_items where user_id = d), 'souhaits';
  assert not exists (select from public.guild_wishlists where user_id = d and fulfilled_at is null), 'souhait de guilde';
  assert not exists (select from public.notifications where user_id = d), 'notifications';
  assert not exists (select from public.push_subscriptions where user_id = d), 'push';
  assert not exists (select from public.friendships where d in (requester_id, addressee_id)), 'amitiés';
  assert not exists (select from wm.guild_invites where d in (user_id, inviter_id)), 'invitations';
  assert exists (select from wm.deleted_accounts where user_id = d and auth_done_at is null), 'deleted_accounts';
  assert not exists (select from wm.banned_emails where user_id = d), 'aucune empreinte sous avertissement';
  perform pg_temp.inv('après la suppression');
  assert pg_temp.err(format('select wm.actor(%L)', d)) = pg_temp.e(401, 'unauthorized', 'Session expirée, reconnecte-toi.'), 'actor';
  assert pg_temp.err(format('select wm.access_check(%L)', d)) = pg_temp.e(401, 'unauthorized', 'Session expirée, reconnecte-toi.'),
    'access_check';
  -- Même clé : la réponse stockée, aucun second effet.
  n := (select jsonb_build_array((select count(*) from wm.wb_ledger), (select count(*) from public.notifications),
    (select count(*) from wm.deleted_accounts), (select count(*) from wm.idempotency_keys))::text);
  r2 := wm.account_delete(d, 'd_user', 'acc-del-1');
  assert r2 = r, r2::text;
  assert n = (select jsonb_build_array((select count(*) from wm.wb_ledger), (select count(*) from public.notifications),
    (select count(*) from wm.deleted_accounts), (select count(*) from wm.idempotency_keys))::text), 'second effet';
  -- Compte inatteignable.
  assert pg_temp.err(format('select wm.friend_request(%L, %L)', e, d)) = pg_temp.e(404, null, 'Joueur introuvable'), 'friend_request';
  assert not exists (select from public.friendships where d in (requester_id, addressee_id)), 'aucune amitié';
  assert not exists (select from public.notifications where user_id = d), 'aucune notification';
  assert not exists (select from jsonb_array_elements(wm.friend_search(e, 'jo') -> 'users') u where u ->> 'id' = d::text), 'recherche';
  assert exists (select from public.profiles where lower(username) like 'jo%' and id = d), 'D a bien le préfixe cherché';
  perform pg_temp.inv('compte inatteignable');
end $$;

-- Guilde : seul membre, simple membre, sans guilde, successeur parti, tous partis.
do $$ declare d1 uuid := pg_temp.player('AccG1'); d2 uuid := pg_temp.player('AccG2'); d3 uuid := pg_temp.player('AccG3');
  d4 uuid := pg_temp.player('AccG4'); d5 uuid := pg_temp.player('AccG5'); x uuid := pg_temp.player('AccGX');
  h uuid := pg_temp.player('AccGH'); i uuid := pg_temp.player('AccGI'); h2 uuid := pg_temp.player('AccGH2');
  g1 uuid; g2 uuid; g4 uuid; g5 uuid; r jsonb; begin
  g1 := pg_temp.guild('AccGuild1', d1);
  r := wm.account_delete(d1, 'AccG1');
  assert r ->> 'guild' = 'dissolved', r::text;
  assert not exists (select from public.guilds where id = g1), 'guilde dissoute';
  g2 := pg_temp.guild('AccGuild2', x, array[d2]);
  r := wm.account_delete(d2, 'accg2');
  assert r ->> 'guild' = 'left', r::text;
  assert (select leader_id from public.guilds where id = g2) = x and not exists (select from public.guild_members where user_id = d2), 'départ';
  r := wm.account_delete(d3, 'AccG3');
  assert r -> 'guild' = 'null'::jsonb, r::text;
  g4 := pg_temp.guild('AccGuild4', d4, array[h, i]);
  delete from public.guild_members where user_id = h;
  r := wm.account_delete(d4, 'AccG4');
  assert r ->> 'guild' = 'transferred', r::text;
  assert (select leader_id from public.guilds where id = g4) = i
    and (select array_agg(user_id) from public.guild_members where guild_id = g4) = array[i]
    and (select role from public.guild_members where user_id = i) = 'leader', 'I chef';
  g5 := pg_temp.guild('AccGuild5', d5, array[h2]);
  delete from public.guild_members where user_id = h2;
  r := wm.account_delete(d5, 'AccG5');
  assert r ->> 'guild' = 'dissolved', r::text;
  assert not exists (select from public.guilds where id = g5), 'tous partis : dissoute';
  perform pg_temp.inv('guildes');
end $$;

-- Anti-évasion : empreinte sous bannissement seulement ; un banni supprime son compte.
do $$ declare b uuid := pg_temp.player('AccBan'); s uuid := pg_temp.player('AccSusp'); w uuid := pg_temp.player('AccWarn');
  em text; begin
  insert into wm.sanctions (user_id, kind, reason) values (b, 'ban', 'Bannissement d''essai');
  insert into wm.sanctions (user_id, kind, reason, ends_at) values (s, 'suspension', 'Suspension d''essai', now() + interval '1 day');
  insert into wm.sanctions (user_id, kind, reason) values (w, 'warning', 'Avertissement d''essai');
  select email into em from auth.users where id = b;
  assert wm.account_delete(b, 'AccBan') ->> 'ok' = 'true', 'banni : la suppression passe';
  assert exists (select from wm.banned_emails where email_hash = wm.email_hash(em) and user_id = b), 'empreinte du banni';
  perform wm.account_delete(s, 'AccSusp');
  perform wm.account_delete(w, 'AccWarn');
  assert not exists (select from wm.banned_emails where user_id in (s, w)), 'aucune empreinte hors bannissement';
  assert exists (select from wm.sanctions where user_id = b and kind = 'ban' and revoked_at is null), 'sanction du banni gardée';
  perform pg_temp.inv('anti-évasion');
end $$;

-- Refus : pseudo différent (rien d'écrit), maintenance, déjà supprimé sans clé.
do $$ declare d uuid := pg_temp.player('AccRef'); n text; q text; begin
  q := format('select wm.account_delete(%L, %L, %L)', d, 'AccRefX', 'acc-ref-1');
  n := (select jsonb_build_array((select count(*) from wm.deleted_accounts), (select count(*) from wm.idempotency_keys),
    (select username from public.profiles where id = d))::text);
  assert pg_temp.err(q) = pg_temp.e(400, 'invalid_request', 'Tape ton pseudo exactement pour confirmer'), 'pseudo différent';
  assert pg_temp.err(format('select wm.account_delete(%L, null)', d))
    = pg_temp.e(400, 'invalid_request', 'Tape ton pseudo exactement pour confirmer'), 'pseudo nul';
  assert n = (select jsonb_build_array((select count(*) from wm.deleted_accounts), (select count(*) from wm.idempotency_keys),
    (select username from public.profiles where id = d))::text), 'écriture sur refus';
  update wm.config set value = 'true' where key = 'maintenance';
  assert pg_temp.err(format('select wm.account_delete(%L, %L)', d, 'AccRef'))
    = pg_temp.e(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.'), 'maintenance';
  update wm.config set value = 'false' where key = 'maintenance';
  perform wm.account_delete(d, ' accref ');
  assert pg_temp.err(format('select wm.account_delete(%L, %L)', d, pg_temp.tomb(d)))
    = pg_temp.e(401, 'unauthorized', 'Session expirée, reconnecte-toi.'), 'déjà supprimé';
  assert pg_temp.err(format('select wm.account_delete(%L, %L)', gen_random_uuid(), 'x'))
    = pg_temp.e(401, 'unauthorized', 'Session expirée, reconnecte-toi.'), 'profil absent';
end $$;

-- Collision du pseudo : 16 hex.
do $$ declare d uuid := pg_temp.player('AccColl'); o uuid := tests.make_user('AccCollOther'); begin
  update public.profiles set username = pg_temp.tomb(d) where id = o;
  perform wm.account_delete(d, 'AccColl');
  assert (select username from public.profiles where id = d) = 'Joueur supprimé ' || substr(md5(d::text), 1, 16), 'pseudo à 16 hex';
  perform pg_temp.inv('collision');
end $$;

-- Volume (mesure, sans assertion de durée ; durée consignée dans le rapport de la Task 6b) : 20 000 copies effacées.
do $$ declare d uuid := pg_temp.player('AccVol'); c uuid := tests.image_card('Acc Volume'); begin
  insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_atk, snapshot_def)
  select d, c, 'Acc Volume', 'R', 10, 10 from generate_series(1, 20000);
  assert wm.account_delete(d, 'AccVol') ->> 'ok' = 'true', 'volume';
  assert not exists (select from public.user_cards where user_id = d), 'copies effacées';
  perform pg_temp.inv('volume');
end $$;

-- lock_timeout avant le premier verrou ; ordre C4 d'account_delete (celui d'admin_card_remove).
do $$ declare s text := (select prosrc from pg_proc where oid = to_regproc('wm.account_delete')); begin
  assert tests.lock_timeout_violations(array['account_delete', 'friend_request'], array['for update', 'wm.lock_users(']) is null,
    tests.lock_timeout_violations(array['account_delete', 'friend_request'], array['for update', 'wm.lock_users(']);
  assert 0 < strpos(s, 'from public.guild_wishlists') and strpos(s, 'from public.guild_wishlists') < strpos(s, 'from public.trades')
    and strpos(s, 'from public.trades') < strpos(s, 'from public.auctions') and strpos(s, 'from public.auctions') < strpos(s, 'from public.battles')
    and strpos(s, 'from public.battles') < strpos(s, 'from public.friendships') and strpos(s, 'from public.friendships') < strpos(s, 'wm.lock_users(')
    and strpos(s, 'wm.lock_users(') < strpos(s, 'from public.guilds'), 'ordre C4';
end $$;

-- Invariant deleted_account, branches auction, trade, battle et push (fuite d'un engagement, sous-transaction annulée).
do $$ declare u uuid := tests.make_user('AccLeak1'); w uuid := tests.make_user('AccLeak2'); c uuid := tests.image_card('Acc Leak');
  d jsonb; begin
  begin
    insert into wm.deleted_accounts (user_id) values (u);
    insert into public.auctions (seller_id, card_id, snapshot_rarity, base_amount, listing_base_amount, end_at)
    values (u, c, 'R', 10, 10, now() + interval '1 hour');
    insert into public.trades (initiator_id, recipient_id, expires_at) values (w, u, now() + interval '1 day');
    insert into public.battles (challenger_id, opponent_id) values (w, u);
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (u, 'https://push.test/acc-leak', 'k', 'a');
    d := wm.check_invariants();
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert (select jsonb_agg(e ->> 'problem' order by e ->> 'problem') from jsonb_array_elements(d) e
    where e ->> 'check' = 'deleted_account' and e ->> 'user_id' = u::text) = '["auction", "battle", "push", "trade"]'::jsonb, d::text;
end $$;

select pg_temp.inv('fin de 39');
