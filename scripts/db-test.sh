#!/usr/bin/env bash
# Banc de tests SQL : base wm_test neuve (cluster PG jetable dans .cache/pg, ou serveur de $DATABASE_URL),
# stub Supabase, migrations, helpers, puis supabase/tests/*.test.{sql,sh}.
# --setup-only : imprime une seule ligne DATABASE_URL=… et laisse la base en place.
# --stop : arrête et supprime le cluster local laissé par --setup-only (rien à faire avec $DATABASE_URL).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tests="$root/supabase/tests"
setup_only=false
[[ "${1:-}" == --setup-only ]] && setup_only=true
[[ "${1:-}" == --stop && -n "${DATABASE_URL:-}" ]] && exit 0

export LC_COLLATE=C                                                  # ordre lexical des migrations
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"     # pas de NOTICE parasite
shopt -s nullglob                                                    # dossier absent ou vide : boucle vide

if [[ -z "${DATABASE_URL:-}" ]]; then
  pgbin="${PGBIN:-/usr/lib/postgresql/16/bin}"
  dir="$root/.cache/pg"
  as_pg() { if [[ $EUID -eq 0 ]]; then runuser -u postgres -- "$@"; else "$@"; fi; }  # initdb refuse root
  cleanup() { as_pg "$pgbin/pg_ctl" -D "$dir" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$dir" "$dir.pw"; }
  cleanup  # un cluster laissé par un --setup-only précédent
  [[ "${1:-}" == --stop ]] && exit 0
  trap cleanup EXIT
  mkdir -p "$dir"
  echo postgres >"$dir.pw"
  if [[ $EUID -eq 0 ]]; then chown postgres: "$dir" "$dir.pw"; fi
  # Mot de passe + scram comme le postgres:17 de la CI, pour que les mots de passe de test soient vérifiés.
  as_pg "$pgbin/initdb" -D "$dir" -U postgres --pwfile="$dir.pw" --auth=scram-sha-256 -E UTF8 --locale=C.UTF-8 -N >/dev/null
  rm "$dir.pw"
  as_pg "$pgbin/pg_ctl" -D "$dir" -l "$dir/log" -w \
    -o "-p 54329 -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off" start >/dev/null
  DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres
fi

# shortcut: URL postgres://… uniquement (pas la forme clé=valeur), remplacer par un parse libpq si besoin.
url="$(sed -E 's#^([a-z]+://[^/?]*)(/[^?]*)?#\1/wm_test#' <<<"$DATABASE_URL")"
psql "$DATABASE_URL" -qX -v ON_ERROR_STOP=1 -c 'drop database if exists wm_test with (force)' -c 'create database wm_test'

run() { psql "$url" -qX -v ON_ERROR_STOP=1 "$@"; }

# stdout jeté : un SELECT de migration ne doit pas polluer la ligne DATABASE_URL= de --setup-only.
run -f "$tests/bootstrap_local.sql" >/dev/null
cron="$(run -Atc "select exists (select from pg_available_extensions where name = 'pg_cron')")"
for f in "$root"/supabase/migrations/*.sql; do
  [[ $cron == f && ${f##*/} == 9000_* ]] && continue
  run -f "$f" >/dev/null
done
run -f "$tests/helpers.sql" >/dev/null

if $setup_only; then
  trap - EXIT
  echo "DATABASE_URL=$url"
  exit 0
fi

for f in "$tests"/*.test.sql; do
  if run -c begin -f "$f" -c rollback >/dev/null; then echo "ok ${f##*/}"; else echo "FAIL ${f##*/}"; exit 1; fi
done
export DATABASE_URL="$url"
for f in "$tests"/*.test.sh; do
  if bash "$f" >/dev/null; then echo "ok ${f##*/}"; else echo "FAIL ${f##*/}"; exit 1; fi
done
