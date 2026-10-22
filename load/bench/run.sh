#!/usr/bin/env bash
# Benchs du marché en tables journalisées (M3-4, P14), sur le banc local seulement, jamais sur la démo : mises sur une enchère disputée,
# mises réparties sur 50 enchères, puis règlement de 5 000 enchères sous des lectures de la liste (P9). Chiffres indicatifs (A5), le M8
# mesure sur Pro. Jamais pendant un banc de contrat ou d'E2E : il reprend .cache/pg et le port 54329, que db-test.sh:22-25 efface au
# démarrage.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
here="$root/load/bench"
pgbench="${PGBIN:-/usr/lib/postgresql/16/bin}/pgbench"
unset DATABASE_URL  # seule source ensuite : la ligne de --setup-only, donc le cluster local
eval "$(env -u DATABASE_URL PG_FSYNC=on bash "$root/scripts/db-test.sh" --setup-only)"
tmp="$(mktemp -d)"
# Avec DATABASE_URL posé, --stop ne ferait rien (db-test.sh:12).
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
wait "$reader"
cat "$tmp/read"
ms="$(sed -n 's/^Time: \([0-9.]*\) ms.*/\1/p' "$tmp/settle")"
# Une ligne de progression couvre la seconde qui finit à son horodatage : marquée si elle recouvre [t0, t0 + durée du lot].
reads="$(awk -v t0="$t0" -v ms="$ms" '/^progress:/ { print $0 ($2 > t0 && $2 - 1 < t0 + ms / 1000 ? "  <- règlement" : "") }' "$tmp/read")"

[[ "$(deadlocks)" == "$dl0" ]] || fail "interblocages : $dl0 avant, $(deadlocks) après"
inv="$(q -c 'select wm.check_invariants()')"
[[ $inv == '[]' ]] || fail "invariants violés : $inv"
printf '%s\n' '' '== Résumé' "${summary[@]}" "règlement de 5 000 enchères : $ms ms" 'lectures (wm.market_list), seconde par seconde :' \
  "$reads" "interblocages : 0 ; invariants : $inv"
