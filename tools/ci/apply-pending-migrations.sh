#!/usr/bin/env bash
# Apply every migration the database has not had yet, in order — what a person
# used to do by hand in the Supabase SQL editor (db/README.md, "Applying
# migrations"). Run by .github/workflows/db-migrate.yml; safe to run locally.
#
#   DATABASE_URL=postgresql://… tools/ci/apply-pending-migrations.sh            apply
#   DATABASE_URL=postgresql://… DRY_RUN=1 tools/ci/apply-pending-migrations.sh  only list them
#   UP_TO=77 …                                                                   stop after 0077
#
# "Not had yet" is meganet.app_meta's schema_version: every migration sets it
# to its own number as its last statement, so a file numbered above it is
# pending. Each goes in as one transaction (--single-transaction, ON_ERROR_STOP)
# — all of it or none — and the version must then read that file's number, or
# the run stops there: a later file never lands on top of one that did not
# take.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is not set}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UP_TO="${UP_TO:-}"
export PGOPTIONS="${PGOPTIONS:--c statement_timeout=0 -c lock_timeout=60s}"

version() { psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c "select coalesce((select value from meganet.app_meta where key = 'schema_version'), '0')"; }

now=$(version)
echo "The database is at schema_version $now."

pending=()
for f in "$HERE"/db/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  n=$((10#$(basename "$f" | cut -c1-4)))
  (( n > now )) || continue
  [ -n "$UP_TO" ] && (( n > 10#$UP_TO )) && continue
  pending+=("$f")
done

if [ ${#pending[@]} -eq 0 ]; then echo "Nothing to apply."; exit 0; fi
echo "Pending: ${#pending[@]}"
for f in "${pending[@]}"; do echo "  $(basename "$f")"; done
if [ -n "${DRY_RUN:-}" ]; then echo "Dry run: nothing applied."; exit 0; fi

for f in "${pending[@]}"; do
  n=$((10#$(basename "$f" | cut -c1-4)))
  echo "::group::$(basename "$f")"
  start=$(date +%s)
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$f" > /dev/null
  echo "::endgroup::"
  got=$(version)
  if [ "$got" != "$n" ]; then
    echo "::error::$(basename "$f") ran, but schema_version reads $got, not $n — stopping here."
    exit 1
  fi
  echo "Applied $(basename "$f") in $(( $(date +%s) - start )) s — schema_version $got."
done
echo "Done: the database is at schema_version $(version)."
