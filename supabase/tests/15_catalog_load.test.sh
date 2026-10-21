#!/usr/bin/env bash
# Chargement de bout en bout (catalog/src/load.ts, cible free) sur catalog/fixtures/expected : refus sans écriture (colonnes
# déplacées, parts hors tolérance) ; premier passage (insertions, essai \copy, comptes du pool) ; second passage identique
# derrière un stage laissé plein (mêmes ids, même état) ; reprise après une fusion interrompue (v2 : résumés changés,
# 10 paires de raretés échangées), sous des tirages continus d'une autre session (aucun null) ; invariants vides.
# Sources, médias, cartes, runs et stages supprimés à la sortie, pool reconstruit.
set -euo pipefail
q() { psql "$DATABASE_URL" -qXAt -v ON_ERROR_STOP=1 "$@"; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fx="$root/catalog/fixtures/expected"
tmp="$(mktemp -d)"
runs="$(q -c 'select coalesce(max(id), 0) from wm.catalog_runs')"
pid=
cleanup() {
  if [[ -n $pid ]]; then kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null || true; fi
  if [[ -n "${PICK_PID:-}" ]]; then kill "$PICK_PID" 2>/dev/null || true; fi
  # Clés étrangères NO ACTION vers public.cards : pool, médias et sources d'abord.
  q -c 'create temp table gone as select card_id from wm.card_source' \
    -c 'delete from wm.draw_pool where card_id in (select card_id from gone)' \
    -c 'delete from wm.card_media where card_id in (select card_id from gone)' \
    -c 'delete from wm.card_source where card_id in (select card_id from gone)' \
    -c 'delete from public.cards where id in (select card_id from gone)' -c "delete from wm.catalog_runs where id > $runs" \
    -c 'truncate wm.catalog_stage, wm.catalog_stage_media, wm.catalog_stage_result' -c 'select wm.rebuild_draw_pool()' >/dev/null
  rm -rf "$tmp"
}
trap cleanup EXIT
load() { node "$root/catalog/src/cli.ts" load --mode sample --target free --db "$DATABASE_URL" "$@"; }
fail() { echo "$1" >&2; cat "$tmp"/log* >&2 2>/dev/null || true; exit 1; }
size() { q -c 'select sum(pg_database_size(datname))::bigint from pg_database'; }
ids() { q -c "select string_agg(card_id || ':' || page_id, ',' order by page_id) from wm.card_source"; }
state() {
  q -c "select concat_ws(' ', (select md5(string_agg(c::text, ',' order by c.id)) from public.cards c),
    (select md5(string_agg(m::text, ',' order by m.card_id)) from wm.card_media m),
    (select md5(string_agg(d::text, ',' order by d.rarity, d.seq)) from wm.draw_pool d))"
}

# v2 : chaque résumé finit par « v2 », 10 paires échangent leur rareté (4 C↔PC, 3 R↔SR, 3 UR↔L : comptes par rareté inchangés).
mkdir "$tmp/v2"
cp "$fx/media.csv" "$fx/counts.json" "$tmp/v2/"
{ read -r rows; read -r want; read -r moved; } <<<"$(q -c 'create temp table v as select * from wm.catalog_stage limit 0' \
  -c "\copy v from '$fx/cards.csv' with (format csv, header true)" \
  -c "create temp table sw as select a.page_id, b.rarity
      from (select page_id, rarity, row_number() over (partition by rarity order by page_id) k from v) a
      join (select page_id, rarity, row_number() over (partition by rarity order by page_id) k from v) b
        on b.k = a.k and (a.rarity, b.rarity) in (('C', 'PC'), ('PC', 'C'), ('R', 'SR'), ('SR', 'R'), ('UR', 'L'), ('L', 'UR'))
      where a.k <= case when a.rarity in ('C', 'PC') then 4 else 3 end" \
  -c "update v set summary = coalesce(summary, '') || ' v2' where true" -c 'update v set rarity = sw.rarity from sw where sw.page_id = v.page_id' \
  -c "\copy (select * from v order by page_id) to '$tmp/v2/cards.csv' with (format csv, header true)" \
  -c 'select count(*) from v' -c 'select jsonb_object_agg(rarity, n) from (select rarity, count(*) n from v group by 1) c' \
  -c "select string_agg(page_id || ':' || rarity, ',' order by page_id) from sw having count(*) = 20")"
[[ -n $moved ]] || fail "v2 : 20 échanges de rareté attendus"

# Refus sans écriture : deux colonnes échangées dans l'en-tête (header match, dès l'essai) ; parts de l'échantillon hors
# tolérance (avant le premier appel psql).
mkdir "$tmp/cols" "$tmp/skew"
cp "$fx/media.csv" "$fx/counts.json" "$tmp/cols/"
sed '1s/,atk,def,/,def,atk,/' "$fx/cards.csv" >"$tmp/cols/cards.csv"
! load --dir "$tmp/cols" >/dev/null 2>"$tmp/log0" || fail "colonnes déplacées acceptées"
grep -q 'column name mismatch' "$tmp/log0" || fail "colonnes déplacées : refus inattendu"
cp "$fx/cards.csv" "$fx/media.csv" "$tmp/skew/"
jq '.selected.C = 0' "$fx/counts.json" >"$tmp/skew/counts.json"
! load --dir "$tmp/skew" >/dev/null 2>"$tmp/log0" || fail "parts hors tolérance acceptées"
[[ "$(cat "$tmp/log0")" == 'Parts de rareté hors tolérance : 57.19 points' ]] || fail "parts hors tolérance : refus inattendu"
[[ "$(q -c 'select (select count(*) from wm.card_source) + (select count(*) from wm.catalog_stage)')" == 0 ]] || fail "refus avec écriture"

# Premier passage : une carte par ligne, pool aux comptes de cards.csv à l'unité (taux 1, D§10.4).
load --dir "$fx" >"$tmp/out1" 2>"$tmp/log1" || fail "premier chargement en échec"
[[ "$(jq .inserted "$tmp/out1")" == "$rows" ]] || fail "insertions : $(cat "$tmp/out1") ($rows attendues)"
grep -qF 'essai \copy : 10 lignes' "$tmp/log1" || fail "journal sans essai \\copy"
[[ "$(q -c 'select jsonb_object_agg(rarity, n) from wm.catalog_stats where n > 0')" == "$want" ]] || fail "catalog_stats ≠ $want"
ids1="$(ids)"
state1="$(state)"

# Second passage identique derrière un stage laissé plein (\copy sans fusion) : vidé avant la mesure, il ne compte pas
# dans la taille ; rien ne change, ni id ni octet.
q -c "\copy wm.catalog_stage from '$fx/cards.csv' with (format csv, header true)" \
  -c "\copy wm.catalog_stage_media from '$fx/media.csv' with (format csv, header true)" >/dev/null
left="$(size)"
load --dir "$fx" >"$tmp/out2" 2>"$tmp/log2" || fail "second chargement en échec"
before="$(sed -n 's/^base avant chargement : \([0-9]*\) octets$/\1/p' "$tmp/log2")"
((before < left)) || fail "stage laissé compté dans la taille : $before ≥ $left"
[[ "$(jq -c '[.unchanged, .inserted]' "$tmp/out2")" == "[$rows,0]" ]] || fail "second passage : $(cat "$tmp/out2")"
[[ "$(ids)" == "$ids1" && "$(state)" == "$state1" ]] || fail "second passage : ids ou état changés"

# Interruption : v2 au stage et un seul lot de 50, puis le chargement complet de v2 (lots de 100), qui vide d'abord le stage
# et ses résultats ; sans cela, l'essai \copy lèverait 23505 et les 50 pages déjà fusionnées seraient sautées.
q -c "\copy wm.catalog_stage from '$tmp/v2/cards.csv' with (format csv, header true)" \
  -c "\copy wm.catalog_stage_media from '$tmp/v2/media.csv' with (format csv, header true)" -c "select wm.catalog_merge('sample', 50)" >/dev/null
load --dir "$tmp/v2" --batch 100 >"$tmp/out3" 2>"$tmp/log3" &
pid=$!
# Une seule session tire par lots de 1 000 tant que le chargement tourne.
coproc PICK { q; }
nulls=0
lots=0
while kill -0 "$pid" 2>/dev/null; do
  echo "select count(*) - count(c) from (select wm.pick_card(null, '{}') c from generate_series(1, 1000)) x;" >&"${PICK[1]}"
  read -r n <&"${PICK[0]}"
  nulls=$((nulls + n))
  lots=$((lots + 1))
done
wait "$pid" || fail "chargement de v2 en échec"
pid=
exec {PICK[1]}>&-
wait "$PICK_PID"
! grep -qE '23505|duplicate key' "$tmp/log3" || fail "23505 au chargement de v2"
[[ "$(jq -c '[.unchanged, .updated]' "$tmp/out3")" == "[50,$((rows - 50))]" ]] || fail "v2 : $(cat "$tmp/out3") (unchanged 50 attendu)"
[[ "$(q -c "select count(*) from wm.card_source x join public.cards c on c.id = x.card_id where c.summary like '% v2'")" == "$rows" ]] ||
  fail "v2 : résumés non repris"
[[ "$(q -c "select string_agg(x.page_id || ':' || d.rarity, ',' order by x.page_id) from wm.card_source x join wm.draw_pool d using (card_id)
    where x.page_id in (select split_part(e, ':', 1)::bigint from unnest(string_to_array('$moved', ',')) e)")" == "$moved" ]] ||
  fail "v2 : raretés échangées absentes du pool"
[[ "$(ids)" == "$ids1" ]] || fail "v2 : ids changés"
# Pool dense (M2-10) : par rareté seq = 1..n avec n = catalog_stats.n, card_id uniques, une entrée par ligne de cards.csv.
[[ "$(q -c "select bool_and(coalesce((select array_agg(seq order by seq) from wm.draw_pool d where d.rarity = r), '{}')
      = array(select generate_series(1, coalesce((select n from wm.catalog_stats s where s.rarity = r), 0))))
    and (select count(distinct card_id) = $rows and count(*) = $rows from wm.draw_pool)
    and (select sum(n) = $rows from wm.catalog_stats)
  from unnest(enum_range(null::public.rarity)) r")" == t ]] || fail "pool non dense"
[[ "$(q -c 'select (select count(*) from wm.catalog_stage) + (select count(*) from wm.catalog_stage_media)
    + (select count(*) from wm.catalog_stage_result)')" == 0 ]] || fail "stage non vidé"
((lots > 0 && nulls == 0)) || fail "tirages pendant la fusion : $nulls null sur $lots lots de 1 000"
[[ "$(q -c 'select wm.check_invariants()')" == '[]' ]] || fail "invariants violés"
