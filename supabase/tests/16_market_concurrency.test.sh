#!/usr/bin/env bash
# Marché en parallèle (joueurs et cartes supprimés à la sortie, config restaurée). Partout : aucun 40P01 ni 55P03, M = Σ soldes des quatre
# joueurs + Σ current_bid de leurs enchères actives menées, conservé à l'unité, invariants vides.
# 1. Surenchères croisées : 100 mises de A et B sur X et Y, lâchées d'un coup → seuls refus bid_too_low et « Tu es déjà en tête », chaque
#    mise remboursée au plus une fois.
# 2. Double règlement : 20 settle_auction(X) et 20 settle_due_auctions() → une seule ligne settle: par enchère, une seule copie gagnée.
# 3. Mise contre règlement à la fin de Z, sur 5 tours : jamais une mise acceptée après settled_at ; prolongée au 1er tour, réglée au 5e.
# 4. Cron contre mises (P9) : des lots de 4 qui alternent hi et lo pendant 40 surenchères de A et B sur W → les 20 réglées.
# 5. Ordre des verrous du lot (P9), déterministe : une mise simulée tient lo puis demande hi ; le lot attend < 1 s, sans 40P01.
# 6. settle_request contre une prolongation et un retrait validés pendant son attente du verrou → 409 et 404 (P8).
# 7. Diffusion contre mises (P28), suite de 4 : 20 enchères de V dont les cartes sont souhaitées, une sur deux, par hi seul puis par lo seul ;
#    un premier lot de 4 contre une mise simulée (lo, puis hi), puis des lots de 4 jusqu'à file vide pendant 40 surenchères de A et B sur W
#    → 20 wishlist_listed.
set -euo pipefail
q() { psql "$DATABASE_URL" -qXAt -v ON_ERROR_STOP=1 "$@"; }
tmp="$(mktemp -d)"
tag="mkt_$RANDOM$RANDOM"
keys="'market_bid_burst', 'market_list_burst', 'max_concurrent_auctions'"
cfg="$(q -c "select jsonb_object_agg(key, value) from wm.config where key in ($keys)")"
cleanup() {
  q -c "delete from auth.users where id in (select id from public.profiles where username like '${tag}_%')" \
    -c "delete from public.cards where wikipedia_title like '$tag %'" \
    -c "update wm.config set value = '$cfg'::jsonb -> key where key in ($keys)" >/dev/null
  rm -rf "$tmp"
}
trap cleanup EXIT
fail() { echo "$1" >&2; shift; (( $# == 0 )) || cat "$@" >&2; exit 1; }  # $2… : sorties d'erreur à montrer

q -c "update wm.config set value = '{\"count\": 100000, \"window_s\": 60}' where key in ('market_bid_burst', 'market_list_burst')" \
  -c "update wm.config set value = '{\"free\": 1000, \"pro\": 1000}' where key = 'max_concurrent_auctions'" >/dev/null
player() { q -c "select tests.make_user('${tag}_$1', 1000000)"; }
v="$(player v)"; a="$(player a)"; b="$(player b)"; t="$(player t)"
q -c "select wm.set_human_verified(u) from unnest(array['$v', '$a', '$b', '$t']::uuid[]) u" >/dev/null
lo="$(q -c "select least('$a'::uuid, '$b'::uuid)")"; hi="$(q -c "select greatest('$a'::uuid, '$b'::uuid)")"
card() { q -c "insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
  values ('$tag $1', 'https://fr.wikipedia.org/wiki/Essai', 'R', 1000, 1000) returning id"; }
cx="$(card x)"; cy="$(card y)"; cz="$(card z)"
list() { q -c "select wm.create_auction('$1', (wm.grant_copy('$1', '$2', false)).id, 10, 60) ->> 'auction_id'"; }
money() {
  q -c "select (select sum(wikibidous_balance) from public.profiles where id in ('$v', '$a', '$b', '$t'))
    + (select coalesce(sum(current_bid), 0) from public.auctions where seller_id in ('$v', '$a', '$b', '$t') and status = 'active'
       and current_bidder_id is not null)"
}
# Appels en arrière-plan, SQLSTATE dans les erreurs (VERBOSITY verbose) : $1 = fichier d'erreurs, puis la requête.
pids=()
bg() { q -v VERBOSITY=verbose -c "set role service_role; $2" >/dev/null 2>"$tmp/$1" & pids+=($!); }
# Même chose, mais l'appel part à l'heure du serveur $2 (pg_sleep_until) : connexion et fork ne mangent pas la fenêtre.
bgat() { q -v VERBOSITY=verbose -c "select pg_sleep_until($2)" -c "set role service_role; $3" >/dev/null 2>"$tmp/$1" & pids+=($!); }
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

# 1. Surenchères croisées : X et Y sont tenues 1 s (la moitié du lock_timeout) le temps de lancer les 100 mises.
x="$(list "$v" "$cx")"; y="$(list "$v" "$cy")"
m0="$(money)"
q -c "begin; select from public.auctions where id in ('$x', '$y') for update; select pg_sleep(1); commit;" >/dev/null &
blocker=$!
until [[ "$(q -c "select count(*) from pg_stat_activity where wait_event = 'PgSleep'")" == 1 ]]; do kill -0 "$blocker"; done
for i in $(seq 25); do
  bg "1ax$i" "select wm.place_bid('$a', '$x', $((100 + 4 * i)))"
  bg "1bx$i" "select wm.place_bid('$b', '$x', $((102 + 4 * i)))"
  bg "1by$i" "select wm.place_bid('$b', '$y', $((100 + 4 * i)))"
  bg "1ay$i" "select wm.place_bid('$a', '$y', $((102 + 4 * i)))"
done
wait "$blocker"
waitall
refusals 'bid_too_low|Tu es déjà en tête' "$tmp"/1*
(( fails > 0 && fails < 100 )) || fail "surenchères : $fails échecs"
[[ -z "$(q -c "select count(*) from wm.wb_ledger where reason = 'refund' group by ref having count(*) > 1")" ]] || fail "remboursement en double"
check surenchères

# 2. Double règlement.
q -c "update public.auctions set end_at = now() - interval '1 second' where id in ('$x', '$y')" >/dev/null
for i in $(seq 20); do
  bg "2s$i" "select wm.settle_auction('$x')"
  bg "2d$i" "select wm.settle_due_auctions()"
done
waitall
quiet "$tmp"/2*
[[ $fails == 0 ]] || fail "double règlement : $fails échecs"
got="$(q -c "select format('%s %s %s', (select count(*) from public.auctions where id in ('$x', '$y') and status = 'settled_sold'),
    (select count(*) from wm.wb_ledger where ref = 'settle:$x'), (select count(*) from wm.wb_ledger where ref = 'settle:$y'))")"
[[ $got == '2 1 1' ]] || fail "X et Y réglées, lignes settle:<X> et settle:<Y> : $got"
[[ "$(q -c "select count(*) = 1 and bool_and(k.obtained_at = x.settled_at) from public.user_cards k join public.auctions x on x.id = '$x'
  where k.user_id = x.winner_id and k.card_id = x.card_id")" == t ]] || fail "copie gagnée de X"
check "double règlement"

# 3. Mise contre règlement : Z finit 1 s après sa mise de 10 ; 20 mises (B 11, A 12, … A 30) et 20 règlements partent, entrelacés, en
# 0,3 s, après 0,8 s au 1er tour … 1,2 s au 5e (tout après end_at), à l'heure du serveur comptée depuis end_at.
rounds=""
delays=(0.8 0.9 1.0 1.1 1.2)
for r in 0 1 2 3 4; do
  z="$(list "$v" "$cz")"
  q -c "select wm.place_bid('$a', '$z', 10)" >/dev/null
  e0="$(q -c "update public.auctions set end_at = clock_timestamp() + interval '1 second' where id = '$z' returning end_at")"
  for i in $(seq 20); do
    w="$b"; (( i % 2 )) || w="$a"
    at="'$e0'::timestamptz + make_interval(secs => ${delays[r]} - 1 + 0.015 * ($i - 1))"
    bgat "3b$r-$i" "$at" "select wm.place_bid('$w', '$z', $((10 + i)))"
    bgat "3s$r-$i" "$at + interval '7.5 milliseconds'" "select wm.settle_auction('$z')"
  done
  waitall
  quiet "$tmp"/3s"$r"-*
  refusals 'bid_too_low|Tu es déjà en tête|Cette enchère est terminée' "$tmp"/3b"$r"-*
  got="$(q -c "select case when z.status = 'settled_sold' then format('réglée %s %s %s',
      (select count(*) from public.auction_bids where auction_id = z.id and placed_at > z.settled_at),
      (select count(*) from wm.wb_ledger where ref = 'settle:' || z.id), z.final_price = z.current_bid)
    when z.status = 'active' and z.end_at >= '$e0'::timestamptz + interval '60 seconds' then 'prolongée'
    else to_jsonb(z)::text end from public.auctions z where id = '$z'")"
  [[ $got == 'réglée 0 1 t' || $got == prolongée ]] || fail "tour $((r + 1)) : $got"
  rounds+="${got%% *} "
  check "tour $((r + 1))"
done
[[ $rounds == prolongée* && $rounds == *'réglée ' ]] || fail "tours : $rounds(prolongée au 1er, réglée au 5e attendues)"

# 4. Cron contre mises : 20 enchères vendues une sur deux par hi puis par lo, menées par T, échues en bloc avec des end_at croissants dans cet
# ordre ; des lots de 4 tournent pendant 40 surenchères croisées de A et B sur W, jusqu'à ce que les 20 soient réglées.
q -c "do \$\$ declare x uuid; s uuid; begin
  for i in 1 .. 20 loop
    s := case when i % 2 = 1 then '$hi'::uuid else '$lo'::uuid end;
    x := wm.create_auction(s, (wm.grant_copy(s, '$cz', false)).id, 10, 60) ->> 'auction_id';
    perform wm.place_bid('$t', x, 10);
    update public.auctions set end_at = now() - interval '1 minute' + make_interval(secs => i) where id = x;
  end loop;
end \$\$" >/dev/null
wa="$(list "$v" "$cz")"
due="select count(*) from public.auctions where seller_id in ('$lo', '$hi') and status = 'settled_sold'"
(
  for n in $(seq 200); do
    [[ "$(q -c "$due")" == 20 ]] && exit 0
    q -v VERBOSITY=verbose -c "set role service_role; select wm.settle_due_auctions(4)" >/dev/null 2>>"$tmp/4cron" || true
  done
) & pids+=($!)
# Montants au minimum suivant (10, 11, 13, 15…) : arrivées dans l'ordre, toutes passent et verrouillent A et B, comme le lot.
m=10
for i in $(seq 20); do
  bg "4a$i" "select wm.place_bid('$a', '$wa', $m)"; m=$(((11 * m + 9) / 10))
  bg "4b$i" "select wm.place_bid('$b', '$wa', $m)"; m=$(((11 * m + 9) / 10))
  sleep 0.015
done
waitall
touch "$tmp/4cron"
quiet "$tmp/4cron"
refusals 'bid_too_low|Tu es déjà en tête' "$tmp"/4[ab]*
[[ "$(q -c "$due")" == 20 ]] || fail "cron : $(q -c "$due") réglées sur 20"
check "cron contre mises"

# 5. Ordre des verrous du lot : le bloqueur imite une mise (lo, puis hi une seconde plus tard) ; le lot doit tout prendre trié d'un coup, lo
# d'abord, et attendre < 1 s. (a) hi puis lo vendeurs, sans mise : attrape le lot verrouillé enchère par enchère ou sans ses vendeurs ;
# (b) vendue par hi, menée par lo : attrape le lot sans ses meneurs. Chacun de ces trois défauts tient hi en attendant lo → 40P01.
lockstep() {  # $1 = étiquette, puis les enchères, dans l'ordre de end_at
  local k="$1" ids; shift
  ids="$(printf "'%s'," "$@")"; ids="array[${ids%,}]::uuid[]"
  q -c "update public.auctions a set end_at = now() - interval '1 minute' + make_interval(secs => v.n)
    from unnest($ids) with ordinality v (id, n) where a.id = v.id" >/dev/null
  q -v VERBOSITY=verbose -c "begin; select from public.profiles where id = '$lo' for update; select pg_sleep(1);
    select from public.profiles where id = '$hi' for update; commit;" >/dev/null 2>"$tmp/5$k-mise" &
  blocker=$!
  until [[ "$(q -c "select count(*) from pg_stat_activity where wait_event = 'PgSleep'")" == 1 ]]; do kill -0 "$blocker"; done
  q -v VERBOSITY=verbose -c "set role service_role; select wm.settle_due_auctions()" >/dev/null 2>"$tmp/5$k-lot" || true
  wait "$blocker" || true
  quiet "$tmp/5$k-mise" "$tmp/5$k-lot"
  [[ "$(q -c "select count(*) from public.auctions where id = any ($ids) and status <> 'active'")" == $# ]] || fail "lot $k : non réglé"
}
lockstep a "$(list "$hi" "$cz")" "$(list "$lo" "$cz")"
l5="$(list "$hi" "$cz")"
q -c "select wm.place_bid('$lo', '$l5', 10)" >/dev/null
lockstep b "$l5"
check "ordre des verrous du lot"

# 6. settle_request contre une écriture validée pendant qu'il attend le verrou : enchère échue au moment de ses refus, puis prolongée (comme
# une mise de dernière seconde) → 409 ; puis retirée → 404. Le refus annule aussi la clé d'idempotence.
race() {  # $1 = étiquette, $2 = enchère, $3 = écriture du bloqueur, $4 = message attendu
  q -c "begin; $3; select pg_sleep(1); commit;" >/dev/null &
  blocker=$!
  until [[ "$(q -c "select count(*) from pg_stat_activity where wait_event = 'PgSleep'")" == 1 ]]; do kill -0 "$blocker"; done
  ! q -v VERBOSITY=verbose -c "set role service_role; select wm.settle_request('$t', '$2', '$tag $1')" >/dev/null 2>"$tmp/6$1" \
    || fail "settle_request $1 : accepté"
  wait "$blocker"
  refusals "$4" "$tmp/6$1"
  [[ "$(q -c "select count(*) from wm.idempotency_keys where user_id = '$t' and key = '$tag $1'")" == 0 ]] || fail "clé $1 gardée"
}
z6="$(list "$v" "$cz")"
q -c "select wm.place_bid('$a', '$z6', 10)" -c "update public.auctions set end_at = now() - interval '1 second' where id = '$z6'" >/dev/null
race prolongée "$z6" "update public.auctions set end_at = clock_timestamp() + interval '1 hour' where id = '$z6'" \
  "L'enchère n'est pas encore terminée"
z6="$(list "$v" "$cz")"
q -c "update public.auctions set end_at = now() - interval '1 second' where id = '$z6'" >/dev/null
race retirée "$z6" "select wm.cancel_auction('$v', '$z6')" 'Enchère introuvable'
check "settle_request contre un verrou"

# 7. Diffusion contre mises : chaque lot de 4 notifie hi et lo (ordre de la file : hi, lo, hi, lo). Inséré dans cet ordre, il prendrait le
# FOR KEY SHARE de hi puis de lo, à l'envers d'une mise qui tient lo et attend hi (40P01) ; trié par user_id, jamais (P28). D'abord
# déterministe : le bloqueur imite une mise (lo, puis hi une seconde plus tard) pendant le premier lot ; puis la boucle pendant les mises.
ch="$(card h)"; cl="$(card l)"
q -c "insert into public.wishlist_items (user_id, card_id) values ('$hi', '$ch'), ('$lo', '$cl')" \
  -c "do \$\$ begin
  for i in 1 .. 20 loop
    perform wm.create_auction('$v', (wm.grant_copy('$v', (case when i % 2 = 1 then '$ch' else '$cl' end)::uuid, false)).id, 10, 60);
  end loop;
end \$\$" >/dev/null
w7="$(list "$v" "$cz")"
pending="select count(*) from wm.wishlist_alert_queue where done_at is null"
q -v VERBOSITY=verbose -c "begin; select from public.profiles where id = '$lo' for update; select pg_sleep(1);
  select from public.profiles where id = '$hi' for update; commit;" >/dev/null 2>"$tmp/7mise" &
blocker=$!
until [[ "$(q -c "select count(*) from pg_stat_activity where wait_event = 'PgSleep'")" == 1 ]]; do kill -0 "$blocker"; done
got="$(q -v VERBOSITY=verbose -c "set role service_role; select wm.wishlist_alerts_fanout(4)" 2>"$tmp/7lot" || true)"
wait "$blocker" || true
quiet "$tmp/7mise" "$tmp/7lot"
[[ $got == 4 ]] || fail "premier lot : $got notifications, 4 attendues"
(
  for n in $(seq 200); do
    [[ "$(q -c "$pending")" == 0 ]] && exit 0
    q -v VERBOSITY=verbose -c "set role service_role; select wm.wishlist_alerts_fanout(4)" >/dev/null 2>>"$tmp/7fan" || true
  done
) & pids+=($!)
m=10
for i in $(seq 20); do
  bg "7a$i" "select wm.place_bid('$a', '$w7', $m)"; m=$(((11 * m + 9) / 10))
  bg "7b$i" "select wm.place_bid('$b', '$w7', $m)"; m=$(((11 * m + 9) / 10))
  sleep 0.015
done
waitall
touch "$tmp/7fan"
quiet "$tmp/7fan"
refusals 'bid_too_low|Tu es déjà en tête' "$tmp"/7[ab]*
[[ "$(q -c "$pending")" == 0 ]] || fail "diffusion : $(q -c "$pending") lignes de file en attente"
got="$(q -c "select format('%s %s', count(*) filter (where user_id = '$hi' and data ->> 'card_id' = '$ch'),
  count(*) filter (where user_id = '$lo' and data ->> 'card_id' = '$cl')) from public.notifications where type = 'wishlist_listed'")"
[[ $got == '10 10' ]] || fail "diffusion : $got wishlist_listed pour hi et lo, 10 10 attendus"
check "diffusion contre mises"
