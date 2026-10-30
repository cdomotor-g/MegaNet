#!/usr/bin/env bash
# tools/photo-reader/fetch.sh — the session's half of the photo reader's fetch:
# make a key for this one run, ask the workflow for photos encrypted to it,
# wait, download, decrypt, unpack, and delete the artifact.
#
#   tools/photo-reader/fetch.sh WORK [unread|ids] [SIZE] [LIMIT] [IDS] [READER_VERSION]
#
#   WORK      a folder of the session's own — the scratchpad — never the repo:
#             the photos are private (0035), and nothing here is committed
#   SIZE      full, thumb, or the longest side in pixels (default 1600)
#   LIMIT     at most this many (default 200, at most 1000)
#   IDS       photo ids, comma-separated, when the second argument is ids
#
# Prints the path of the manifest (WORK/out-<run>/manifest.json) on its last
# line. Needs gh signed in with the repository (a cloud session's GH_TOKEN),
# and age. Uses the REST API only — a cloud session's proxy refuses GraphQL —
# so every gh call names the repository and the ref. See docs/photo-reader.md.

set -euo pipefail

WORK=${1:?usage: fetch.sh WORK [unread|ids] [SIZE] [LIMIT] [IDS] [READER_VERSION]}
SELECT=${2:-unread}
SIZE=${3:-1600}
LIMIT=${4:-200}
IDS=${5:-}
VERSION=${6:-1}
REPO=${PHOTO_READER_REPO:-cdomotor-g/MegaNet}
WF=photo-reader-fetch.yml

case "$WORK" in
  "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)"*) echo "WORK is inside the repository — use the scratchpad" >&2; exit 2 ;;
esac
command -v age >/dev/null || { echo "age is not installed (apt-get install age)" >&2; exit 2; }

mkdir -p "$WORK"
chmod 700 "$WORK"
KEY="$WORK/reader-key.txt"
[ -s "$KEY" ] || age-keygen -o "$KEY" 2>/dev/null
RECIPIENT=$(age-keygen -y "$KEY")
NONCE="pr-$(date -u +%Y%m%d-%H%M%S)-$RANDOM"

gh workflow run "$WF" --repo "$REPO" --ref main \
  -f recipient="$RECIPIENT" -f select="$SELECT" -f ids="$IDS" -f size="$SIZE" \
  -f limit="$LIMIT" -f reader_version="$VERSION" -f nonce="$NONCE" >&2

# The run, by the nonce in its name: a few seconds after the dispatch.
RUN=""
for _ in $(seq 1 40); do
  RUN=$(gh api "repos/$REPO/actions/workflows/$WF/runs?per_page=20&event=workflow_dispatch" \
          --jq ".workflow_runs[] | select(.display_title | contains(\"$NONCE\")) | .id" 2>/dev/null | head -1 || true)
  [ -n "$RUN" ] && break
  sleep 3
done
[ -n "$RUN" ] || { echo "the fetch run did not appear (nonce $NONCE)" >&2; exit 1; }
echo "run $RUN" >&2

# Until it ends: a fetch of a few hundred photos is two to five minutes.
STATUS="" CONCLUSION=""
for _ in $(seq 1 240); do
  read -r STATUS CONCLUSION < <(gh api "repos/$REPO/actions/runs/$RUN" --jq '"\(.status) \(.conclusion // "-")"')
  [ "$STATUS" = completed ] && break
  sleep 10
done
if [ "$CONCLUSION" != success ]; then
  echo "the fetch run $RUN ended $STATUS/$CONCLUSION — gh run view $RUN --repo $REPO --log-failed" >&2
  exit 1
fi

DL="$WORK/dl-$RUN"
OUT="$WORK/out-$RUN"
rm -rf "$DL" "$OUT"
gh run download "$RUN" --repo "$REPO" -n "photo-reader-$RUN" -D "$DL" >&2
mkdir -p "$OUT"
age -d -i "$KEY" "$DL/photos.tar.age" | tar --no-same-owner -C "$OUT" -xf -
rm -rf "$DL"

# Nobody can open it without the key, and it would be gone in a day; gone now.
ART=$(gh api "repos/$REPO/actions/runs/$RUN/artifacts" --jq '.artifacts[0].id' 2>/dev/null || true)
[ -n "$ART" ] && gh api -X DELETE "repos/$REPO/actions/artifacts/$ART" >/dev/null 2>&1 || true

echo "$OUT/manifest.json"
