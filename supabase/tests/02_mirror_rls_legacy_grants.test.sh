#!/usr/bin/env bash
# 0002 (puis 0003, qui rouvre le catalogue à anon, 0004, le marché, et 0005, les échanges et amitiés) rejouées sur une base aux anciens défauts Supabase (GRANT ALL, droit de colonne) : mêmes droits exacts.
set -euo pipefail
d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
psql "$DATABASE_URL" -qX -v ON_ERROR_STOP=1 -c begin \
  -c 'grant all on all tables in schema public to public, anon, authenticated' \
  -c 'grant update (count) on public.user_cards to public, anon, authenticated' \
  -f "$d/../migrations/0002_mirror_rls.sql" -f "$d/../migrations/0003_mirror_rpc.sql" \
  -f "$d/../migrations/0004_mirror_market.sql" -f "$d/../migrations/0005_mirror_trades.sql" \
  -f "$d/02_mirror_rls.test.sql" -c rollback
