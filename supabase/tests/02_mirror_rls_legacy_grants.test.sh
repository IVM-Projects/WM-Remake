#!/usr/bin/env bash
# 0002 rejouée sur une base aux anciens défauts Supabase (GRANT ALL, droit de colonne) : mêmes droits exacts.
set -euo pipefail
d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
psql "$DATABASE_URL" -qX -v ON_ERROR_STOP=1 -c begin \
  -c 'grant all on all tables in schema public to public, anon, authenticated' \
  -c 'grant update (count) on public.user_cards to public, anon, authenticated' \
  -f "$d/../migrations/0002_mirror_rls.sql" -f "$d/02_mirror_rls.test.sql" -c rollback
