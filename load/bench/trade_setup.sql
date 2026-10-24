-- Données du bench d'acceptation d'échange (load/bench/run.sh, M4-6), sur la base du banc seulement, après setup.sql (schéma bench,
-- bench.player) : aucune migration ne crée ces objets. 10 paires amies × 2 tailles × 10 tours d'échanges créés par wm.create_trade, sur
-- des copies propres au tour, 5 000 échanges en attente en fond, et un abonnement push par joueur des paires (M4b-26).
\set ON_ERROR_STOP on
do $$ begin
  if current_database() <> 'wm_test' then
    raise exception 'trade_setup.sql : base wm_test du banc seulement, pas %', current_database();
  end if;
end $$;

-- Paire k = client k de pgbench (:client_id, de 0 à 9) : joueurs 2k et 2k + 1, une étiquette chacun.
create table bench.trade_players (n int primary key, uid uuid);
insert into bench.trade_players select n, bench.player('bench_echangeur_' || n, 1000000000) from generate_series(0, 19) n;
insert into public.friendships (requester_id, addressee_id, status)
select a.uid, b.uid, 'accepted' from bench.trade_players a join bench.trade_players b on b.n = a.n + 1 where a.n % 2 = 0;
insert into public.tags (user_id, name) select uid, 'bench' from bench.trade_players;

-- Un côté, n = taille / 10 : 7n copies seules (dont n favorites, chacune étiquetée), n piles de 3 favorites et n piles de 2. Éléments au
-- format de wm.create_trade, une unité chacun : 1 par copie seule et par pile de 2, 2 par pile de 3 (count - 1, au moins 1).
create function bench.trade_side(p_uid uuid, p_size int) returns jsonb language sql as $$
  with c as (select row_number() over (order by id) j, * from public.cards),
  spec (count, starred, n) as (values (1, true, p_size / 10), (1, false, 6 * p_size / 10), (3, true, p_size / 10), (2, false, p_size / 10)),
  k as (
    insert into public.user_cards (user_id, card_id, count, starred, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk,
      snapshot_def)
    select p_uid, c.id, s.count, s.starred, c.wikipedia_title, c.rarity, c.category, c.atk, c.def from spec s join c on c.j <= s.n
    returning id, card_id, count, starred),
  t as (
    insert into public.user_card_tags (user_card_id, tag_id)
    select k.id, g.id from k join public.tags g on g.user_id = p_uid where k.starred and k.count = 1)
  select jsonb_agg(jsonb_build_object('user_card_id', k.id, 'card_id', k.card_id, 'offered_by', p_uid))
  from k, generate_series(1, greatest(k.count - 1, 1))
$$;

-- Tour impair : le joueur 2k propose au 2k + 1 ; tour pair : l'inverse. WB : 500 de l'initiateur, 300 du destinataire.
create table bench.trades (client int, size int, round int, id uuid, recipient uuid, done boolean not null default false,
  primary key (client, size, round));
do $$
declare
  s int;
  i uuid;
  d uuid;
  v_items jsonb;
begin
  for k in 0 .. 9 loop
    foreach s in array array[100, 10] loop
      for r in 1 .. 10 loop
        i := (select uid from bench.trade_players where n = 2 * k + (r + 1) % 2);
        d := (select uid from bench.trade_players where n = 2 * k + r % 2);
        v_items := bench.trade_side(i, s) || bench.trade_side(d, s);
        insert into bench.trades (client, size, round, id, recipient)
        values (k, s, r, (wm.create_trade(i, d, v_items, 500, 300) ->> 'id')::uuid, d);
      end loop;
    end loop;
  end loop;
end $$;

-- Fond : 100 joueurs amis deux à deux, 5 000 échanges en attente d'un élément par côté posés directement (chaque copie à son offrant),
-- échus dans 168 h jusqu'à l'étape d'expiration de run.sh.
do $$
declare
  p uuid[] := array(select bench.player('bench_fond_' || n, 0) from generate_series(1, 100) n order by n);
  v_cards uuid[] := array(select id from public.cards order by id);
  t uuid;
begin
  insert into public.friendships (requester_id, addressee_id, status) select p[2 * k - 1], p[2 * k], 'accepted' from generate_series(1, 50) k;
  for i in 0 .. 4999 loop
    insert into public.trades (initiator_id, recipient_id, expires_at)
    values (p[1 + 2 * (i % 50)], p[2 + 2 * (i % 50)], clock_timestamp() + interval '168 hours')
    returning id into t;
    insert into public.trade_items (trade_id, offered_by, user_card_id, card_id, snapshot_rarity, is_shiny)
    select t, k.user_id, k.id, k.card_id, k.snapshot_rarity, k.is_shiny
    from unnest(array[p[1 + 2 * (i % 50)], p[2 + 2 * (i % 50)]]) u, wm.grant_copy(u, v_cards[1 + i % cardinality(v_cards)], false) k;
  end loop;
end $$;

-- Une acceptation : le premier tour non fait de (client, taille), tenu jusqu'au commit, ses avatars et vitrines, puis l'acceptation du
-- destinataire.
-- Aucun refus avalé : un P0001 fait échouer la transaction, et pgbench arrête le client.
create function bench.accept_next(p_client int, p_size int) returns boolean language plpgsql as $$
declare
  r bench.trades;
  v int;
begin
  select * into r from bench.trades where client = p_client and size = p_size and not done order by round limit 1 for update;
  if not found then
    return false;
  end if;
  update bench.trades set done = true where client = r.client and size = r.size and round = r.round;
  -- Avatar de chaque joueur sur une de ses copies seules de l'échange : l'instruction (5) de wm.trade_move l'efface à chaque tour.
  -- Profils verrouillés avant l'échange (trade_action), l'inverse de C4 : sûr parce que chaque client a sa paire, pas entre clients.
  update public.profiles p set avatar_user_card_id = a.k
  from (select distinct on (i.offered_by) i.offered_by u, i.user_card_id k
    from public.trade_items i join public.user_cards uc on uc.id = i.user_card_id and uc.count = 1
    where i.trade_id = r.id order by i.offered_by, i.user_card_id) a
  where p.id = a.u;
  get diagnostics v = row_count;
  if v <> 2 then
    raise exception 'bench.accept_next : % avatar(s) posé(s) sur 2', v;
  end if;
  -- Vitrine pleine (M4b-26) : les 4 emplacements de chaque joueur sur 4 de ses copies seules de l'échange, que trade_move vide.
  insert into public.showcase (user_id, position, user_card_id)
  select u, p, k from (select i.offered_by u, i.user_card_id k, row_number() over (partition by i.offered_by order by i.user_card_id) - 1 p
    from public.trade_items i join public.user_cards uc on uc.id = i.user_card_id and uc.count = 1 where i.trade_id = r.id) s
  where p < 4
  on conflict (user_id, position) do update set user_card_id = excluded.user_card_id;
  get diagnostics v = row_count;
  if v <> 8 then
    raise exception 'bench.accept_next : % emplacement(s) de vitrine posé(s) sur 8', v;
  end if;
  perform wm.trade_action(r.recipient, r.id, 'accept');
  return true;
end $$;

-- Contrôle de la préparation : 200 échanges en attente, deux côtés chacun ; par côté, copies à leur offrant, (taille, éléments, copies
-- étiquetées, favorites, piles de 3, piles de 2) = (100, 100, 10, 20, 10, 10) ou (10, 10, 1, 2, 1, 1) ; 5 000 échanges de fond.
do $$
declare v jsonb := (select jsonb_build_object('sides', count(*),
    'shapes', jsonb_agg(distinct jsonb_build_array(b.size, x.items, x.tagged, x.starred, x.p3, x.p2)))
  from bench.trades b join public.trades t on t.id = b.id and t.status = 'pending'
  cross join lateral (select count(*) items, count(distinct ut.user_card_id) tagged, count(distinct uc.id) filter (where uc.starred) starred,
      count(distinct uc.id) filter (where uc.count = 3) p3, count(distinct uc.id) filter (where uc.count = 2) p2
    from public.trade_items i join public.user_cards uc on uc.id = i.user_card_id and uc.user_id = i.offered_by
    left join public.user_card_tags ut on ut.user_card_id = i.user_card_id
    where i.trade_id = b.id and i.offered_by in (t.initiator_id, t.recipient_id) group by i.offered_by) x);
begin
  if v is distinct from '{"sides": 400, "shapes": [[10, 10, 1, 2, 1, 1], [100, 100, 10, 20, 10, 10]]}'
     or (select count(*) from bench.trades) <> 200
     or (select count(*) from public.trades where status = 'pending' and id not in (select id from bench.trades)) <> 5000 then
    raise exception 'trade_setup.sql : préparation inattendue %', v;
  end if;
end $$;

-- Un abonnement push par joueur des paires, types d'échange activés (M4b-26) : le trigger d'outbox tourne dans chaque acceptation. Posés
-- après la création des échanges, dont les trade_received n'ont donc rien mis dans l'outbox, vide au départ.
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
select uid, 'https://fcm.googleapis.com/fcm/send/bench-' || n, 'bench', 'bench' from bench.trade_players;
insert into wm.notification_prefs (user_id, push_types)
select uid, '{trade_accepted,trade_cancelled,trade_countered,trade_declined,trade_received}' from bench.trade_players;

-- Statistiques d'une base installée avant la mesure : un autovacuum passé pendant les insertions ci-dessus (non validées, donc pas comptées
-- vivantes) a laissé user_cards à reltuples = 0 au banc ; le planificateur y voit 1 ligne, et chaque acceptation 100 ↔ 100 prenait ≈ 2,4 s.
analyze;
