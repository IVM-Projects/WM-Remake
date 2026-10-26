-- Social (1800_wm_social_core.sql, puis 1810…1860) : config, index, avatar_url, vitrine hors échange et dans trade_move ; profil, vitrine et
-- collection d'un profil privé (1810) ; messages privés, débit, notification chat_message et synchronisation « lu » (1820) ; signalements (1830) ;
-- friendOwners de l'overlay du catalogue (1850) ; chat_message non lue de plus de 10 minutes remplacée à l'envoi (1860).
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
    = '{"battles_closed":50,"conversations":50,"friend_owners":3,"friend_search":20,"messages":100,"notifications":50,"trades_closed":200}', 'list_caps';
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

-- Envoi (M4b-2, M4b-4, M4b-8, B2) : {message} aux six clés du B2, non lu ; une seule chat_message non lue par couple, de data exactement
-- {user_id, username} de l'expéditeur ; lue, l'envoi suivant en pose une neuve. Refus : non-ami 403, soi-même 400, pair inconnu 404,
-- maintenance 503, sans aucun message.
do $$ declare a uuid := pg_temp.player('Chat1'); b uuid := pg_temp.player('Chat2'); carol uuid := pg_temp.player('Chat3');
  q text := 'select wm.chat_send(%L, %L, %L)'; r jsonb; d jsonb; begin
  perform pg_temp.friends(a, b);
  r := wm.chat_send(a, b, 'Salut');
  assert pg_temp.keys(r) = array['message']
    and pg_temp.keys(r -> 'message') = array['content', 'created_at', 'id', 'read', 'recipient_id', 'sender_id']
    and r -> 'message' = (select to_jsonb(m) from public.chat_messages m where m.sender_id = a)
    and r -> 'message' @> jsonb_build_object('sender_id', a, 'recipient_id', b, 'content', 'Salut', 'read', false), r::text;
  assert (select jsonb_agg(data) from public.notifications where user_id = b and type = 'chat_message' and not read)
    = jsonb_build_array(jsonb_build_object('user_id', a, 'username', 'Chat1')), 'notification du premier envoi';
  perform wm.chat_send(a, b, 'Encore');
  assert (select count(*) from public.notifications where user_id = b and type = 'chat_message') = 1, 'second envoi : seconde notification';
  perform wm.notifications_read(b);
  perform wm.chat_send(a, b, 'Trois');
  assert (select array_agg(read order by read) from public.notifications where user_id = b and type = 'chat_message') = array[false, true],
    'envoi après lecture';
  d := pg_temp.err(format(q, a, carol, 'x'));
  assert d = '{"status":403,"code":"FORBIDDEN","error":"Vous devez être amis pour vous écrire","message":"Vous devez être amis pour vous écrire"}',
    coalesce(d::text, 'accepté');
  d := pg_temp.err(format(q, a, a, 'x'));
  assert d = '{"status":400,"code":"invalid_request","error":"Tu ne peux pas t''écrire à toi-même","message":"Tu ne peux pas t''écrire à toi-même"}',
    coalesce(d::text, 'accepté');
  d := pg_temp.err(format(q, a, gen_random_uuid(), 'x'));
  assert d = '{"status":404,"error":"Joueur introuvable","message":"Joueur introuvable"}', coalesce(d::text, 'accepté');
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format(q, a, b, 'x'));
  update wm.config set value = 'false' where key = 'maintenance';
  assert d = '{"status":503,"code":"maintenance","error":"Maintenance en cours, reviens dans quelques minutes.",
    "message":"Maintenance en cours, reviens dans quelques minutes."}', coalesce(d::text, 'accepté');
  assert (select count(*) from public.chat_messages where sender_id = a) = 3, 'message écrit par un refus';
end $$;

-- Non lue ancienne (M4b-4 amendé, 1860) : deux envois de suite → une seule non lue, même id ; vieillie de 11 minutes, l'envoi suivant la
-- remplace (toujours une seule non lue du couple, id neuf, created_at = now()) ; à 9 minutes, rien n'est remplacé ; la non lue d'un autre
-- expéditeur, vieillie elle aussi, n'est jamais touchée.
do $$ declare a uuid := pg_temp.player('Renot1'); b uuid := pg_temp.player('Renot2'); carol uuid := pg_temp.player('Renot3');
  n uuid; o uuid; v uuid[]; t timestamptz; begin
  perform pg_temp.friends(a, b);
  perform pg_temp.friends(carol, b);
  perform wm.chat_send(carol, b, 'ailleurs');
  o := (select id from public.notifications where user_id = b and type = 'chat_message' and data ->> 'user_id' = carol::text);
  update public.notifications set created_at = now() - interval '11 minutes' where id = o;
  perform wm.chat_send(a, b, 'un');
  n := (select id from public.notifications where user_id = b and type = 'chat_message' and not read and data ->> 'user_id' = a::text);
  perform wm.chat_send(a, b, 'deux');
  assert (select array_agg(id) from public.notifications where user_id = b and type = 'chat_message' and not read
    and data ->> 'user_id' = a::text) = array[n], 'deux envois de suite';
  update public.notifications set created_at = now() - interval '11 minutes' where id = n;
  perform wm.chat_send(a, b, 'trois');
  select array_agg(id), max(created_at) into v, t from public.notifications where user_id = b and type = 'chat_message' and not read
    and data ->> 'user_id' = a::text;
  assert cardinality(v) = 1 and v[1] <> n and t = now(), 'non lue de 11 minutes : ' || coalesce(v::text, 'aucune');
  update public.notifications set created_at = now() - interval '9 minutes' where id = v[1];
  perform wm.chat_send(a, b, 'quatre');
  assert (select array_agg(id) from public.notifications where user_id = b and type = 'chat_message' and not read
    and data ->> 'user_id' = a::text) = v, 'non lue de 9 minutes remplacée';
  assert (select array_agg(id) from public.notifications where user_id = b and type = 'chat_message' and not read
    and data ->> 'user_id' = carol::text and created_at = now() - interval '11 minutes') = array[o], 'non lue d''un autre expéditeur';
end $$;

-- Contenu aux bornes (Review Focus) : blancs seuls ou rien → 400 ; 2 000 émojis (points de code) passent, 2 001 é → 400 ; stocké tel quel.
do $$ declare a uuid := pg_temp.player('Contenu1'); b uuid := pg_temp.player('Contenu2'); q text := 'select wm.chat_send(%L, %L, %L)';
  empty jsonb := '{"status":400,"code":"invalid_request","error":"Le message est vide","message":"Le message est vide"}'; r jsonb; d jsonb; begin
  perform pg_temp.friends(a, b);
  d := pg_temp.err(format(q, a, b, E'  \n\t '));
  assert d = empty, coalesce(d::text, 'accepté');
  assert pg_temp.err(format(q, a, b, null)) = empty, 'contenu nul';
  r := wm.chat_send(a, b, repeat('😀', 2000));
  assert r -> 'message' ->> 'content' = repeat('😀', 2000), '2 000 émojis';
  d := pg_temp.err(format(q, a, b, repeat('é', 2001)));
  assert d = '{"status":400,"code":"invalid_request","error":"Un message fait au plus 2 000 caractères",
    "message":"Un message fait au plus 2 000 caractères"}', coalesce(d::text, 'accepté');
  r := wm.chat_send(a, b, '  hé  ');
  assert r -> 'message' ->> 'content' = '  hé  ' and (select content from public.chat_messages where id = (r -> 'message' ->> 'id')::uuid) = '  hé  ',
    r::text;
end $$;

-- Débit aux bornes (M4b-3, M4b-29, Review Focus) : chat_burst à 3 le temps du bloc (PF7). Compté par expéditeur, tous pairs confondus ;
-- un refus ou un rejeu ne compte pas ; le 4ᵉ → 429 (now() figé : retry_after = 60), sans message ; une fenêtre posée par une transaction
-- plus tardive (début après now()) donne encore un retry_after de 1 à 60 ; une fenêtre échue repart à 1.
update wm.config set value = '{"count": 3, "window_s": 60}' where key = 'chat_burst';
do $$ declare a uuid := pg_temp.player('Debit1'); b uuid := pg_temp.player('Debit2'); c uuid := pg_temp.player('Debit3');
  carol uuid := pg_temp.player('Debit4'); q text := 'select wm.chat_send(%L, %L, %L)'; r jsonb; d jsonb; begin
  perform pg_temp.friends(a, b);
  perform pg_temp.friends(c, a);
  perform wm.chat_send(a, b, 'd1');
  perform wm.chat_send(a, b, 'd2');
  assert pg_temp.err(format(q, a, b, ' ')) ->> 'status' = '400' and pg_temp.err(format(q, a, carol, 'x')) ->> 'status' = '403', 'refus';
  assert (select chat_window_count from wm.user_state where user_id = a) = 2, 'refus comptés';
  r := wm.chat_send(a, c, 'd3', 'k-chat');
  d := pg_temp.err(format(q, a, b, 'd4'));
  assert d = '{"status":429,"error":"Le site demande de ralentir","message":"Le site demande de ralentir","retry_after":60}',
    coalesce(d::text, 'accepté');
  assert (select count(*) from public.chat_messages where sender_id = a) = 3, 'message écrit par le 429';
  update wm.user_state set chat_window_start = now() + interval '0.5 seconds' where user_id = a;
  d := pg_temp.err(format(q, a, b, 'd4'));
  assert (d ->> 'retry_after')::int between 1 and 60, 'fenêtre posée plus tard : ' || coalesce(d::text, 'accepté');
  update wm.user_state set chat_window_start = now() where user_id = a;
  assert wm.chat_send(a, c, 'autre', 'k-chat') = r and (select count(*) from public.chat_messages where sender_id = a) = 3
    and (select chat_window_count from wm.user_state where user_id = a) = 3, 'rejeu de la clé';
  update wm.user_state set chat_window_start = chat_window_start - interval '61 seconds' where user_id = a;
  perform wm.chat_send(a, b, 'd5');
  assert (select chat_window_count from wm.user_state where user_id = a) = 1
    and (select count(*) from public.chat_messages where sender_id = a) = 4, 'fenêtre échue';
end $$;
update wm.config set value = '{"count": 30, "window_s": 60}' where key = 'chat_burst';

-- Fil (M4b-9, B2) : les 100 plus récents du couple, en ordre croissant, sans ceux d'un autre couple ; peer et isFriend ; un ancien ami garde
-- l'historique ; un tiers lit un fil vide ; soi-même → 400, pair inconnu → 404.
do $$ declare a uuid := pg_temp.player('Fil1'); b uuid := pg_temp.player('Fil2'); carol uuid := pg_temp.player('Fil3'); r jsonb; d jsonb;
  want jsonb; begin
  perform pg_temp.friends(a, b);
  insert into public.chat_messages (sender_id, recipient_id, content, created_at)
  select case i % 2 when 0 then a else b end, case i % 2 when 0 then b else a end, 'f' || i, now() - make_interval(secs => 200 - i)
  from generate_series(1, 105) i;
  insert into public.chat_messages (sender_id, recipient_id, content) values (carol, b, 'ailleurs');
  want := (select jsonb_agg(to_jsonb(m) order by m.created_at) from public.chat_messages m
    where m.content in (select 'f' || i from generate_series(6, 105) i) and m.sender_id in (a, b));
  r := wm.chat_thread(b, a);
  assert r = jsonb_build_object('messages', want, 'peer', jsonb_build_object('id', a, 'username', 'Fil1', 'avatar_url', null), 'isFriend', true),
    r::text;
  assert jsonb_array_length(r -> 'messages') = 100 and r -> 'messages' -> 0 ->> 'content' = 'f6'
    and r -> 'messages' -> 99 ->> 'content' = 'f105', 'bornes du fil';
  delete from public.friendships where requester_id = a and addressee_id = b;
  r := wm.chat_thread(b, a);
  assert r -> 'messages' = want and r -> 'isFriend' = 'false', r::text;
  assert wm.chat_thread(carol, a) -> 'messages' = '[]', 'fil d''un tiers';
  d := pg_temp.err(format('select wm.chat_thread(%L, %L)', a, a));
  assert d = '{"status":400,"code":"invalid_request","error":"Tu ne peux pas t''écrire à toi-même","message":"Tu ne peux pas t''écrire à toi-même"}',
    coalesce(d::text, 'accepté');
  d := pg_temp.err(format('select wm.chat_thread(%L, %L)', a, gen_random_uuid()));
  assert d = '{"status":404,"error":"Joueur introuvable","message":"Joueur introuvable"}', coalesce(d::text, 'accepté');
end $$;

-- Conversations (M4b-9, B2) : une par pair, la plus récente d'abord, puis par peer_id ; unread_count = messages du pair non lus ; un ami sans
-- message et les fils des autres absents ; 50 au plus.
do $$ declare a uuid := pg_temp.player('Conv1'); b uuid := pg_temp.player('Conv2'); c uuid := pg_temp.player('Conv3');
  d uuid := pg_temp.player('Conv4'); e uuid := pg_temp.player('Conv5'); r jsonb; begin
  perform pg_temp.friends(a, d);
  insert into public.chat_messages (sender_id, recipient_id, content, read, created_at) values
    (a, b, 'b1', false, now() - interval '50 seconds'), (b, a, 'b2', true, now() - interval '40 seconds'),
    (a, b, 'b3', false, now() - interval '30 seconds'), (c, a, 'c0', true, now() - interval '20 seconds'),
    (c, a, 'c1', false, now() - interval '10 seconds'), (b, c, 'ailleurs', false, now());
  r := wm.chat_conversations(a);
  assert r = jsonb_build_object('conversations', jsonb_build_array(
    jsonb_build_object('peer_id', c, 'peer_username', 'Conv3', 'peer_avatar_url', null, 'last_message', 'c1',
      'last_message_at', now() - interval '10 seconds', 'unread_count', 1),
    jsonb_build_object('peer_id', b, 'peer_username', 'Conv2', 'peer_avatar_url', null, 'last_message', 'b3',
      'last_message_at', now() - interval '30 seconds', 'unread_count', 0))), r::text;
  insert into public.chat_messages (sender_id, recipient_id, content) select e, tests.make_user('ConvP' || i), 'p' from generate_series(1, 51) i;
  r := wm.chat_conversations(e);
  assert (select array_agg(x ->> 'peer_id' order by o) from jsonb_array_elements(r -> 'conversations') with ordinality t (x, o))
    = (select array_agg(id::text order by id) from (select recipient_id id from public.chat_messages where sender_id = e order by 1 limit 50) s),
    '50 conversations par peer_id : ' || r::text;
end $$;

-- Synchronisation « lu » (M4b-4) : le marquage direct du destinataire, sous RLS, marque lue la chat_message du couple, pas celle d'un autre
-- expéditeur ; rejoué, il ne lève rien ; une ligne déjà lue, réécrite, ne compte pas (D : message lu et chat_message non lue, posés à la main).
do $$ declare a uuid := pg_temp.player('Sync1'); b uuid := pg_temp.player('Sync2'); c uuid := pg_temp.player('Sync3');
  d uuid := pg_temp.player('Sync4'); n int; begin
  perform pg_temp.friends(a, b);
  perform pg_temp.friends(c, b);
  perform wm.chat_send(a, b, 's1');
  perform wm.chat_send(a, b, 's2');
  perform wm.chat_send(c, b, 's3');
  perform tests.login(b);
  update public.chat_messages set read = true where sender_id = a and recipient_id = b and not read;
  get diagnostics n = row_count;
  perform tests.reset_role();
  assert n = 2, 'messages marqués : ' || n;
  assert (select jsonb_object_agg(data ->> 'username', read) from public.notifications where user_id = b and type = 'chat_message')
    = '{"Sync1": true, "Sync3": false}', 'notifications après le marquage';
  insert into public.chat_messages (sender_id, recipient_id, content, read) values (d, b, 's4', true);
  insert into public.notifications (user_id, type, data) values (b, 'chat_message', jsonb_build_object('user_id', d, 'username', 'Sync4'));
  perform tests.login(b);
  update public.chat_messages set read = true where sender_id = a and recipient_id = b and not read;
  update public.chat_messages set read = true where sender_id = d and recipient_id = b;
  perform tests.reset_role();
  assert (select not read from public.notifications where user_id = b and data ->> 'user_id' = d::text), 'ligne déjà lue comptée';
end $$;

-- Signalements (M4b-8, M4b-10, R:258) : un par couple, modifiable, '' efface les détails ; report_get rend toujours celui de p_uid, null pour une
-- cible inconnue. Refus exacts sans écriture ; rejeu par la clé. Ni amitié exigée (A et B ne sont pas amis), ni notification.
do $$ declare a uuid := pg_temp.player('Signal1'); b uuid := pg_temp.player('Signal2'); carol uuid := pg_temp.player('Signal3');
  q text := 'select wm.report_upsert(%L, %L, %L, %L)'; r jsonb; d jsonb; begin
  assert wm.report_get(a, b) = '{"report": null}', 'avant le signalement : ' || wm.report_get(a, b)::text;
  r := wm.report_upsert(a, b, 'spam', 'pub');
  assert r = '{"report":{"reason":"spam","details":"pub"}}' and wm.report_get(a, b) = r, r::text;
  r := wm.report_upsert(a, b, 'cheating', '');
  assert r = '{"report":{"reason":"cheating","details":null}}' and wm.report_get(a, b) = r, r::text;
  assert (select count(*) from public.reports where reporter_id = a and reported_user_id = b) = 1, 'une seule ligne A → B';
  assert wm.report_get(carol, b) = '{"report": null}' and wm.report_get(a, gen_random_uuid()) = '{"report": null}', 'signalement d''un autre';
  r := wm.report_upsert(a, b, 'inappropriate_content', repeat('é', 500));
  assert r -> 'report' ->> 'details' = repeat('é', 500), '500 caractères';
  d := pg_temp.err(format(q, a, a, 'spam', null));
  assert d = '{"status":400,"code":"invalid_request","error":"Tu ne peux pas te signaler toi-même",
    "message":"Tu ne peux pas te signaler toi-même"}', coalesce(d::text, 'accepté');
  d := pg_temp.err(format(q, a, b, 'abuse', null));
  assert d = '{"status":400,"code":"invalid_request","error":"Motif de signalement inconnu","message":"Motif de signalement inconnu"}',
    coalesce(d::text, 'accepté');
  assert pg_temp.err(format(q, a, b, null, null)) = d, 'motif nul';
  d := pg_temp.err(format(q, a, b, 'spam', repeat('é', 501)));
  assert d = '{"status":400,"code":"invalid_request","error":"Les détails font au plus 500 caractères",
    "message":"Les détails font au plus 500 caractères"}', coalesce(d::text, 'accepté');
  d := pg_temp.err(format(q, a, gen_random_uuid(), 'spam', null));
  assert d = '{"status":404,"error":"Joueur introuvable","message":"Joueur introuvable"}', coalesce(d::text, 'accepté');
  update wm.config set value = 'true' where key = 'maintenance';
  d := pg_temp.err(format(q, a, b, 'spam', null));
  update wm.config set value = 'false' where key = 'maintenance';
  assert d = '{"status":503,"code":"maintenance","error":"Maintenance en cours, reviens dans quelques minutes.",
    "message":"Maintenance en cours, reviens dans quelques minutes."}', coalesce(d::text, 'accepté');
  assert wm.report_get(a, b) = r and (select count(*) from public.reports where reporter_id = a) = 1, 'signalement écrit par un refus';
  r := wm.report_upsert(a, carol, 'spam', 'k1', 'k-rep');
  assert wm.report_upsert(a, carol, 'cheating', 'k2', 'k-rep') = r and wm.report_get(a, carol) = r
    and r = '{"report":{"reason":"spam","details":"k1"}}', 'rejeu de la clé';
  assert not exists (select from public.notifications where user_id in (a, b, carol)), 'notification d''un signalement';
end $$;

-- friendOwners de l'overlay (1850, M4b-21) : amis acceptés des deux sens, profil privé compris (E), soi exclu (W), demandes en attente
-- ignorées dans les deux sens (F, G) ; au plus list_caps.friend_owners par carte, par lower(username), id (le tri brut en C mettrait POS4 en
-- tête) ; deux copies d'un ami comptent une fois ; une carte sans ami possesseur n'a pas de clé.
do $$ declare a uuid := pg_temp.player('Pos0'); b uuid := pg_temp.player('Pos1'); c uuid := pg_temp.player('pos2');
  d uuid := pg_temp.player('POS4'); e uuid := pg_temp.player('pos3'); f uuid := pg_temp.player('Pos5'); g uuid := pg_temp.player('Pos6');
  x uuid := pg_temp.card('Ami possède X'); y uuid := pg_temp.card('Ami possède Y'); z uuid := pg_temp.card('Ami possède Z');
  w uuid := pg_temp.card('Ami possède W'); begin
  perform pg_temp.friends(a, b);
  perform pg_temp.friends(a, c);
  perform pg_temp.friends(d, a);
  perform pg_temp.friends(e, a);
  insert into public.friendships (requester_id, addressee_id) values (f, a), (a, g);
  update public.profiles set is_public = false where id = e;
  perform pg_temp.copy(b, x);
  perform pg_temp.copy(b, x);
  perform pg_temp.copy(c, x);
  perform pg_temp.copy(u, y) from unnest(array[b, c, d, e]) u;
  perform pg_temp.copy(f, z);
  perform pg_temp.copy(g, z);
  perform pg_temp.copy(a, w);
  assert wm.cards_overlay(a, array[x, y, z, w]) -> 'friendOwners' = jsonb_build_object(
    x, jsonb_build_array(jsonb_build_object('id', b, 'username', 'Pos1'), jsonb_build_object('id', c, 'username', 'pos2')),
    y, jsonb_build_array(jsonb_build_object('id', b, 'username', 'Pos1'), jsonb_build_object('id', c, 'username', 'pos2'),
      jsonb_build_object('id', e, 'username', 'pos3'))), wm.cards_overlay(a, array[x, y, z, w])::text;
  assert wm.cards_overlay(f, array[z]) = jsonb_build_object('ownedCardIds', jsonb_build_array(z), 'wishlistCardIds', '[]'::jsonb,
    'friendOwners', '{}'::jsonb), wm.cards_overlay(f, array[z])::text;
end $$;

-- Volatilité des lectures (1810, 1820, 1830) : un create or replace sans le mot-clé repasserait en volatile. lock_timeout (P5, M4b-2) avant le
-- premier verrou, la copie relue sous le verrou du profil, et les deux profils tenus avant le message ; chaque tâche ajoute ses fonctions.
do $$ declare bad text; begin
  assert (select jsonb_object_agg(proname, provolatile::text) from pg_proc where pronamespace = 'wm'::regnamespace
    and proname in ('profile_json', 'profile_get', 'showcase_json', 'my_showcase', 'profile_showcase', 'chat_conversations', 'chat_thread',
      'report_get'))
    = '{"profile_json":"s","profile_get":"s","showcase_json":"s","my_showcase":"s","profile_showcase":"s","chat_conversations":"s",
      "chat_thread":"s","report_get":"s"}', 'volatilité des lectures';
  bad := tests.lock_timeout_violations(array['profile_update', 'showcase_put', 'showcase_delete', 'chat_send', 'report_upsert']);
  assert bad is null, 'lock_timeout absent ou posé après un verrou : ' || bad;
  select string_agg(f, ', ') into bad from unnest(array['profile_update', 'showcase_put']) f,
    lateral (select prosrc s from pg_proc where oid = to_regproc('wm.' || f)) p
  where not strpos(s, 'wm.lock_user(') between 1 and strpos(s, 'public.user_cards');
  assert bad is null, 'copie lue avant wm.lock_user : ' || bad;
  assert (select strpos(prosrc, 'wm.lock_users(') between 1 and strpos(prosrc, 'insert into public.chat_messages') from pg_proc
    where oid = to_regproc('wm.chat_send')), 'message inséré avant wm.lock_users';
end $$;
