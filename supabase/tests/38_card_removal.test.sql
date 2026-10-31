-- Retrait de carte (2230_wm_card_removal.sql) : enchères dénouées, échanges annulés, souhaits, vitrines, avatars, banque et file de quiz,
-- pool ; remise ; effacement d'une banque ; fiche et liste du staff ; fusion du catalogue ; verrous.
-- Une seule transaction pour tout le fichier (now() figé) : chaque bloc crée ses joueurs et sa carte dédiée et ne filtre que sur eux.

-- Rejeu de 2230 : la migration passe une seconde fois sur la base déjà migrée.
\ir ../migrations/2230_wm_card_removal.sql

create function pg_temp.err(p_sql text) returns jsonb language plpgsql as $$
declare d text; begin
  execute p_sql;
  return null;
exception when sqlstate 'P0001' then
  get stacked diagnostics d = pg_exception_detail;
  return d::jsonb;
end $$;

create function pg_temp.inv(p_label text) returns void language plpgsql as $$ begin
  assert wm.check_invariants() = '[]'::jsonb, p_label || ' : ' || wm.check_invariants()::text;
end $$;

create function pg_temp.staff(p_role text) returns uuid language plpgsql as $$
declare u uuid := tests.make_user('Staff' || substr(md5(random()::text), 1, 10)); begin
  insert into wm.staff (user_id, role) values (u, p_role);
  return u;
end $$;

-- Joueur vérifié (marché).
create function pg_temp.player(p_name text, p_balance int default 0) returns uuid language plpgsql as $$
declare u uuid := tests.make_user(p_name, p_balance); begin
  perform wm.set_human_verified(u);
  return u;
end $$;

create function pg_temp.e(p_status int, p_code text, p_msg text) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('status', p_status, 'code', p_code, 'error', p_msg, 'message', p_msg))
$$;

-- Carte dédiée au pool, image propre (comme 37_moderation).
create function pg_temp.icard(p_title text) returns uuid language plpgsql as $$
declare c uuid := tests.image_card(p_title); begin
  update public.cards set image_url = image_url || '#' || id where id = c;
  perform wm.pool_add(c, 'R');
  return c;
end $$;

create function pg_temp.copy_of(p_user uuid, p_card uuid) returns uuid language sql as $$
  insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_atk, snapshot_def)
  select p_user, c.id, c.wikipedia_title, c.rarity, c.atk, c.def from public.cards c where c.id = p_card returning id
$$;

create function pg_temp.n_r() returns int language sql as $$ select n from wm.catalog_stats where rarity = 'R' $$;

-- Un refus : le corps d'erreur, sans retrait, audit, clé d'idempotence ni changement du pool.
create function pg_temp.refused(p_sql text) returns jsonb language plpgsql as $$
declare
  n text := (select jsonb_build_array((select count(*) from wm.card_removals), (select count(*) from wm.staff_actions),
    (select count(*) from wm.idempotency_keys), (select count(*) from wm.draw_pool), (select count(*) from wm.card_quizzes))::text);
  d jsonb;
begin
  d := pg_temp.err(p_sql);
  assert d is not null, 'aucun refus : ' || p_sql;
  assert n = (select jsonb_build_array((select count(*) from wm.card_removals), (select count(*) from wm.staff_actions),
    (select count(*) from wm.idempotency_keys), (select count(*) from wm.draw_pool), (select count(*) from wm.card_quizzes))::text),
    'écriture sur refus : ' || p_sql;
  return d;
end $$;

-- Effets du retrait (Review Focus), bataille gelée (G6), refus, idempotence, fiche et liste, remise, banque.
do $$ declare ad uuid := pg_temp.staff('admin'); mo uuid := pg_temp.staff('moderator'); x uuid := pg_temp.icard('Retrait X');
  s uuid := pg_temp.player('RetS'); s2 uuid := pg_temp.player('RetS2'); m uuid := pg_temp.player('RetM', 500);
  a uuid := pg_temp.player('RetA'); b uuid := pg_temp.player('RetB'); o uuid := pg_temp.player('RetO');
  ks uuid := pg_temp.copy_of(s, x); ks2 uuid := pg_temp.copy_of(s2, x); kt uuid := pg_temp.copy_of(a, x); kv uuid := pg_temp.copy_of(a, x);
  kb uuid := pg_temp.copy_of(b, x); y uuid := pg_temp.icard('Retrait Y'); z uuid := pg_temp.icard('Retrait Z');
  au1 uuid; au2 uuid; tr uuid; bid uuid; g uuid; bt uuid; n0 int; r jsonb; r2 jsonb; d jsonb; c jsonb; w wm.staff_actions; begin
  au1 := (wm.create_auction(s, ks, 50, 60) ->> 'id')::uuid;
  au2 := (wm.create_auction(s2, ks2, 50, 60) ->> 'id')::uuid;
  perform wm.place_bid(m, au1, 100);
  select id into bid from public.auction_bids where auction_id = au1 and bidder_id = m;
  assert (select wikibidous_balance from public.profiles where id = m) = 400, 'mise débitée';
  insert into public.friendships (requester_id, addressee_id, status) values (a, b, 'accepted');
  tr := (wm.create_trade(a, b, jsonb_build_array(jsonb_build_object('user_card_id', kt, 'card_id', x, 'offered_by', a))) ->> 'id')::uuid;
  g := (wm.guild_create(o, 'Guilde du retrait') -> 'guild' ->> 'id')::uuid;
  perform wm.guild_wish_set(o, x);
  insert into public.showcase (user_id, position, user_card_id) values (a, 0, kv);
  update public.profiles set avatar_user_card_id = kb, avatar_url = (select image_url from public.cards where id = x) where id = b;
  insert into wm.card_quizzes (card_id, prompt_version, source, questions) values (x, 1, 'template', '[]');
  insert into wm.quiz_queue (card_id, priority) values (x, 1);
  insert into public.battles (challenger_id, opponent_id, status, game_state) values (a, b, 'active', '{"turn": 3}') returning id into bt;
  insert into public.battle_decks (battle_id, user_id, card_ids) values (bt, a, array[x, y, z]);
  perform pg_temp.inv('avant le retrait');

  -- Fiche avant.
  c := wm.staff_card(mo, x);
  assert c = jsonb_build_object('card', jsonb_build_object('id', x, 'wikipedia_title', 'Retrait X', 'rarity', 'R',
      'image_url', (select image_url from public.cards where id = x), 'hide_image', false, 'nsfw_image', false, 'in_pool', true),
    'removal', null, 'image_reports', 0, 'quiz_bank', true,
    'engagements', '{"active_auctions": 2, "pending_trades": 1, "open_wishes": 1, "showcase": 1, "avatars": 1}'::jsonb), c::text;

  -- Refus exacts, sans effet ni audit.
  d := pg_temp.refused(format('select wm.admin_card_remove(%L, %L, %L)', mo, x, 'Motif de test'));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Action réservée aux administrateurs'), d::text;
  d := pg_temp.refused(format('select wm.admin_card_remove(%L, %L, %L)', ad, x, '  '));
  assert d = pg_temp.e(400, 'invalid_request', 'Le motif est obligatoire (3 à 500 caractères)'), d::text;
  d := pg_temp.refused(format('select wm.admin_card_remove(%L, %L, %L)', ad, gen_random_uuid(), 'Motif de test'));
  assert d = pg_temp.e(404, null, 'Carte introuvable'), d::text;
  d := pg_temp.refused(format('select wm.staff_card(%L, %L)', mo, gen_random_uuid()));
  assert d = pg_temp.e(404, null, 'Carte introuvable'), d::text;
  d := pg_temp.refused(format('select wm.staff_card(%L, %L)', s, x));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Accès réservé à l''équipe de modération'), d::text;

  n0 := pg_temp.n_r();
  r := wm.admin_card_remove(ad, x, ' Contenu illicite ', 'rm-1');
  assert r = '{"ok": true, "voided_auctions": 2, "cancelled_trades": 1, "removed_wishes": 1, "cleared_showcase": 1, "cleared_avatars": 1,
    "quiz_bank_deleted": true}'::jsonb, r::text;
  r2 := wm.admin_card_remove(ad, x, ' Contenu illicite ', 'rm-1');
  assert r2 = r, 'même idem, même corps';
  assert (select count(*) from wm.staff_actions where action = 'card_remove' and target_id = x::text) = 1, 'un seul audit';
  select * into w from wm.staff_actions where action = 'card_remove' and target_id = x::text;
  assert (w.staff_id, w.target_type, w.reason) = (ad, 'card', 'Contenu illicite') and w.payload = r - 'ok', to_jsonb(w)::text;
  assert (select (reason, removed_by) = ('Contenu illicite', ad) from wm.card_removals where card_id = x), 'ligne de retrait';

  -- Enchères dénouées, séquestres rendus, meneur remboursé.
  assert (select array_agg(status order by id) from public.auctions where id in (au1, au2)) = array['cancelled', 'cancelled']::public.auction_status[],
    'enchères';
  assert not exists (select from wm.auction_escrow where auction_id in (au1, au2)), 'séquestres';
  assert (select count(*) = 1 and bool_and(not starred) from public.user_cards where user_id = s and card_id = x)
    and (select count(*) = 1 and bool_and(not starred) from public.user_cards where user_id = s2 and card_id = x), 'copies rendues';
  assert not exists (select from public.user_card_tags t join public.user_cards uc on uc.id = t.user_card_id where uc.user_id in (s, s2)),
    'sans étiquette';
  assert (select wikibidous_balance from public.profiles where id = m) = 500, 'solde d''avant la mise';
  assert (select array_agg(delta) from wm.wb_ledger where user_id = m and reason = 'refund' and ref = 'refund:' || bid) = array[100], 'refund';
  assert (select jsonb_agg(jsonb_build_array(user_id, data -> 'auction_id', data -> 'amount') order by data ->> 'auction_id' = au2::text, user_id)
    from public.notifications where type = 'auction_voided' and user_id in (s, s2, m))
    = jsonb_build_array(jsonb_build_array(least(s, m), au1, 100), jsonb_build_array(greatest(s, m), au1, 100), jsonb_build_array(s2, au2, null)),
    'auction_voided';
  assert (select data ? 'card_title' and not data ? 'amount' from public.notifications where type = 'auction_voided' and user_id = s2), 'sans amount';
  -- Échange annulé, notifications.
  assert (select status = 'cancelled' and closed_at is not null and updated_at = closed_at from public.trades where id = tr), 'échange';
  assert (select array_agg(user_id order by user_id) from public.notifications where type = 'trade_voided' and user_id in (a, b))
    = array[least(a, b), greatest(a, b)], 'trade_voided';
  assert (select bool_and(data = jsonb_build_object('trade_id', tr, 'user_id', null, 'username', null)) from public.notifications
    where type = 'trade_voided' and user_id in (a, b)), 'data trade_voided';
  -- Souhait, vitrine, avatar, pool, banque, file.
  assert not exists (select from public.guild_wishlists where user_id = o and card_id = x), 'souhait';
  assert not exists (select from public.showcase where user_id = a), 'vitrine';
  assert (select avatar_user_card_id is null and avatar_url is null from public.profiles where id = b), 'avatar';
  assert not exists (select from wm.draw_pool where card_id = x) and pg_temp.n_r() = n0 - 1, 'pool';
  assert not exists (select from wm.card_quizzes where card_id = x) and not exists (select from wm.quiz_queue where card_id = x), 'banque et file';
  -- Copies toujours chez leurs propriétaires (G6), bataille intacte.
  assert (select jsonb_object_agg(user_id, n) from (select user_id, count(*) n from public.user_cards where card_id = x group by user_id) q)
    = jsonb_build_object(s, 1, s2, 1, a, 2, b, 1), 'copies';
  assert (select status = 'active' and game_state = '{"turn": 3}' from public.battles where id = bt), 'bataille';
  perform pg_temp.inv('après le retrait');

  -- Fiche après, liste.
  c := wm.staff_card(mo, x);
  assert c -> 'card' ->> 'in_pool' = 'false' and c -> 'quiz_bank' = 'false'
    and c -> 'removal' = jsonb_build_object('reason', 'Contenu illicite', 'removed_at', now(),
      'removed_by_username', (select username from public.profiles where id = ad))
    and c -> 'engagements' = '{"active_auctions": 0, "pending_trades": 0, "open_wishes": 0, "showcase": 0, "avatars": 0}', c::text;
  r := wm.staff_card_removals(mo);
  assert r -> 'removals' -> 0 = jsonb_build_object('card_id', x, 'wikipedia_title', 'Retrait X', 'reason', 'Contenu illicite',
    'removed_at', now(), 'removed_by_username', (select username from public.profiles where id = ad)), r::text;

  -- De nouveau : 409, sans effet ni audit.
  d := pg_temp.refused(format('select wm.admin_card_remove(%L, %L, %L)', ad, x, 'Motif de test'));
  assert d = pg_temp.e(409, null, 'Cette carte est déjà retirée'), d::text;

  -- Remise : refus, puis pool rétabli, retrait effacé, audit ; enchères toujours annulées.
  d := pg_temp.refused(format('select wm.admin_card_restore(%L, %L, %L)', mo, x, 'Motif de test'));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Action réservée aux administrateurs'), d::text;
  d := pg_temp.refused(format('select wm.admin_card_restore(%L, %L, %L)', ad, x, ''));
  assert d ->> 'status' = '400', d::text;
  r := wm.admin_card_restore(ad, x, 'Erreur de retrait', 'rs-1');
  assert r = '{"ok": true}' and wm.admin_card_restore(ad, x, 'Erreur de retrait', 'rs-1') = r, r::text;
  assert (select count(*) from wm.staff_actions where action = 'card_restore' and target_id = x::text and staff_id = ad
    and reason = 'Erreur de retrait') = 1, 'audit card_restore';
  assert exists (select from wm.draw_pool where card_id = x and rarity = 'R') and pg_temp.n_r() = n0, 'pool rétabli';
  assert not exists (select from wm.card_removals where card_id = x), 'card_removals vide';
  assert (select bool_and(status = 'cancelled') from public.auctions where id in (au1, au2)), 'enchères restées annulées';
  d := pg_temp.refused(format('select wm.admin_card_restore(%L, %L, %L)', ad, x, 'Motif de test'));
  assert d = pg_temp.e(409, null, 'Cette carte n''est pas retirée'), d::text;

  -- Banque de quiz : effacée, puis rien à effacer ; refus.
  insert into wm.card_quizzes (card_id, prompt_version, source, questions) values (x, 1, 'template', '[]');
  d := pg_temp.refused(format('select wm.admin_quiz_bank_clear(%L, %L, %L)', mo, x, 'Motif de test'));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Action réservée aux administrateurs'), d::text;
  d := pg_temp.refused(format('select wm.admin_quiz_bank_clear(%L, %L, %L)', ad, x, 'x'));
  assert d ->> 'status' = '400', d::text;
  d := pg_temp.refused(format('select wm.admin_quiz_bank_clear(%L, %L, %L)', ad, gen_random_uuid(), 'Motif de test'));
  assert d = pg_temp.e(404, null, 'Carte introuvable'), d::text;
  r := wm.admin_quiz_bank_clear(ad, x, 'Banque fautive', 'qc-1');
  assert r = '{"ok": true, "deleted": true}' and wm.admin_quiz_bank_clear(ad, x, 'Banque fautive', 'qc-1') = r, r::text;
  assert not exists (select from wm.card_quizzes where card_id = x), 'banque effacée';
  assert wm.admin_quiz_bank_clear(ad, x, 'Banque fautive') = '{"ok": true, "deleted": false}', 'rien à effacer';
  assert (select array_agg(payload order by id) from wm.staff_actions where action = 'quiz_clear' and target_id = x::text)
    = array['{"deleted": true}', '{"deleted": false}']::jsonb[], 'audits quiz_clear';
  perform pg_temp.inv('fin des effets');
end $$;

-- Retrait sans aucun engagement : compteurs nuls, banque absente.
do $$ declare ad uuid := pg_temp.staff('admin'); x uuid := pg_temp.icard('Retrait vide'); r jsonb; begin
  r := wm.admin_card_remove(ad, x, 'Motif de test');
  assert r = '{"ok": true, "voided_auctions": 0, "cancelled_trades": 0, "removed_wishes": 0, "cleared_showcase": 0, "cleared_avatars": 0,
    "quiz_bank_deleted": false}'::jsonb, r::text;
end $$;

-- Fusion du catalogue : la carte retirée par le staff reste hors du pool (26_catalog_merge.test.sql:221-229 pour une ligne posée à la main).
-- Dernier bloc : catalog_finalize sort du pool toute carte absente du stage.
do $$ declare ad uuid := pg_temp.staff('admin'); x uuid := pg_temp.icard('Retrait fusion'); begin
  perform wm.admin_card_remove(ad, x, 'Motif de test');
  insert into wm.catalog_stage (page_id, wikipedia_title, wikipedia_url, lang, rarity, atk, def, pageviews)
  select 990000001, wikipedia_title, wikipedia_url, lang, rarity, atk, def, coalesce(pageviews, 0) from public.cards where id = x;
  perform wm.catalog_merge('sample');
  assert (select card_id from wm.card_source where page_id = 990000001) = x, 'carte liée';
  assert not exists (select from wm.draw_pool where card_id = x), 'retirée après fusion';
  perform wm.catalog_finalize('sample');
  assert not exists (select from wm.draw_pool where card_id = x), 'retirée après finalisation';
end $$;

-- lock_timeout, ordre des verrous C4, aides sans lock_timeout, lectures stables.
do $$ declare s text := (select prosrc from pg_proc where oid = to_regproc('wm.admin_card_remove')); bad text; begin
  assert tests.lock_timeout_violations(array['admin_card_remove', 'admin_card_restore', 'admin_quiz_bank_clear'],
    array['for update', 'wm.lock_users(', 'insert into wm.card_removals', 'delete from wm.card_removals', 'delete from wm.card_quizzes'])
    is null, 'lock_timeout';
  assert strpos(s, 'insert into wm.card_removals') < strpos(s, 'from public.guild_wishlists')
    and strpos(s, 'from public.guild_wishlists') < strpos(s, 'from public.trades')
    and strpos(s, 'from public.trades') < strpos(s, 'from public.auctions')
    and strpos(s, 'from public.auctions') < strpos(s, 'wm.lock_users(') and strpos(s, 'insert into wm.card_removals') > 0, 'ordre C4';
  assert strpos((select prosrc from pg_proc where oid = to_regproc('wm.auction_void')), 'lock_timeout') = 0
    and strpos((select prosrc from pg_proc where oid = to_regproc('wm.trade_void')), 'lock_timeout') = 0, 'aides sans lock_timeout';
  select string_agg(f, ', ') into bad from unnest(array['staff_card(uuid, uuid)', 'staff_card_removals(uuid)']) f
  where (select provolatile from pg_proc where oid = ('wm.' || f)::regprocedure) <> 's';
  assert bad is null, 'non stable : ' || bad;
end $$;

select pg_temp.inv('fin de 38');
