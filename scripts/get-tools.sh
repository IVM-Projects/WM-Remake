#!/usr/bin/env bash
# Binaires du banc (PostgREST, GoTrue, Mailpit) dans .cache/<nom>/ : téléchargés une fois, SHA-256 vérifié à chaque appel.
set -euo pipefail

cache="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.cache"

# fetch <nom> <url> <sha256> <membres de l'archive…>
fetch() {
  local dir="$cache/$1" url="$2" sum="$3"
  shift 3
  local file="$dir/${url##*/}"
  mkdir -p "$dir"
  if ! echo "$sum  $file" | sha256sum -c --status 2>/dev/null; then
    curl -fsSL --retry 4 --retry-all-errors --retry-delay 2 -o "$file" "$url"  # un 5xx ou une coupure passagère ne rougit pas la CI
    echo "$sum  $file" | sha256sum -c --status || { rm -f "$file"; echo "get-tools : SHA-256 inattendu pour ${file##*/}" >&2; exit 1; }
  fi
  # Toujours réextrait : les binaires sont ceux de l'archive vérifiée.
  tar -xf "$file" -C "$dir" --no-same-owner "$@"
}

# Épinglé au premier téléchargement (2026-10-19, 3 772 512 octets) ; aucune somme officielle publiée par le projet.
fetch postgrest https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz \
  9f71269e61ac3a940281e93ff415760f5957e430e475ba4c3889f3ede7d5527c postgrest
# 26 096 776 octets ; `auth migrate` lit ./migrations.
fetch gotrue https://github.com/supabase/auth/releases/download/v2.197.0/auth-v2.197.0-x86.tar.gz \
  9daff5d1939c3142a1586e435e6e2a7a2f71534ec40ff1b196b59b83ad5678f3 auth migrations
# 10 634 648 octets.
fetch mailpit https://github.com/axllent/mailpit/releases/download/v1.31.0/mailpit-linux-amd64.tar.gz \
  076b5ded9a2182842b93e761b9586a1a251445bffe2666f9f22a6dc14470237d mailpit

"$cache/postgrest/postgrest" --version >/dev/null
"$cache/gotrue/auth" version >/dev/null 2>&1
"$cache/mailpit/mailpit" version --no-release-check >/dev/null # sans contrôle en ligne : api.github.com hors d'atteinte du bac à sable
