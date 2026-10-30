#!/usr/bin/env bash
# tools/photo-reader/open.sh — fetch.sh's two ends, for a session whose gh is
# not signed in and which asks the fetch workflow through the GitHub connector
# instead (.claude/skills/photo-reader/SKILL.md, step 1):
#
#   tools/photo-reader/open.sh WORK --key     make this run's key; print its public half (age1…)
#   tools/photo-reader/open.sh WORK FILE      open what the workflow sent — the artifact's .zip
#                                             as downloaded, or the photos.tar.age inside it
#
# Prints the manifest's path on its last line, as fetch.sh does. WORK is the
# session's scratchpad, never the repository. See docs/photo-reader.md.

set -euo pipefail

WORK=${1:?usage: open.sh WORK --key | open.sh WORK FILE}
ARG=${2:?usage: open.sh WORK --key | open.sh WORK FILE}
command -v age >/dev/null || { echo "age is not installed (apt-get install age)" >&2; exit 2; }

mkdir -p "$WORK"
chmod 700 "$WORK"
KEY="$WORK/reader-key.txt"

if [ "$ARG" = --key ]; then
  [ -s "$KEY" ] || age-keygen -o "$KEY" 2>/dev/null
  age-keygen -y "$KEY"
  exit 0
fi
[ -s "$KEY" ] || { echo "no key in $WORK — the run's key is made with --key before the workflow is asked" >&2; exit 2; }

# Each opening in a folder of its own, empty to start with.
OUT="$WORK/out-$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
case "$ARG" in
  *.zip)
    TMP=$(mktemp -d "$WORK/zip-XXXXXX")
    python3 -I -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extract("photos.tar.age", sys.argv[2])' "$ARG" "$TMP"
    AGE="$TMP/photos.tar.age" ;;
  *) TMP=""; AGE="$ARG" ;;
esac
age -d -i "$KEY" "$AGE" | tar --no-same-owner -C "$OUT" -xf -
[ -n "$TMP" ] && rm -rf "$TMP"
echo "$OUT/manifest.json"
