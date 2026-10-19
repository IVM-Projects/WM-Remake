#!/usr/bin/env bash
# wallet_apply en parallèle sur un même joueur (données validées, nettoyées à la sortie) :
# 20 débits de 10 et 20 rejeux du même crédit de 5 sur 100 WB → solde 5, 10 débits, un seul crédit, invariants vides.
set -euo pipefail
q() { psql "$DATABASE_URL" -qXAt -v ON_ERROR_STOP=1 "$@"; }
tmp="$(mktemp -d)"
uid="$(q -c "select tests.make_user('conc_' || gen_random_uuid(), 100)")"
trap 'q -c "delete from auth.users where id = '\''$uid'\''" >/dev/null; rm -rf "$tmp"' EXIT

# Le profil est verrouillé le temps de lancer les 40 appels : ils se disputent tous le même verrou à sa libération.
q -c "begin; select from public.profiles where id = '$uid' for update; select pg_sleep(2); commit;" >/dev/null &
blocker=$!
until [[ "$(q -c "select count(*) from pg_stat_activity where wait_event = 'PgSleep'")" == 1 ]]; do kill -0 "$blocker"; done

pids=()
for i in $(seq 20); do
  q -c "set role service_role; select wm.wallet_apply('$uid', -10, 'test', 'd$i')" >/dev/null 2>"$tmp/d$i" & pids+=($!)
  q -c "set role service_role; select wm.wallet_apply('$uid', 5, 'test', 'dup')" >/dev/null 2>"$tmp/c$i" & pids+=($!)
done
wait "$blocker"
fails=0
for p in "${pids[@]}"; do wait "$p" || fails=$((fails + 1)); done

# Seuls des débits échouent, et uniquement pour solde insuffisant.
[[ $fails == 10 ]] || { echo "échecs : $fails (10 attendus)" >&2; cat "$tmp"/* >&2; exit 1; }
[[ -z "$(cat "$tmp"/c*)" ]] || { echo "crédit en erreur" >&2; cat "$tmp"/c* >&2; exit 1; }
[[ "$(grep -l insufficient_balance "$tmp"/d* | wc -l)" == 10 ]] || { echo "erreur inattendue" >&2; cat "$tmp"/d* >&2; exit 1; }

got="$(q -c "select format('%s %s %s %s %s', p.wikibidous_balance,
    (select count(*) from wm.wb_ledger where user_id = p.id and ref like 'd%' and ref <> 'dup'),
    (select count(*) from wm.wb_ledger where user_id = p.id and ref = 'dup'),
    (select string_agg(delta::text, ',') from wm.wb_ledger where user_id = p.id and reason = 'opening'),
    (select bool_and(balance_after = s) from (select balance_after, sum(delta) over (order by id) s
                                              from wm.wb_ledger where user_id = p.id) l))
  from public.profiles p where p.id = '$uid'")"
[[ $got == '5 10 1 100 t' ]] || { echo "solde, débits, crédits, ouverture, soldes successifs : $got" >&2; exit 1; }
[[ "$(q -c 'select wm.check_invariants()')" == '[]' ]] || { echo "invariants violés" >&2; exit 1; }
