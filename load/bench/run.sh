#!/usr/bin/env bash
# Benchs du marché en tables journalisées (M3-4, P14), sur le banc local seulement, jamais sur la démo : mises sur une enchère disputée,
# mises réparties sur 50 enchères, puis règlement de 5 000 enchères sous des lectures de la liste (P9), puis acceptations d'échange
# 100 ↔ 100 et 10 ↔ 10 sur 5 000 échanges en attente, vitrine pleine et abonnements push des deux côtés (M4b-26), et leur expiration
# (M4-6), puis overlay des amis d'un joueur à 1 000 amis (B14). Chiffres indicatifs (A5), le M8 mesure sur Pro.
# Jamais pendant un banc de contrat ou d'E2E : il reprend .cache/pg et le port 54329, que db-test.sh:25-26 efface au démarrage.
set -euo pipefail
export LC_ALL=C  # « Time: » de psql et sorties de pgbench non traduits : sinon les durées se lisent vides
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
here="$root/load/bench"
pgbench="${PGBIN:-/usr/lib/postgresql/16/bin}/pgbench"
unset DATABASE_URL  # seule source ensuite : la ligne de --setup-only, donc le cluster local
# En deux temps : un eval de chaîne vide réussirait, alors qu'une affectation en échec arrête le script (set -e).
out="$(env -u DATABASE_URL PG_FSYNC=on bash "$root/scripts/db-test.sh" --setup-only)"
eval "$out"
tmp="$(mktemp -d)"
# Avec DATABASE_URL posé, --stop ne ferait rien (db-test.sh:13).
trap 'env -u DATABASE_URL bash "$root/scripts/db-test.sh" --stop; rm -rf "$tmp"' EXIT
q() { psql "$DATABASE_URL" -qXAt -v ON_ERROR_STOP=1 "$@"; }
fail() { echo "bench : $*" >&2; exit 1; }

[[ "$(q -c 'show fsync') $(q -c 'show synchronous_commit')" == 'on on' ]] || fail "fsync et synchronous_commit doivent valoir on"
deadlocks() { q -c 'select deadlocks from pg_stat_database where datname = current_database()'; }
dl0="$(deadlocks)"
q -f "$here/setup.sql" >/dev/null

# Mises : 50 clients pendant 30 s ; chaque run échoue si Δ bids_count des enchères du banc < 90 % des transactions (P14).
bids() { q -c 'select sum(a.bids_count) from public.auctions a join bench.auctions b using (id)'; }
summary=()
bench() {
  local b0 n ok
  b0="$(bids)"
  "$pgbench" -n -c 50 -j 4 -T 30 -f "$here/$1.sql" "$DATABASE_URL" | tee "$tmp/$1"
  n="$(sed -n 's/^number of transactions actually processed: \([0-9]*\).*/\1/p' "$tmp/$1")"
  [[ $n =~ ^[1-9][0-9]*$ ]] || fail "$1 : sortie pgbench illisible"
  # pgbench 16 compte un 40P01 en transaction échouée sans arrêter le client : il en faut 0.
  grep -q '^number of failed transactions: 0 ' "$tmp/$1" || fail "$1 : transactions en échec"
  ok=$(($(bids) - b0))
  summary+=("$1 : $(grep -o 'tps = [0-9.]*' "$tmp/$1"), $(grep -o 'latency average = [0-9.]* ms' "$tmp/$1"), mises réussies $ok sur $n")
  ((ok * 10 >= n * 9)) || fail "$1 : $ok mises réussies sur $n transactions (moins de 90 %)"
}
bench bid_hot
bench bid_spread

# Règlement : préparation, puis lot chronométré pendant que read.sql tourne ; 1,5 s avant le lot, pour une première seconde de lectures
# entière sans lui (P9).
q -v regle=off -f "$here/settle.sql"
"$pgbench" -n -c 4 -T 5 -P 1 --progress-timestamp -f "$here/read.sql" "$DATABASE_URL" >"$tmp/read" 2>&1 &
reader=$!
sleep 1.5
t0="$(date +%s.%N)"
q -v regle=on -f "$here/settle.sql" | tee "$tmp/settle"
wait "$reader" || { cat "$tmp/read" >&2; fail "lectures en échec"; }
cat "$tmp/read"
ms="$(sed -n 's/^Time: \([0-9.]*\) ms.*/\1/p' "$tmp/settle")"
[[ -n $ms ]] || fail "durée du règlement illisible"
# Une ligne de progression couvre la seconde qui finit à son horodatage : marquée si elle recouvre [t0, t0 + durée du lot].
reads="$(awk -v t0="$t0" -v ms="$ms" '/^progress:/ { print $0 ($2 > t0 && $2 - 1 < t0 + ms / 1000 ? "  <- règlement" : "") }' "$tmp/read")"

# Latence par transaction en 3e colonne des journaux de pgbench (µs) : nombre, p95 en µs, puis p50, p95 et max en ms, au rang le plus proche.
lat() { cut -d' ' -f3 "$@" | sort -n | awk '{ v[NR] = $1 } END { p50 = v[int((50 * NR + 99) / 100)]
  p95 = v[int((95 * NR + 99) / 100)]; printf "%d %d %.1f %.1f %.1f\n", NR, p95, p50 / 1000, p95 / 1000, v[NR] / 1000 }'; }

# Acceptations (M4-6, M4b-26) : 10 clients × 10 tours, 100 ↔ 100 puis 10 ↔ 10 en témoin, vitrine pleine et un abonnement push par joueur.
# Échec si le p95 atteint 500 ms.
q -f "$here/trade_setup.sql" >/dev/null
accept=()
declare -A p95
for size in 100 10; do
  "$pgbench" -n -c 10 -j 10 -t 10 -D size=$size -l --log-prefix="$tmp/acc$size" -f "$here/trade_accept.sql" "$DATABASE_URL" \
    | tee "$tmp/trade$size"
  grep -q '^number of failed transactions: 0 ' "$tmp/trade$size" || fail "acceptation $size : transactions en échec"
  ok="$(q -c "select count(*) from bench.trades b join public.trades t using (id) where b.size = $size and t.status = 'accepted'")"
  [[ $ok == 100 ]] || fail "acceptation $size : $ok échanges acceptés sur 100"
  read -r n us p50 p95ms max < <(lat "$tmp/acc$size".*)
  [[ $n == 100 ]] || fail "acceptation $size : $n lignes de journal sur 100"
  p95[$size]=$us
  # Les 8 emplacements posés à chaque tour pointaient vers des copies déplacées : trade_move les a vidés. Outbox vide au départ
  # (trade_setup.sql) et vidée après chaque taille : une trade_accepted par acceptation, pour l'abonnement de l'initiateur.
  sc="$(q -c 'select count(*) from public.showcase where user_id in (select uid from bench.trade_players)')"
  [[ $sc == 0 ]] || fail "acceptation $size : $sc emplacements de vitrine restants sur 0"
  ob="$(q -c 'select count(*) from wm.push_outbox')"
  [[ $ob == 100 ]] || fail "acceptation $size : $ob lignes d'outbox sur 100"
  accept+=("acceptation $size ↔ $size : p50 $p50 ms, p95 $p95ms ms, max $max ms ; $ok acceptés, $(grep -o 'tps = [0-9.]*' "$tmp/trade$size") ;\
 vitrines vidées, $ob lignes d'outbox")
  ((us < 500000)) || fail "acceptation $size : p95 de $us µs (moins de 500 000 exigés)"
  q -c 'delete from wm.push_outbox where true'
done
accept+=("rapport des p95 (100 ↔ 100 sur 10 ↔ 10) : $(awk -v a="${p95[100]}" -v b="${p95[10]}" 'BEGIN { printf "%.1f", a / b }')")

# Expiration des 5 000 échanges de fond en un lot chronométré, qui tient leurs verrous de ligne jusqu'à son commit.
q -c "update public.trades set expires_at = clock_timestamp() - interval '1 second' where status = 'pending' and id not in (select id from bench.trades)"
q -c '\timing on' -c 'select wm.expire_trades(5000)' | tee "$tmp/expire"
[[ "$(head -1 "$tmp/expire")" == 5000 ]] || fail "expiration : $(head -1 "$tmp/expire") échanges expirés sur 5 000"
xms="$(sed -n 's/^Time: \([0-9.]*\) ms.*/\1/p' "$tmp/expire")"
[[ -n $xms ]] || fail "durée de l'expiration illisible"

# Overlay des amis (B14) : plan lu par auto_explain sur les sorties LOG d'overlay.sql, puis 200 appels d'un client ; échec si le p95 atteint
# 50 ms.
q -f "$here/overlay.sql" 2>&1 >/dev/null | tee "$tmp/overlay_plan"
grep -q 'user_cards_card_user_idx' "$tmp/overlay_plan" || fail "overlay : user_cards_card_user_idx absent du plan"
if grep -q 'Seq Scan on user_cards' "$tmp/overlay_plan"; then fail "overlay : Seq Scan on user_cards dans le plan"; fi
echo 'select wm.cards_overlay(uid, ids) from bench.overlay;' >"$tmp/overlay_call.sql"
"$pgbench" -n -c 1 -t 200 -l --log-prefix="$tmp/ovl" -f "$tmp/overlay_call.sql" "$DATABASE_URL" | tee "$tmp/overlay"
grep -q '^number of failed transactions: 0 ' "$tmp/overlay" || fail "overlay : transactions en échec"
read -r n us p50 p95ms max < <(lat "$tmp/ovl".*)
[[ $n == 200 ]] || fail "overlay : $n lignes de journal sur 200"
((us < 50000)) || fail "overlay : p95 de $us µs (moins de 50 000 exigés)"
overlay="overlay des amis (1 000 amis, 50 cartes) : p50 $p50 ms, p95 $p95ms ms, max $max ms ; user_cards_card_user_idx, aucun Seq Scan on user_cards"

[[ "$(deadlocks)" == "$dl0" ]] || fail "interblocages : $dl0 avant, $(deadlocks) après"
inv="$(q -c 'select wm.check_invariants()')"
[[ $inv == '[]' ]] || fail "invariants violés : $inv"
printf '%s\n' '' '== Résumé' "${summary[@]}" "règlement de 5 000 enchères : $ms ms" 'lectures (wm.market_list), seconde par seconde :' \
  "$reads" "${accept[@]}" "expiration de 5 000 échanges en attente : $xms ms" "$overlay" "interblocages : 0 ; invariants : $inv"
