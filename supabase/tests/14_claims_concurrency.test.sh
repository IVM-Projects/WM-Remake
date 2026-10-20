#!/usr/bin/env bash
# pro_daily_claim et claim_grace en parallèle sur un même joueur Pro (mini-catalogue et joueur supprimés à la sortie) :
# 20 Pro du jour en alternant Etc/GMT+12 et Etc/GMT-14 (26 h d'écart, jamais le même jour : la clé primaire ne les départage pas)
# → 1 succès, 19 already_claimed ; 20 grâces sur une seule dotation → 1 succès, 19 no_grace ; 20 copies, invariants vides.
set -euo pipefail
q() { psql "$DATABASE_URL" -qXAt -v ON_ERROR_STOP=1 "$@"; }
tmp="$(mktemp -d)"
tag="claims_$RANDOM$RANDOM"
uid="$(q -c "select tests.make_user('$tag')")"
cleanup() {
  q -c "delete from auth.users where id = '$uid'" \
    -c "delete from wm.draw_pool where card_id in (select id from public.cards where wikipedia_title like '$tag %')" \
    -c "delete from public.cards where wikipedia_title like '$tag %'" -c "select wm.rebuild_draw_pool()" >/dev/null
  rm -rf "$tmp"
}
trap cleanup EXIT

q -c "insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
      select '$tag ' || i, 'https://fr.wikipedia.org/wiki/Essai', (enum_range(null::public.rarity))[1 + i % 6], 1000, 1000
      from generate_series(1, 10) i" \
  -c "select wm.rebuild_draw_pool()" -c "select wm.set_human_verified('$uid')" \
  -c "update public.profiles set is_pro = true where id = '$uid'" \
  -c "insert into wm.grace_grants (user_id, size) values ('$uid', 5)" >/dev/null

# Le profil est verrouillé le temps de lancer les 40 appels : ils se disputent tous le même verrou à sa libération.
q -c "begin; select from public.profiles where id = '$uid' for update; select pg_sleep(2); commit;" >/dev/null &
blocker=$!
until [[ "$(q -c "select count(*) from pg_stat_activity where wait_event = 'PgSleep'")" == 1 ]]; do kill -0 "$blocker"; done

pids=()
for i in $(seq 20); do
  tz=Etc/GMT-14; (( i % 2 )) && tz=Etc/GMT+12
  q -c "set role service_role; select wm.pro_daily_claim('$uid', '$tz')" >/dev/null 2>"$tmp/p$i" & pids+=($!)
  q -c "set role service_role; select wm.claim_grace('$uid')" >/dev/null 2>"$tmp/g$i" & pids+=($!)
done
wait "$blocker"
fails=0
for p in "${pids[@]}"; do wait "$p" || fails=$((fails + 1)); done

[[ $fails == 38 ]] || { echo "échecs : $fails (38 attendus)" >&2; cat "$tmp"/* >&2; exit 1; }
[[ "$(grep -l already_claimed "$tmp"/p* | wc -l)" == 19 ]] || { echo "Pro du jour : erreur inattendue" >&2; cat "$tmp"/p* >&2; exit 1; }
[[ "$(grep -l no_grace "$tmp"/g* | wc -l)" == 19 ]] || { echo "grâce : erreur inattendue" >&2; cat "$tmp"/g* >&2; exit 1; }

got="$(q -c "select format('%s %s %s %s %s', (select count(*) from public.user_cards where user_id = p.id),
    (select count(*) from wm.pro_daily_claims where user_id = p.id),
    (select count(*) from wm.grace_grants where user_id = p.id and claimed_at is not null), s.packs_opened, s.cards_obtained)
  from public.profiles p join wm.user_stats s on s.user_id = p.id where p.id = '$uid'")"
[[ $got == '20 1 1 2 20' ]] || { echo "copies, Pro du jour, grâces, paquets ouverts, cartes obtenues : $got" >&2; exit 1; }
[[ "$(q -c 'select wm.check_invariants()')" == '[]' ]] || { echo "invariants violés" >&2; exit 1; }
