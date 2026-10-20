#!/usr/bin/env bash
# open_pack en parallèle sur un même joueur (mini-catalogue et joueur supprimés à la sortie, intervalle minimal restauré) :
# 50 ouvertures sur un stock de 3 → 3 paquets, 15 copies, stock 0, 47 refus « Plus de paquets disponibles », invariants vides.
set -euo pipefail
q() { psql "$DATABASE_URL" -qXAt -v ON_ERROR_STOP=1 "$@"; }
tmp="$(mktemp -d)"
tag="packs_$RANDOM$RANDOM"
min="$(q -c "select value from wm.config where key = 'open_min_interval_s'")"
uid="$(q -c "select tests.make_user('$tag')")"
cleanup() {
  q -c "update wm.config set value = '$min' where key = 'open_min_interval_s'" -c "delete from auth.users where id = '$uid'" \
    -c "delete from wm.draw_pool where card_id in (select id from public.cards where wikipedia_title like '$tag %')" \
    -c "delete from public.cards where wikipedia_title like '$tag %'" -c "select wm.rebuild_draw_pool()" >/dev/null
  rm -rf "$tmp"
}
trap cleanup EXIT

# Intervalle à 0 : les 50 appels se suivent sous le verrou, seul le stock doit les départager.
q -c "update wm.config set value = '0' where key = 'open_min_interval_s'" \
  -c "insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def)
      select '$tag ' || i, 'https://fr.wikipedia.org/wiki/Essai', (enum_range(null::public.rarity))[1 + i % 6], 1000, 1000
      from generate_series(1, 10) i" \
  -c "select wm.rebuild_draw_pool()" -c "select wm.set_human_verified('$uid')" \
  -c "update public.profiles set packs_remaining = 3, packs_last_regen_at = now() where id = '$uid'" >/dev/null

# Le profil est verrouillé le temps de lancer les 50 appels : ils se disputent tous le même verrou à sa libération.
q -c "begin; select from public.profiles where id = '$uid' for update; select pg_sleep(2); commit;" >/dev/null &
blocker=$!
until [[ "$(q -c "select count(*) from pg_stat_activity where wait_event = 'PgSleep'")" == 1 ]]; do kill -0 "$blocker"; done

pids=()
for i in $(seq 50); do
  q -c "set role service_role; select wm.open_pack('$uid', 'Europe/Paris')" >/dev/null 2>"$tmp/o$i" & pids+=($!)
done
wait "$blocker"
fails=0
for p in "${pids[@]}"; do wait "$p" || fails=$((fails + 1)); done

[[ $fails == 47 ]] || { echo "échecs : $fails (47 attendus)" >&2; cat "$tmp"/* >&2; exit 1; }
[[ "$(grep -l 'Plus de paquets disponibles' "$tmp"/o* | wc -l)" == 47 ]] || { echo "erreur inattendue" >&2; cat "$tmp"/* >&2; exit 1; }

got="$(q -c "select format('%s %s %s %s', (select count(*) from public.user_cards where user_id = p.id), p.packs_remaining,
    s.packs_opened, s.cards_obtained)
  from public.profiles p join wm.user_stats s on s.user_id = p.id where p.id = '$uid'")"
[[ $got == '15 0 3 15' ]] || { echo "copies, stock, paquets ouverts, cartes obtenues : $got" >&2; exit 1; }
[[ "$(q -c 'select wm.check_invariants()')" == '[]' ]] || { echo "invariants violés" >&2; exit 1; }
