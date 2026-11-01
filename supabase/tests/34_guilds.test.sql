-- Guildes (2000_wm_progress_core.sql, puis 2010…2040) : config guild et achievements, user_state.achievements_checked_at, index, borne
-- hebdomadaire, crochet de score, notify_guild, invariant ach_money ; les tâches suivantes du M5b ajoutent leurs blocs.
-- Une seule transaction pour tout le fichier (now() figé) : chaque bloc crée ses joueurs, ses cartes et ses guildes, et ne filtre que sur eux.
-- check_invariants est global : un bloc qui crée une violation voulue la fait dans une sous-transaction annulée (WMT00,
-- 27_market.test.sql:278-285, P5a:47), et contrôle le résultat après.

-- Exécute p_sql et renvoie le detail JSON de l'erreur P0001 levée (null si aucune) ; l'effet de p_sql n'est annulé que si p_sql lève.
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

-- Carte du catalogue au titre unique.
create function pg_temp.card(p_title text, p_rarity public.rarity default 'R') returns uuid language sql as $$
  insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, category)
  values (p_title, 'https://fr.wikipedia.org/wiki/' || replace(p_title, ' ', '_'), p_rarity, 1200, 800, 'Catégorie échange')
  returning id
$$;

-- Joueur vérifié (fenêtres anti-bot remises à zéro).
create function pg_temp.player(p_name text, p_balance int default 0) returns uuid language plpgsql as $$
declare u uuid := tests.make_user(p_name, p_balance); begin
  perform wm.set_human_verified(u);
  return u;
end $$;

-- Une ligne user_cards aux snapshots de la carte.
create function pg_temp.copy(p_uid uuid, p_card uuid, p_count int default 1) returns uuid language sql as $$
  insert into public.user_cards (user_id, card_id, count, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
  select p_uid, id, p_count, wikipedia_title, rarity, category, atk, def from public.cards where id = p_card
  returning id
$$;

create function pg_temp.friends(p_a uuid, p_b uuid) returns void language sql as $$
  insert into public.friendships (requester_id, addressee_id, status) values (p_a, p_b, 'accepted')
$$;

-- Config du M5b (G9), chaque clé avec sa note.
create function pg_temp.progress_config() returns jsonb language sql as $$
  select jsonb_object_agg(key, value) from wm.config where key in ('guild', 'achievements')
$$;

do $$ begin
  assert pg_temp.progress_config() = '{"guild":{"max_members":200,"donations_per_day":1},"achievements":{"check_interval_s":300}}'::jsonb,
    pg_temp.progress_config()::text;
  assert not exists (select from wm.config where key in ('guild', 'achievements') and coalesce(note, '') = ''), 'note manquante';
end $$;

-- Rejeu de 2000, suivi de 2250 qui redéfinit check_invariants (M5b-18) : mêmes valeurs, et une valeur déjà posée garde la sienne.
create temp table progress_config as select pg_temp.progress_config() v;
update wm.config set value = value || '{"max_members": 5}' where key = 'guild';
\ir ../migrations/2000_wm_progress_core.sql
\ir ../migrations/2250_wm_account_delete.sql
do $$ begin
  assert pg_temp.progress_config() = jsonb_set((select v from progress_config), '{guild,max_members}', '5'), pg_temp.progress_config()::text;
end $$;
update wm.config set value = value || '{"max_members": 200}' where key = 'guild';

-- achievements_checked_at d'un joueur neuf (M5b-5).
do $$ declare u uuid := pg_temp.player('GuiState'); begin
  perform wm.lock_user(u);
  assert (select achievements_checked_at is null from wm.user_state where user_id = u), 'achievements_checked_at';
end $$;

-- Index du M5b (M16, D:812, D-C14), définition complète.
do $$ declare bad text; begin
  select string_agg(v.n, ', ') into bad from (values
    ('guild_members_user_key', 'UNIQUE ', 'public.guild_members USING btree (user_id)'),
    ('guild_members_leader_key', 'UNIQUE ', 'public.guild_members USING btree (guild_id) WHERE (role = ''leader''::guild_role)'),
    ('guilds_leader_idx', '', 'public.guilds USING btree (leader_id)'),
    ('guild_wishlists_open_key', 'UNIQUE ', 'public.guild_wishlists USING btree (user_id) WHERE (fulfilled_at IS NULL)'),
    ('guild_wishlists_guild_idx', '', 'public.guild_wishlists USING btree (guild_id, created_at) WHERE (fulfilled_at IS NULL)'),
    ('guild_wishlists_card_idx', '', 'public.guild_wishlists USING btree (card_id)'),
    ('guild_donations_recipient_idx', '', 'public.guild_donations USING btree (recipient_id, created_at DESC)'),
    ('guild_donations_donor_idx', '', 'public.guild_donations USING btree (donor_id, created_at DESC)'),
    ('guild_donations_guild_idx', '', 'public.guild_donations USING btree (guild_id, created_at DESC)'),
    ('guild_donations_wishlist_idx', '', 'public.guild_donations USING btree (wishlist_id)'),
    ('guild_chat_messages_guild_idx', '', 'public.guild_chat_messages USING btree (guild_id, created_at DESC)'),
    ('guild_chat_messages_user_idx', '', 'public.guild_chat_messages USING btree (user_id)'),
    ('guild_weekly_scores_rank_idx', '', 'public.guild_weekly_scores USING btree (week_start, total_score DESC)'),
    ('guild_weekly_scores_guild_idx', '', 'public.guild_weekly_scores USING btree (guild_id)'),
    ('guild_invites_user_idx', '', 'wm.guild_invites USING btree (user_id, created_at DESC)'),
    ('guild_invites_inviter_idx', '', 'wm.guild_invites USING btree (inviter_id)'),
    ('user_stats_battles_won_idx', '', 'wm.user_stats USING btree (battles_won DESC) WHERE (battles_won > 0)'),
    ('battles_completed_idx', '', 'public.battles USING btree (updated_at) WHERE (status = ''completed''::battle_status)'),
    ('user_cards_obtained_idx', '', 'public.user_cards USING btree (obtained_at)'),
    ('guild_wishlists_user_idx', '', 'public.guild_wishlists USING btree (user_id)'),
    ('guild_wishlists_guild_fk_idx', '', 'public.guild_wishlists USING btree (guild_id)'),
    ('user_achievements_achievement_idx', '', 'public.user_achievements USING btree (achievement_id)')) v (n, u, def)
  where not exists (select from pg_indexes i where i.indexname = v.n and i.indexdef = format('CREATE %sINDEX %s ON %s', v.u, v.n, v.def));
  assert bad is null, 'index absents ou différents : ' || bad;
end $$;

-- Borne hebdomadaire (D:1084, D-C12) : lundi 00:00 UTC, quel que soit le TimeZone de session (C3) ; semaine ISO lue en UTC.
-- Appels dynamiques (execute) : un appel statique d'une fonction immutable sur des constantes serait replié au premier plan, sous UTC, et
-- gardé dans le cache de plans de PL/pgSQL ; changer de fuseau ne le replanifierait pas.
do $$ declare z text; tz text := current_setting('timezone'); c record; v timestamptz; iw text; begin
  foreach z in array array['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles'] loop
    perform set_config('timezone', z, true);
    for c in select * from (values
      ('2026-11-01 23:59:59+00', '2026-10-26 00:00:00+00', null, 'dimanche soir'),
      ('2026-11-01 23:59:59.999999+00', '2026-10-26 00:00:00+00', null, 'dernière microseconde'),
      ('2026-11-02 00:00:00+00', '2026-11-02 00:00:00+00', null, 'lundi 00:00'),
      ('2026-11-02 00:59:59+01', '2026-10-26 00:00:00+00', null, 'lundi 00:59:59+01'),
      ('2027-01-03 23:59:59+00', '2026-12-28 00:00:00+00', '53', 'semaine 53'),
      ('2027-01-04 00:00:00+00', '2027-01-04 00:00:00+00', '01', 'semaine 1')) t (at, ws, iw, label)
    loop
      execute format('select w, to_char(w at time zone ''UTC'', ''IW'') from wm.week_start(%L::timestamptz) w', c.at) into v, iw;
      assert v = c.ws::timestamptz, format('%s : %s → %s', z, c.label, v);
      assert c.iw is null or iw = c.iw, format('%s : %s → IW %s', z, c.label, iw);
    end loop;
  end loop;
  perform set_config('timezone', tz, true);
  assert (select provolatile = 'i' from pg_proc where oid = 'wm.week_start(timestamptz)'::regprocedure), 'week_start immutable';
end $$;

-- guild_score_add (G4) : guilde et membres posés en superutilisateur ; Alice membre de G, Bob sans guilde.
do $$ declare a uuid := pg_temp.player('GuiScoAlice'); b uuid := pg_temp.player('GuiScoBob'); g uuid; n int; m int; total bigint; k bigint; begin
  insert into public.guilds (name, leader_id) values ('GuiSco', a) returning id into g;
  insert into public.guild_members (guild_id, user_id, role) values (g, a, 'leader');
  -- Dimanche 23:59:59 et lundi 00:00:00 UTC : deux lignes.
  assert wm.guild_score_add(a, 'battles', 500, '2026-11-01 23:59:59+00') = 500, 'battles dimanche';
  assert wm.guild_score_add(a, 'wb', 120, '2026-11-02 00:00:00+00') = 120, 'wb lundi';
  assert (select count(*) from public.guild_weekly_scores where guild_id = g) = 2, 'deux lignes';
  assert exists (select from public.guild_weekly_scores where guild_id = g and week_start = '2026-10-26 00:00:00+00'
    and (score_battles, score_wb, total_score) = (500, 0, 500)), 'semaine du 26';
  assert exists (select from public.guild_weekly_scores where guild_id = g and week_start = '2026-11-02 00:00:00+00'
    and (score_battles, score_wb, total_score) = (0, 120, 120)), 'semaine du 2';
  -- Même semaine : la ligne s'additionne.
  assert wm.guild_score_add(a, 'battles', 500, '2026-11-02 12:00:00+00') = 500, 'battles lundi midi';
  assert exists (select from public.guild_weekly_scores where guild_id = g and week_start = '2026-11-02 00:00:00+00'
    and (score_battles, score_wb, total_score) = (500, 120, 620)), 'cumul';
  -- Sans guilde, montant nul ou absent : 0, rien n'est écrit.
  select sum(total_score) into total from public.guild_weekly_scores;
  select count(*) into k from public.guild_weekly_scores;
  assert wm.guild_score_add(b, 'battles', 500, '2026-11-02 12:00:00+00') = 0, 'Bob sans guilde';
  assert wm.guild_score_add(a, 'battles', 0, '2026-11-02 12:00:00+00') = 0, 'montant 0';
  assert wm.guild_score_add(a, 'wb', null, '2026-11-02 12:00:00+00') = 0, 'montant nul';
  assert (select sum(total_score) from public.guild_weekly_scores) = total
    and (select count(*) from public.guild_weekly_scores) = k, 'rien écrit';
  -- Type inconnu : erreur de programmation.
  begin
    perform wm.guild_score_add(a, 'x', 1, '2026-11-02 12:00:00+00');
    assert false, 'type x accepté';
  exception when sqlstate 'XX000' then null;
  end;
  -- Guilde supprimée avant l'appel : 0, sans erreur ; puis membre resté sans sa guilde (clés étrangères suspendues), qui prend la
  -- branche « disparue » du verrou for key share.
  begin
    delete from public.guilds where id = g;
    n := wm.guild_score_add(a, 'battles', 500, '2026-11-02 12:00:00+00');
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  begin
    perform set_config('session_replication_role', 'replica', true);
    delete from public.guilds where id = g;
    perform set_config('session_replication_role', 'origin', true);
    assert exists (select from public.guild_members where guild_id = g), 'membre resté';
    m := wm.guild_score_add(a, 'battles', 500, '2026-11-02 12:00:00+00');
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert n = 0 and m = 0, format('guilde supprimée : %s, %s', n, m);
  assert (select count(*) from public.guild_weekly_scores where guild_id = g) = 2, 'guilde rétablie';

  -- notify_guild (M5b-11) : une ligne par destinataire, data de l'acteur.
  assert wm.notify_guild(array[b, a], 'guild_invite', g, a) = 2, 'deux notifications';
  assert (select jsonb_agg(jsonb_build_object('user_id', user_id, 'data', data) order by user_id) from public.notifications
      where type = 'guild_invite' and user_id in (a, b))
    = (select jsonb_agg(jsonb_build_object('user_id', u, 'data', jsonb_build_object('guild_id', g, 'guild_name', 'GuiSco', 'user_id', a,
        'username', 'GuiScoAlice')) order by u) from unnest(array[a, b]) u), 'data de guild_invite';
  perform pg_temp.inv('guild_score_add');
end $$;

-- ach_money (D:611, D-C16) : tout le scénario dans une sous-transaction annulée (WMT00), contrôlé après.
do $$ declare a uuid := pg_temp.player('GuiAchA'); c uuid := pg_temp.player('GuiAchCarol'); x uuid := gen_random_uuid();
  d1 jsonb; d2 jsonb; d3 jsonb; d4 jsonb; d5 jsonb; begin
  begin
    insert into public.achievements (id, title, description, wikibidous_reward, sort_order, category, threshold)
    values (x, 'Succès d''essai', 'Pour le test', 10, 1, 'Essai', 1);
    -- (a) Ligne ach:<id> sans user_achievements, puis débloqué non réclamé, puis réclamé.
    perform wm.wallet_apply(a, 10, 'achievement', 'ach:' || x);
    d1 := wm.check_invariants();
    insert into public.user_achievements (user_id, achievement_id) values (a, x);
    d2 := wm.check_invariants();
    update public.user_achievements set claimed_at = now() where user_id = a and achievement_id = x;
    d3 := wm.check_invariants();
    -- (b) Réclamé sans sa ligne.
    insert into public.user_achievements (user_id, achievement_id, claimed_at) values (c, x, now());
    d4 := wm.check_invariants();
    -- (a) Ref mal formée (un cast y lèverait 22P02) : une violation, pas une erreur.
    perform wm.wallet_apply(a, 10, 'achievement', 'ach:x');
    d5 := wm.check_invariants();
    raise exception using errcode = 'WMT00';
  exception when sqlstate 'WMT00' then null;
  end;
  assert d1 = jsonb_build_array(jsonb_build_object('check', 'ach_money', 'ref', 'ach:' || x, 'user_id', a)), d1::text;
  assert d2 = d1, d2::text;
  assert d3 = '[]', d3::text;
  assert d4 = jsonb_build_array(jsonb_build_object('check', 'ach_money', 'achievement_id', x, 'user_id', c)), d4::text;
  assert d5 @> d4 and d5 @> jsonb_build_array(jsonb_build_object('check', 'ach_money', 'ref', 'ach:x', 'user_id', a))
    and jsonb_array_length(d5) = 2, d5::text;
  perform pg_temp.inv('après ach_money');
end $$;

-- Guildes (2010, Task 3) : lecture, création, invitations, adhésion, refus d'une invitation.

-- Corps d'erreur de wm.raise_err (error = message, code absent si null).
create function pg_temp.e(p_status int, p_code text, p_message text) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('status', p_status, 'code', p_code, 'error', p_message, 'message', p_message))
$$;

-- Guilde de p_leader par guild_create ; chaque membre devient ami du chef, est invité par lui et rejoint.
create function pg_temp.guild(p_leader uuid, p_members uuid[] default '{}') returns uuid language plpgsql as $$
declare g uuid; m uuid; begin
  g := (wm.guild_create(p_leader, left('Guilde ' || (select username from public.profiles where id = p_leader), 40)) -> 'guild' ->> 'id')::uuid;
  foreach m in array p_members loop
    perform pg_temp.friends(p_leader, m);
    perform wm.guild_invite(p_leader, m);
    perform wm.guild_join(m, g);
  end loop;
  return g;
end $$;

-- Création (D:583, gratuite) : nom rogné, rôle leader, réponse = guild_get, rejeu de la clé ; refus exacts.
do $$ declare a uuid := pg_temp.player('GuiCreA'); b uuid := pg_temp.player('GuiCreB'); c uuid := pg_temp.player('GuiCreC');
  w uuid := pg_temp.player('GuiCreW'); r jsonb; d jsonb; g public.guilds; m public.guild_members; begin
  r := wm.guild_create(a, '  Les Archivistes ', 'Une guilde.');
  select * into g from public.guilds where leader_id = a;
  select * into m from public.guild_members where user_id = a;
  assert r = jsonb_build_object('guild', jsonb_build_object('id', g.id, 'name', 'Les Archivistes', 'description', 'Une guilde.',
      'leader_id', a, 'created_at', g.created_at),
    'membership', jsonb_build_object('guild_id', g.id, 'user_id', a, 'role', 'leader', 'joined_at', m.joined_at),
    'member_count', 1, 'invites', '[]'::jsonb), r::text;
  assert g.name = 'Les Archivistes' and m.guild_id = g.id, 'lignes';
  assert wm.guild_get(a) = r, 'guild_get';
  -- Sans guilde : guild et membership nuls, 0 membre, invitations en tableau.
  assert wm.guild_get(b) = '{"guild": null, "membership": null, "member_count": 0, "invites": []}', wm.guild_get(b)::text;
  -- Même clé deux fois : même corps, une seule guilde (sans clé, le second appel serait un 409).
  r := wm.guild_create(b, 'Clé', p_idem => 'k-gcreate');
  assert wm.guild_create(b, 'Clé', p_idem => 'k-gcreate') = r, 'rejeu de la clé';
  assert (select count(*) from public.guilds where leader_id = b) = 1, 'une seule guilde';
  -- Description blanche stockée nulle ; nom de 40 caractères exactement.
  r := wm.guild_create(c, repeat('n', 40), '   ');
  assert r -> 'guild' -> 'description' = 'null' and r -> 'guild' ->> 'name' = repeat('n', 40), r::text;
  assert (select description is null from public.guilds where leader_id = c), 'description nulle';
  -- Refus.
  d := pg_temp.err(format('select wm.guild_create(%L, %L)', w, '   '));
  assert d = pg_temp.e(400, 'invalid_request', 'Le nom de la guilde est vide'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_create(%L, null)', w));
  assert d = pg_temp.e(400, 'invalid_request', 'Le nom de la guilde est vide'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_create(%L, %L)', w, repeat('n', 41)));
  assert d = pg_temp.e(400, 'invalid_request', 'Un nom de guilde fait au plus 40 caractères'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_create(%L, %L, %L)', w, 'Longue', repeat('d', 281)));
  assert d = pg_temp.e(400, 'invalid_request', 'Une description fait au plus 280 caractères'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_create(%L, %L)', a, 'Encore'));
  assert d = pg_temp.e(409, null, 'Tu fais déjà partie d''une guilde'), coalesce(d::text, 'accepté');
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format('select wm.guild_create(%L, %L)', w, 'Maintenance'));
  update wm.config set value = 'false' where key = 'maintenance';
  assert d = pg_temp.e(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.'), coalesce(d::text, 'accepté');
  assert not exists (select from public.guilds where leader_id = w) and not exists (select from public.guild_members where user_id = w),
    'refus sans écriture';
end $$;

-- Invitations (M5b-8, M5b-11) : entre amis, réécrites, notifiées à chaque fois ; refus exacts.
do $$ declare a uuid := pg_temp.player('GuiInvA'); b uuid := pg_temp.player('GuiInvB'); c uuid := pg_temp.player('GuiInvC');
  m uuid := pg_temp.player('GuiInvM'); dd uuid := pg_temp.player('GuiInvD'); x uuid := pg_temp.player('GuiInvX');
  y uuid := pg_temp.player('GuiInvY'); g uuid; t timestamptz; r jsonb; d jsonb; begin
  g := (wm.guild_create(a, 'Les Archivistes') -> 'guild' ->> 'id')::uuid;
  perform pg_temp.friends(a, m);
  perform wm.guild_invite(a, m);
  perform wm.guild_join(m, g);
  perform pg_temp.friends(a, b);
  assert wm.guild_invite(a, b) = '{"ok": true}', 'invite';
  assert (select jsonb_agg(data) from public.notifications where user_id = b and type = 'guild_invite')
    = jsonb_build_array(jsonb_build_object('guild_id', g, 'guild_name', 'Les Archivistes', 'user_id', a, 'username', 'GuiInvA')),
    'notification';
  select created_at into t from wm.guild_invites where guild_id = g and user_id = b;
  assert wm.guild_get(b) -> 'invites' = jsonb_build_array(jsonb_build_object('guild_id', g, 'guild_name', 'Les Archivistes',
    'inviter_username', 'GuiInvA', 'created_at', t)), wm.guild_get(b)::text;
  -- Réinvité par un autre membre : une ligne, réécrite (inviteur et instant), deux notifications.
  perform pg_temp.friends(m, b);
  assert wm.guild_invite(m, b) = '{"ok": true}', 'réinvitation';
  assert (select count(*) from wm.guild_invites where user_id = b) = 1, 'une ligne';
  assert (select inviter_id = m and created_at > t from wm.guild_invites where guild_id = g and user_id = b), 'réécrite';
  assert wm.guild_get(b) -> 'invites' -> 0 ->> 'inviter_username' = 'GuiInvM', wm.guild_get(b)::text;
  assert (select jsonb_agg(data ->> 'username' order by created_at, data ->> 'username') from public.notifications
    where user_id = b and type = 'guild_invite') = '["GuiInvA", "GuiInvM"]', 'deux notifications';
  -- Même clé deux fois : même corps, une seule notification de plus.
  r := wm.guild_invite(a, b, 'k-ginvite');
  assert wm.guild_invite(a, b, 'k-ginvite') = r, 'rejeu de la clé';
  assert (select count(*) from public.notifications where user_id = b and type = 'guild_invite') = 3, 'un seul effet';
  -- Refus.
  d := pg_temp.err(format('select wm.guild_invite(%L, %L)', a, a));
  assert d = pg_temp.e(400, 'invalid_request', 'Tu ne peux pas t''inviter toi-même'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_invite(%L, %L)', a, gen_random_uuid()));
  assert d = pg_temp.e(404, null, 'Joueur introuvable'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_invite(%L, %L)', a, c));
  assert d = '{"status":403,"code":"FORBIDDEN","error":"Vous devez être amis pour inviter ce joueur",
    "message":"Vous devez être amis pour inviter ce joueur"}', coalesce(d::text, 'accepté');
  perform pg_temp.friends(dd, b);
  d := pg_temp.err(format('select wm.guild_invite(%L, %L)', dd, b));
  assert d = pg_temp.e(404, null, 'Tu n''es dans aucune guilde'), coalesce(d::text, 'accepté');
  perform pg_temp.guild(y, array[x]);
  perform pg_temp.friends(a, x);
  d := pg_temp.err(format('select wm.guild_invite(%L, %L)', a, x));
  assert d = pg_temp.e(409, null, 'Ce joueur fait déjà partie d''une guilde'), coalesce(d::text, 'accepté');
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format('select wm.guild_invite(%L, %L)', a, b));
  update wm.config set value = 'false' where key = 'maintenance';
  assert d = pg_temp.e(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.'), coalesce(d::text, 'accepté');
  assert not exists (select from wm.guild_invites where user_id in (c, x, a)), 'refus sans écriture';
  assert (select count(*) from public.notifications where user_id = b and type = 'guild_invite') = 3, 'refus sans notification';
end $$;

-- Deux invitations : la plus récente d'abord ; rejoindre l'une efface toutes les autres.
do $$ declare a uuid := pg_temp.player('GuiTwoA'); h uuid := pg_temp.player('GuiTwoH'); b uuid := pg_temp.player('GuiTwoB');
  g uuid := pg_temp.guild(a); hh uuid := pg_temp.guild(h); r jsonb; d jsonb; begin
  perform pg_temp.friends(a, b);
  perform pg_temp.friends(h, b);
  perform wm.guild_invite(a, b);
  perform wm.guild_invite(h, b);
  assert (select jsonb_agg(i ->> 'guild_id') from jsonb_array_elements(wm.guild_get(b) -> 'invites') i)
    = jsonb_build_array(hh, g), wm.guild_get(b)::text;
  r := wm.guild_join(b, g);
  assert r = wm.guild_get(b), 'réponse de guild_get';
  assert (r -> 'guild' ->> 'id')::uuid = g and r -> 'membership' ->> 'role' = 'member' and (r -> 'membership' ->> 'user_id')::uuid = b
    and r -> 'member_count' = '2' and r -> 'invites' = '[]', r::text;
  assert not exists (select from wm.guild_invites where user_id = b), 'invitations effacées';
  d := pg_temp.err(format('select wm.guild_join(%L, %L)', b, hh));
  assert d = pg_temp.e(409, null, 'Tu fais déjà partie d''une guilde'), coalesce(d::text, 'accepté');
end $$;

-- Adhésion : invitation exigée, guilde connue, plafond guild.max_members ; rejeu de la clé ; maintenance.
do $$ declare a uuid := pg_temp.player('GuiJoiA'); b uuid := pg_temp.player('GuiJoiB'); e uuid := pg_temp.player('GuiJoiE');
  f uuid := pg_temp.player('GuiJoiF'); k uuid := pg_temp.player('GuiJoiK'); g uuid; r jsonb; d jsonb; begin
  g := pg_temp.guild(a, array[b]);
  d := pg_temp.err(format('select wm.guild_join(%L, %L)', f, g));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Aucune invitation de cette guilde'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_join(%L, %L)', f, gen_random_uuid()));
  assert d = pg_temp.e(404, null, 'Guilde introuvable'), coalesce(d::text, 'accepté');
  -- Plafond à 2, A et B déjà membres : E invité est refusé, son invitation reste.
  update wm.config set value = value || '{"max_members": 2}' where key = 'guild';
  perform pg_temp.friends(a, e);
  perform wm.guild_invite(a, e);
  d := pg_temp.err(format('select wm.guild_join(%L, %L)', e, g));
  update wm.config set value = value || '{"max_members": 200}' where key = 'guild';
  assert d = pg_temp.e(409, null, 'Cette guilde est pleine'), coalesce(d::text, 'accepté');
  assert exists (select from wm.guild_invites where guild_id = g and user_id = e), 'invitation restée';
  assert (select count(*) from public.guild_members where guild_id = g) = 2, 'deux membres';
  -- Maintenance, puis même clé deux fois : même corps, un seul membre de plus.
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format('select wm.guild_join(%L, %L)', e, g));
  update wm.config set value = 'false' where key = 'maintenance';
  assert d = pg_temp.e(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.'), coalesce(d::text, 'accepté');
  r := wm.guild_join(e, g, 'k-gjoin');
  assert wm.guild_join(e, g, 'k-gjoin') = r and r -> 'member_count' = '3', r::text;
  assert (select count(*) from public.guild_members where guild_id = g) = 3, 'un seul effet';
  -- Créer une guilde efface les invitations reçues (M5b-8).
  perform pg_temp.friends(a, k);
  perform wm.guild_invite(a, k);
  r := wm.guild_create(k, 'La mienne');
  assert r -> 'invites' = '[]' and wm.guild_get(k) -> 'invites' = '[]', 'invitations de K';
  assert not exists (select from wm.guild_invites where user_id = k), 'ligne effacée';
end $$;

-- Refus d'une invitation : la ligne disparaît ; une invitation absente est un 404 ; rejeu de la clé ; maintenance.
do $$ declare a uuid := pg_temp.player('GuiDecA'); b uuid := pg_temp.player('GuiDecB'); g uuid := pg_temp.guild(a); d jsonb; begin
  perform pg_temp.friends(a, b);
  perform wm.guild_invite(a, b);
  assert wm.guild_invite_decline(b, g) = '{"ok": true}', 'refus';
  assert not exists (select from wm.guild_invites where user_id = b), 'ligne supprimée';
  d := pg_temp.err(format('select wm.guild_invite_decline(%L, %L)', b, g));
  assert d = pg_temp.e(404, null, 'Aucune invitation de cette guilde'), coalesce(d::text, 'accepté');
  perform wm.guild_invite(a, b);
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format('select wm.guild_invite_decline(%L, %L)', b, g));
  update wm.config set value = 'false' where key = 'maintenance';
  assert d = pg_temp.e(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.'), coalesce(d::text, 'accepté');
  assert exists (select from wm.guild_invites where user_id = b), 'refus sans effet';
  assert wm.guild_invite_decline(b, g, 'k-gdecline') = '{"ok": true}' and wm.guild_invite_decline(b, g, 'k-gdecline') = '{"ok": true}',
    'rejeu de la clé';
  assert not exists (select from wm.guild_invites where user_id = b), 'un seul effet';
end $$;

-- Volatilité, lock_timeout avant le premier verrou (P5), profils puis guilde (M5b-1), aucun profil pour le refus.
do $$ declare v text; begin
  assert (select provolatile = 's' from pg_proc where oid = 'wm.guild_get(uuid)'::regprocedure), 'guild_get stable';
  v := tests.lock_timeout_violations(array['guild_create', 'guild_invite', 'guild_join', 'guild_invite_decline'],
    array['for update', 'for no key update', 'for key share', 'wm.lock_users(', 'wm.lock_user(', 'delete from wm.guild_invites']);
  assert v is null, 'lock_timeout : ' || v;
  assert (select strpos(prosrc, 'wm.lock_user') between 1 and strpos(prosrc, 'for no key update') from pg_proc
    where oid = to_regproc('wm.guild_invite')), 'guild_invite : profils puis guilde';
  assert (select strpos(prosrc, 'wm.lock_user') between 1 and strpos(prosrc, 'for no key update') from pg_proc
    where oid = to_regproc('wm.guild_join')), 'guild_join : profil puis guilde';
  assert (select strpos(prosrc, 'wm.lock_user') = 0 and strpos(prosrc, 'for no key update') = 0 from pg_proc
    where oid = to_regproc('wm.guild_invite_decline')), 'guild_invite_decline sans profil ni guilde';
end $$;

-- Nom de guilde : tout blanc (tabulation, saut de ligne) rogné comme la description (\s), pas seulement l'espace.
do $$ declare w uuid := pg_temp.player('GuiNomW'); a uuid := pg_temp.player('GuiNomA'); d jsonb; begin
  d := pg_temp.err(format('select wm.guild_create(%L, %L)', w, E'\t'));
  assert d = pg_temp.e(400, 'invalid_request', 'Le nom de la guilde est vide'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_create(%L, %L)', w, E'\n'));
  assert d = pg_temp.e(400, 'invalid_request', 'Le nom de la guilde est vide'), coalesce(d::text, 'accepté');
  assert wm.guild_create(a, E' \n x \t ') -> 'guild' ->> 'name' = 'x', 'nom rogné';
  assert (select name from public.guilds where leader_id = a) = 'x', 'nom stocké';
end $$;

-- Départ (M5b-4, M5b-10, D-C20) : membre, chef avec membres (409), dernier membre (dissolution), sans guilde.
do $$ declare a uuid := pg_temp.player('GuiLvA'); b uuid := pg_temp.player('GuiLvB'); c uuid := pg_temp.player('GuiLvC');
  z uuid := pg_temp.player('GuiLvZ'); x uuid := pg_temp.player('GuiLvX'); g uuid; g2 uuid; k uuid := pg_temp.card('GuiLv carte');
  k2 uuid := pg_temp.card('GuiLv carte 2'); d jsonb; begin
  g := pg_temp.guild(a, array[b]);
  insert into public.guild_wishlists (guild_id, user_id, card_id, fulfilled_at) values (g, b, k, now());
  insert into public.guild_wishlists (guild_id, user_id, card_id) values (g, b, k2);
  insert into public.guild_chat_messages (guild_id, user_id, content) values (g, b, 'Salut');
  d := pg_temp.err(format('select wm.guild_leave(%L)', a));
  assert d = pg_temp.e(409, null, 'Transmets d''abord ton rôle de chef à un autre membre'), coalesce(d::text, 'accepté');
  assert wm.guild_leave(b) = '{"ok": true}', 'départ';
  assert not exists (select from public.guild_members where user_id = b), 'adhésion supprimée';
  assert not exists (select from public.guild_wishlists where user_id = b and fulfilled_at is null), 'souhait ouvert supprimé';
  assert exists (select from public.guild_wishlists where user_id = b and fulfilled_at is not null), 'souhait clos resté';
  assert exists (select from public.guild_chat_messages where user_id = b and guild_id = g), 'messages restés';
  assert exists (select from public.guilds where id = g), 'guilde restée';
  d := pg_temp.err(format('select wm.guild_leave(%L)', b));
  assert d = pg_temp.e(404, null, 'Tu n''es dans aucune guilde'), coalesce(d::text, 'accepté');
  -- Dernier membre : tout part avec la guilde.
  perform pg_temp.friends(a, c);
  perform wm.guild_invite(a, c);
  perform wm.guild_score_add(a, 'battles', 500, now());
  insert into public.guild_wishlists (guild_id, user_id, card_id) values (g, a, k);
  assert wm.guild_leave(a) = '{"ok": true}', 'dissolution';
  assert not exists (select from public.guilds where id = g), 'guilde dissoute';
  assert not exists (select from public.guild_members where guild_id = g)
    and not exists (select from public.guild_weekly_scores where guild_id = g)
    and not exists (select from wm.guild_invites where guild_id = g)
    and not exists (select from public.guild_wishlists where guild_id = g)
    and not exists (select from public.guild_chat_messages where guild_id = g), 'cascade';
  -- Rejeu de la clé (un seul effet) et maintenance.
  g2 := pg_temp.guild(z, array[x]);
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format('select wm.guild_leave(%L)', x));
  update wm.config set value = 'false' where key = 'maintenance';
  assert d = pg_temp.e(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.'), coalesce(d::text, 'accepté');
  assert exists (select from public.guild_members where user_id = x), 'refus sans effet';
  assert wm.guild_leave(x, 'k-gleave') = '{"ok": true}' and wm.guild_leave(x, 'k-gleave') = '{"ok": true}', 'rejeu de la clé';
  perform pg_temp.inv('guild_leave');
end $$;

-- Exclusion (M5b-11) : chef seul, notifiée, souhait ouvert supprimé ; refus exacts.
do $$ declare a uuid := pg_temp.player('GuiKiA'); b uuid := pg_temp.player('GuiKiB'); c uuid := pg_temp.player('GuiKiC');
  o uuid := pg_temp.player('GuiKiO'); g uuid; k uuid := pg_temp.card('GuiKi carte'); d jsonb; begin
  g := pg_temp.guild(a, array[b, c]);
  insert into public.guild_wishlists (guild_id, user_id, card_id) values (g, b, k);
  d := pg_temp.err(format('select wm.guild_kick(%L, %L)', b, a));
  assert d = '{"status":403,"code":"FORBIDDEN","error":"Seul le chef de la guilde peut faire cela",
    "message":"Seul le chef de la guilde peut faire cela"}', coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_kick(%L, %L)', a, a));
  assert d = pg_temp.e(400, 'invalid_request', 'Tu ne peux pas t''exclure toi-même'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_kick(%L, %L)', a, o));
  assert d = pg_temp.e(404, null, 'Ce joueur ne fait pas partie de ta guilde'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_kick(%L, %L)', o, a));
  assert d = pg_temp.e(404, null, 'Tu n''es dans aucune guilde'), coalesce(d::text, 'accepté');
  assert not exists (select from public.notifications where type = 'guild_kicked' and user_id in (a, b, c, o)), 'refus sans notification';
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format('select wm.guild_kick(%L, %L)', a, b));
  update wm.config set value = 'false' where key = 'maintenance';
  assert d = pg_temp.e(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.'), coalesce(d::text, 'accepté');
  assert wm.guild_kick(a, b) = '{"ok": true}', 'exclusion';
  assert not exists (select from public.guild_members where user_id = b), 'adhésion supprimée';
  assert not exists (select from public.guild_wishlists where user_id = b and fulfilled_at is null), 'souhait ouvert supprimé';
  assert (select jsonb_agg(data) from public.notifications where type = 'guild_kicked' and user_id = b)
    = jsonb_build_array(jsonb_build_object('guild_id', g, 'guild_name', 'Guilde GuiKiA', 'user_id', a, 'username', 'GuiKiA')), 'notification';
  -- Même clé deux fois : une seule notification de plus.
  assert wm.guild_kick(a, c, 'k-gkick') = '{"ok": true}' and wm.guild_kick(a, c, 'k-gkick') = '{"ok": true}', 'rejeu de la clé';
  assert (select count(*) from public.notifications where type = 'guild_kicked' and user_id = c) = 1, 'un seul effet';
  perform pg_temp.inv('guild_kick');
end $$;

-- Transfert du rôle (M5b-10, C17) : le chef d'abord (403), puis soi-même (400), puis la cible (404).
do $$ declare a uuid := pg_temp.player('GuiTrA'); b uuid := pg_temp.player('GuiTrB'); o uuid := pg_temp.player('GuiTrO');
  c uuid := pg_temp.player('GuiTrC'); e uuid := pg_temp.player('GuiTrE'); g uuid; d jsonb; begin
  g := pg_temp.guild(a, array[b]);
  d := pg_temp.err(format('select wm.guild_transfer(%L, %L)', b, b));
  assert d = '{"status":403,"code":"FORBIDDEN","error":"Seul le chef de la guilde peut faire cela",
    "message":"Seul le chef de la guilde peut faire cela"}', 'chef avant soi-même : ' || coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_transfer(%L, %L)', o, a));
  assert d = pg_temp.e(404, null, 'Tu n''es dans aucune guilde'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_transfer(%L, %L)', a, o));
  assert d = pg_temp.e(404, null, 'Ce joueur ne fait pas partie de ta guilde'), coalesce(d::text, 'accepté');
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format('select wm.guild_transfer(%L, %L)', a, b));
  update wm.config set value = 'false' where key = 'maintenance';
  assert d = pg_temp.e(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.'), coalesce(d::text, 'accepté');
  assert wm.guild_transfer(a, b) = '{"ok": true}', 'transfert';
  assert (select role from public.guild_members where user_id = b) = 'leader' and (select role from public.guild_members where user_id = a) = 'member'
    and (select leader_id from public.guilds where id = g) = b
    and (select count(*) from public.guild_members where guild_id = g and role = 'leader') = 1, 'rôles';
  d := pg_temp.err(format('select wm.guild_transfer(%L, %L)', a, b));
  assert d = '{"status":403,"code":"FORBIDDEN","error":"Seul le chef de la guilde peut faire cela",
    "message":"Seul le chef de la guilde peut faire cela"}', coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_transfer(%L, %L)', b, b));
  assert d = pg_temp.e(400, 'invalid_request', 'Tu es déjà le chef de la guilde'), coalesce(d::text, 'accepté');
  assert not exists (select from public.notifications where user_id in (a, b) and type like 'guild\_%' and type <> 'guild_invite'),
    'aucune notification';
  assert wm.guild_leave(a) = '{"ok": true}', 'l''ancien chef peut partir';
  -- Même clé deux fois : un seul effet (le second appel, sans la clé, serait un 403).
  perform pg_temp.friends(b, c);
  perform wm.guild_invite(b, c);
  perform wm.guild_join(c, g);
  assert wm.guild_transfer(b, c, 'k-gtransfer') = '{"ok": true}' and wm.guild_transfer(b, c, 'k-gtransfer') = '{"ok": true}', 'rejeu de la clé';
  assert (select leader_id from public.guilds where id = g) = c, 'un seul effet';
  perform pg_temp.inv('guild_transfer');
end $$;

-- Membres : chef d'abord, puis joined_at, puis user_id ; pagination ; borne list_caps.guild_members.
do $$ declare a uuid := pg_temp.player('GuiMeA'); b uuid := pg_temp.player('GuiMeB'); c uuid := pg_temp.player('GuiMeC');
  o uuid := pg_temp.player('GuiMeO'); g uuid; r jsonb; u uuid; i int; d jsonb; begin
  g := pg_temp.guild(a, array[b, c]);
  update public.guild_members set joined_at = '2026-01-05' where user_id = a;
  update public.guild_members set joined_at = '2026-01-03' where user_id = b;
  update public.guild_members set joined_at = '2026-01-02' where user_id = c;
  r := wm.guild_members(a);
  assert r = jsonb_build_object('members', jsonb_build_array(
      jsonb_build_object('user_id', a, 'id', a, 'username', 'GuiMeA', 'profile', '{"username": "GuiMeA"}'::jsonb,
        'user', '{"username": "GuiMeA"}'::jsonb, 'role', 'leader', 'joined_at', (select joined_at from public.guild_members where user_id = a)),
      jsonb_build_object('user_id', c, 'id', c, 'username', 'GuiMeC', 'profile', '{"username": "GuiMeC"}'::jsonb,
        'user', '{"username": "GuiMeC"}'::jsonb, 'role', 'member', 'joined_at', (select joined_at from public.guild_members where user_id = c)),
      jsonb_build_object('user_id', b, 'id', b, 'username', 'GuiMeB', 'profile', '{"username": "GuiMeB"}'::jsonb,
        'user', '{"username": "GuiMeB"}'::jsonb, 'role', 'member', 'joined_at', (select joined_at from public.guild_members where user_id = b))),
    'hasMore', false), r::text;
  assert wm.guild_members(b) = r, 'même liste pour un membre';
  -- Égalité de joined_at : départage par user_id.
  update public.guild_members set joined_at = '2026-01-03' where user_id = c;
  assert (select jsonb_agg(m ->> 'user_id') from jsonb_array_elements(wm.guild_members(a) -> 'members') m)
    = jsonb_build_array(a, (select least(b, c)), (select greatest(b, c))), 'départage par user_id';
  r := wm.guild_members(a, 2);
  assert jsonb_array_length(r -> 'members') = 2 and r -> 'hasMore' = 'true', r::text;
  r := wm.guild_members(a, null, 2);
  assert jsonb_array_length(r -> 'members') = 1 and r -> 'hasMore' = 'false', r::text;
  r := wm.guild_members(a, 2, 1);
  assert jsonb_array_length(r -> 'members') = 2 and r -> 'hasMore' = 'false', r::text;
  assert wm.guild_members(a, 0) -> 'members' = wm.guild_members(a, 1) -> 'members' and jsonb_array_length(wm.guild_members(a, -5, -3) -> 'members') = 1,
    'bornes basses';
  assert jsonb_array_length(wm.guild_members(a, 2, 99) -> 'members') = 0, 'offset au-delà';
  d := pg_temp.err(format('select wm.guild_members(%L)', o));
  assert d = pg_temp.e(404, null, 'Tu n''es dans aucune guilde'), coalesce(d::text, 'accepté');
  -- 55 membres posés par insert : la borne est 50.
  update wm.config set value = value || '{"max_members": 60}' where key = 'guild';
  for i in 1..52 loop
    u := pg_temp.player('GuiMeP' || i);
    insert into public.guild_members (guild_id, user_id, role) values (g, u, 'member');
  end loop;
  update wm.config set value = value || '{"max_members": 200}' where key = 'guild';
  assert (select count(*) from public.guild_members where guild_id = g) = 55, '55 membres';
  r := wm.guild_members(a, 500);
  assert jsonb_array_length(r -> 'members') = 50 and r -> 'hasMore' = 'true', 'borné à 50';
  r := wm.guild_members(a);
  assert jsonb_array_length(r -> 'members') = 50 and r -> 'hasMore' = 'true', 'borne par défaut';
  assert jsonb_array_length(wm.guild_members(a, null, 50) -> 'members') = 5 and wm.guild_members(a, null, 50) -> 'hasMore' = 'false', 'dernière page';
end $$;

-- Volatilité, lock_timeout, ordre des verrous (G3 : souhait ouvert, puis G2 : profil, puis la guilde), aucun profil pour le départ.
do $$ declare v text; s text; p1 int; p2 int; p3 int; p4 int; begin
  assert (select provolatile = 's' from pg_proc where oid = 'wm.guild_members(uuid,int,int)'::regprocedure), 'guild_members stable';
  v := tests.lock_timeout_violations(array['guild_leave', 'guild_kick', 'guild_transfer'],
    array['for update', 'for no key update', 'for key share', 'wm.lock_users(', 'wm.lock_user(', 'delete from']);
  assert v is null, 'lock_timeout : ' || v;
  select prosrc into s from pg_proc where oid = to_regproc('wm.guild_kick');
  p1 := strpos(s, 'from public.guild_wishlists');
  p2 := strpos(s, 'for update');
  p3 := strpos(s, 'for key share');
  p4 := strpos(s, 'for no key update');
  assert p1 > 0 and p1 < p2 and p2 < p3 and p3 < p4, format('guild_kick : souhait, profil, guilde (%s %s %s %s)', p1, p2, p3, p4);
  select prosrc into s from pg_proc where oid = to_regproc('wm.guild_leave');
  p1 := strpos(s, 'from public.guild_wishlists');
  p2 := strpos(s, 'for update');
  p4 := strpos(s, 'for no key update');
  assert p1 > 0 and p1 < p2 and p2 < p4, format('guild_leave : souhait, guilde (%s %s %s)', p1, p2, p4);
  assert strpos(s, 'wm.lock_user') = 0 and strpos(s, 'from public.profiles') = 0, 'guild_leave sans profil';
  select prosrc into s from pg_proc where oid = to_regproc('wm.guild_transfer');
  assert strpos(s, 'wm.lock_users(') between 1 and strpos(s, 'for no key update'), 'guild_transfer : profils puis guilde';
end $$;

-- Entraide (2020, Task 5) : souhait, don d'une unité par move_copies, un don reçu par jour UTC, entraide, karma de la semaine.

-- État que rien ne doit changer après un refus : copies, souhaits, dons et notifications de don des joueurs.
create function pg_temp.help_snap(p_users uuid[]) returns jsonb language sql as $$
  select jsonb_build_object(
    'copies', (select jsonb_agg(jsonb_build_array(id, user_id, count, starred) order by id) from public.user_cards where user_id = any (p_users)),
    'wishes', (select jsonb_agg(jsonb_build_array(id, card_id, fulfilled_at) order by id) from public.guild_wishlists
      where user_id = any (p_users)),
    'donations', (select count(*) from public.guild_donations where donor_id = any (p_users) or recipient_id = any (p_users)),
    'notifications', (select count(*) from public.notifications where type = 'guild_donation' and user_id = any (p_users)))
$$;

-- Don posé en superutilisateur (souhait clos et sa ligne de don), pour le karma.
create function pg_temp.gift(p_guild uuid, p_donor uuid, p_recipient uuid, p_card uuid, p_at timestamptz default now())
returns void language sql as $$
  with w as (insert into public.guild_wishlists (guild_id, user_id, card_id, fulfilled_at) values (p_guild, p_recipient, p_card, p_at)
    returning id)
  insert into public.guild_donations (guild_id, wishlist_id, donor_id, recipient_id, user_card_id, created_at)
  select p_guild, id, p_donor, p_recipient, gen_random_uuid(), p_at from w
$$;

-- Souhait (M5b-4) : un seul ouvert, remplacé ; rejeu de la clé ; refus exacts ; retrait.
do $$ declare a uuid := pg_temp.player('GuiWiA'); b uuid := pg_temp.player('GuiWiB'); o uuid := pg_temp.player('GuiWiO');
  x uuid := pg_temp.card('GuiWi X'); y uuid := pg_temp.card('GuiWi Y'); g uuid; r jsonb; w public.guild_wishlists; v public.guild_wishlists;
  d jsonb; begin
  g := pg_temp.guild(a, array[b]);
  r := wm.guild_wish_set(b, x);
  select * into w from public.guild_wishlists where user_id = b and fulfilled_at is null;
  assert r = jsonb_build_object('wishlist', jsonb_build_object('id', w.id, 'user_id', b, 'card_id', x, 'created_at', w.created_at)), r::text;
  assert w.guild_id = g and w.card_id = x, 'ligne du souhait';
  -- Remplacé : un seul souhait ouvert, sur Y, d'un autre id ; l'ancien ouvert est supprimé.
  r := wm.guild_wish_set(b, y);
  select * into v from public.guild_wishlists where user_id = b and fulfilled_at is null;
  assert v.card_id = y and v.id <> w.id and (r -> 'wishlist' ->> 'id')::uuid = v.id, r::text;
  assert (select count(*) from public.guild_wishlists where user_id = b) = 1, 'un seul souhait';
  -- Même clé deux fois : même corps, un seul effet (le second appel demanderait X).
  r := wm.guild_wish_set(b, y, 'k-gwish');
  assert wm.guild_wish_set(b, x, 'k-gwish') = r, 'rejeu de la clé';
  assert (select card_id from public.guild_wishlists where user_id = b and fulfilled_at is null) = y, 'un seul effet';
  -- Refus.
  d := pg_temp.err(format('select wm.guild_wish_set(%L, %L)', b, gen_random_uuid()));
  assert d = pg_temp.e(404, null, 'Carte introuvable'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_wish_set(%L, %L)', o, x));
  assert d = pg_temp.e(404, null, 'Tu n''es dans aucune guilde'), coalesce(d::text, 'accepté');
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format('select wm.guild_wish_set(%L, %L)', b, x));
  update wm.config set value = 'false' where key = 'maintenance';
  assert d = pg_temp.e(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.'), coalesce(d::text, 'accepté');
  assert not exists (select from public.guild_wishlists where user_id = o), 'refus sans écriture';
  assert (select card_id from public.guild_wishlists where user_id = b and fulfilled_at is null) = y, 'souhait inchangé';
  -- Retrait, puis plus rien à retirer ; sans guilde (C6) ; maintenance ; rejeu de la clé.
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format('select wm.guild_wish_clear(%L)', b));
  update wm.config set value = 'false' where key = 'maintenance';
  assert d = pg_temp.e(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.'), coalesce(d::text, 'accepté');
  assert exists (select from public.guild_wishlists where user_id = b and fulfilled_at is null), 'maintenance sans effet';
  assert wm.guild_wish_clear(b) = '{"ok": true}', 'retrait';
  assert not exists (select from public.guild_wishlists where user_id = b), 'souhait supprimé';
  d := pg_temp.err(format('select wm.guild_wish_clear(%L)', b));
  assert d = pg_temp.e(404, null, 'Tu ne demandes aucune carte'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_wish_clear(%L)', o));
  assert d = pg_temp.e(404, null, 'Tu n''es dans aucune guilde'), coalesce(d::text, 'accepté');
  perform wm.guild_wish_set(b, x);
  assert wm.guild_wish_clear(b, 'k-gclear') = '{"ok": true}' and wm.guild_wish_clear(b, 'k-gclear') = '{"ok": true}', 'rejeu de la clé';
  assert not exists (select from public.guild_wishlists where user_id = b), 'un seul effet';
end $$;

-- La copie donnée (Review Focus) : copie entière étoilée, étiquetée, en vitrine et en avatar ; puis une pile de 3.
do $$ declare a uuid := pg_temp.player('GuiDonA'); b uuid := pg_temp.player('GuiDonB'); c uuid := pg_temp.player('GuiDonC');
  x uuid := pg_temp.card('GuiDon X'); g uuid; k uuid; k3 uuid; w uuid; w2 uuid; r jsonb; n public.user_cards; begin
  g := pg_temp.guild(a, array[b, c]);
  k := pg_temp.copy(a, x);
  update public.user_cards set starred = true where id = k;
  with t as (insert into public.tags (user_id, name) values (a, 'GuiDon tag') returning id)
  insert into public.user_card_tags (user_card_id, tag_id) select k, id from t;
  insert into public.showcase (user_id, position, user_card_id) values (a, 0, k);
  update public.profiles set avatar_user_card_id = k, avatar_url = 'u-k' where id = a;
  w := wm.guild_wish_set(b, x) -> 'wishlist' ->> 'id';
  r := wm.guild_donate(a, w, k);
  assert r = jsonb_build_object('ok', true, 'wishlist_id', w), r::text;
  assert (select user_id = b and count = 1 and not starred from public.user_cards where id = k), 'copie passée à B, sans étoile';
  assert not exists (select from public.user_card_tags where user_card_id = k), 'sans étiquette';
  assert not exists (select from public.showcase where user_card_id = k), 'vitrine vidée';
  assert (select avatar_user_card_id is null and avatar_url is null from public.profiles where id = a), 'avatar vidé';
  assert (select fulfilled_at = now() from public.guild_wishlists where id = w), 'souhait clos';
  assert (select jsonb_agg(jsonb_build_array(guild_id, wishlist_id, donor_id, recipient_id, user_card_id)) from public.guild_donations
    where recipient_id = b) = jsonb_build_array(jsonb_build_array(g, w, a, b, k)), 'ligne de don';
  assert (select jsonb_agg(data) from public.notifications where user_id = b and type = 'guild_donation')
    = jsonb_build_array(jsonb_build_object('guild_id', g, 'guild_name', 'Guilde GuiDonA', 'user_id', a, 'username', 'GuiDonA')), 'notification';
  assert not exists (select from public.notifications where type = 'guild_donation' and user_id in (a, c)), 'une seule notification';
  perform pg_temp.inv('don d''une copie entière');
  -- Pile de 3 en vitrine et en avatar : C reçoit une ligne neuve de 1 (même obtained_at), la pile passe à 2 et garde vitrine et avatar.
  k3 := pg_temp.copy(a, x, 3);
  update public.user_cards set obtained_at = '2026-01-02 03:04:05+00' where id = k3;
  insert into public.showcase (user_id, position, user_card_id) values (a, 1, k3);
  update public.profiles set avatar_user_card_id = k3, avatar_url = 'u-k3' where id = a;
  w2 := wm.guild_wish_set(c, x) -> 'wishlist' ->> 'id';
  assert wm.guild_donate(a, w2, k3) = jsonb_build_object('ok', true, 'wishlist_id', w2), 'don d''une unité';
  assert (select user_id = a and count = 2 from public.user_cards where id = k3), 'pile de A à 2';
  select * into n from public.user_cards where user_id = c;
  assert n.id <> k3 and n.card_id = x and n.count = 1 and not n.starred and n.obtained_at = '2026-01-02 03:04:05+00'
    and n.snapshot_title = 'GuiDon X', 'ligne neuve de C';
  assert exists (select from public.showcase where user_id = a and position = 1 and user_card_id = k3), 'vitrine gardée';
  assert (select avatar_user_card_id = k3 and avatar_url = 'u-k3' from public.profiles where id = a), 'avatar gardé';
  assert (select user_card_id from public.guild_donations where wishlist_id = w2) = k3, 'don de la pile';
  perform pg_temp.inv('don d''une unité');
end $$;

-- Refus exacts du don ; après chaque refus, rien n'a bougé. Un don reçu par jour UTC du receveur (D-C13).
do $$ declare a uuid := pg_temp.player('GuiRefA'); b uuid := pg_temp.player('GuiRefB'); c uuid := pg_temp.player('GuiRefC');
  dd uuid := pg_temp.player('GuiRefD'); o uuid := pg_temp.player('GuiRefO'); x uuid := pg_temp.card('GuiRef X');
  z uuid := pg_temp.card('GuiRef Z'); g uuid; wa uuid; wb uuid; wz uuid; ax uuid; az uuid; cx uuid; cz uuid; dx uuid; ox uuid; t uuid;
  s jsonb; r jsonb; d jsonb; us uuid[]; begin
  g := pg_temp.guild(a, array[b, c]);
  perform pg_temp.guild(dd);
  us := array[a, b, c, dd, o];
  ax := pg_temp.copy(a, x); az := pg_temp.copy(a, z); cx := pg_temp.copy(c, x); cz := pg_temp.copy(c, z);
  dx := pg_temp.copy(dd, x); ox := pg_temp.copy(o, x);
  wa := wm.guild_wish_set(a, x) -> 'wishlist' ->> 'id';
  wb := wm.guild_wish_set(b, x) -> 'wishlist' ->> 'id';
  s := pg_temp.help_snap(us);
  d := pg_temp.err(format('select wm.guild_donate(%L, %L, %L)', a, wa, ax));
  assert d = pg_temp.e(400, 'invalid_request', 'Tu ne peux pas te donner une carte'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_donate(%L, %L, %L)', a, wb, az));
  assert d = pg_temp.e(400, 'invalid_request', 'Cette carte n''est pas celle demandée'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_donate(%L, %L, %L)', a, wb, cx));
  assert d = pg_temp.e(403, '42501', 'Vous ne possédez pas cette carte'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_donate(%L, %L, %L)', dd, wb, dx));
  assert d = pg_temp.e(403, 'FORBIDDEN', 'Ce souhait n''est pas dans ta guilde'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_donate(%L, %L, %L)', o, wb, ox));
  assert d = pg_temp.e(404, null, 'Tu n''es dans aucune guilde'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_donate(%L, %L, %L)', a, gen_random_uuid(), ax));
  assert d = pg_temp.e(404, null, 'Ce souhait n''existe plus'), coalesce(d::text, 'accepté');
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format('select wm.guild_donate(%L, %L, %L)', a, wb, ax));
  update wm.config set value = 'false' where key = 'maintenance';
  assert d = pg_temp.e(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.'), coalesce(d::text, 'accepté');
  -- Une copie X promise par A dans un échange en attente (verrou au niveau card_id, D:676).
  insert into public.trades (initiator_id, recipient_id, expires_at) values (a, c, now() + interval '1 day') returning id into t;
  insert into public.trade_items (trade_id, offered_by, user_card_id, card_id, snapshot_rarity) values (t, a, ax, x, 'R');
  d := pg_temp.err(format('select wm.guild_donate(%L, %L, %L)', a, wb, ax));
  assert d = pg_temp.e(409, null, 'Cette carte est déjà engagée dans un échange en attente'), coalesce(d::text, 'accepté');
  delete from public.trades where id = t;
  assert pg_temp.help_snap(us) = s, 'refus sans effet : ' || pg_temp.help_snap(us)::text;
  -- Même clé deux fois : même corps, un seul don ; W clos ensuite → 404.
  r := wm.guild_donate(a, wb, ax, 'k-gdonate');
  assert wm.guild_donate(a, wb, ax, 'k-gdonate') = r and r = jsonb_build_object('ok', true, 'wishlist_id', wb), r::text;
  assert (select count(*) from public.guild_donations where wishlist_id = wb) = 1, 'un seul effet';
  s := pg_temp.help_snap(us);
  d := pg_temp.err(format('select wm.guild_donate(%L, %L, %L)', c, wb, cx));
  assert d = pg_temp.e(404, null, 'Ce souhait n''existe plus'), coalesce(d::text, 'accepté');
  assert pg_temp.help_snap(us) = s, 'refus sans effet : ' || pg_temp.help_snap(us)::text;
  -- B a reçu aujourd'hui : un deuxième souhait du jour ne reçoit rien.
  wz := wm.guild_wish_set(b, z) -> 'wishlist' ->> 'id';
  s := pg_temp.help_snap(us);
  d := pg_temp.err(format('select wm.guild_donate(%L, %L, %L)', c, wz, cz));
  assert d = pg_temp.e(409, null, 'Ce membre a déjà reçu un don aujourd''hui'), coalesce(d::text, 'accepté');
  assert pg_temp.help_snap(us) = s, 'refus sans effet : ' || pg_temp.help_snap(us)::text;
  -- Premier don reculé à la dernière seconde de la veille (UTC) : le don de C passe.
  update public.guild_donations set created_at = date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' - interval '1 second'
  where wishlist_id = wb;
  assert wm.guild_donate(c, wz, cz) = jsonb_build_object('ok', true, 'wishlist_id', wz), 'don du lendemain';
  assert (select user_id from public.user_cards where id = cz) = b, 'copie de C à B';
  perform pg_temp.inv('refus du don');
end $$;

-- G18 (Review Focus) : le souhait ouvert d'un ancien membre est invisible et ne reçoit aucun don.
do $$ declare a uuid := pg_temp.player('GuiExA'); e uuid := pg_temp.player('GuiExE'); x uuid := pg_temp.card('GuiEx X'); g uuid;
  w uuid; ax uuid; s jsonb; d jsonb; begin
  g := pg_temp.guild(a);
  ax := pg_temp.copy(a, x);
  insert into public.guild_wishlists (guild_id, user_id, card_id) values (g, e, x) returning id into w;
  assert wm.guild_home(a) -> 'wishlists' = '[]', wm.guild_home(a)::text;
  s := pg_temp.help_snap(array[a, e]);
  d := pg_temp.err(format('select wm.guild_donate(%L, %L, %L)', a, w, ax));
  assert d = pg_temp.e(404, null, 'Ce souhait n''existe plus'), coalesce(d::text, 'accepté');
  assert pg_temp.help_snap(array[a, e]) = s, 'refus sans effet';
end $$;

-- Entraide (guild_home) : clés exactes, souhaits des autres membres, copies du lecteur (G6), don du jour.
do $$ declare a uuid := pg_temp.player('GuiHoA'); b uuid := pg_temp.player('GuiHoB'); c uuid := pg_temp.player('GuiHoC');
  o uuid := pg_temp.player('GuiHoO'); x uuid := pg_temp.card('GuiHo X'); y uuid := pg_temp.card('GuiHo Y'); g uuid; k1 uuid; k2 uuid;
  wb uuid; wc uuid; h jsonb; e jsonb; t uuid; d jsonb; begin
  g := pg_temp.guild(a, array[b, c]);
  k1 := pg_temp.copy(a, x, 2);
  k2 := pg_temp.copy(a, x);
  update public.user_cards set is_shiny = true where id = k2;
  perform pg_temp.copy(b, y);
  wb := wm.guild_wish_set(b, x) -> 'wishlist' ->> 'id';
  wc := wm.guild_wish_set(c, y) -> 'wishlist' ->> 'id';
  h := wm.guild_home(a);
  assert (select array_agg(k order by k) from jsonb_object_keys(h) k)
    = array['my_wishlist', 'received_donation_today', 'weekly_karma_donors', 'wishlists'], h::text;
  assert h -> 'my_wishlist' = 'null' and h -> 'received_donation_today' = 'false' and h -> 'weekly_karma_donors' = '[]', h::text;
  -- Même created_at (now() figé) : départage par id.
  assert (select jsonb_agg(v ->> 'id') from jsonb_array_elements(h -> 'wishlists') v) = jsonb_build_array(least(wb, wc), greatest(wb, wc)),
    h::text;
  select v into e from jsonb_array_elements(h -> 'wishlists') v where v ->> 'id' = wb::text;
  assert e = (select jsonb_build_object('id', wb, 'user_id', b, 'card', jsonb_build_object('id', c.id, 'wikipedia_title', c.wikipedia_title,
        'rarity', c.rarity, 'category', c.category, 'atk', c.atk, 'def', c.def, 'image_url', c.image_url, 'hide_image', c.hide_image,
        'nsfw_image', c.nsfw_image, 'wikipedia_url', c.wikipedia_url, 'description', c.category, 'summary', c.summary),
      'created_at', w.created_at, 'can_donate', true, 'recipient_received_today', false,
      'user', jsonb_build_object('id', b, 'username', 'GuiHoB'), 'recipient', jsonb_build_object('id', b, 'username', 'GuiHoB'),
      'my_copies', jsonb_build_array(jsonb_build_object('id', least(k1, k2), 'count', case when k1 < k2 then 2 else 1 end,
        'is_shiny', k2 < k1), jsonb_build_object('id', greatest(k1, k2), 'count', case when k1 < k2 then 1 else 2 end, 'is_shiny', k2 > k1)))
    from public.cards c, public.guild_wishlists w where c.id = x and w.id = wb), e::text;
  assert jsonb_typeof(e -> 'card') = 'object' and (select count(*) from jsonb_object_keys(e -> 'card')) = 12, 'douze clés de card';
  -- A sans copie de Y : my_copies vide, can_donate faux.
  select v into e from jsonb_array_elements(h -> 'wishlists') v where v ->> 'id' = wc::text;
  assert e -> 'my_copies' = '[]' and e -> 'can_donate' = 'false' and e -> 'recipient_received_today' = 'false', e::text;
  -- my_wishlist de B : son souhait ouvert (can_donate faux pour l'auteur) ; ses wishlists, celles des autres.
  h := wm.guild_home(b);
  assert h -> 'my_wishlist' ->> 'id' = wb::text and h -> 'my_wishlist' -> 'can_donate' = 'false', h::text;
  assert (select jsonb_agg(v ->> 'id') from jsonb_array_elements(h -> 'wishlists') v) = jsonb_build_array(wc), h::text;
  -- X promise par A dans un échange en attente : my_copies vide (G6).
  insert into public.trades (initiator_id, recipient_id, expires_at) values (a, c, now() + interval '1 day') returning id into t;
  insert into public.trade_items (trade_id, offered_by, user_card_id, card_id, snapshot_rarity) values (t, a, k1, x, 'R');
  select v into e from jsonb_array_elements(wm.guild_home(a) -> 'wishlists') v where v ->> 'id' = wb::text;
  assert e -> 'my_copies' = '[]' and e -> 'can_donate' = 'false', e::text;
  delete from public.trades where id = t;
  -- Après un don à B : un nouveau souhait de B montre recipient_received_today, can_donate faux.
  perform wm.guild_donate(a, wb, k1);
  wb := wm.guild_wish_set(b, x) -> 'wishlist' ->> 'id';
  select v into e from jsonb_array_elements(wm.guild_home(a) -> 'wishlists') v where v ->> 'id' = wb::text;
  assert e -> 'recipient_received_today' = 'true' and e -> 'can_donate' = 'false' and jsonb_array_length(e -> 'my_copies') = 2, e::text;
  assert wm.guild_home(b) -> 'received_donation_today' = 'true' and wm.guild_home(a) -> 'received_donation_today' = 'false',
    'received_donation_today';
  perform wm.guild_wish_clear(b);
  assert wm.guild_home(b) -> 'my_wishlist' = 'null', 'my_wishlist nul';
  d := pg_temp.err(format('select wm.guild_home(%L)', o));
  assert d = pg_temp.e(404, null, 'Tu n''es dans aucune guilde'), coalesce(d::text, 'accepté');
  perform pg_temp.inv('entraide');
end $$;

-- Karma de la semaine (M5b-7) : dons dans cette guilde depuis week_start, karma = tous les dons, 10 au plus, égalités par username.
do $$ declare a uuid := pg_temp.player('GuiKarA'); c uuid := pg_temp.player('GuiKarC'); e uuid := pg_temp.player('GuiKarE');
  h uuid := pg_temp.player('GuiKarH'); x uuid := pg_temp.card('GuiKar X'); g uuid; g2 uuid; u uuid; i int; r jsonb; begin
  g := pg_temp.guild(a, array[c, e]);
  g2 := pg_temp.guild(h);
  perform pg_temp.gift(g, a, c, x);
  perform pg_temp.gift(g, a, e, x);
  perform pg_temp.gift(g, c, a, x);
  perform pg_temp.gift(g, e, a, x, wm.week_start(now()) - interval '1 second');
  perform pg_temp.gift(g2, a, h, x);
  r := wm.guild_home(a) -> 'weekly_karma_donors';
  assert r = jsonb_build_array(
    jsonb_build_object('user_id', a, 'username', 'GuiKarA', 'karma', 3, 'karma_this_week', 2, 'donations_this_week', 2),
    jsonb_build_object('user_id', c, 'username', 'GuiKarC', 'karma', 1, 'karma_this_week', 1, 'donations_this_week', 1)), r::text;
  -- E donne de nouveau : son don de la semaine passée compte dans karma ; égalité avec C, départage par username.
  perform pg_temp.gift(g, e, c, x);
  r := wm.guild_home(a) -> 'weekly_karma_donors';
  assert r -> 2 = jsonb_build_object('user_id', e, 'username', 'GuiKarE', 'karma', 2, 'karma_this_week', 1, 'donations_this_week', 1)
    and r -> 1 ->> 'username' = 'GuiKarC', r::text;
  -- 10 donneurs de plus : 13 en tout, 10 entrées.
  for i in 1..10 loop
    u := pg_temp.player('GuiKarP' || lpad(i::text, 2, '0'));
    insert into public.guild_members (guild_id, user_id, role) values (g, u, 'member');
    perform pg_temp.gift(g, u, a, x);
  end loop;
  r := wm.guild_home(c) -> 'weekly_karma_donors';
  assert (select jsonb_agg(v ->> 'username') from jsonb_array_elements(r) v) = '["GuiKarA", "GuiKarC", "GuiKarE", "GuiKarP01", "GuiKarP02",
    "GuiKarP03", "GuiKarP04", "GuiKarP05", "GuiKarP06", "GuiKarP07"]', r::text;
end $$;

-- Volatilité, lock_timeout avant le premier verrou, ordre des verrous (G3 : souhait, profils, guilde, copie), adhésion relue sous la
-- guilde, move_copies et guild_score_add sans lock_timeout, trade_move qui passe par move_copies.
do $$ declare v text; s text; p1 int; p2 int; p3 int; p4 int; begin
  assert (select provolatile = 's' from pg_proc where oid = 'wm.guild_home(uuid)'::regprocedure), 'guild_home stable';
  v := tests.lock_timeout_violations(array['guild_wish_set', 'guild_wish_clear', 'guild_donate'],
    array['for update', 'for no key update', 'for key share', 'wm.lock_users(', 'wm.lock_user(', 'delete from wm.guild_invites',
      'delete from public.guild_wishlists']);
  assert v is null, 'lock_timeout : ' || v;
  select prosrc into s from pg_proc where oid = to_regproc('wm.guild_donate');
  p1 := strpos(s, 'from public.guild_wishlists');
  p2 := strpos(s, 'for update');
  p3 := strpos(s, 'wm.lock_users(');
  p4 := strpos(s, 'from public.user_cards');
  assert p1 > 0 and p1 < p2 and p2 < p3 and p3 < p4, format('guild_donate : souhait, profils, copie (%s %s %s %s)', p1, p2, p3, p4);
  p1 := strpos(s, 'for key share');
  p2 := strpos(s, 'from public.guild_members where user_id = p_uid');
  assert p3 < p1 and p1 < p2 and p2 < p4, format('guild_donate : profils, guilde, adhésion relue, copie (%s %s %s %s)', p3, p1, p2, p4);
  select prosrc into s from pg_proc where oid = to_regproc('wm.guild_wish_set');
  p1 := strpos(s, 'for update');
  p2 := strpos(s, 'wm.lock_user(');
  p3 := strpos(s, 'for key share');
  p4 := strpos(s, 'from public.guild_members where user_id = p_uid and guild_id = g');
  assert p1 > 0 and p1 < p2 and p2 < p3 and p3 < p4, format('guild_wish_set : souhait, profil, guilde, adhésion relue (%s %s %s %s)',
    p1, p2, p3, p4);
  assert (select bool_and(strpos(prosrc, 'lock_timeout') = 0) and count(*) = 2 from pg_proc
    where oid in (to_regproc('wm.move_copies'), to_regproc('wm.guild_score_add'))), 'move_copies et guild_score_add sans lock_timeout';
  assert (select strpos(prosrc, 'update public.user_cards set user_id = case user_id when p_a then p_b else p_a end, starred = false where id = any (v_full)') > 0
    from pg_proc where oid = to_regproc('wm.move_copies')), 'move_copies : instruction (1)';
  assert (select strpos(prosrc, 'perform wm.move_copies(') > 0 and strpos(prosrc, 'update public.user_cards') = 0 from pg_proc
    where oid = to_regproc('wm.trade_move')), 'trade_move par move_copies';
end $$;

-- Chat de guilde (M5b-6, M5b-9, G10, D-C18) : envoi, rejeu, refus, 100 derniers, membre parti.
do $$ declare a uuid := pg_temp.player('GuiChA'); b uuid := pg_temp.player('GuiChB'); o uuid := pg_temp.player('GuiChO'); g uuid; r jsonb; d jsonb;
  c uuid := pg_temp.player('GuiChC'); first_id uuid; begin
  g := pg_temp.guild(a, array[b, c]);
  r := wm.guild_chat_send(a, 'Bonjour');
  assert (select array_agg(k order by k) from jsonb_object_keys(r -> 'message') k) = array['content', 'created_at', 'id', 'profile', 'user', 'user_id', 'username'],
    r::text;
  assert r -> 'message' ->> 'username' = 'GuiChA' and r -> 'message' ->> 'content' = 'Bonjour' and r -> 'message' ->> 'user_id' = a::text
    and r -> 'message' -> 'user' = '{"username":"GuiChA"}' and r -> 'message' -> 'profile' = '{"username":"GuiChA"}', r::text;
  d := wm.guild_chat_send(a, 'Autre', 'k-gchat');
  assert wm.guild_chat_send(a, 'Autre', 'k-gchat') = d and (select count(*) from public.guild_chat_messages where guild_id = g) = 2,
    'rejeu de la clé : ' || d::text;
  -- now() est figé dans la transaction : l'ordre de deux messages posés ensemble est celui de l'id, seul le contenu est vérifié.
  assert jsonb_array_length(wm.guild_chat_list(b) -> 'messages') = 2 and (wm.guild_chat_list(b) -> 'messages') @> jsonb_build_array(r -> 'message'),
    'liste de Bob';
  -- Refus ; contenu stocké tel quel.
  d := pg_temp.err(format('select wm.guild_chat_send(%L, %L)', a, E'  \n '));
  assert d = pg_temp.e(400, 'invalid_request', 'Le message est vide'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_chat_send(%L, null)', a));
  assert d = pg_temp.e(400, 'invalid_request', 'Le message est vide'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_chat_send(%L, %L)', a, repeat('x', 1001)));
  assert d = pg_temp.e(400, 'invalid_request', 'Un message fait au plus 1 000 caractères'), coalesce(d::text, 'accepté');
  assert wm.guild_chat_send(a, repeat('x', 1000)) -> 'message' ->> 'content' = repeat('x', 1000), '1 000 passe';
  assert wm.guild_chat_send(a, '  espaces  ') -> 'message' ->> 'content' = '  espaces  ', 'contenu tel quel';
  d := pg_temp.err(format('select wm.guild_chat_send(%L, %L)', o, 'Hello'));
  assert d = pg_temp.e(404, null, 'Tu n''es dans aucune guilde'), coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.guild_chat_list(%L)', o));
  assert d = pg_temp.e(404, null, 'Tu n''es dans aucune guilde'), coalesce(d::text, 'accepté');
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format('select wm.guild_chat_send(%L, %L)', a, 'Hello'));
  update wm.config set value = 'false' where key = 'maintenance';
  assert d = pg_temp.e(503, 'maintenance', 'Maintenance en cours, reviens dans quelques minutes.'), coalesce(d::text, 'accepté');
  -- 101 messages : les 100 derniers, du plus ancien au plus récent.
  delete from public.guild_chat_messages where guild_id = g;
  insert into public.guild_chat_messages (guild_id, user_id, content, created_at)
  select g, b, 'm' || i, now() - make_interval(secs => 200 - i) from generate_series(1, 101) i;
  r := wm.guild_chat_list(a) -> 'messages';
  assert jsonb_array_length(r) = 100 and r -> 0 ->> 'content' = 'm2' and r -> 99 ->> 'content' = 'm101'
    and not exists (select from jsonb_array_elements(r) m where m ->> 'content' = 'm1'), 'cent derniers';
  -- Le message d'un membre parti reste, avec son pseudo.
  perform wm.guild_leave(b);
  r := wm.guild_chat_list(a) -> 'messages';
  assert jsonb_array_length(r) = 100 and r -> 99 ->> 'username' = 'GuiChB', 'membre parti';
  perform pg_temp.inv('chat de guilde');
end $$;

-- Seau de rafale partagé avec les messages privés (D-C18) : un seul compteur, 3 par fenêtre ici ; la config est restaurée.
update wm.config set value = '{"count": 3, "window_s": 60}' where key = 'chat_burst';
do $$ declare a uuid := pg_temp.player('GuiBuA'); f uuid := pg_temp.player('GuiBuF'); g uuid; d jsonb; begin
  g := pg_temp.guild(a);
  perform pg_temp.friends(a, f);
  perform wm.chat_send(a, f, 'p1');
  perform wm.chat_send(a, f, 'p2');
  perform wm.chat_send(a, f, 'p3');
  d := pg_temp.err(format('select wm.guild_chat_send(%L, %L)', a, 'g1'));
  assert d ->> 'status' = '429' and d ->> 'error' = 'Le site demande de ralentir' and d ->> 'message' = 'Le site demande de ralentir'
    and (d ->> 'retry_after')::int between 1 and 60, coalesce(d::text, 'accepté');
  assert not exists (select from public.guild_chat_messages where guild_id = g), 'aucun message écrit par le 429';
  update wm.user_state set chat_window_start = chat_window_start - interval '61 seconds' where user_id = a;
  perform wm.guild_chat_send(a, 'g1');
  perform wm.guild_chat_send(a, 'g2');
  perform wm.guild_chat_send(a, 'g3');
  d := pg_temp.err(format('select wm.chat_send(%L, %L, %L)', a, f, 'p4'));
  assert d ->> 'status' = '429' and (d ->> 'retry_after')::int between 1 and 60, coalesce(d::text, 'accepté');
  update wm.user_state set chat_window_start = chat_window_start - interval '61 seconds' where user_id = a;
  perform wm.chat_send(a, f, 'p4');
  assert (select chat_window_count from wm.user_state where user_id = a) = 1, 'fenêtre échue';
end $$;
update wm.config set value = '{"count": 30, "window_s": 60}' where key = 'chat_burst';

-- Volatilité, lock_timeout avant le premier verrou, ordre des verrous (profil, guilde, adhésion relue sous la guilde).
do $$ declare v text; s text; p1 int; p2 int; p3 int; begin
  assert (select provolatile = 's' from pg_proc where oid = 'wm.guild_chat_list(uuid)'::regprocedure), 'guild_chat_list stable';
  v := tests.lock_timeout_violations(array['guild_chat_send'], array['for update', 'for no key update', 'for key share', 'wm.lock_user(']);
  assert v is null, 'lock_timeout : ' || v;
  select prosrc into s from pg_proc where oid = to_regproc('wm.guild_chat_send');
  p1 := strpos(s, 'wm.lock_user(');
  p2 := strpos(s, 'for key share');
  p3 := strpos(s, 'from public.guild_members where user_id = p_uid and guild_id = g');
  assert p1 > 0 and p1 < p2 and p2 < p3, format('guild_chat_send : profil, guilde, adhésion relue (%s %s %s)', p1, p2, p3);
end $$;
