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

| Script                      | Sources                                                                           | License tier               |
| --------------------------- | --------------------------------------------------------------------------------- | -------------------------- |
| `fetch-hrsa.sh`             | HRSA Health Center Service Delivery Sites (federal)                               | A (US PD)                  |
| `fetch-imls-pls.sh`         | IMLS Public Libraries Survey — outlet-level (~17K library branches, FY 2023)      | A (US PD)                  |
| `fetch-nppes.sh`            | NPPES NPI registry — full monthly dissemination (~7M provider venue+address rows) | A (US PD)                  |
| `fetch-state-sources.sh`    | NY/TX/DE/OR notaries, IA contractors, WA health providers, HI lobbyists           | A (state PD-equivalent)    |
| `fetch-state-hi-schools.sh` | Hawaii DOE school directory (XLSX → CSV via openpyxl)                             | A (state PD-equivalent)    |
| `fetch-openaddresses.sh`    | OpenAddresses country collections (default: Canada / `ca`)                        | B/C mixed — per-row filter |

License tiers per `docs/licensing-strategy.md` (or the playpen knowledge base
mirror at `docs/docs/projects/mailwoman/licensing-strategy.md`). Sources here
are all Tier A except `fetch-openaddresses.sh`, which is a **Tier-mixed**
source: the downloaded collection includes CC0, CC-BY, OGL, and ODbL/CC-BY-SA
rows. The per-row `LICENSE` filter in the `openaddresses` adapter is
essential — Tier-C (ODbL, CC-BY-SA) rows are dropped at ingest by default
to protect proprietary-weights training.

### OpenAddresses authentication (as of 2026-05-18)

`batch.openaddresses.io` now requires a free registered account for bulk
downloads (auth gate prevents CDN abuse; data remains openly licensed).
`fetch-openaddresses.sh` reads `OA_BATCH_TOKEN` from the environment:

```sh
# One-time: register at https://batch.openaddresses.io/register
# Log in → Profile → "Create Token" → copy token
export OA_BATCH_TOKEN=<your-token>

# Download Canada (~2 GiB compressed, ~7 GiB uncompressed)
OUT_ROOT=/mnt/playpen/mailwoman-data/corpus/sources \
  packages/corpus/scripts/fetch-sources/fetch-openaddresses.sh --country ca

# Or any other OA country code
OA_BATCH_TOKEN=$OA_BATCH_TOKEN packages/corpus/scripts/fetch-sources/fetch-openaddresses.sh --country fr
```

The script without a token prints setup instructions and exits cleanly.

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
