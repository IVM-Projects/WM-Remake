#!/usr/bin/env bash
# Modèles de quiz sur les 299 cartes réelles de catalog/fixtures/expected/cards.csv (M5a-9) : quiz_fixtures.sql, dans une transaction
# annulée. ON_ERROR_STOP : sans lui, psql rendrait le statut du rollback final, toujours 0.
set -euo pipefail
d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$d/../.." && pwd)"
psql "$DATABASE_URL" -qX -v ON_ERROR_STOP=1 -c begin \
  -c "create temp table fx (page_id bigint, wikipedia_title text, wikipedia_url text, lang text, rarity public.rarity, atk int, def int, q_score numeric, pageviews int, pageviews_refreshed_at timestamptz, qscore_refreshed_at timestamptz, category text, summary text, image_url text)" \
  -c "\copy fx from '$root/catalog/fixtures/expected/cards.csv' csv header" -f "$d/quiz_fixtures.sql" -c rollback
