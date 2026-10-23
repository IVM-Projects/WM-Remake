#!/usr/bin/env bash
# Social en parallèle (joueurs et cartes supprimés à la sortie, chat_burst restauré). Derrière un bloqueur, l'attente est prouvée : il tient
# ses verrous jusqu'à n appels en attente, 1 s au plus après le premier vu (5 s en tout), et le nombre maximal vu doit atteindre la moitié
# de n.
# 1. Vitrine et avatar contre acceptation (M4b-2), 10 tours : A et B amis, a1 une copie seule d'une carte à image, un échange qui la donne
#    à B. Derrière A et B tenus, accept, showcase_put(A, 0, a1) et profile_update(A, avatar a1) → aucun 40P01 ni 55P03, aucune erreur
#    d'accept, seul refus « Vous ne possédez pas cette carte », aucune vitrine ni aucun avatar sur la copie d'un autre joueur.
# 2. Messages croisés (M4b-2) : 30 chat_send A → B et 30 B → A derrière A et B tenus → aucune erreur, 60 messages, une chat_message non
#    lue de chaque côté.
# 2 b. Même clé, deux sessions (M4-8) : la seconde attend au moins 0,5 s, puis rejoue la réponse de la première ; un seul message, une
#    seule chat_message non lue, un seul envoi compté.
# 2 c. Envoi et marquage lu (B20), dans les deux ordres → une seule chat_message non lue, un seul message non lu.
# 3. Signalement contre deux profils pris dans l'ordre des id (M4b-31) : un bloqueur prend L puis R for update, comme lock_users ; R signale
#    L, puis L signale R → aucun 40P01, le signalement écrit après le bloqueur, entre 0,5 et 2 s.
# 4. Réservation de l'outbox (Task 6) : deux push_claim(500) sur 1 000 lignes, la seconde servie sans attendre (skip locked), ensembles
#    disjoints.
set -euo pipefail
q() { psql "$DATABASE_URL" -qXAt -v ON_ERROR_STOP=1 "$@"; }
tmp="$(mktemp -d)"
tag="soc_$RANDOM$RANDOM"
burst="$(q -c "select value from wm.config where key = 'chat_burst'")"
cleanup() {
  wait  # appels encore en vol après un échec : rien n'est supprimé sous eux
  q -c "delete from auth.users where id in (select id from public.profiles where username like '${tag}_%')" \
    -c "delete from public.cards where wikipedia_title like '$tag %'" \
    -c "update wm.config set value = '$burst' where key = 'chat_burst'" >/dev/null
  rm -rf "$tmp"
}
trap cleanup EXIT
fail() { echo "$1" >&2; shift; (( $# == 0 )) || cat "$@" >&2; exit 1; }  # $2… : sorties d'erreur à montrer

player() { q -c "select tests.make_user('${tag}_$1')"; }
# Appels en arrière-plan, SQLSTATE dans les erreurs (VERBOSITY verbose) : $1 = fichier d'erreurs, puis la requête.
pids=()
bg() { q -v VERBOSITY=verbose -c "set role service_role; $2" >/dev/null 2>"$tmp/$1" & pids+=($!); }
waitall() { fails=0; for p in "${pids[@]}"; do wait "$p" || fails=$((fails + 1)); done; pids=(); }
# Aucun interblocage ni attente de verrou échue ; chaque sortie d'erreur non vide des fichiers $2… contient un refus du motif $1.
refusals() {
  local pat="$1"; shift
  ! grep -qE '40P01|55P03' "$@" || fail "interblocage ou verrou échu" $(grep -lE '40P01|55P03' "$@")
  for f in "$@"; do [[ ! -s $f ]] || grep -qE "$pat" "$f" || fail "refus inattendu dans ${f##*/}" "$f"; done
}
# Aucune erreur ni aucun avertissement.
quiet() { for f in "$@"; do [[ ! -s $f ]] || fail "sortie d'erreur dans ${f##*/}" "$f"; done; }
# Attend le PgSleep du bloqueur ; mort avant, il échoue avec sa sortie d'erreur $1, si elle est donnée.
sleeping() {
  until [[ "$(q -c "select count(*) from pg_stat_activity where wait_event = 'PgSleep'")" == 1 ]]; do
    kill -0 "$blocker" 2>/dev/null || fail "bloqueur mort avant son PgSleep" ${1:+"$1"}
  done
}
# Bloqueur $1 : prend $2 (un perform … for update) et le tient jusqu'à ce que $3 appels de bg attendent un verrou, 1 s au plus après le premier
# vu (la moitié du lock_timeout : chaque appel attend donc ~1 s plus la vidange, même si les connexions arrivent lentement), 5 s au plus en
# tout ; puis imprime le nombre maximal vu en attente. Rendu dès son premier PgSleep, avant le lancement des appels.
hold() {
  cat >"$tmp/$1.sql" <<SQL
begin;
do \$\$ declare n int; m int := 0; t timestamptz; t1 timestamptz := clock_timestamp(); begin
  $2;
  loop
    perform pg_stat_clear_snapshot();  -- sinon pg_stat_activity reste figé pour toute la transaction
    n := (select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query like 'set role service_role;%');
    m := greatest(m, n);
    if t is null and n > 0 then t := clock_timestamp(); end if;
    exit when n >= $3 or clock_timestamp() > t + interval '1 second' or clock_timestamp() > t1 + interval '5 seconds';
    perform pg_sleep(0.05);
  end loop;
  perform set_config('wm_test.max_waiters', m::text, true);
end \$\$;
select current_setting('wm_test.max_waiters');
commit;
SQL
  q -f "$tmp/$1.sql" >"$tmp/$1.out" 2>"$tmp/$1.err" &
  blocker=$!
  sleeping "$tmp/$1.err"
}
# Fin du bloqueur $1 : au moins $2 appels vus en attente. La contention est prouvée, même si, sur un runner lent, quelques appels partent
# après la libération.
released() {
  wait "$blocker" || fail "bloqueur $1 en erreur" "$tmp/$1.err"
  local max; max="$(cat "$tmp/$1.out")"
  echo "18_social_concurrency : $1 : $max appels au plus en attente derrière le bloqueur" >&2
  (( max >= $2 )) || fail "$1 : contention insuffisante, $max appels en attente ($2 au moins)"
}
ms() { echo $(( (${EPOCHREALTIME/[.,]/} - ${t0/[.,]/}) / 1000 )); }  # depuis t0=$EPOCHREALTIME

# 1. Vitrine et avatar contre acceptation : la copie est relue sous le verrou du profil, que l'acceptation tient avant de la déplacer. Deux
# joueurs neufs par tour : l'ordre de leurs id, donc celui des verrous de l'acceptation, varie d'un tour à l'autre.
for i in $(seq 10); do
  a="$(player "a$i")"; b="$(player "b$i")"
  q -c "select wm.set_human_verified(u) from unnest(array['$a', '$b']::uuid[]) u" \
    -c "insert into public.friendships (requester_id, addressee_id, status) values ('$a', '$b', 'accepted')" >/dev/null
  a1="$(q -c "select (wm.grant_copy('$a', tests.image_card('$tag i$i'), false)).id")"
  t="$(q -c "select wm.create_trade('$a', '$b', jsonb_build_array(jsonb_build_object('user_card_id', id, 'card_id', card_id,
    'offered_by', user_id)), 0, 0) ->> 'id' from public.user_cards where id = '$a1'")"
  hold s1 "perform from public.profiles where id in ('$a', '$b') order by id for update" 3
  bg "1a$i" "select wm.trade_action('$b', '$t', 'accept')"
  bg "1s$i" "select wm.showcase_put('$a', 0, '$a1')"
  bg "1p$i" "select wm.profile_update('$a', '${tag}_a$i', p_avatar_user_card_id => '$a1', p_avatar_set => true)"
  released s1 1
  waitall
  refusals 'Vous ne possédez pas cette carte' "$tmp/1s$i" "$tmp/1p$i"
  refusals . "$tmp/1a$i"  # aucun 40P01 ni 55P03, puis aucune erreur du tout
  quiet "$tmp/1a$i"
  got="$(q -c "select count(*) from public.showcase s join public.user_cards uc on uc.id = s.user_card_id where uc.user_id <> s.user_id")"
  [[ $got == 0 ]] || fail "tour $i : $got emplacements de vitrine sur la copie d'un autre joueur"
  got="$(q -c "select count(*) from public.profiles p join public.user_cards uc on uc.id = p.avatar_user_card_id where uc.user_id <> p.id")"
  [[ $got == 0 ]] || fail "tour $i : $got avatars sur la copie d'un autre joueur"
done

# 2. Messages croisés : chaque envoi tient les deux profils (lock_users). Avec son seul profil, l'insertion prendrait FOR KEY SHARE sur celui
# de l'autre, tenu par un envoi croisé : 40P01.
a="$(player a)"; b="$(player b)"
q -c "update wm.config set value = '{\"count\": 1000, \"window_s\": 60}' where key = 'chat_burst'" \
  -c "insert into public.friendships (requester_id, addressee_id, status) values ('$a', '$b', 'accepted')" >/dev/null
hold s2 "perform from public.profiles where id in ('$a', '$b') order by id for update" 60
for i in $(seq 30); do
  bg "2-a$i" "select wm.chat_send('$a', '$b', 'a$i')"
  bg "2-b$i" "select wm.chat_send('$b', '$a', 'b$i')"
done
released s2 30
waitall
refusals . "$tmp"/2-*  # aucun 40P01 ni 55P03, puis aucune erreur du tout
quiet "$tmp"/2-*
q -c "update wm.config set value = '$burst' where key = 'chat_burst'" >/dev/null
got="$(q -c "select count(*) from public.chat_messages where '$a' in (sender_id, recipient_id)")"
[[ $got == 60 ]] || fail "messages croisés : $got messages"
got="$(q -c "select count(*) filter (where user_id = '$a' and data ->> 'user_id' = '$b') || ' ' || count(*) filter (where user_id = '$b'
  and data ->> 'user_id' = '$a') || ' ' || count(*) from public.notifications where user_id in ('$a', '$b') and type = 'chat_message' and not read")"
[[ $got == "1 1 2" ]] || fail "messages croisés : chat_message non lues (de B pour A, de A pour B, en tout) : $got"

# 2 b. Même clé, deux sessions : la seconde attend l'unicité de la clé tenue par la première, puis lit sa réponse.
pe="$(player e)"; pf="$(player f)"  # pas $f : la variable de boucle de refusals et quiet
q -c "insert into public.friendships (requester_id, addressee_id, status) values ('$pe', '$pf', 'accepted')" >/dev/null
dup="select wm.chat_send('$pe', '$pf', 'x', 'k-dup')::text"
q -v VERBOSITY=verbose -c "set role service_role; begin; $dup; select pg_sleep(1); commit;" >"$tmp/2b1" 2>"$tmp/2b1.err" &
blocker=$!
sleeping "$tmp/2b1.err"
t0=$EPOCHREALTIME
got="$(q -v VERBOSITY=verbose -c "set role service_role; $dup" 2>"$tmp/2b2.err")" || fail "même clé : seconde session en erreur" "$tmp/2b2.err"
d="$(ms)"
wait "$blocker" || fail "même clé : première session en erreur" "$tmp/2b1.err"
echo "18_social_concurrency : même clé : seconde session servie en $d ms" >&2
refusals . "$tmp/2b1.err" "$tmp/2b2.err"
quiet "$tmp/2b1.err" "$tmp/2b2.err"
(( d >= 500 )) || fail "même clé : seconde session servie en $d ms (500 au moins)"
[[ "$(cat "$tmp/2b1")" == "$got" && $got == *'"message"'* ]] || fail "même clé : $got, puis $(cat "$tmp/2b1")"
got="$(q -c "select (select count(*) from public.chat_messages where sender_id = '$pe' and recipient_id = '$pf') || ' '
  || (select count(*) from public.notifications where user_id = '$pf' and type = 'chat_message' and not read) || ' '
  || (select chat_window_count from wm.user_state where user_id = '$pe')")"
[[ $got == "1 1 1" ]] || fail "même clé : messages, chat_message non lues, envois comptés : $got"

# 2 c. Envoi et marquage lu : chacun prend la chat_message non lue du couple (for update) avant de la relire, dans une instruction à part.
# a) le marquage d'abord : l'envoi l'attend, la relit lue et en pose une neuve ; b) l'envoi d'abord : le trigger du marquage l'attend, puis
# voit le message neuf et la laisse non lue.
for pass in a b; do
  a="$(player "c${pass}1")"; b="$(player "c${pass}2")"
  q -c "insert into public.friendships (requester_id, addressee_id, status) values ('$a', '$b', 'accepted')" \
    -c "select wm.chat_send('$a', '$b', 'm0')" >/dev/null
  mark="update public.chat_messages set read = true where sender_id = '$a' and recipient_id = '$b' and not read"
  if [[ $pass == a ]]; then first="$mark"; second="set role service_role; select wm.chat_send('$a', '$b', 'x')"
  else first="set role service_role; select wm.chat_send('$a', '$b', 'y')"; second="$mark"; fi
  q -v VERBOSITY=verbose -c "begin; $first; select pg_sleep(1); commit;" >/dev/null 2>"$tmp/2c$pass-1" &
  blocker=$!
  sleeping "$tmp/2c$pass-1"
  q -v VERBOSITY=verbose -c "$second" >/dev/null 2>"$tmp/2c$pass-2" || fail "envoi et marquage lu, passe $pass : erreur" "$tmp/2c$pass-2"
  wait "$blocker" || fail "envoi et marquage lu, passe $pass : bloqueur en erreur" "$tmp/2c$pass-1"
  refusals . "$tmp/2c$pass-1" "$tmp/2c$pass-2"
  quiet "$tmp/2c$pass-1" "$tmp/2c$pass-2"
  got="$(q -c "select (select count(*) from public.notifications where user_id = '$b' and type = 'chat_message' and not read
    and data ->> 'user_id' = '$a') || ' ' || (select count(*) from public.chat_messages where sender_id = '$a' and recipient_id = '$b' and not read)")"
  [[ $got == "1 1" ]] || fail "envoi et marquage lu, passe $pass : chat_message non lues, messages non lus : $got"
done

# 3. Signalement contre une acceptation : l'insertion vérifie ses deux clés étrangères dans l'ordre de leurs triggers, pas dans celui des id.
# Sans le for key share order by id, dans l'un des deux sens elle tient R et attend L, que le bloqueur tient en attendant R : 40P01.
x="$(player r1)"; y="$(player r2)"
L="$(q -c "select least('$x'::uuid, '$y')")"; R="$(q -c "select greatest('$x'::uuid, '$y')")"
for pass in 1 2; do
  if [[ $pass == 1 ]]; then by=$R; on=$L; else by=$L; on=$R; fi
  q -v VERBOSITY=verbose -c "begin; select from public.profiles where id = '$L' for update; select pg_sleep(1);
    select from public.profiles where id = '$R' for update; commit;" >/dev/null 2>"$tmp/3b$pass" &
  blocker=$!
  sleeping "$tmp/3b$pass"
  t0=$EPOCHREALTIME
  # Échecs lus dans les sorties d'erreur, pour montrer un 40P01 de l'un ou de l'autre.
  q -v VERBOSITY=verbose -c "set role service_role; select wm.report_upsert('$by', '$on', 'spam')" >/dev/null 2>"$tmp/3r$pass" || true
  d="$(ms)"
  wait "$blocker" || true
  echo "18_social_concurrency : signalement, passe $pass : servi en $d ms" >&2
  refusals . "$tmp/3b$pass" "$tmp/3r$pass"  # aucun 40P01 ni 55P03, puis aucune erreur du tout
  quiet "$tmp/3b$pass" "$tmp/3r$pass"
  (( d >= 500 && d <= 2000 )) || fail "signalement, passe $pass : servi en $d ms (0,5 à 2 s)"
  got="$(q -c "select reason from public.reports where reporter_id = '$by' and reported_user_id = '$on'")"
  [[ $got == spam ]] || fail "signalement, passe $pass : motif « $got »"
done
