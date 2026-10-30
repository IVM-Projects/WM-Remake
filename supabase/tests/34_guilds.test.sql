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

-- Rejeu de 2000 : mêmes valeurs, et une valeur déjà posée garde la sienne.
create temp table progress_config as select pg_temp.progress_config() v;
update wm.config set value = value || '{"max_members": 5}' where key = 'guild';
\ir ../migrations/2000_wm_progress_core.sql
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
