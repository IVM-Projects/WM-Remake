#!/usr/bin/env bash
# Binaire PostgREST du banc de contrat dans .cache/postgrest/ : téléchargé une fois, SHA-256 vérifié à chaque appel.
set -euo pipefail

version=v12.2.3
# Épinglé au premier téléchargement (2026-10-19, 3 772 512 octets) ; aucune somme officielle publiée par le projet.
sha256=9f71269e61ac3a940281e93ff415760f5957e430e475ba4c3889f3ede7d5527c
name="postgrest-$version-linux-static-x64.tar.xz"
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.cache/postgrest"
mkdir -p "$dir"

check() { echo "$sha256  $dir/$name" | sha256sum -c --status; }
if ! check 2>/dev/null; then
  curl -fsSL -o "$dir/$name" "https://github.com/PostgREST/postgrest/releases/download/$version/$name"
  check || { rm -f "$dir/$name"; echo "get-postgrest : SHA-256 inattendu pour $name" >&2; exit 1; }
fi
# Toujours réextrait : le binaire est celui de l'archive vérifiée.
tar -xJf "$dir/$name" -C "$dir" --no-same-owner postgrest
"$dir/postgrest" --version >/dev/null
