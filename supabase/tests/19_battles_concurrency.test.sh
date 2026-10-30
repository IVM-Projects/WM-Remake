#!/usr/bin/env bash
# Batailles en parallèle (joueurs et cartes supprimés à la sortie, config battle restaurée). Derrière un bloqueur, l'attente est prouvée : il
# tient ses verrous jusqu'à n appels en attente, 1 s au plus après le premier vu (5 s en tout), et le nombre maximal vu doit atteindre la
# moitié de n. Cartes du tag : R, au pool (les pairs des modèles ne viennent que de wm.draw_pool), vues 100 × 1,2^(k mod 60) au rang k de
# création, toutes distinctes : questions de vues (T5) seules.
# 1. Défis croisés (D:325) : 25 paires d'amis, battle_create(A, B) et battle_create(B, A) pour chacune, derrière les 50 profils tenus →
#    aucun 40P01 ni 55P03, une bataille ouverte par paire, 25 refus « Une bataille est déjà en cours avec ce joueur ».
# 2. Quota en rafale (M5a-12) : quota_free à 3, 6 battle_create(A, F_i) derrière le profil de A tenu → 3 batailles, 3 refus « Limite
#    quotidienne de défis atteinte ».
# 3. Même question, deux sessions sans clé (C5) : deux réponses de B à q1 derrière la bataille tenue → deux succès au même
#    correct_answer_id, un seul answered_at, q1 une fois dans answered. Puis, au tour 2, deux submit_attack de B derrière la bataille tenue →
#    un succès, un 409 « Ce n'est pas à toi d'attaquer », 3 secrets au tour 2.
# 4. Même clé, deux sessions (M4-8) : la seconde attend au moins 0,5 s, puis rend la réponse stockée de la première, au même corps, bien que
#    la première ait changé la bataille après son appel.
# 5. quiz_ensure croisé, 20 tours sur deux cartes neuves : quiz_ensure(array[a, b]) et quiz_ensure(array[b, a]) ensemble, chacun tenu 0,2 s
#    dans sa transaction → aucun 40P01, une banque par carte.
# 5 b. Second deck contre deux profils pris dans l'ordre des id (M4b-31) : un bloqueur prend L puis R for update, comme lock_users ; le second
#    deck de R, puis celui de L → aucun 40P01 ni 55P03, servi entre 0,5 et 2 s, bataille active, battle_started pour le premier joueur.
# 6. Dernière réponse contre le cron, le cron d'abord (M5a-12, C11) : KO à sa dernière question, défenseur B, inactif depuis 49 h ; le cron
#    tient la bataille et attend les profils tenus, puis la dernière réponse de B attend la bataille → le cron rend 1, A gagne, deux lignes
#    battle:<id>, battles_won de A + 1, la réponse rend 409 « Cette bataille est terminée ».
# 7. Bataille tenue : une partie inactive tenue 1 s par un bloqueur → expire_battles la saute (skip locked) et rend 0 en moins de 0,5 s,
#    puis la finit au passage suivant.
# 8. Défi contre le cron, 10 tours (C4, C6) : battle_create(A, F), qui solde le défi échu P(A, F), et expire_battles, qui finit la partie
#    inactive Y(A, G), derrière les trois profils tenus → aucun 40P01 ni 55P03, P cancelled, une bataille ouverte A–F, Y completed.
# 9. Fins croisées, 10 tours : la dernière réponse d'un KO et les abandons de A et de B derrière la bataille tenue → une seule fin (deux
#    lignes battle:<id>, battles_won + 1, une battle_won et une battle_lost), deux 409 « Cette bataille est terminée ».
set -euo pipefail
q() { psql "$DATABASE_URL" -qXAt -v ON_ERROR_STOP=1 "$@"; }
tmp="$(mktemp -d)"
tag="bat_$RANDOM$RANDOM"
cfg="$(q -c "select value from wm.config where key = 'battle'")"
cleanup() {
  wait  # appels encore en vol après un échec : rien n'est supprimé sous eux
  # Clés NO ACTION vers public.cards : le pool d'abord (1200_wm_packs.sql:25), puis les joueurs, leurs copies et leurs batailles avec eux,
  # puis les cartes, leurs banques et leur file avec elles. Les clés d'idempotence n'ont pas de clé étrangère vers les profils.
  q -c "select wm.pool_remove(id) from public.cards where wikipedia_title like '$tag %'" \
    -c "delete from wm.idempotency_keys where user_id in (select id from public.profiles where username like '${tag}_%')" \
    -c "delete from auth.users where id in (select id from public.profiles where username like '${tag}_%')" \
    -c "delete from public.cards where wikipedia_title like '$tag %'" \
    -c "update wm.config set value = '$cfg' where key = 'battle'" >/dev/null
  rm -rf "$tmp"
}
trap cleanup EXIT
fail() { echo "$1" >&2; shift; (( $# == 0 )) || cat "$@" >&2; exit 1; }  # $2… : sorties d'erreur à montrer

player() { q -c "select tests.make_user('${tag}_$1')"; }
# Carte R du tag au pool, titrée « $tag $1 », ATK $2 et DEF $3 (1 000 et 800 par défaut) ; k = nombre de cartes du tag déjà créées. Rend
# son id (pool_add, void, n'imprime qu'une ligne vide, que $(…) retire).
card() {
  q -c "insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, pageviews)
    select '$tag $1', 'https://fr.wikipedia.org/wiki/${tag}_$1', 'R', ${2:-1000}, ${3:-800}, round(100 * 1.2 ^ (count(*) % 60))::int
    from public.cards where wikipedia_title like '$tag %' returning id" \
    -c "select wm.pool_add(id, rarity) from public.cards where wikipedia_title = '$tag $1'"
}
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
  echo "19_battles_concurrency : $1 : $max appels au plus en attente derrière le bloqueur" >&2
  (( max >= $2 )) || fail "$1 : contention insuffisante, $max appels en attente ($2 au moins)"
}
ms() { echo $(( (${EPOCHREALTIME/[.,]/} - ${t0/[.,]/}) / 1000 )); }  # depuis t0=$EPOCHREALTIME

# 1. Défis croisés : chaque défi tient les deux profils (lock_users) avant de chercher la bataille ouverte de la paire. Sans eux, les deux
# défis d'une paire la cherchent avant toute insertion, et l'index unique de la paire refuse le second (23505, 500).
pairs="$(q -c "create temp table p as select i, tests.make_user('${tag}_1a' || i) a, tests.make_user('${tag}_1b' || i) b
  from generate_series(1, 25) i" -c "insert into public.friendships (requester_id, addressee_id, status) select a, b, 'accepted' from p" \
  -c "select a || ' ' || b from p order by i")"
hold s1 "perform from public.profiles where username like '${tag}_1%' order by id for update" 50
i=0
while read -r a b; do
  i=$((i + 1))
  bg "1-a$i" "select wm.battle_create('$a', '$b')"
  bg "1-b$i" "select wm.battle_create('$b', '$a')"
done <<<"$pairs"
released s1 25
waitall
refusals 'Une bataille est déjà en cours avec ce joueur' "$tmp"/1-*
got="$(cat "$tmp"/1-* | grep -c '^ERROR:  P0001: Une bataille est déjà en cours avec ce joueur$') $(q -c "select count(*) || ' '
  || count(distinct least(challenger_id, opponent_id)) from public.battles
  where status = 'pending' and challenger_id in (select id from public.profiles where username like '${tag}_1%')")"
[[ $got == "25 25 25" ]] || fail "défis croisés : refus, batailles ouvertes, paires : $got"

# 2. Quota en rafale : chaque défi compte ceux de A après avoir pris son profil (lock_users), donc après le défi qui le tenait.
q -c "update wm.config set value = value || '{\"quota_free\": 3}' where key = 'battle'" >/dev/null
a="$(player 2a)"
fs=()
for i in $(seq 6); do
  f="$(player "2f$i")"
  fs+=("$f")
  q -c "insert into public.friendships (requester_id, addressee_id, status) values ('$a', '$f', 'accepted')" >/dev/null
done
hold s2 "perform from public.profiles where id = '$a' for update" 6
for f in "${fs[@]}"; do bg "2-$f" "select wm.battle_create('$a', '$f')"; done
released s2 3
waitall
refusals 'Limite quotidienne de défis atteinte' "$tmp"/2-*
got="$(cat "$tmp"/2-* | grep -c '^ERROR:  P0001: Limite quotidienne de défis atteinte$') $(cat "$tmp"/2-* | grep -c '"status": 429') $(q -c "select
  count(*) from public.battles where challenger_id = '$a'")"
[[ $got == "3 3 3" ]] || fail "quota en rafale : refus, refus 429, batailles : $got"

# 3. Partie de A contre B : c1 à c3 à A, c4 à c6 à B, une copie chacun ; c7 et c8 au pool seulement (T5 tire ses pairs par 30 seq au hasard :
# 31_battles.test.sql:526-527). A attaque avec c1, B défend.
a="$(player 3a)"; b="$(player 3b)"
c=(); for i in $(seq 8); do c+=("$(card "c$i")"); done
deck() { echo "jsonb_build_object('card_ids', array['$1', '$2', '$3'])"; }
x="$(q -c "insert into public.friendships (requester_id, addressee_id, status) values ('$a', '$b', 'accepted')" \
  -c "select from unnest(array['${c[0]}', '${c[1]}', '${c[2]}']::uuid[]) u, wm.grant_copy('$a', u, false)" \
  -c "select from unnest(array['${c[3]}', '${c[4]}', '${c[5]}']::uuid[]) u, wm.grant_copy('$b', u, false)" \
  -c "select wm.battle_create('$a', '$b') ->> 'id'")"
q -c "select wm.battle_action('$b', '$x', 'accept')" \
  -c "select wm.battle_action('$a', '$x', 'submit_deck', $(deck "${c[0]}" "${c[1]}" "${c[2]}"))" \
  -c "select wm.battle_action('$b', '$x', 'submit_deck', $(deck "${c[3]}" "${c[4]}" "${c[5]}"))" \
  -c "select wm.battle_action('$a', '$x', 'submit_attack', jsonb_build_object('attack_card_id', '${c[0]}'))" >/dev/null
read -r q1 q2 q3 <<<"$(q -c "select string_agg(e ->> 'id', ' ' order by i) from public.battles,
  jsonb_array_elements(game_state #> '{pendingAttack,questions}') with ordinality t (e, i) where id = '$x'")"
secret() { q -c "select correct_option_id from wm.battle_secrets where question_id = '$1'"; }
o="$(q -c "select game_state #>> '{pendingAttack,questions,0,options,0,id}' from public.battles where id = '$x'")"  # juste ou non
s1="$(secret "$q1")"
answer() { echo "select wm.battle_action('$b', '$x', 'submit_single_answer', jsonb_build_object('questionId', '$1', 'answerId', '$2'))"; }
# La seconde réponse attend la bataille, puis relit le secret répondu : rejeu (C5), rien n'est écrit. Sorties gardées : correct_answer_id.
hold s3 "perform from public.battles where id = '$x' for update" 2
for k in 1 2; do
  q -v VERBOSITY=verbose -c "set role service_role; $(answer "$q1" "$o") ->> 'correct_answer_id'" >"$tmp/3a$k.out" 2>"$tmp/3a$k" & pids+=($!)
done
released s3 1
waitall
refusals . "$tmp/3a1" "$tmp/3a2"  # aucun 40P01 ni 55P03, puis aucune erreur du tout
quiet "$tmp/3a1" "$tmp/3a2"
got="$(cat "$tmp/3a1.out") $(cat "$tmp/3a2.out")"
[[ $got == "$s1 $s1" ]] || fail "même question : correct_answer_id $got ($s1 attendu deux fois)"
got="$(q -c "select (select count(*) from wm.battle_secrets where battle_id = '$x' and answered_at is not null) || ' '
  || (game_state #> '{pendingAttack,answered}' = jsonb_build_array('$q1')) from public.battles where id = '$x'")"
[[ $got == "1 true" ]] || fail "même question : answered_at posés, answered = [q1] : $got"
for k in "$q2" "$q3"; do
  q -c "$(answer "$k" "$(secret "$k")")" >/dev/null
done
got="$(q -c "select concat_ws(' ', game_state ->> 'phase', game_state ->> 'currentTurnUserId', game_state ->> 'turnNumber')
  from public.battles where id = '$x'")"
[[ $got == "attack $b 2" ]] || fail "tour 1 clos : phase, currentTurnUserId, turnNumber : $got"
# La seconde attaque attend la bataille, puis la relit en phase quiz.
hold s3b "perform from public.battles where id = '$x' for update" 2
for k in 1 2; do bg "3b$k" "select wm.battle_action('$b', '$x', 'submit_attack', jsonb_build_object('attack_card_id', '${c[3]}'))"; done
released s3b 1
waitall
refusals "Ce n'est pas à toi d'attaquer" "$tmp/3b1" "$tmp/3b2"
got="$(cat "$tmp/3b1" "$tmp/3b2" | grep -c '"status": 409') $(q -c "select count(*) from wm.battle_secrets
  where battle_id = '$x' and turn_number = 2")"
[[ $got == "1 3" ]] || fail "attaque doublée : refus 409, secrets du tour 2 : $got"

# 4. Même clé, deux sessions : la seconde attend l'unicité de la clé tenue par la première, puis lit sa réponse stockée. B rejoue sa
# réponse à q1 (C5), le seul appel de réponse qui lui réussisse encore, A défendant au tour 2. La session 1 tient aussi la bataille : sans
# la clé, la seconde attendrait autant, puis rejouerait q1. Elle avance donc updated_at d'une minute après son appel : une réponse
# recalculée la montrerait (updated_at, idle_at), la réponse stockée non.
dup="select wm.battle_action('$b', '$x', 'submit_single_answer', jsonb_build_object('questionId', '$q1', 'answerId', '$o'), 'k-dup')::text"
q -v VERBOSITY=verbose -c "set role service_role; begin; $dup; reset role;
  update public.battles set updated_at = updated_at + interval '1 minute' where id = '$x'; select pg_sleep(1); commit;" \
  >"$tmp/4s1" 2>"$tmp/4s1.err" &
blocker=$!
sleeping "$tmp/4s1.err"
t0=$EPOCHREALTIME
got="$(q -v VERBOSITY=verbose -c "set role service_role; $dup" 2>"$tmp/4s2.err")" || fail "même clé : seconde session en erreur" "$tmp/4s2.err"
d="$(ms)"
wait "$blocker" || fail "même clé : première session en erreur" "$tmp/4s1.err"
echo "19_battles_concurrency : même clé : seconde session servie en $d ms" >&2
refusals . "$tmp/4s1.err" "$tmp/4s2.err"
quiet "$tmp/4s1.err" "$tmp/4s2.err"
(( d >= 500 )) || fail "même clé : seconde session servie en $d ms (500 au moins)"
[[ "$(cat "$tmp/4s1")" == "$got" && $got == *"\"correct_answer_id\": \"$s1\""* ]] || fail "même clé : $got, puis $(cat "$tmp/4s1")"

# 5. quiz_ensure croisé : chaque insertion suit l'ordre des card_id (1910_wm_quiz_templates.sql:333 et :339). Dans deux ordres, chaque
# session attendrait l'unicité de la banque insérée par l'autre (40P01).
for i in $(seq 20); do
  ca="$(card "q${i}a")"; cb="$(card "q${i}b")"
  bg "5-a$i" "begin; select wm.quiz_ensure(array['$ca', '$cb']::uuid[]); select pg_sleep(0.2); commit;"
  bg "5-b$i" "begin; select wm.quiz_ensure(array['$cb', '$ca']::uuid[]); select pg_sleep(0.2); commit;"
  waitall
  refusals . "$tmp/5-a$i" "$tmp/5-b$i"
  quiet "$tmp/5-a$i" "$tmp/5-b$i"
  got="$(q -c "select count(*) from wm.card_quizzes where card_id in ('$ca', '$cb')")"
  [[ $got == 2 ]] || fail "quiz_ensure croisé, tour $i : $got banques"
done

# 5 b. Second deck contre deux profils : battle_decks prend celui de l'appelant, la battle_started celui de l'autre. Sans le for key share
# order by id de battle_submit_deck, la passe 1 tient R et attend L, que le bloqueur tient en attendant R : 40P01.
u="$(player 5u)"; v="$(player 5v)"
L="$(q -c "select least('$u'::uuid, '$v')")"; R="$(q -c "select greatest('$u'::uuid, '$v')")"
q -c "insert into public.friendships (requester_id, addressee_id, status) values ('$L', '$R', 'accepted')" \
  -c "select from unnest(array['${c[0]}', '${c[1]}', '${c[2]}']::uuid[]) u, wm.grant_copy('$L', u, false)" \
  -c "select from unnest(array['${c[3]}', '${c[4]}', '${c[5]}']::uuid[]) u, wm.grant_copy('$R', u, false)" >/dev/null
dl="$(deck "${c[0]}" "${c[1]}" "${c[2]}")"; dr="$(deck "${c[3]}" "${c[4]}" "${c[5]}")"
for pass in 1 2; do
  if [[ $pass == 1 ]]; then first=$L d1=$dl second=$R d2=$dr; else first=$R d1=$dr second=$L d2=$dl; fi
  y="$(q -c "select wm.battle_create('$L', '$R') ->> 'id'")"
  q -c "select wm.battle_action('$R', '$y', 'accept')" -c "select wm.battle_action('$first', '$y', 'submit_deck', $d1)" >/dev/null
  q -v VERBOSITY=verbose -c "begin; select from public.profiles where id = '$L' for update; select pg_sleep(1);
    select from public.profiles where id = '$R' for update; commit;" >/dev/null 2>"$tmp/5bb$pass" &
  blocker=$!
  sleeping "$tmp/5bb$pass"
  t0=$EPOCHREALTIME
  # Échecs lus dans les sorties d'erreur, pour montrer un 40P01 de l'un ou de l'autre.
  q -v VERBOSITY=verbose -c "set role service_role; select wm.battle_action('$second', '$y', 'submit_deck', $d2)" >/dev/null \
    2>"$tmp/5bd$pass" || true
  d="$(ms)"
  wait "$blocker" || true
  echo "19_battles_concurrency : second deck, passe $pass : servi en $d ms" >&2
  refusals . "$tmp/5bb$pass" "$tmp/5bd$pass"  # aucun 40P01 ni 55P03, puis aucune erreur du tout
  quiet "$tmp/5bb$pass" "$tmp/5bd$pass"
  (( d >= 500 && d <= 2000 )) || fail "second deck, passe $pass : servi en $d ms (0,5 à 2 s)"
  got="$(q -c "select status || ' ' || (select count(*) from public.notifications where user_id = '$first' and type = 'battle_started'
    and data ->> 'battle_id' = '$y') from public.battles where id = '$y'")"
  [[ $got == "active 1" ]] || fail "second deck, passe $pass : statut, battle_started du premier joueur : $got"
  q -c "select wm.battle_action('$L', '$y', 'forfeit')" >/dev/null  # une seule bataille ouverte par paire
done

# Parties des scénarios 6 à 9, joueurs neufs à chaque partie (quota, une bataille ouverte par paire). k1 (ATK 1 000) à k3 pour A, k4 à k6
# (DEF 300, Σ 900) pour B : trois mauvaises réponses à l'attaque de k1 font un KO.
kc=("$(card k1 1000 500)" "$(card k2 400 500)" "$(card k3 400 500)" "$(card k4 400 300)" "$(card k5 400 300)" "$(card k6 400 300)")
# Partie active de $1 (A, challenger, à qui revient l'attaque) contre $2 (B), amis. Rend son id.
live() {
  local x
  x="$(q -c "insert into public.friendships (requester_id, addressee_id, status) values ('$1', '$2', 'accepted')" \
    -c "select from unnest(array['${kc[0]}', '${kc[1]}', '${kc[2]}']::uuid[]) u, wm.grant_copy('$1', u, false)" \
    -c "select from unnest(array['${kc[3]}', '${kc[4]}', '${kc[5]}']::uuid[]) u, wm.grant_copy('$2', u, false)" \
    -c "select wm.battle_create('$1', '$2') ->> 'id'")"
  q -c "select wm.battle_action('$2', '$x', 'accept')" \
    -c "select wm.battle_action('$1', '$x', 'submit_deck', $(deck "${kc[0]}" "${kc[1]}" "${kc[2]}"))" \
    -c "select wm.battle_action('$2', '$x', 'submit_deck', $(deck "${kc[3]}" "${kc[4]}" "${kc[5]}"))" >/dev/null
  echo "$x"
}
# Question $2 (1 à 3) de l'attaque en cours de la bataille $1 et sa plus petite mauvaise option, « question option ».
wrong() {
  q -c "select (e ->> 'id') || ' ' || (select min(o ->> 'id') from jsonb_array_elements(e -> 'options') o where o ->> 'id' <> s.correct_option_id)
    from public.battles t, jsonb_array_elements(t.game_state #> '{pendingAttack,questions}') with ordinality u (e, i), wm.battle_secrets s
    where t.id = '$1' and u.i = $2 and s.battle_id = t.id and s.question_id = (e ->> 'id')::uuid"
}
# La même partie à la dernière question d'un KO : A attaque avec k1, B a mal répondu aux deux premières. Rend « bataille question option »,
# l'option fausse.
ko() {
  local x i qq oo
  x="$(live "$1" "$2")"
  q -c "select wm.battle_action('$1', '$x', 'submit_attack', jsonb_build_object('attack_card_id', '${kc[0]}'))" >/dev/null
  for i in 1 2; do
    read -r qq oo <<<"$(wrong "$x" "$i")"
    q -c "select wm.battle_action('$2', '$x', 'submit_single_answer', jsonb_build_object('questionId', '$qq', 'answerId', '$oo'))" >/dev/null
  done
  echo "$x $(wrong "$x" 3)"
}
reply() { echo "select wm.battle_action('$2', '$1', 'submit_single_answer', jsonb_build_object('questionId', '$3', 'answerId', '$4'))"; }
waiting() { q -c "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query like 'set role service_role;%'"; }

# Les comptes du cron (scénarios 6 et 7) valent pour toute la base : le reliquat soldé d'abord, comme 31_battles.test.sql.
q -c "select wm.expire_battles(5000)" >/dev/null

# 6. Dernière réponse contre le cron, le cron d'abord : il prend la bataille (skip locked), puis les deux profils d'un seul lock_users ; la
# réponse attend la bataille, puis la relit completed (C11). L'ordre inverse (la bataille tenue, le cron qui la saute) est le scénario 7.
pa="$(player 6a)"; pb="$(player 6b)"
read -r bt q3 o3 <<<"$(ko "$pa" "$pb")"
w="$(q -c "update public.battles set updated_at = updated_at - interval '49 hours' where id = '$bt'" \
  -c "select coalesce((select battles_won from wm.user_stats where user_id = '$pa'), 0)")"
hold s6 "perform from public.profiles where id in ('$pa', '$pb') order by id for update" 2
q -v VERBOSITY=verbose -c "set role service_role; select wm.expire_battles(500)" >"$tmp/6c.out" 2>"$tmp/6c" & pids+=($!)
cron=$!
until (( $(waiting) >= 1 )); do
  kill -0 "$cron" 2>/dev/null || fail "cron jamais en attente des profils" "$tmp/6c"
  sleep 0.05
done
bg 6r "$(reply "$bt" "$pb" "$q3" "$o3")"
released s6 2
waitall
refusals 'Cette bataille est terminée' "$tmp/6c" "$tmp/6r"
quiet "$tmp/6c"
got="$(cat "$tmp/6c.out") $(grep -c '^ERROR:  P0001: Cette bataille est terminée$' "$tmp/6r") $(grep -c '"status": 409' "$tmp/6r") $(q -c "select
  concat_ws(' ', status, (winner_id = '$pa')::text, (select count(*) from wm.wb_ledger where reason = 'battle' and ref = 'battle:$bt'),
    (select battles_won from wm.user_stats where user_id = '$pa') - $w, wm.check_invariants()) from public.battles where id = '$bt'")"
[[ $got == "1 1 1 completed true 2 1 []" ]] || fail "réponse contre le cron : rendu du cron, refus, refus 409, statut, A vainqueur, lignes battle,
  battles_won de A, invariants : $got"

# 7. Bataille tenue : le cron saute la ligne tenue (skip locked) sans l'attendre, puis la finit au passage suivant. Bloqueur à la main
# (18_social_concurrency.test.sh:182-183) : hold attend un appel en attente, que le cron ne fait jamais.
pa="$(player 7a)"; pb="$(player 7b)"
bt="$(live "$pa" "$pb")"
q -c "update public.battles set updated_at = updated_at - interval '49 hours' where id = '$bt'" >/dev/null
q -v VERBOSITY=verbose -c "begin; select from public.battles where id = '$bt' for update; select pg_sleep(1); commit;" >/dev/null 2>"$tmp/7b" &
blocker=$!
sleeping "$tmp/7b"
t0=$EPOCHREALTIME
got="$(q -v VERBOSITY=verbose -c "set role service_role; select wm.expire_battles(500)" 2>"$tmp/7c")" \
  || fail "bataille tenue : cron en erreur" "$tmp/7c"
d="$(ms)"
wait "$blocker" || fail "bataille tenue : bloqueur en erreur" "$tmp/7b"
echo "19_battles_concurrency : bataille tenue : cron servi en $d ms" >&2
quiet "$tmp/7b" "$tmp/7c"
(( d < 500 )) || fail "bataille tenue : cron servi en $d ms (moins de 500)"
got="$got $(q -c "set role service_role; select wm.expire_battles(500)") $(q -c "select status || ' ' || (winner_id = '$pb')
  from public.battles where id = '$bt'")"
[[ $got == "0 1 completed true" ]] || fail "bataille tenue : rendus des deux passages, statut, B vainqueur : $got"

# 8. Défi contre le cron : battle_create prend le défi échu de la paire avant les profils (C4, C6), le cron ses batailles avant les profils ;
# chacun saute ou attend la ligne de l'autre, jamais un profil contre une bataille. Le solde remis après lock_users ferait un cycle : le défi
# tient A et attend P, que le cron tient en attendant A (40P01).
for i in $(seq 10); do
  pa="$(player "8a$i")"; pf="$(player "8f$i")"; pg="$(player "8g$i")"
  by="$(live "$pa" "$pg")"
  bp="$(q -c "insert into public.friendships (requester_id, addressee_id, status) values ('$pa', '$pf', 'accepted')" \
    -c "select wm.battle_create('$pa', '$pf') ->> 'id'")"
  q -c "update public.battles set created_at = created_at - interval '25 hours' where id = '$bp'" \
    -c "update public.battles set updated_at = updated_at - interval '49 hours' where id = '$by'" >/dev/null
  hold s8 "perform from public.profiles where id in ('$pa', '$pf', '$pg') order by id for update" 2
  bg "8b$i" "select wm.battle_create('$pa', '$pf')"
  bg "8c$i" "select wm.expire_battles(500)"
  released s8 1
  waitall
  refusals . "$tmp/8b$i" "$tmp/8c$i"  # aucun 40P01 ni 55P03, puis aucune erreur du tout
  quiet "$tmp/8b$i" "$tmp/8c$i"
  got="$(q -c "select concat_ws(' ', (select status from public.battles where id = '$bp'),
    (select count(*) from public.battles where challenger_id in ('$pa', '$pf') and opponent_id in ('$pa', '$pf')
      and status in ('pending', 'deck_selection', 'generating_quizzes', 'active')),
    (select status from public.battles where id = '$by'), (select count(*) from wm.wb_ledger where reason = 'battle' and ref = 'battle:$by'),
    wm.check_invariants())")"
  [[ $got == "cancelled 1 completed 2 []" ]] || fail "défi contre le cron, tour $i : P, ouvertes A–F, Y, lignes battle de Y, invariants : $got"
done

# 9. Fins croisées : chaque fin prend la bataille for update avant les profils ; la première finit, les deux autres la relisent completed
# (C11). Lue sans for update, la seconde fin passerait aussi : XX000 par la garde de battle_finish.
for i in $(seq 10); do
  pa="$(player "9a$i")"; pb="$(player "9b$i")"
  read -r bt q3 o3 <<<"$(ko "$pa" "$pb")"
  hold s9 "perform from public.battles where id = '$bt' for update" 3
  bg "9r$i" "$(reply "$bt" "$pb" "$q3" "$o3")"
  bg "9a$i" "select wm.battle_action('$pa', '$bt', 'forfeit')"
  bg "9b$i" "select wm.battle_action('$pb', '$bt', 'forfeit')"
  released s9 1
  waitall
  refusals 'Cette bataille est terminée' "$tmp/9r$i" "$tmp/9a$i" "$tmp/9b$i"
  e="$(cat "$tmp/9r$i" "$tmp/9a$i" "$tmp/9b$i")"
  got="$(grep -c '^ERROR:  P0001: Cette bataille est terminée$' <<<"$e") $(grep -c '"status": 409' <<<"$e") $(q -c "select concat_ws(' ', status,
      (select count(*) from wm.wb_ledger where reason = 'battle' and ref = 'battle:$bt'),
      (select sum(battles_won) || ' ' || sum(battles_won) filter (where user_id = b.winner_id) from wm.user_stats where user_id in ('$pa', '$pb')),
      (select count(*) filter (where type = 'battle_won') || ' ' || count(*) filter (where type = 'battle_lost') from public.notifications
        where data ->> 'battle_id' = '$bt'), wm.check_invariants()) from public.battles b where id = '$bt'")"
  [[ $got == "2 2 completed 2 1 1 1 1 []" ]] || fail "fins croisées, tour $i : refus, refus 409, statut, lignes battle, battles_won (total,
    vainqueur), battle_won, battle_lost, invariants : $got"
done
