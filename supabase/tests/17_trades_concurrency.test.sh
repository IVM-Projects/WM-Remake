#!/usr/bin/env bash
# Échanges en parallèle (joueurs et cartes supprimés à la sortie, config restaurée). A, B et C amis deux à deux, une carte par copie (count 1),
# M = Σ soldes des trois joueurs, conservé. Derrière un bloqueur, l'attente est prouvée : il tient ses verrous jusqu'à n appels en attente,
# 1 s au plus après le premier vu (5 s en tout), et le nombre maximal vu doit atteindre la moitié de n.
# 1. Défausse et mise en vente pendant l'acceptation : 30 accept, 20 discard et 10 create_auction des copies offertes par les initiateurs,
#    derrière A et B tenus → aucun 40P01 ni 55P03, aucune erreur d'accept, seuls refus « déjà engagée » ou « Vous ne possédez pas cette
#    carte », aucune enchère, copies chez l'autre joueur, M = m0, invariants vides.
# 2. Acceptation bloquée après sa première écriture (M4-7 C, P24) : compteurs de rareté de A et B tenus 3 s → 55P03 après 1,9 à 2,9 s, levée
#    dans le trigger de l'instruction (1) de trade_move ; instantané inchangé ; la même clé, le bloqueur fini → accepted.
# 3. Double acceptation : 20 accept sans clé, derrière A et B tenus → 1 succès, 19 « déjà traité », 2 lignes trade:<T2>, copies déplacées
#    une fois.
# 4. Même clé, deux sessions (M4-8) : la seconde attend au moins 0,5 s, puis rejoue la réponse de la première ; 2 lignes trade:<T3>.
# 5. Acceptations croisées : 30 échanges sur A–B, B–C et C–A, dans les deux sens, derrière les trois profils tenus → aucun 40P01 ni 55P03,
#    aucune erreur, 30 accepted, M = m0, invariants vides.
# 6. Contre-offre, acceptation et annulation du même parent (M4-2), 10 parents derrière A et B tenus → un succès par parent, deux 409
#    « déjà traité », aucun 40P01 ni 55P03, invariants vides.
# 7. Copie partie chez un tiers (P25), déterministe : X tenue 3 s, accept de T2 → 409 « Une carte de cet échange n'est plus disponible » en
#    moins de 0,5 s, T2 en attente, instantané inchangé.
set -euo pipefail
q() { psql "$DATABASE_URL" -qXAt -v ON_ERROR_STOP=1 "$@"; }
tmp="$(mktemp -d)"
tag="trd_$RANDOM$RANDOM"
keys="'market_list_burst', 'max_concurrent_auctions'"
cfg="$(q -c "select jsonb_object_agg(key, value) from wm.config where key in ($keys)")"
cleanup() {
  wait  # appels encore en vol après un échec (bloqueurs de 3 s au plus) : rien n'est supprimé sous eux
  q -c "delete from auth.users where id in (select id from public.profiles where username like '${tag}_%')" \
    -c "delete from public.cards where wikipedia_title like '$tag %'" \
    -c "update wm.config set value = '$cfg'::jsonb -> key where key in ($keys)" >/dev/null
  rm -rf "$tmp"
}
trap cleanup EXIT
fail() { echo "$1" >&2; shift; (( $# == 0 )) || cat "$@" >&2; exit 1; }  # $2… : sorties d'erreur à montrer

q -c "update wm.config set value = '{\"count\": 100000, \"window_s\": 60}' where key = 'market_list_burst'" \
  -c "update wm.config set value = '{\"free\": 1000, \"pro\": 1000}' where key = 'max_concurrent_auctions'" >/dev/null
player() { q -c "select tests.make_user('${tag}_$1', 1000000)"; }
a="$(player a)"; b="$(player b)"; c="$(player c)"
q -c "select wm.set_human_verified(u) from unnest(array['$a', '$b', '$c']::uuid[]) u" \
  -c "insert into public.friendships (requester_id, addressee_id, status) values ('$a', '$b', 'accepted'), ('$b', '$c', 'accepted'),
    ('$c', '$a', 'accepted')" >/dev/null
list() { local s; s="$(printf "'%s'," "$@")"; echo "${s%,}"; }
n=0
copies() {  # $1 = tableau rempli des ids, $2 = joueur, $3 = nombre ; une carte '$tag c<i>' par copie, de rareté $4 (R par défaut)
  local r="generate_series($((n + 1)), $((n + $3))) i"
  q -c "insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
      select '$tag c' || i, 'https://fr.wikipedia.org/wiki/Essai', '${4:-R}', 1000, 1000 from $r" \
    -c "select (wm.grant_copy('$2', id, false)).id from public.cards where wikipedia_title in (select '$tag c' || i from $r)" >"$tmp/ids"
  mapfile -t "$1" <"$tmp/ids"
  n=$((n + $3))
}
# Éléments des copies $@, une unité chacune, offerte par son propriétaire.
items() { echo "(select jsonb_agg(jsonb_build_object('user_card_id', id, 'card_id', card_id, 'offered_by', user_id))
  from public.user_cards where id in ($(list "$@")))"; }
trade() {  # $1 → $2, WB $3 de l'initiateur et $4 du destinataire, puis les copies ; imprime l'id
  local from=$1 to=$2 iwb=$3 rwb=$4; shift 4
  q -c "select wm.create_trade('$from', '$to', $(items "$@"), $iwb, $rwb) ->> 'id'"
}
# Chaque copie offerte dans les échanges $2… est chez l'autre joueur, en une unité : déplacée une fois, et une seule ; sinon échec $1.
moved() {
  local label=$1 bad; shift
  bad="$(q -c "select string_agg(format('%s chez %s (count %s)', i.user_card_id, coalesce(p.username, 'personne'), uc.count), ', ')
    from public.trade_items i join public.trades t on t.id = i.trade_id
    left join public.user_cards uc on uc.id = i.user_card_id left join public.profiles p on p.id = uc.user_id
    where t.id in ($(list "$@")) and (uc.count is distinct from 1
      or uc.user_id is distinct from case i.offered_by when t.initiator_id then t.recipient_id else t.initiator_id end)")"
  [[ -z $bad ]] || fail "$label : copies mal placées : $bad"
}
money() { q -c "select sum(wikibidous_balance) from public.profiles where id in ('$a', '$b', '$c')"; }
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
check() {
  [[ "$(money)" == "$m0" ]] || fail "$1 : M = $(money), $m0 attendu"
  [[ "$(q -c 'select wm.check_invariants()')" == '[]' ]] || fail "$1 : invariants violés $(q -c 'select wm.check_invariants()')"
}
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
  echo "17_trades_concurrency : $1 : $max appels au plus en attente derrière le bloqueur" >&2
  (( max >= $2 )) || fail "$1 : contention insuffisante, $max appels en attente ($2 au moins)"
}
ms() { echo $(( (${EPOCHREALTIME/[.,]/} - ${t0/[.,]/}) / 1000 )); }  # depuis t0=$EPOCHREALTIME
done409="\"error\": \"Cet échange n'est plus en attente \\(déjà traité\\)\", \"status\": 409"
m0="$(money)"

# 1. Défausse et mise en vente pendant l'acceptation : 15 échanges A → B et 15 B → A, une copie par côté. Derrière A et B tenus partent les
# 30 accept, et pour la copie offerte par chaque initiateur 20 discard et 10 create_auction, chacun lancé avant l'accept de son échange.
# 2 × 30 et pas 100 : le max_connections de 100 du banc et de la CI.
copies ca "$a" 30; copies cb "$b" 30
t1=()
for i in $(seq 0 29); do
  if (( i < 15 )); then t1+=("$(trade "$a" "$b" 0 0 "${ca[i]}" "${cb[i]}")"); else t1+=("$(trade "$b" "$a" 0 0 "${cb[i]}" "${ca[i]}")"); fi
done
hold s1 "perform from public.profiles where id in ('$a', '$b') for update" 60
for i in $(seq 0 29); do
  if (( i < 15 )); then from=$a to=$b x=${ca[i]}; else from=$b to=$a x=${cb[i]}; fi
  if (( i % 3 )); then bg "1d$i" "select wm.discard('$from', '$x')"; else bg "1v$i" "select wm.create_auction('$from', '$x', 10, 60)"; fi
  bg "1a$i" "select wm.trade_action('$to', '${t1[i]}', 'accept')"
done
released s1 30
waitall
refusals 'Cette carte est déjà engagée dans un échange en attente|Vous ne possédez pas cette carte' "$tmp"/1[dv]*
# Le verrou d'échange doit avoir servi, pour la défausse comme pour la vente : sinon chaque appel est passé après l'accept de son échange.
engaged() { { grep -l 'Cette carte est déjà engagée' "$@" || true; } | wc -l; }  # fichiers qui la contiennent
locked="$(engaged "$tmp"/1d*)"; listed="$(engaged "$tmp"/1v*)"
echo "17_trades_concurrency : s1 : verrou d'échange opposé à $locked défausses sur 20 et $listed mises en vente sur 10" >&2
(( locked > 0 && listed > 0 )) || fail "défausse et vente : verrou d'échange jamais exercé"
refusals . "$tmp"/1a*  # aucun 40P01 ni 55P03 ; aucune erreur du tout, vérifié après
[[ "$(q -c "select count(*) from public.auctions where seller_id in ('$a', '$b', '$c')")" == 0 ]] || fail "défausse et vente : enchère créée"
for f in "$tmp"/1[dv]*; do [[ -s $f ]] || fail "${f##*/} passée ; accept du même échange :" "$tmp/1a${f##*/1[dv]}"; done
quiet "$tmp"/1a*
moved "défausse et vente" "${t1[@]}"
check "défausse et vente pendant l'acceptation"

# 2. Acceptation bloquée après sa première écriture : a1 (R) contre b1 (C), donc l'instruction (1) de trade_move change les compteurs de
# rareté des deux joueurs (à rareté égale, les deltas s'annulent et le trigger n'écrit rien). Le bloqueur tient ces compteurs 3 s : la 55P03
# tombe dans le trigger, après la mise à jour de user_cards, et l'échec doit tout annuler (55P03 → 503 BUSY, P24).
copies a1 "$a" 1; copies b1 "$b" 1 C
q -c "update public.user_cards set starred = true where id = '$a1'" \
  -c "with g as (insert into public.tags (user_id, name) values ('$a', '$tag') returning id)
    insert into public.user_card_tags (user_card_id, tag_id) select '$a1', id from g" \
  -c "update public.profiles set avatar_user_card_id = '$a1' where id = '$a'" >/dev/null
t="$(trade "$a" "$b" 300 500 "$a1" "$b1")"
s0="$(q -c "select tests.trade_snapshot('$t')")"
q -c "begin; select from wm.user_rarity_counts where user_id in ('$a', '$b') for update; select pg_sleep(3); commit;" >/dev/null &
blocker=$!
sleeping
busy="select wm.trade_action('$b', '$t', 'accept', null, 'k-busy')"
t0=$EPOCHREALTIME
! q -v VERBOSITY=verbose -c "set role service_role; $busy" >/dev/null 2>"$tmp/2" || fail "acceptation passée malgré les compteurs tenus"
d="$(ms)"
echo "17_trades_concurrency : acceptation bloquée : 55P03 en $d ms" >&2
grep -q 55P03 "$tmp/2" || fail "acceptation bloquée : 55P03 attendue" "$tmp/2"
grep -q 'function wm.sync_rarity_counts()' "$tmp/2" && grep -q 'SQL statement "update public.user_cards set user_id' "$tmp/2" \
  || fail "acceptation bloquée : la 55P03 doit venir du trigger de l'instruction (1) de trade_move" "$tmp/2"
(( d >= 1900 && d <= 2900 )) || fail "acceptation bloquée : 55P03 en $d ms (1 900 à 2 900 attendues)"
[[ "$(q -c "select tests.trade_snapshot('$t')")" == "$s0" ]] || fail "acceptation bloquée : état changé $(q -c "select tests.trade_snapshot('$t')")"
wait "$blocker"
[[ "$(q -c "set role service_role; $busy")" == *'"status": "accepted"'* ]] || fail "acceptation rejouée : non acceptée"
check "acceptation bloquée"

# 3. Double acceptation : derrière A et B tenus, le premier appel tient l'échange et attend les profils, les 19 autres attendent l'échange ;
# à la libération, ils le relisent clos.
copies x "$a" 1; copies y "$b" 1
t2="$(trade "$a" "$b" 3 5 "$x" "$y")"
hold s3 "perform from public.profiles where id in ('$a', '$b') for update" 20
for i in $(seq 20); do bg "3-$i" "select wm.trade_action('$b', '$t2', 'accept')"; done
released s3 10
waitall
refusals "$done409" "$tmp"/3-*
[[ $fails == 19 ]] || fail "double acceptation : $((20 - fails)) succès"
[[ "$(q -c "select count(*) from wm.wb_ledger where ref = 'trade:$t2'")" == 2 ]] || fail "double acceptation : lignes trade:<T2>"
moved "double acceptation" "$t2"
check "double acceptation"

# 4. Même clé, deux sessions : la seconde attend l'unicité de la clé tenue par la première, puis lit sa réponse.
copies x "$a" 1; copies y "$b" 1
t3="$(trade "$a" "$b" 3 5 "$x" "$y")"
dup="select wm.trade_action('$b', '$t3', 'accept', null, 'k-dup')::text"
q -c "set role service_role; begin; $dup; select pg_sleep(1); commit;" >"$tmp/4a" &
blocker=$!
sleeping
t0=$EPOCHREALTIME
got="$(q -c "set role service_role; $dup")"
d="$(ms)"
wait "$blocker"
echo "17_trades_concurrency : même clé : seconde session servie en $d ms" >&2
(( d >= 500 )) || fail "même clé : seconde session servie en $d ms (500 au moins)"
[[ "$(cat "$tmp/4a")" == "$got" && $got == *'"status": "accepted"'* ]] || fail "même clé : $got, puis $(cat "$tmp/4a")"
[[ "$(q -c "select count(*) from wm.wb_ledger where ref = 'trade:$t3'")" == 2 ]] || fail "même clé : lignes trade:<T3>"
check "même clé"

# 5. Acceptations croisées : 10 échanges par paire, moitié dans chaque sens, deux copies par côté. 30 et pas 60 : chaque paire partage un
# joueur avec les deux autres, tout se sérialise, et 60 acceptations approcheraient les 2 s du lock_timeout.
t5=(); r5=()
for pair in "$a $b" "$b $c" "$c $a"; do
  read -r p o <<<"$pair"
  copies cp "$p" 20; copies co "$o" 20
  for i in $(seq 0 9); do
    x="${cp[2 * i]} ${cp[2 * i + 1]}"; y="${co[2 * i]} ${co[2 * i + 1]}"
    # $x et $y non cités : deux copies chacun
    if (( i % 2 )); then t5+=("$(trade "$p" "$o" 3 5 $x $y)"); r5+=("$o"); else t5+=("$(trade "$o" "$p" 3 5 $y $x)"); r5+=("$p"); fi
  done
done
hold s5 "perform from public.profiles where id in ('$a', '$b', '$c') for update" 30
for i in "${!t5[@]}"; do bg "5-$i" "select wm.trade_action('${r5[i]}', '${t5[i]}', 'accept')"; done
released s5 15
waitall
refusals . "$tmp"/5-*  # aucun 40P01 ni 55P03, puis aucune erreur du tout
quiet "$tmp"/5-*
got="$(q -c "select count(*) from public.trades where id in ($(list "${t5[@]}")) and status = 'accepted'")"
[[ $got == 30 ]] || fail "acceptations croisées : $got échanges acceptés sur 30"
moved "acceptations croisées" "${t5[@]}"
check "acceptations croisées"

# 6. Contre-offre, acceptation et annulation du même parent : le premier qui tient le parent gagne, les deux autres le relisent clos.
copies x "$a" 10; copies y "$b" 10
p6=(); i6=()
for i in $(seq 0 9); do
  p6+=("$(trade "$a" "$b" 0 0 "${x[i]}" "${y[i]}")")
  i6+=("$(q -c "select $(items "${y[i]}" "${x[i]}")")")
done
hold s6 "perform from public.profiles where id in ('$a', '$b') for update" 30
for i in $(seq 0 9); do
  bg "6a$i" "select wm.trade_action('$b', '${p6[i]}', 'accept')"
  bg "6c$i" "select wm.create_trade('$b', '$a', '${i6[i]}', 0, 0, '${p6[i]}')"
  bg "6x$i" "select wm.trade_action('$a', '${p6[i]}', 'cancel')"
done
released s6 15
waitall
refusals "$done409" "$tmp"/6[acx]*
declare -A status=([a]=accepted [c]=countered [x]=cancelled)
for i in $(seq 0 9); do
  won=""; for k in a c x; do [[ -s $tmp/6$k$i ]] || won+=$k; done
  [[ ${#won} == 1 ]] || fail "parent $i : succès « $won », un seul attendu"
  got="$(q -c "select status from public.trades where id = '${p6[i]}'")"
  [[ $got == "${status[$won]}" ]] || fail "parent $i : statut $got, ${status[$won]} attendu"
done
check "contre-offre contre acceptation"

# 7. Copie partie chez un tiers : T1 (A → B) et T2 (A → C) offrent X ; T1 accepté, X est chez B. Le bloqueur tient X 3 s : l'acceptation de
# T2 ne verrouille que les copies de A et C, donc la manque et refuse sans l'attendre.
copies x "$a" 1
t7a="$(trade "$a" "$b" 0 0 "$x")"; t7b="$(trade "$a" "$c" 0 0 "$x")"
q -c "select wm.trade_action('$b', '$t7a', 'accept')" >/dev/null
s0="$(q -c "select tests.trade_snapshot('$t7b')")"
q -c "begin; select from public.user_cards where id = '$x' for update; select pg_sleep(3); commit;" >/dev/null &
blocker=$!
sleeping
t0=$EPOCHREALTIME
! q -v VERBOSITY=verbose -c "set role service_role; select wm.trade_action('$c', '$t7b', 'accept')" >/dev/null 2>"$tmp/7" \
  || fail "copie partie : T2 acceptée"
d="$(ms)"
echo "17_trades_concurrency : copie partie : refus en $d ms" >&2
refusals "\"error\": \"Une carte de cet échange n'est plus disponible\", \"status\": 409" "$tmp/7"
(( d < 500 )) || fail "copie partie : refus en $d ms (moins de 500 attendues)"
[[ "$(q -c "select status from public.trades where id = '$t7b'")" == pending ]] || fail "copie partie : T2 n'est plus en attente"
[[ "$(q -c "select tests.trade_snapshot('$t7b')")" == "$s0" ]] || fail "copie partie : état de T2 changé"
wait "$blocker"
check "copie partie chez un tiers"
