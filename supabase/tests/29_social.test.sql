-- Social (1800_wm_social_core.sql, puis 1810…1850) : config, index, avatar_url, vitrine hors échange et dans trade_move.
-- Une seule transaction pour tout le fichier (now() figé) : chaque bloc crée ses joueurs et ses cartes, et ne filtre que sur eux.

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

-- p_items de create_trade : un élément par entrée de p_copies (répétée pour plusieurs unités), offert par p_by, au card_id de la copie.
create function pg_temp.items(p_by uuid, p_copies uuid[]) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_card_id', x, 'card_id', (select card_id from public.user_cards where id = x),
    'offered_by', p_by) order by o), '[]')
  from unnest(p_copies) with ordinality u (x, o)
$$;

-- Config du M4b (M4b-3, M4b-12, M4b-13, M4b-17, M4b-20, B3), chaque clé avec sa note.
create function pg_temp.social_config() returns jsonb language sql as $$
  select jsonb_object_agg(key, value) from wm.config
  where key in ('chat_burst', 'push_origins', 'push_max_subscriptions', 'push_types', 'push_wake_url', 'list_caps')
$$;

do $$ begin
  assert pg_temp.social_config() - 'list_caps' = '{"chat_burst":{"count":30,"window_s":60},
    "push_origins":{"origins":["https://fcm.googleapis.com","https://updates.push.services.mozilla.com","https://web.push.apple.com"],
      "suffixes":[".notify.windows.com"]},
    "push_max_subscriptions":10,
    "push_types":["auction_outbid","auction_sold","auction_unsold","auction_won","chat_message","friend_accepted","friend_request",
      "trade_accepted","trade_cancelled","trade_countered","trade_declined","trade_received","wishlist_listed"],
    "push_wake_url":null}'::jsonb, pg_temp.social_config()::text;
  assert pg_temp.social_config() -> 'list_caps'
    = '{"conversations":50,"friend_owners":3,"friend_search":20,"messages":100,"notifications":50,"trades_closed":200}', 'list_caps';
  assert not exists (select from wm.config where key in ('chat_burst', 'push_origins', 'push_max_subscriptions', 'push_types', 'push_wake_url',
    'list_caps') and coalesce(note, '') = ''), 'note manquante';
end $$;

-- Rejeu de 1800 (B3) : mêmes valeurs, et un plafond déjà posé garde sa valeur.
create temp table social_config as select pg_temp.social_config() v;
update wm.config set value = value || '{"messages": 7}' where key = 'list_caps';
\ir ../migrations/1800_wm_social_core.sql
do $$ begin
  assert pg_temp.social_config() = jsonb_set((select v from social_config), '{list_caps,messages}', '7'), pg_temp.social_config()::text;
end $$;
update wm.config set value = value || '{"messages": 100}' where key = 'list_caps';

-- Index des fils (M4b-9), de la vitrine (M4b-7), des abonnements et des signalements, définition complète.
do $$ declare bad text; begin
  select string_agg(v.n, ', ') into bad from (values
    ('chat_messages_pair_idx', 'public.chat_messages USING btree (sender_id, recipient_id, created_at DESC)'),
    ('chat_messages_recipient_pair_idx', 'public.chat_messages USING btree (recipient_id, sender_id, created_at DESC)'),
    ('chat_messages_unread_idx', 'public.chat_messages USING btree (recipient_id) WHERE (NOT read)'),
    ('showcase_user_card_idx', 'public.showcase USING btree (user_card_id)'),
    ('push_subscriptions_user_idx', 'public.push_subscriptions USING btree (user_id)'),
    ('reports_reported_idx', 'public.reports USING btree (reported_user_id)')) v (n, def)
  where not exists (select from pg_indexes i where i.indexname = v.n and i.indexdef = format('CREATE INDEX %s ON %s', v.n, v.def));
  assert bad is null, 'index absents ou différents : ' || bad;
end $$;

-- Avatar (M4b-6) : l'id qui passe d'une copie à null, par la clé étrangère ou par une écriture, efface avatar_url ; une autre colonne écrite,
-- ou un profil migré sans copie, le garde.
do $$ declare a uuid := pg_temp.player('Avatar1'); a1 uuid := pg_temp.copy(a, tests.image_card('Avatar A1'));
  a2 uuid := pg_temp.copy(a, tests.image_card('Avatar A2')); a3 uuid := pg_temp.copy(a, tests.image_card('Avatar A3')); begin
  update public.profiles set avatar_user_card_id = a1, avatar_url = 'u1' where id = a;
  delete from public.user_cards where id = a1;
  assert (select avatar_user_card_id is null and avatar_url is null from public.profiles where id = a), 'copie supprimée';
  update public.profiles set avatar_user_card_id = a2, avatar_url = 'u2' where id = a;
  update public.profiles set avatar_user_card_id = null where id = a;
  assert (select avatar_url is null from public.profiles where id = a), 'avatar retiré';
  update public.profiles set avatar_user_card_id = a3, avatar_url = 'u3' where id = a;
  update public.profiles set bio = 'x' where id = a;
  assert (select avatar_user_card_id = a3 and avatar_url = 'u3' from public.profiles where id = a), 'autre colonne écrite';
  update public.profiles set avatar_user_card_id = null where id = a;
  update public.profiles set avatar_url = 'legacy' where id = a;
  update public.profiles set avatar_user_card_id = null where id = a;
  assert (select avatar_url = 'legacy' from public.profiles where id = a), 'profil migré';
end $$;

-- Vitrine, sorties autres que l'échange (D:436) : une copie qui quitte la collection quitte la vitrine (cascade), une pile entamée garde
-- son emplacement ; la mise en vente emporte aussi l'avatar et son avatar_url.
do $$ declare a uuid := pg_temp.player('Vitrine1'); s1 uuid := pg_temp.copy(a, pg_temp.card('Vitrine S1'));
  s2 uuid := pg_temp.copy(a, pg_temp.card('Vitrine S2'), 2); s3 uuid := pg_temp.copy(a, pg_temp.card('Vitrine S3')); begin
  insert into public.showcase (user_id, position, user_card_id) values (a, 0, s1), (a, 1, s2), (a, 2, s3);
  update public.profiles set avatar_user_card_id = s3, avatar_url = 'u-s3' where id = a;
  perform wm.discard(a, s1);
  assert not exists (select from public.showcase where user_id = a and position = 0), 'copie seule défaussée encore en vitrine';
  perform wm.discard(a, s2);
  assert (select uc.count from public.showcase s join public.user_cards uc on uc.id = s.user_card_id
    where s.user_id = a and s.position = 1 and s.user_card_id = s2) = 1, 'pile entamée sortie de la vitrine';
  perform wm.create_auction(a, s3, 10, 60);
  assert not exists (select from public.showcase where user_id = a and position = 2), 'copie en vente encore en vitrine';
  assert (select avatar_user_card_id is null and avatar_url is null from public.profiles where id = a), 'avatar d''une copie en vente';
  perform pg_temp.inv('vitrine hors échange');
end $$;

-- trade_move (M4b-7) : une copie déplacée en entier quitte la vitrine, une pile donnée en partie garde son emplacement ; l'avatar donné
-- perd son avatar_url (M4b-6). Personne n'est abonné : aucune ligne d'outbox.
do $$ declare a uuid := pg_temp.player('VitEch1'); b uuid := pg_temp.player('VitEch2');
  a1 uuid := pg_temp.copy(a, pg_temp.card('VitEch A1')); a2 uuid := pg_temp.copy(a, pg_temp.card('VitEch A2'), 3);
  b1 uuid := pg_temp.copy(b, pg_temp.card('VitEch B1')); t uuid; s jsonb; begin
  perform pg_temp.friends(a, b);
  insert into public.showcase (user_id, position, user_card_id) values (a, 0, a1), (a, 1, a2), (b, 2, b1);
  update public.profiles set avatar_user_card_id = a1, avatar_url = 'u-a1' where id = a;
  t := wm.create_trade(a, b, pg_temp.items(a, array[a1, a2, a2]) || pg_temp.items(b, array[b1])) ->> 'id';
  assert wm.trade_action(b, t, 'accept') ->> 'status' = 'accepted', 'acceptation';
  s := tests.trade_snapshot(t);
  assert s ?& array['showcase', 'push_outbox'] and s -> 'showcase' = jsonb_build_array(jsonb_build_array(a, 1, a2))
    and s -> 'push_outbox' = '0', s::text;
  assert (select avatar_user_card_id is null and avatar_url is null from public.profiles where id = a), 'avatar donné';
  perform pg_temp.inv('trade_move');
end $$;

-- Erreur injectée (M4-7 A, D:1083) après les déplacements (grand livre) : vitrine et avatar_url reviennent avec le reste ; sans le trigger,
-- la même clé → accepted, vitrine vide et avatar effacé. WB des deux côtés : sans eux, aucune ligne de grand livre, donc aucune faute.
do $$ declare a uuid := pg_temp.player('VitFaute1', 1000); b uuid := pg_temp.player('VitFaute2', 1000);
  a1 uuid := pg_temp.copy(a, pg_temp.card('VitFaute A1')); b1 uuid := pg_temp.copy(b, pg_temp.card('VitFaute B1')); t uuid; s jsonb; r jsonb;
  begin
  perform pg_temp.friends(a, b);
  insert into public.showcase (user_id, position, user_card_id) values (a, 0, a1), (b, 2, b1);
  update public.profiles set avatar_user_card_id = a1, avatar_url = 'u-vit' where id = a;
  t := wm.create_trade(a, b, pg_temp.items(a, array[a1]) || pg_temp.items(b, array[b1]), 300, 500) ->> 'id';
  s := tests.trade_snapshot(t);
  assert jsonb_array_length(s -> 'showcase') = 2, s::text;
  execute format('create trigger zz_boom after insert on wm.wb_ledger for each row when (new.ref = %L) execute function tests.boom()', 'trade:' || t);
  begin
    perform wm.trade_action(b, t, 'accept', null, 'k-vit');
    assert false, 'faute non levée';
  exception when sqlstate 'XX000' then
    assert sqlerrm = 'erreur injectée', sqlerrm;
  end;
  assert tests.trade_snapshot(t) = s, tests.trade_snapshot(t)::text;
  drop trigger zz_boom on wm.wb_ledger;
  assert wm.trade_action(b, t, 'accept', null, 'k-vit') ->> 'status' = 'accepted', 'même clé sans trigger';
  r := tests.trade_snapshot(t);
  assert r -> 'showcase' = '[]' and (select p -> 'avatar_user_card_id' = 'null' and p -> 'avatar_url' = 'null'
    from jsonb_array_elements(r -> 'profiles') p where p ->> 'id' = a::text), r::text;
end $$;
