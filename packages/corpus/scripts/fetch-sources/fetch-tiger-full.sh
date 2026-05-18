#!/usr/bin/env bash
# Fetch the full TIGER 2024 ADDRFEAT dataset — all US counties.
#
# TIGER ADDRFEAT 2024 source:
#   https://www2.census.gov/geo/tiger/TIGER2024/ADDRFEAT/
#   Files: tl_2024_<statefips><countyfips>_addrfeat.zip
#
# Each state's ZIPs land in:
#   $OUT_ROOT/tiger/addrfeat/state-<statefips>/
# with a per-state MANIFEST.json recording filename, sha256, and bytes for
# every county ZIP so re-runs can skip already-verified files.
#
# Usage:
#   OUT_ROOT=/mnt/playpen/mailwoman-data/corpus/sources \
#     packages/corpus/scripts/fetch-sources/fetch-tiger-full.sh
#
# Options (env vars):
#   OUT_ROOT          Destination root (default: repo-root/data/corpus/sources)
#   SKIP_STATE_FIPS   Space-separated list of 2-digit state FIPS to skip
#                     (default: "50" — Vermont, already fetched in v0.1.1)
#   RATE_SLEEP        Seconds to sleep between downloads (default: 0.2)
#   MAX_PARALLEL      Max concurrent curl workers per state (default: 4)
#   DRY_RUN           Set to 1 to print planned downloads without fetching

set -euo pipefail

TIGER_BASE_URL="https://www2.census.gov/geo/tiger/TIGER2024/ADDRFEAT"
OUT_ROOT="${OUT_ROOT:-"$(git rev-parse --show-toplevel)/data/corpus/sources"}"
# Space-separated 2-digit state FIPS codes to skip entirely.
# Default: skip 50 (Vermont) — already present from v0.1.1 build.
SKIP_STATE_FIPS="${SKIP_STATE_FIPS:-"50"}"
RATE_SLEEP="${RATE_SLEEP:-0.2}"
MAX_PARALLEL="${MAX_PARALLEL:-4}"
DRY_RUN="${DRY_RUN:-0}"

ADDRFEAT_DIR="$OUT_ROOT/tiger/addrfeat"
mkdir -p "$ADDRFEAT_DIR"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

log()  { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }

# Return 0 if the given state FIPS is in the skip list.
should_skip_state() {
  local fips="$1" s
  for s in $SKIP_STATE_FIPS; do
    [[ "$s" == "$fips" ]] && return 0
  done
  return 1
}

# Read a per-state MANIFEST.json and echo "filename sha256 bytes" lines.
read_manifest() {
  local manifest="$1"
  [[ -f "$manifest" ]] || return 0
  jq -r '.counties[]? | "\(.filename) \(.sha256) \(.bytes)"' "$manifest" 2>/dev/null || true
}

# Check if a file already matches a recorded sha256 and byte count.
# Returns 0 if verified, 1 otherwise.
file_matches_sha() {
  local path="$1" expected_sha="$2" expected_bytes="$3"
  [[ -f "$path" ]] || return 1
  local actual_bytes actual_sha
  actual_bytes=$(stat -c '%s' "$path" 2>/dev/null || stat -f '%z' "$path")
  [[ "$actual_bytes" == "$expected_bytes" ]] || return 1
  actual_sha=$(sha256sum "$path" | awk '{print $1}')
  [[ "$actual_sha" == "$expected_sha" ]] || return 1
  return 0
}

# ---------------------------------------------------------------------------
# Step 1: Discover the full county file list from the TIGER directory listing.
# ---------------------------------------------------------------------------

log "=== Fetching TIGER 2024 ADDRFEAT directory listing..."
ALL_ZIPS=$(
  curl -fsSL --max-time 60 "$TIGER_BASE_URL/" \
    | grep -o 'tl_2024_[0-9][0-9][0-9][0-9][0-9]_addrfeat\.zip' \
    | sort -u
)

TOTAL_COUNTIES=$(printf '%s\n' "$ALL_ZIPS" | wc -l)
log "  Found $TOTAL_COUNTIES county ZIPs in the TIGER 2024 ADDRFEAT index."

# Build an associative array: state_fips -> space-separated list of filenames.
declare -A STATE_FILES

while IFS= read -r fname; do
  # tl_2024_SSCCC_addrfeat.zip — SS = 2-digit state FIPS, CCC = county FIPS
  state_fips="${fname:8:2}"
  STATE_FILES["$state_fips"]+="$fname "
done <<< "$ALL_ZIPS"

TOTAL_STATES=${#STATE_FILES[@]}
log "  Spans $TOTAL_STATES state/territory FIPS codes."

# ---------------------------------------------------------------------------
# Step 2: For each state, download missing/unverified county ZIPs.
# ---------------------------------------------------------------------------

total_fetched=0
total_skipped=0
total_skipped_state=0
total_failed=0
total_bytes_fetched=0

# Working temp dir for result files from parallel workers.
WORK_DIR=$(mktemp -d)
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# Process states in sorted FIPS order for predictable output.
mapfile -t SORTED_STATES < <(printf '%s\n' "${!STATE_FILES[@]}" | sort)

for state_fips in "${SORTED_STATES[@]}"; do

  # --- Skip entire state if requested ------------------------------------------
  if should_skip_state "$state_fips"; then
    county_count=$(printf '%s\n' ${STATE_FILES["$state_fips"]} | wc -w)
    log "--- State $state_fips — SKIPPED (in SKIP_STATE_FIPS, $county_count counties)"
    total_skipped_state=$((total_skipped_state + county_count))
    continue
  fi

  state_dir="$ADDRFEAT_DIR/state-$state_fips"
  mkdir -p "$state_dir"
  manifest_path="$state_dir/MANIFEST.json"

  # Load existing manifest into associative arrays for O(1) lookup.
  declare -A MANIFEST_SHA=()
  declare -A MANIFEST_BYTES=()
  while IFS=' ' read -r mf ms mb; do
    [[ -n "$mf" ]] || continue
    MANIFEST_SHA["$mf"]="$ms"
    MANIFEST_BYTES["$mf"]="$mb"
  done < <(read_manifest "$manifest_path")

  # Split the space-separated filename list into an array.
  read -r -a county_files <<< "${STATE_FILES["$state_fips"]}"
  n_counties=${#county_files[@]}

  log "--- State $state_fips — $n_counties counties"

  # Build a list of URLs+dests that need fetching.
  pending_urls=()
  pending_dests=()

  for fname in "${county_files[@]}"; do
    dest="$state_dir/$fname"
    url="$TIGER_BASE_URL/$fname"

    # Skip if already verified via MANIFEST.
    if [[ -v "MANIFEST_SHA[$fname]" ]]; then
      if file_matches_sha "$dest" "${MANIFEST_SHA[$fname]}" "${MANIFEST_BYTES[$fname]}"; then
        info "skip (verified) $fname"
        total_skipped=$((total_skipped + 1))
        continue
      fi
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
      info "would fetch: $url"
      total_fetched=$((total_fetched + 1))
      continue
    fi

    pending_urls+=("$url")
    pending_dests+=("$dest")
  done

  [[ "$DRY_RUN" == "1" ]] && { unset MANIFEST_SHA MANIFEST_BYTES; continue; }

  # --- Download pending files with bounded parallelism ----------------------
  n_pending=${#pending_urls[@]}
  if [[ "$n_pending" -gt 0 ]]; then
    state_result_dir="$WORK_DIR/$state_fips"
    mkdir -p "$state_result_dir"

    running=0
    for (( i=0; i<n_pending; i++ )); do
      url="${pending_urls[$i]}"
      dest="${pending_dests[$i]}"
      fname=$(basename "$dest")
      result_file="$state_result_dir/$fname.result"

      # Launch background worker.
      (
        if curl -fsSL --max-time 600 --retry 3 --retry-delay 5 -o "$dest" "$url"; then
          bytes=$(stat -c '%s' "$dest" 2>/dev/null || stat -f '%z' "$dest")
          if [[ "$bytes" -lt 1024 ]]; then
            printf 'FAIL\t%s\ttoo small (%s bytes)\n' "$fname" "$bytes" > "$result_file"
            rm -f "$dest"
          else
            sha=$(sha256sum "$dest" | awk '{print $1}')
            printf 'OK\t%s\t%s\t%s\n' "$fname" "$sha" "$bytes" > "$result_file"
          fi
        else
          printf 'FAIL\t%s\tcurl error\n' "$fname" > "$result_file"
        fi
      ) &

      running=$((running + 1))

      # Rate-limit: sleep between each job dispatch.
      sleep "$RATE_SLEEP"

      # Throttle: wait until a slot opens up.
      if [[ $running -ge $MAX_PARALLEL ]]; then
        wait -n 2>/dev/null || wait
        running=$((running - 1))
      fi
    done

    # Wait for all remaining workers.
    wait

    # Collect results from this state's result dir.
    shopt -s nullglob
    for result_file in "$state_result_dir"/*.result; do
      [[ -f "$result_file" ]] || continue
      IFS=$'\t' read -r status fname sha_bytes < "$result_file"
      if [[ "$status" == "OK" ]]; then
        sha=$(awk '{print $1}' <<< "$sha_bytes")
        bytes=$(awk '{print $2}' <<< "$sha_bytes")
        info "ok $fname  $(numfmt --to=iec "$bytes" 2>/dev/null || echo "$bytes B")  sha256=${sha:0:12}..."
        MANIFEST_SHA["$fname"]="$sha"
        MANIFEST_BYTES["$fname"]="$bytes"
        total_fetched=$((total_fetched + 1))
        total_bytes_fetched=$((total_bytes_fetched + bytes))
      else
        info "FAIL $fname -- $sha_bytes"
        total_failed=$((total_failed + 1))
      fi
    done
    shopt -u nullglob

    # Rewrite per-state MANIFEST.json with all known-good counties.
    {
      printf '{\n'
      printf '  "state_fips": "%s",\n' "$state_fips"
      printf '  "updated_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf '  "tiger_base_url": "%s",\n' "$TIGER_BASE_URL"
      printf '  "counties": [\n'
      first=1
      for fname in "${!MANIFEST_SHA[@]}"; do
        [[ "$first" == "1" ]] || printf ',\n'
        printf '    {"filename": "%s", "sha256": "%s", "bytes": %s}' \
          "$fname" "${MANIFEST_SHA[$fname]}" "${MANIFEST_BYTES[$fname]}"
        first=0
      done
      printf '\n  ]\n'
      printf '}\n'
    } > "$manifest_path"
  fi

  unset MANIFEST_SHA MANIFEST_BYTES
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

log ""
log "=== Summary ==="
log "  Total counties in index   : $TOTAL_COUNTIES"
log "  State(s) fully skipped    : $total_skipped_state (SKIP_STATE_FIPS=\"$SKIP_STATE_FIPS\")"
log "  Counties already present  : $total_skipped"
log "  Counties fetched this run : $total_fetched"
log "  Counties failed           : $total_failed"
if [[ "$total_bytes_fetched" -gt 0 ]]; then
  log "  Bytes fetched this run    : $(numfmt --to=iec "$total_bytes_fetched") ($total_bytes_fetched)"
fi

if [[ "$total_failed" -gt 0 ]]; then
  log ""
  log "WARNING: $total_failed download(s) failed. Re-run to retry."
  exit 1
fi

exit 0
