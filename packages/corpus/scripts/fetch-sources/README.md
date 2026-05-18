# `fetch-sources/` — bulk-download recovery scripts

Reproducible curl-based fetchers for the open-data sources the corpus build
pipeline consumes. Each script writes the raw download files **plus** a
sibling `MANIFEST.json` capturing the origin URL, fetch timestamp, byte
count, and sha256 so downstream adapters can verify provenance.

The corpus build pipeline itself does NOT call these scripts — the existing
convention is for operators to pre-download into `$OUT_ROOT` and point
adapters at the resulting files. These scripts exist for **reproducibility**
(disk-loss recovery, weekly refresh, fresh-environment bootstrap).

## Usage

```sh
# Default: writes under ./data/corpus/sources/ at the repo root
packages/corpus/scripts/fetch-sources/fetch-state-sources.sh
packages/corpus/scripts/fetch-sources/fetch-hrsa.sh

# Or point at the standard mailwoman data root
OUT_ROOT=/data/corpus/sources \
  packages/corpus/scripts/fetch-sources/fetch-state-sources.sh
```

Each adapter under `packages/corpus/src/adapters/*/README.md` documents the
specific URL its input was pulled from; these scripts mirror those URLs in a
single executable place.

## Coverage

| Script                   | Sources                                                                             | License tier            |
| ------------------------ | ----------------------------------------------------------------------------------- | ----------------------- |
| `fetch-hrsa.sh`          | HRSA Health Center Service Delivery Sites (federal)                                 | A (US PD)               |
| `fetch-imls-pls.sh`      | IMLS Public Libraries Survey — outlet-level (~17K library branches, FY 2023)        | A (US PD)               |
| `fetch-nppes.sh`         | NPPES NPI registry — full monthly dissemination (~7M provider venue+address rows)   | A (US PD)               |
| `fetch-state-sources.sh` | NY/TX/DE/OR notaries, IA contractors, WA health providers, HI schools, HI lobbyists | A (state PD-equivalent) |

License tiers per `docs/licensing-strategy.md` (or the playpen knowledge base
mirror at `docs/docs/projects/mailwoman/licensing-strategy.md`). Sources here
are all Tier A — safe for proprietary-weights training without attribution
beyond the model-card disclosure.

## Adding a new source

1. Pick the right script (or create a sibling one if the source is from a
   meaningfully different family).
2. Append to the `SOURCES=()` table: `slug|filename|url`.
3. Confirm the destination URL via `curl -sI -L <url> | head` before
   committing — state open-data portals occasionally rotate Socrata view IDs.
4. Run the script against a scratch `OUT_ROOT` to verify the download
   succeeds + the MANIFEST is well-formed.
5. Add the source's adapter (or extend an existing one) under
   `packages/corpus/src/adapters/`.
