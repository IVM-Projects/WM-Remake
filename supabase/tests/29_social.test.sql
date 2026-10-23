-- Social (1800_wm_social_core.sql, puis 1810…1850) : config, index, avatar_url, vitrine hors échange et dans trade_move ; profil, vitrine et
-- collection d'un profil privé (1810).
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

-- Clés d'un objet, triées.
create function pg_temp.keys(j jsonb) returns text[] language sql as $$ select array_agg(k order by k) from jsonb_object_keys(j) k $$;

-- Profil (M4b-5, B2) : entier pour soi, un ami ou un profil public ; réduit, sans bio, pour un tiers sur un profil privé ; friendship = la
-- ligne de la paire, quel qu'en soit le statut, null pour soi ; pseudo sans casse ; inconnu → 404.
do $$ declare a uuid := pg_temp.player('Prof1'); b uuid := pg_temp.player('Prof2'); c uuid := pg_temp.player('Prof3');
  d uuid := pg_temp.player('Prof4'); f uuid; r jsonb; begin
  update public.profiles set bio = 'Bio ' || username, is_public = username = 'Prof2' where id in (a, b, c, d);
  perform pg_temp.friends(d, a);
  r := wm.profile_get(a, 'Prof1');
  assert pg_temp.keys(r -> 'profile') = array['avatar_url', 'bio', 'created_at', 'id', 'is_public', 'username']
    and r - 'profile' = '{"isOwn":true,"isFriend":false,"friendship":null}', r::text;
  r := wm.profile_get(a, 'Prof2');
  assert r = jsonb_build_object('profile', (select jsonb_build_object('id', id, 'username', username, 'avatar_url', avatar_url, 'bio', bio,
    'is_public', is_public, 'created_at', created_at) from public.profiles where id = b), 'isOwn', false, 'isFriend', false, 'friendship', null),
    r::text;
  r := wm.profile_get(a, 'Prof3');
  assert pg_temp.keys(r -> 'profile') = array['avatar_url', 'created_at', 'id', 'is_public', 'username'] and r -> 'profile' -> 'is_public' = 'false'
    and r - 'profile' = '{"isOwn":false,"isFriend":false,"friendship":null}', r::text;
  r := wm.profile_get(a, 'Prof4');
  assert r -> 'profile' ->> 'bio' = 'Bio Prof4' and r -> 'isFriend' = 'true' and r -> 'friendship'
    = (select jsonb_build_object('id', id, 'status', 'accepted', 'requester_id', d) from public.friendships where requester_id = d and addressee_id = a),
    r::text;
  insert into public.friendships (requester_id, addressee_id) values (a, c) returning id into f;
  r := wm.profile_get(a, 'Prof3');
  assert r -> 'friendship' = jsonb_build_object('id', f, 'status', 'pending', 'requester_id', a) and r -> 'isFriend' = 'false'
    and not r -> 'profile' ? 'bio', r::text;
  assert wm.profile_get(a, 'PROF2') = wm.profile_get(a, 'Prof2'), 'pseudo en majuscules';
  r := pg_temp.err(format('select wm.profile_get(%L, %L)', a, 'Personne'));
  assert r = '{"status":404,"error":"Joueur introuvable","message":"Joueur introuvable"}', coalesce(r::text, 'accepté');
end $$;

-- profile_update (M4b-6, M4b-8) : bio de 280 caractères au plus, '' l'efface ; visibilité ; avatar d'une copie du joueur à image utilisable,
-- retiré par un id nul, avatar_url compris, même sur un profil migré ; le profil d'un autre → 403 ; réponse de profile_get, rejouée par sa clé.
do $$ declare a uuid := pg_temp.player('Edit1'); b uuid := pg_temp.player('Edit2');
  a1 uuid := pg_temp.copy(a, tests.image_card('Edit A1')); b1 uuid := pg_temp.copy(b, tests.image_card('Edit B1'));
  bare uuid := pg_temp.copy(a, pg_temp.card('Edit sans image')); hidden uuid := pg_temp.copy(a, tests.image_card('Edit cachée'));
  nsfw uuid := pg_temp.copy(a, tests.image_card('Edit sensible'));
  q text := 'select wm.profile_update(%L, %L, p_avatar_user_card_id => %L, p_avatar_set => true)'; r jsonb; d jsonb;
  no_image jsonb := '{"status":400,"code":"invalid_request","error":"Cette carte n''a pas d''image utilisable en avatar",
    "message":"Cette carte n''a pas d''image utilisable en avatar"}';
  begin
  update public.cards set hide_image = true where id = (select card_id from public.user_cards where id = hidden);
  update public.cards set nsfw_image = true where id = (select card_id from public.user_cards where id = nsfw);
  assert wm.profile_update(a, 'Edit1', p_bio => repeat('é', 280)) -> 'profile' ->> 'bio' = repeat('é', 280), 'bio de 280 caractères';
  d := pg_temp.err(format('select wm.profile_update(%L, %L, p_bio => %L)', a, 'Edit1', repeat('é', 281)));
  assert d = '{"status":400,"code":"invalid_request","error":"La bio fait au plus 280 caractères","message":"La bio fait au plus 280 caractères"}',
    coalesce(d::text, 'accepté');
  r := wm.profile_update(a, 'Edit1', p_bio => '');
  assert r -> 'profile' -> 'bio' = 'null' and (select bio is null from public.profiles where id = a), r::text;
  r := wm.profile_update(a, 'Edit1', p_is_public => false);
  assert r -> 'profile' -> 'is_public' = 'false' and r -> 'profile' -> 'bio' = 'null', r::text;
  r := wm.profile_update(a, 'Edit1', p_bio => 'x');
  assert r -> 'profile' ->> 'bio' = 'x' and r -> 'profile' -> 'is_public' = 'false', r::text;
  r := wm.profile_update(a, 'Edit1', p_avatar_user_card_id => a1, p_avatar_set => true);
  assert r -> 'profile' ->> 'avatar_url' = (select k.image_url from public.cards k join public.user_cards uc on uc.card_id = k.id where uc.id = a1)
    and (select avatar_user_card_id = a1 from public.profiles where id = a), r::text;
  d := pg_temp.err(format(q, a, 'Edit1', b1));
  assert d = '{"status":403,"code":"42501","error":"Vous ne possédez pas cette carte","message":"Vous ne possédez pas cette carte"}',
    coalesce(d::text, 'accepté');
  assert pg_temp.err(format(q, a, 'Edit1', bare)) = no_image, 'carte sans image';
  assert pg_temp.err(format(q, a, 'Edit1', hidden)) = no_image, 'image masquée';
  d := pg_temp.err(format(q, a, 'Edit1', nsfw));
  assert d = '{"status":400,"code":"invalid_request","error":"Une image sensible ne peut pas servir d''avatar",
    "message":"Une image sensible ne peut pas servir d''avatar"}', coalesce(d::text, 'accepté');
  assert (select avatar_user_card_id = a1 from public.profiles where id = a), 'avatar changé par un refus';
  r := wm.profile_update(a, 'Edit1', p_avatar_set => true);
  assert r -> 'profile' -> 'avatar_url' = 'null' and (select avatar_user_card_id is null from public.profiles where id = a), r::text;
  -- Profil migré (avatar_url sans copie, M4b-6) : une autre écriture le garde (clause when du trigger), un retrait l'efface.
  update public.profiles set avatar_url = 'legacy' where id = a;
  assert wm.profile_update(a, 'Edit1', p_bio => 'y') -> 'profile' ->> 'avatar_url' = 'legacy', 'profil migré : avatar_url perdu';
  assert wm.profile_update(a, 'Edit1', p_avatar_set => true) -> 'profile' -> 'avatar_url' = 'null', 'profil migré : retrait';
  d := pg_temp.err(format('select wm.profile_update(%L, %L, p_bio => %L)', a, 'Edit2', 'z'));
  assert d = '{"status":403,"code":"FORBIDDEN","error":"Tu ne peux modifier que ton profil","message":"Tu ne peux modifier que ton profil"}',
    coalesce(d::text, 'accepté');
  assert (select bio is null from public.profiles where id = b), 'profil d''un autre modifié';
  d := pg_temp.err(format('select wm.profile_update(%L, %L, p_bio => %L)', a, 'Personne', 'z'));
  assert d = '{"status":404,"error":"Joueur introuvable","message":"Joueur introuvable"}', coalesce(d::text, 'accepté');
  r := wm.profile_update(a, 'Edit1', p_bio => 'z');
  assert r = wm.profile_get(a, 'Edit1') and r -> 'profile' ->> 'bio' = 'z', 'réponse de profile_get';
  r := wm.profile_update(a, 'Edit1', p_bio => 'k1', p_idem => 'k-prof');
  assert wm.profile_update(a, 'Edit1', p_bio => 'k2', p_idem => 'k-prof') = r and r -> 'profile' ->> 'bio' = 'k1'
    and (select bio = 'k1' from public.profiles where id = a), 'rejeu de la clé';
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format('select wm.profile_update(%L, %L, p_bio => %L)', a, 'Edit1', 'm'));
  update wm.config set value = 'false' where key = 'maintenance';
  assert d = '{"status":503,"code":"maintenance","error":"Maintenance en cours, reviens dans quelques minutes.",
    "message":"Maintenance en cours, reviens dans quelques minutes."}', coalesce(d::text, 'accepté');
end $$;

-- profile_collection (P21 c) : un profil privé s'ouvre à ses amis, pas aux autres.
do $$ declare a uuid := pg_temp.player('CollPriv1'); b uuid := pg_temp.player('CollPriv2'); c uuid := pg_temp.player('CollPriv3'); r jsonb;
  d jsonb; begin
  perform pg_temp.copy(a, pg_temp.card('CollPriv X'));
  update public.profiles set is_public = false where id = a;
  perform pg_temp.friends(a, b);
  r := wm.profile_collection(b, 'CollPriv1');
  assert pg_temp.keys(r) = array['collection', 'total'] and r -> 'total' = '1' and jsonb_array_length(r -> 'collection') = 1, r::text;
  d := pg_temp.err(format('select wm.profile_collection(%L, %L)', c, 'CollPriv1'));
  assert d = '{"status":403,"code":"FORBIDDEN","error":"Ce profil est privé","message":"Ce profil est privé"}', coalesce(d::text, 'accepté');
end $$;

-- Emplacement attendu (B2) : la copie sous la forme des éléments de profile_collection, son card étant celui de my_collection.
create function pg_temp.slot(p_uid uuid, p_pos int, p_id uuid) returns jsonb language sql as $$
  select jsonb_build_object('position', p_pos, 'user_card_id', p_id, 'user_card', jsonb_build_object('id', x -> 'id', 'card', x -> 'card',
    'count', x -> 'count', 'is_shiny', x -> 'is_shiny', 'snapshot_rarity', x -> 'snapshot_rarity'))
  from jsonb_array_elements(wm.my_collection(p_uid) -> 'collection') x where x ->> 'id' = p_id::text
$$;

-- Vitrine (M4b-7, M4b-8) : PUT et DELETE rendent my_showcase, emplacements triés ; 0 à 3 ; la copie d'un autre → 403, la même copie à un
-- autre emplacement → 400, un emplacement occupé remplacé, un emplacement vide retiré sans erreur ; rejeu par la clé. profile_showcase :
-- profil privé ouvert à soi et à ses amis (M4b-5).
do $$ declare a uuid := pg_temp.player('Vit1'); b uuid := pg_temp.player('Vit2'); c uuid := pg_temp.player('Vit3');
  a1 uuid := pg_temp.copy(a, tests.image_card('Vit A1')); a2 uuid := pg_temp.copy(a, pg_temp.card('Vit A2'), 2);
  a3 uuid := pg_temp.copy(a, pg_temp.card('Vit A3')); a4 uuid := pg_temp.copy(a, pg_temp.card('Vit A4')); b1 uuid := pg_temp.copy(b, pg_temp.card('Vit B1'));
  put text := 'select wm.showcase_put(%L, %s, %L)'; r jsonb; d jsonb; v jsonb;
  pos jsonb := '{"status":400,"code":"invalid_request","error":"Emplacement de vitrine inconnu (0 à 3)","message":"Emplacement de vitrine inconnu (0 à 3)"}';
  private jsonb := '{"status":403,"code":"FORBIDDEN","error":"Ce profil est privé","message":"Ce profil est privé"}';
  begin
  r := wm.showcase_put(a, 0, a1);
  assert r = jsonb_build_object('showcase', jsonb_build_array(pg_temp.slot(a, 0, a1)), 'galleries', '[]'::jsonb), r::text;
  assert pg_temp.keys(r -> 'showcase' -> 0 -> 'user_card') = array['card', 'count', 'id', 'is_shiny', 'snapshot_rarity']
    and pg_temp.keys(r -> 'showcase' -> 0 -> 'user_card' -> 'card') = pg_temp.keys(wm.my_collection(a) -> 'collection' -> 0 -> 'card'), r::text;
  assert pg_temp.err(format(put, a, -1, a2)) = pos and pg_temp.err(format(put, a, 4, a2)) = pos, 'emplacement hors de 0 à 3';
  d := pg_temp.err(format(put, a, 1, b1));
  assert d = '{"status":403,"code":"42501","error":"Vous ne possédez pas cette carte","message":"Vous ne possédez pas cette carte"}',
    coalesce(d::text, 'accepté');
  d := pg_temp.err(format(put, a, 1, a1));
  assert d = '{"status":400,"code":"invalid_request","error":"Cette carte est déjà dans ta vitrine","message":"Cette carte est déjà dans ta vitrine"}',
    coalesce(d::text, 'accepté');
  assert wm.showcase_put(a, 0, a1) = r, 'même copie au même emplacement';
  assert wm.showcase_put(a, 0, a2) -> 'showcase' = jsonb_build_array(pg_temp.slot(a, 0, a2)), 'emplacement occupé non remplacé';
  perform wm.showcase_put(a, 3, a3);
  perform wm.showcase_put(a, 1, a1);
  r := wm.showcase_put(a, 2, a4);
  v := jsonb_build_object('showcase', jsonb_build_array(pg_temp.slot(a, 0, a2), pg_temp.slot(a, 1, a1), pg_temp.slot(a, 2, a4), pg_temp.slot(a, 3, a3)));
  assert r = v || '{"galleries":[]}', r::text;
  r := wm.showcase_delete(a, 2);
  assert r = jsonb_build_object('showcase', jsonb_build_array(pg_temp.slot(a, 0, a2), pg_temp.slot(a, 1, a1), pg_temp.slot(a, 3, a3)),
    'galleries', '[]'::jsonb), r::text;
  assert wm.showcase_delete(a, 2) = r, 'emplacement vide';
  assert pg_temp.err(format('select wm.showcase_delete(%L, 9)', a)) = pos, 'retrait hors de 0 à 3';
  -- Rejeu : la réponse stockée, sans rien refaire (la copie de B serait refusée, l'emplacement remis serait retiré).
  r := wm.showcase_put(a, 2, a4, 'k-put');
  assert r = v || '{"galleries":[]}' and wm.showcase_put(a, 2, b1, 'k-put') = r, 'rejeu du PUT';
  r := wm.showcase_delete(a, 2, 'k-del');
  perform wm.showcase_put(a, 2, a4);
  assert wm.showcase_delete(a, 2, 'k-del') = r and wm.my_showcase(a) = v || '{"galleries":[]}', 'rejeu du DELETE';
  assert wm.profile_showcase(c, 'Vit1') = v, 'profil public';
  update public.profiles set is_public = false where id = a;
  perform pg_temp.friends(a, b);
  assert pg_temp.err(format('select wm.profile_showcase(%L, %L)', c, 'Vit1')) = private, 'profil privé lu par un tiers';
  assert wm.profile_showcase(b, 'VIT1') = v and wm.profile_showcase(a, 'Vit1') = v, 'profil privé lu par un ami ou par soi';
  d := pg_temp.err(format('select wm.profile_showcase(%L, %L)', b, 'Personne'));
  assert d = '{"status":404,"error":"Joueur introuvable","message":"Joueur introuvable"}', coalesce(d::text, 'accepté');
end $$;

-- Volatilité des lectures (1810) : un create or replace sans le mot-clé repasserait en volatile. lock_timeout (P5, M4b-2) avant le premier
-- verrou, et la copie relue sous le verrou du profil ; chaque tâche ajoute ses fonctions.
do $$ declare bad text; begin
  assert (select jsonb_object_agg(proname, provolatile::text) from pg_proc where pronamespace = 'wm'::regnamespace
    and proname in ('profile_json', 'profile_get', 'showcase_json', 'my_showcase', 'profile_showcase'))
    = '{"profile_json":"s","profile_get":"s","showcase_json":"s","my_showcase":"s","profile_showcase":"s"}', 'volatilité des lectures';
  bad := tests.lock_timeout_violations(array['profile_update', 'showcase_put', 'showcase_delete']);
  assert bad is null, 'lock_timeout absent ou posé après un verrou : ' || bad;
  select string_agg(f, ', ') into bad from unnest(array['profile_update', 'showcase_put']) f,
    lateral (select prosrc s from pg_proc where oid = to_regproc('wm.' || f)) p
  where not strpos(s, 'wm.lock_user(') between 1 and strpos(s, 'public.user_cards');
  assert bad is null, 'copie lue avant wm.lock_user : ' || bad;
end $$;
