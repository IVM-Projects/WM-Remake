#!/usr/bin/env bash
# stripe_apply, la suppression de compte et la résiliation en parallèle (joueurs du tag, pierres tombales comprises, leurs lignes Stripe en
# cascade, événements evt_bench_<tag>_*, cartes du tag supprimés à la sortie). Gabarit de 21_moderation_concurrency.test.sh : derrière un
# bloqueur, l'attente est prouvée ; « d'abord » : l'appel est lancé, puis attendu en attente d'un verrou avant le suivant. Chaque scénario :
# aucun 40P01 ni 55P03, chaque appel servi sans erreur, check_invariants() = [] (dont stripe_purchase, stripe_pro, deleted_account).
# 1. Même événement, deux livraisons : le profil tenu, deux stripe_apply du même completed payé → un {duplicate: false}, un {duplicate:
#    true}, +2 500 exactement, un achat, une ligne stripe, une wb_purchased.
# 2. completed et async_payment_succeeded d'une même session, ensemble → deux applied, un crédit, un achat, une wb_purchased.
# 3. Dix livraisons simultanées du même événement → neuf doublons, un effet.
# 4. updated (active) et deleted (canceled) ensemble, dans les deux ordres, à created T et T + 5 puis à égalité (T et T) → canceled, is_pro
#    faux dans les quatre cas (garde G5, départage G44).
# 5. Suppression contre abonnement créé (G35) : account_delete(D) et customer.subscription.created active de D, dix tours, ordre alterné →
#    stripe_pending vrai à chaque tour, aucune notification chez D.
# 6. admin_stripe_cancel doublé (même p_idem, deux sessions) → la seconde servie après 0,5 s au même corps, une ligne d'audit.
# 7. stripe_cancel_done contre un second abonnement d'une pierre tombale (G35, G41) : la résiliation tenue puis stripe_apply, et l'inverse
#    → stripe_pending vrai (la ligne prise avant l'exists : aucune mise à jour perdue).
# 8. Suppression contre crédit de 2 500 WB (G38), dans les deux ordres → +2 500 une fois, aucune notification chez D ; l'achat dans
#    purchases_on_deleted_list seulement si la suppression est passée d'abord.
# 9. place_bid contre stripe_apply du même joueur (son profil), dans les deux ordres → servis, solde 100 - 20 + 2 500, P meneur.
set -euo pipefail
q() { psql "$DATABASE_URL" -qXAt -v ON_ERROR_STOP=1 "$@"; }
tmp="$(mktemp -d)"
tag="stripe_$RANDOM$RANDOM"
cleanup() {
  wait  # appels encore en vol après un échec : rien n'est supprimé sous eux
  # Les joueurs par leurs ids (une pierre tombale a perdu son pseudo du tag) ; la garde des pierres tombales levée pour la session. Le pool
  # d'abord (clé NO ACTION vers public.cards), l'audit et les clés d'idempotence (sans clé étrangère), les événements et litiges du tag,
  # puis les joueurs, leurs lignes Stripe, ventes et copies avec eux, puis les cartes.
  local ids
  ids="{$(paste -sd, "$tmp/users" 2>/dev/null || true)}"
  q -c "select set_config('wm.allow_tombstone_delete', 'on', false)" \
    -c "select wm.pool_remove(id) from public.cards where wikipedia_title like '$tag %'" \
    -c "delete from wm.staff_actions where staff_id = any ('$ids'::uuid[]) or target_id = any ('$ids'::text[])" \
    -c "delete from wm.idempotency_keys where user_id = any ('$ids'::uuid[])" \
    -c "delete from wm.stripe_events where starts_with(id, 'evt_bench_${tag}_')" \
    -c "delete from wm.stripe_disputes where starts_with(id, 'dp_bench_${tag}_')" \
    -c "delete from auth.users where id = any ('$ids'::uuid[])" \
    -c "delete from public.cards where wikipedia_title like '$tag %'" >/dev/null
  rm -rf "$tmp"
}
trap cleanup EXIT
fail() { echo "$1" >&2; shift; (( $# == 0 )) || cat "$@" >&2; exit 1; }  # $2… : sorties d'erreur à montrer

# Joueur « ${tag}_$1 » au solde $2 (0 par défaut), noté pour le nettoyage. trader : vérifié (marché).
player() { local u; u="$(q -c "select tests.make_user('${tag}_$1', ${2:-0})")"; echo "$u" >>"$tmp/users"; echo "$u"; }
trader() { local u; u="$(player "$@")"; q -c "select wm.set_human_verified('$u')" >/dev/null; echo "$u"; }
# Carte R du tag au pool, titrée « $tag $1 » ; rend son id.
card() {
  q -c "insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, pageviews)
    select '$tag $1', 'https://fr.wikipedia.org/wiki/${tag}_$1', 'R', 1000, 800, round(100 * 1.2 ^ (count(*) % 60))::int
    from public.cards where wikipedia_title like '$tag %' returning id" \
    -c "select wm.pool_add(id, rarity) from public.cards where wikipedia_title = '$tag $1'"
}
# Appels en arrière-plan, SQLSTATE dans les erreurs (VERBOSITY verbose) : $1 = fichier d'erreurs, puis la requête.
pids=()
bg() { q -v VERBOSITY=verbose -c "set role service_role; $2" >/dev/null 2>"$tmp/$1" & pids+=($!); }
# Même chose, la sortie gardée dans $tmp/$1.out.
bgo() { q -v VERBOSITY=verbose -c "set role service_role; $2" >"$tmp/$1.out" 2>"$tmp/$1" & pids+=($!); }
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
  echo "22_stripe_concurrency : $1 : $max appels au plus en attente derrière le bloqueur" >&2
  (( max >= $2 )) || fail "$1 : contention insuffisante, $max appels en attente ($2 au moins)"
  (( max >= 2 )) || echo "22_stripe_concurrency : $1 : avertissement, un seul appel vu en attente" >&2
}
ms() { echo $(( (${EPOCHREALTIME/[.,]/} - ${t0/[.,]/}) / 1000 )); }  # depuis t0=$EPOCHREALTIME
waiting() { q -c "select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query like 'set role service_role;%'"; }
# Lance $2 par bg (fichier $1), puis attend que ${3:-1} appels attendent un verrou avant de rendre la main.
first() {
  bg "$1" "$2"
  local p="${pids[-1]}"
  until (( $(waiting) >= ${3:-1} )); do
    kill -0 "$p" 2>/dev/null || fail "$1 jamais en attente d'un verrou" "$tmp/$1"
    sleep 0.05
  done
}
# Transaction tenue ${3:-1} s après $2 (fichier d'erreurs $1) ; rendu à son PgSleep.
held() {
  q -v VERBOSITY=verbose -c "begin; $2; select pg_sleep(${3:-1}); commit;" >/dev/null 2>"$tmp/$1" &
  blocker=$!
  sleeping "$tmp/$1"
}
bal() { q -c "select wikibidous_balance from public.profiles where id = '$1'"; }
deleted() { q -c "select count(*) from wm.deleted_accounts where user_id = '$1'"; }
inv() { q -c "select wm.check_invariants()"; }
pending() { q -c "select stripe_pending from wm.deleted_accounts where user_id = '$1'"; }
notes() { q -c "select count(*) from public.notifications where user_id = '$1'${2:+ and type = '$2'}"; }
# Achats, lignes stripe du grand livre et wb_purchased du joueur $1.
paid() { q -c "select (select count(*) from wm.purchases where user_id = '$1') || ' ' || (select count(*) from wm.wb_ledger where user_id = '$1'
  and reason = 'stripe') || ' ' || (select count(*) from public.notifications where user_id = '$1' and type = 'wb_purchased')"; }
sub_state() { q -c "select status || ' ' || (select is_pro from public.profiles where id = s.user_id) from wm.subscriptions s where id = 'sub_bench_${tag}_$1'"; }
del() { echo "select wm.account_delete('$1', '$(q -c "select username from public.profiles where id = '$1'")')"; }

# Événements tels que le webhook les passe à stripe_apply (forme de 40_stripe.test.sql) ; le Customer d'un joueur est cus_bench_<uid hex>.
T="$(date +%s)"
cus() { echo "cus_bench_${1//-/}"; }
# Événement evt_bench_<tag>_$1 de type $2, created $3, objet $4 (expression jsonb) ; apply : son appel.
ev() { echo "jsonb_build_object('id', 'evt_bench_${tag}_$1', 'object', 'event', 'type', '$2', 'created', $3, 'livemode', false,
  'data', jsonb_build_object('object', $4))"; }
apply() { echo "select wm.stripe_apply($(ev "$@"))"; }
# Session Checkout payée de 2 500 WB cs_test_bench_<tag>_$1 du joueur $2.
cs() { echo "jsonb_build_object('id', 'cs_test_bench_${tag}_$1', 'object', 'checkout.session', 'mode', 'payment', 'payment_status', 'paid',
  'client_reference_id', '$2', 'customer', '$(cus "$2")', 'metadata', jsonb_build_object('uid', '$2', 'item', 'wb_2500'),
  'amount_total', 499, 'currency', 'cad', 'consent', jsonb_build_object('terms_of_service', 'accepted'))"; }
# Instantané de l'abonnement sub_bench_<tag>_$1 du joueur $2 au statut $3.
sub() { echo "jsonb_build_object('id', 'sub_bench_${tag}_$1', 'object', 'subscription', 'customer', '$(cus "$2")', 'status', '$3',
  'cancel_at_period_end', false, 'cancel_at', null, 'canceled_at', null, 'metadata', jsonb_build_object('uid', '$2'),
  'items', jsonb_build_object('data', jsonb_build_array(jsonb_build_object('current_period_end', $((T + 2592000)),
  'price', jsonb_build_object('id', 'price_test_bench_pro')))))"; }
run() { q -c "set role service_role; $1" >/dev/null; }

adm="$(player adm)"
q -c "insert into wm.staff (user_id, role) values ('$adm', 'admin')" >/dev/null

# 1. Même événement, deux livraisons : la première insère stripe_events puis attend le profil ; la seconde attend l'index unique de
# stripe_events, puis trouve la ligne validée (on conflict do nothing → doublon).
a="$(player 1a)"
hold s1 "perform from public.profiles where id = '$a' for update" 2
for k in 1 2; do bgo "1-$k" "$(apply 1 checkout.session.completed "$T" "$(cs 1 "$a")")"; done
released s1 2
waitall
refusals . "$tmp/1-1" "$tmp/1-2"
quiet "$tmp/1-1" "$tmp/1-2"
got="$(cat "$tmp/1-1.out" "$tmp/1-2.out" | grep -c '^{"outcome": "applied", "duplicate": false}$') \
$(cat "$tmp/1-1.out" "$tmp/1-2.out" | grep -c '^{"outcome": null, "duplicate": true}$') $(bal "$a") $(paid "$a") $(inv)"
[[ $got == "1 1 2500 1 1 1 []" ]] || fail "même événement deux fois : effets, doublons, solde, achats, lignes stripe, wb_purchased, invariants : $got"

# 2. completed et async_payment_succeeded d'une session : deux événements, un achat (PK session_id) et une réf. stripe:<session>.
a="$(player 2a)"
hold s2 "perform from public.profiles where id = '$a' for update" 2
bgo 2c "$(apply 2c checkout.session.completed "$T" "$(cs 2 "$a")")"
bgo 2s "$(apply 2s checkout.session.async_payment_succeeded "$((T + 1))" "$(cs 2 "$a")")"
released s2 2
waitall
refusals . "$tmp/2c" "$tmp/2s"
quiet "$tmp/2c" "$tmp/2s"
got="$(cat "$tmp/2c.out" "$tmp/2s.out" | grep -c '^{"outcome": "applied", "duplicate": false}$') $(bal "$a") $(paid "$a") $(inv)"
[[ $got == "2 2500 1 1 1 []" ]] || fail "completed et async_payment_succeeded : applied, solde, achats, lignes stripe, wb_purchased, invariants : $got"

# 3. Dix livraisons simultanées du même événement → un effet, neuf doublons.
a="$(player 3a)"
hold s3 "perform from public.profiles where id = '$a' for update" 10
for k in $(seq 10); do bgo "3-$k" "$(apply 3 checkout.session.completed "$T" "$(cs 3 "$a")")"; done
released s3 5
waitall
refusals . "$tmp"/3-{1..10}
quiet "$tmp"/3-{1..10}
got="$(cat "$tmp"/3-{1..10}.out | grep -c '"duplicate": false') $(cat "$tmp"/3-{1..10}.out | grep -c '^{"outcome": null, "duplicate": true}$') \
$(bal "$a") $(paid "$a") $(inv)"
[[ $got == "1 9 2500 1 1 1 []" ]] || fail "dix livraisons : effets, doublons, solde, achats, lignes stripe, wb_purchased, invariants : $got"

# 4. Instantanés croisés : abonnement créé incomplete à T - 10, puis updated (active) et deleted (canceled) ensemble, le profil tenu, l'un
# d'abord. Écart de 5 s : la garde de G5 rend le plus ancien stale ; égalité : le départage de G44 garde canceled.
for pass in "updated 5" "deleted 5" "updated 0" "deleted 0"; do
  read -r lead gap <<<"$pass"
  k="4${lead:0:1}$gap"
  u="$(player "$k")"
  run "$(apply "${k}c" customer.subscription.created "$((T - 10))" "$(sub "$k" "$u" incomplete)")"
  up="$(apply "${k}u" customer.subscription.updated "$T" "$(sub "$k" "$u" active)")"
  dl="$(apply "${k}d" customer.subscription.deleted "$((T + gap))" "$(sub "$k" "$u" canceled)")"
  hold "s$k" "perform from public.profiles where id = '$u' for update" 2
  if [[ $lead == updated ]]; then first "${k}u" "$up"; bg "${k}d" "$dl"; else first "${k}d" "$dl"; bg "${k}u" "$up"; fi
  released "s$k" 2
  waitall
  refusals . "$tmp/${k}u" "$tmp/${k}d"
  quiet "$tmp/${k}u" "$tmp/${k}d"
  got="$(sub_state "$k") $(inv)"
  [[ $got == "canceled false []" ]] || fail "instantanés croisés ($lead d'abord, écart $gap s) : statut, is_pro, invariants : $got"
done

# 5. Suppression contre abonnement créé (G35) : toutes deux prennent le profil de D. Suppression d'abord : stripe_apply relit la pierre
# tombale sous le verrou et pose stripe_pending, sans notification. Abonnement d'abord : le trigger de deleted_accounts voit l'abonnement.
for i in $(seq 10); do
  d="$(player "5d$i")"
  cr="$(apply "5-$i" customer.subscription.created "$T" "$(sub "5-$i" "$d" active)")"
  hold s5 "perform from public.profiles where id = '$d' for update" 2
  if (( i % 2 == 0 )); then first "5d$i" "$(del "$d")"; bg "5a$i" "$cr"; else first "5a$i" "$cr"; bg "5d$i" "$(del "$d")"; fi
  released s5 2
  waitall
  refusals . "$tmp/5d$i" "$tmp/5a$i"
  quiet "$tmp/5d$i" "$tmp/5a$i"
  got="$(pending "$d") $(notes "$d") $(sub_state "5-$i") $(deleted "$d") $(inv)"
  [[ $got == "t 0 active true 1 []" ]] || fail "suppression contre abonnement créé, tour $i : stripe_pending, notifications de D, statut, is_pro,
    supprimé, invariants : $got"
done

# 6. Résiliation admin doublée : la seconde session attend l'unicité de la clé tenue par la première, puis lit sa réponse stockée.
d="$(player 6d)"
run "$(apply 6 customer.subscription.created "$T" "$(sub 6 "$d" active)")"
run "$(del "$d")"
dup="select wm.admin_stripe_cancel('$adm', '$d', 'résiliation de test', 'k-dup')::text"
q -v VERBOSITY=verbose -c "set role service_role; begin; $dup; select pg_sleep(1); commit;" >"$tmp/6s1" 2>"$tmp/6s1.err" &
blocker=$!
sleeping "$tmp/6s1.err"
t0=$EPOCHREALTIME
got="$(q -v VERBOSITY=verbose -c "set role service_role; $dup" 2>"$tmp/6s2.err")" || fail "résiliation doublée : seconde session en erreur" "$tmp/6s2.err"
dt="$(ms)"
wait "$blocker" || fail "résiliation doublée : première session en erreur" "$tmp/6s1.err"
echo "22_stripe_concurrency : résiliation doublée : seconde session servie en $dt ms" >&2
refusals . "$tmp/6s1.err" "$tmp/6s2.err"
quiet "$tmp/6s1.err" "$tmp/6s2.err"
(( dt >= 500 )) || fail "résiliation doublée : seconde session servie en $dt ms (500 au moins)"
[[ "$(cat "$tmp/6s1")" == "$got" && $got == *"\"subscription_ids\": [\"sub_bench_${tag}_6\"]"* ]] || fail "résiliation doublée : $got, puis $(cat "$tmp/6s1")"
got="$(q -c "select count(*) from wm.staff_actions where action = 'stripe_cancel' and target_id = '$d'") $(pending "$d") $(inv)"
[[ $got == "1 t []" ]] || fail "résiliation doublée : lignes d'audit, stripe_pending, invariants : $got"

# 7. stripe_cancel_done(D, [sub1]) contre un second abonnement de D créé par stripe_apply (G35, G41). La résiliation tenue : stripe_apply
# écrit sub2, puis attend la ligne deleted_accounts et la recalcule vraie. stripe_apply tenu : la résiliation attend la ligne, puis lit
# sub2 validé dans une nouvelle instruction ; sans ce verrou préalable, l'update relirait la ligne mais son exists garderait l'instantané
# d'avant sub2 (faux, mise à jour perdue).
for pass in resiliation abonnement; do
  k="7${pass:0:1}"
  d="$(player "$k")"
  run "$(apply "${k}1" customer.subscription.created "$T" "$(sub "${k}1" "$d" active)")"
  run "$(del "$d")"
  done_="select wm.stripe_cancel_done('$d', array['sub_bench_${tag}_${k}1'])"
  cr="$(apply "${k}2" customer.subscription.created "$((T + 1))" "$(sub "${k}2" "$d" active)")"
  if [[ $pass == resiliation ]]; then held "${k}h" "$done_"; first "${k}b" "$cr"; else held "${k}h" "$cr"; first "${k}b" "$done_"; fi
  wait "$blocker" || fail "résiliation contre second abonnement ($pass) : transaction tenue en erreur" "$tmp/${k}h"
  waitall
  refusals . "$tmp/${k}h" "$tmp/${k}b"
  quiet "$tmp/${k}h" "$tmp/${k}b"
  got="$(pending "$d") $(sub_state "${k}2") $(inv)"
  [[ $got == "t active true []" ]] || fail "résiliation contre second abonnement ($pass d'abord) : stripe_pending, statut, is_pro, invariants : $got"
done

# 8. Suppression contre crédit (G38) : crédit d'abord, sa wb_purchased est effacée par la suppression ; suppression d'abord, le crédit
# inerte arrive sans notification et figure parmi les achats sur comptes supprimés.
for pass in credit suppression; do
  k="8${pass:0:1}"
  d="$(player "$k")"
  cr="$(apply "$k" checkout.session.completed "$T" "$(cs "$k" "$d")")"
  hold "s$k" "perform from public.profiles where id = '$d' for update" 2
  if [[ $pass == credit ]]; then first "${k}a" "$cr"; bg "${k}d" "$(del "$d")"; else first "${k}d" "$(del "$d")"; bg "${k}a" "$cr"; fi
  released "s$k" 2
  waitall
  refusals . "$tmp/${k}a" "$tmp/${k}d"
  quiet "$tmp/${k}a" "$tmp/${k}d"
  got="$(bal "$d") $(paid "$d") $(notes "$d") $(deleted "$d") $(q -c "select count(*) from jsonb_array_elements(wm.staff_dashboard('$adm')
    -> 'purchases_on_deleted_list') e where e ->> 'session_id' = 'cs_test_bench_${tag}_$k'") $(inv)"
  if [[ $pass == credit ]]; then want="2500 1 1 0 0 1 0 []"; else want="2500 1 1 0 0 1 1 []"; fi
  [[ $got == "$want" ]] || fail "suppression contre crédit ($pass d'abord) : solde, achats, lignes stripe, wb_purchased, notifications, supprimé,
    achat sur compte supprimé, invariants : $got ($want attendu)"
done

# 9. place_bid contre stripe_apply du même joueur : la mise tient la vente puis attend P ; stripe_apply tient sa ligne stripe_events puis
# attend P. Un seul verrou commun, aucun cycle.
s="$(trader 9s)"
for pass in mise credit; do
  k="9${pass:0:1}"
  u="$(trader "$k" 100)"
  x="$(card "x$k")"
  au="$(q -c "select wm.create_auction('$s', (wm.grant_copy('$s', '$x', false)).id, 10, 60) ->> 'auction_id'")"
  bid="select wm.place_bid('$u', '$au', 20)"
  cr="$(apply "$k" checkout.session.completed "$T" "$(cs "$k" "$u")")"
  hold "s$k" "perform from public.profiles where id = '$u' for update" 2
  if [[ $pass == mise ]]; then first "${k}b" "$bid"; bg "${k}a" "$cr"; else first "${k}a" "$cr"; bg "${k}b" "$bid"; fi
  released "s$k" 2
  waitall
  refusals . "$tmp/${k}b" "$tmp/${k}a"
  quiet "$tmp/${k}b" "$tmp/${k}a"
  got="$(bal "$u") $(paid "$u") $(q -c "select (current_bidder_id = '$u') || ' ' || current_bid from public.auctions where id = '$au'") $(inv)"
  [[ $got == "2580 1 1 1 true 20 []" ]] || fail "mise contre crédit ($pass d'abord) : solde, achats, lignes stripe, wb_purchased, P meneur,
    prix, invariants : $got"
done
