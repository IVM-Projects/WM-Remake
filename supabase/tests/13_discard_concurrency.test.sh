#!/usr/bin/env bash
# discard en parallèle sur un même joueur (carte et joueur supprimés à la sortie) :
# 25 défausses d'une copie à count = 1 et 25 d'une copie à count = 25 → 26 succès, 24 refus 42501, +26 WB, discard_wb 26, invariants vides.
set -euo pipefail
q() { psql "$DATABASE_URL" -qXAt -v ON_ERROR_STOP=1 "$@"; }
tmp="$(mktemp -d)"
tag="disc_$RANDOM$RANDOM"
uid="$(q -c "select tests.make_user('$tag', 7)")"
cleanup() {
  q -c "delete from auth.users where id = '$uid'" -c "delete from public.cards where wikipedia_title = '$tag'" >/dev/null
  rm -rf "$tmp"
}
trap cleanup EXIT

card="$(q -c "insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
              values ('$tag', 'https://fr.wikipedia.org/wiki/Essai', 'C', 1, 1) returning id")"
one="$(q -c "select (wm.grant_copy('$uid', '$card', false)).id")"
many="$(q -c "select (wm.grant_copy('$uid', '$card', true)).id")"
q -c "update public.user_cards set count = 25 where id = '$many'" >/dev/null

# Le profil est verrouillé jusqu'à ce que les 50 appels attendent derrière lui, 1 s au plus après le premier vu (la moitié du lock_timeout de
# bulk_discard, M4-2, même si les connexions arrivent lentement), 5 s au plus en tout : ils se disputent tous le même verrou à sa libération.
# Le bloqueur imprime le nombre maximal d'appels vus en attente.
cat >"$tmp/b.sql" <<SQL
begin;
do \$\$ declare n int; m int := 0; t timestamptz; t1 timestamptz := clock_timestamp(); begin
  perform from public.profiles where id = '$uid' for update;
  loop
    perform pg_stat_clear_snapshot();  -- sinon pg_stat_activity reste figé pour toute la transaction
    n := (select count(*) from pg_stat_activity where wait_event_type = 'Lock' and query like '%discard%');
    m := greatest(m, n);
    if t is null and n > 0 then t := clock_timestamp(); end if;
    exit when n >= 50 or clock_timestamp() > t + interval '1 second' or clock_timestamp() > t1 + interval '5 seconds';
    perform pg_sleep(0.05);
  end loop;
  perform set_config('wm_test.max_waiters', m::text, true);
end \$\$;
select current_setting('wm_test.max_waiters');
commit;
SQL
q -f "$tmp/b.sql" >"$tmp/b.out" 2>"$tmp/b.err" &
blocker=$!
until [[ "$(q -c "select count(*) from pg_stat_activity where wait_event = 'PgSleep'")" == 1 ]]; do kill -0 "$blocker"; done

pids=()
for i in $(seq 25); do
  q -c "set role service_role; select wm.discard('$uid', '$one')" >/dev/null 2>"$tmp/o$i" & pids+=($!)
  q -c "set role service_role; select wm.discard('$uid', '$many')" >/dev/null 2>"$tmp/m$i" & pids+=($!)
done
wait "$blocker" || { echo "bloqueur en erreur" >&2; cat "$tmp/b.err" >&2; exit 1; }
max="$(cat "$tmp/b.out")"
echo "13_discard_concurrency : $max appels au plus en attente derrière le bloqueur" >&2
# Au moins 25 : la contention est prouvée, même si, sur un runner lent, quelques appels partent après la libération.
(( max >= 25 )) || { echo "contention insuffisante : $max appels en attente (25 attendus au moins)" >&2; exit 1; }
fails=0
for p in "${pids[@]}"; do wait "$p" || fails=$((fails + 1)); done

# Seules des défausses de la copie unique échouent, et uniquement parce qu'elle n'est plus possédée.
[[ $fails == 24 ]] || { echo "échecs : $fails (24 attendus)" >&2; cat "$tmp"/* >&2; exit 1; }
[[ -z "$(cat "$tmp"/m*)" ]] || { echo "défausse de la copie à 25 en erreur" >&2; cat "$tmp"/m* >&2; exit 1; }
[[ "$(grep -l 42501 "$tmp"/o* | wc -l)" == 24 ]] || { echo "erreur inattendue" >&2; cat "$tmp"/o* >&2; exit 1; }

got="$(q -c "select format('%s %s %s %s %s', p.wikibidous_balance, s.discard_wb, s.discarded,
    (select count(*) from public.user_cards where user_id = p.id), (select count(*) from wm.wb_ledger where user_id = p.id))
  from public.profiles p join wm.user_stats s on s.user_id = p.id where p.id = '$uid'")"
[[ $got == '33 26 26 0 0' ]] || { echo "solde, discard_wb, défaussées, copies, lignes de grand livre : $got" >&2; exit 1; }
[[ "$(q -c 'select wm.check_invariants()')" == '[]' ]] || { echo "invariants violés" >&2; exit 1; }
