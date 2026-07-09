/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mailwoman corpus fetch <source>` family — reproducible bulk-download recovery modules for
 *   the open-data sources the corpus build pipeline consumes. Each module writes the raw download
 *   files **plus** a sibling `MANIFEST.json` capturing the origin URL, fetch timestamp, byte count,
 *   and sha256 so downstream adapters can verify provenance.
 *
 *   The corpus build pipeline itself does NOT call these modules — the existing convention is for
 *   operators to pre-download into an out-root and point adapters at the resulting files. These
 *   modules exist for **reproducibility** (disk-loss recovery, weekly refresh, fresh-environment
 *   bootstrap).
 *
 *   ## Usage
 *
 *   ```sh
 *   # Default: writes under ./data/corpus/sources/ relative to the working directory
 *   mailwoman corpus fetch state-sources
 *   mailwoman corpus fetch hrsa
 *
 *   # Or point at the standard mailwoman data root
 *   mailwoman corpus fetch state-sources --out-root /data/corpus/sources
 *   ```
 *
 *   Each adapter under `corpus/src/adapters/<adapter>/README.md` documents the specific URL its
 *   input was pulled from; these modules mirror those URLs in a single executable place.
 *
 *   ## Coverage
 *
 *   - `ban` — French BAN (Base Adresse Nationale), all départements incl. DOM/TOM. Tier B (Licence
 *       Ouverte 2.0).
 *   - `nad` — US DOT National Address Database (~97M address points, ArcGIS FeatureServer). Tier A
 *       (US PD).
 *   - `hrsa` — HRSA Health Center Service Delivery Sites (federal). Tier A (US PD).
 *   - `imls-pls` — IMLS Public Libraries Survey, outlet-level (~17K library branches, FY 2023).
 *       Tier A (US PD).
 *   - `nppes` — NPPES NPI registry, full monthly dissemination (~7M provider venue+address rows).
 *       Tier A (US PD).
 *   - `openaddresses` — OpenAddresses country collections (default: Canada / `ca`). Tier B/C mixed
 *       — per-row filter.
 *   - `state-sources` — NY/TX/DE/OR notaries, IA contractors, WA health providers, HI lobbyists.
 *       Tier A (state PD-equivalent).
 *   - `state-hi-schools` — Hawaii DOE school directory (XLSX → CSV via openpyxl). Tier A (state
 *       PD-equivalent).
 *   - `tiger-full` — US Census TIGER 2024 ADDRFEAT, all US counties. Tier A (US PD).
 *
 *   License tiers per `docs/licensing-strategy.md` (or the playpen knowledge base mirror at
 *   `docs/docs/projects/mailwoman/licensing-strategy.md`). `openaddresses` is a **Tier-mixed**
 *   source: the downloaded collection includes CC0, CC-BY, OGL, and ODbL/CC-BY-SA rows. The per-row
 *   `LICENSE` filter in the `openaddresses` adapter is essential — Tier-C (ODbL, CC-BY-SA) rows are
 *   dropped at ingest by default to protect proprietary-weights training.
 *
 *   ### OpenAddresses authentication (as of 2026-05-18)
 *
 *   `batch.openaddresses.io` now requires a free registered account for bulk downloads (auth gate
 *   prevents CDN abuse; data remains openly licensed). `fetchOpenAddresses` reads `OA_BATCH_TOKEN`
 *   from the environment:
 *
 *   ```sh
 *   # One-time: register at https://batch.openaddresses.io/register
 *   # Log in → Profile → "Create Token" → copy token
 *   export OA_BATCH_TOKEN=<your-token>
 *
 *   # Download Canada (~2 GiB compressed, ~7 GiB uncompressed)
 *   mailwoman corpus fetch openaddresses --country ca \
 *     --out-root /mnt/playpen/mailwoman-data/corpus/sources
 *
 *   # Or any other OA country code
 *   mailwoman corpus fetch openaddresses --country fr
 *   ```
 *
 *   Without a token the command prints setup instructions and reports the failure.
 *
 *   ## Adding a new source
 *
 *   1. Pick the right module (or create a sibling one if the source is from a meaningfully
 *      different family).
 *   2. Append to the `SOURCES` array: `{ slug, filename, url }`.
 *   3. Confirm the destination URL via `curl -sI -L <url> | head` before committing — state
 *      open-data portals occasionally rotate Socrata view IDs.
 *   4. Run the command against a scratch `--out-root` to verify the download succeeds + the
 *      MANIFEST is well-formed.
 *   5. Add the source's adapter (or extend an existing one) under `corpus/src/adapters/`.
 */

import { fetchBan } from "./ban.ts"
import { fetchHRSA } from "./hrsa.ts"
import { fetchIMLSPLS } from "./imls-pls.ts"
import { fetchNAD } from "./nad.ts"
import { fetchNPPES } from "./nppes.ts"
import { fetchOpenAddresses } from "./openaddresses.ts"
import { fetchStateHISchools } from "./state-hi-schools.ts"
import { fetchStateSources } from "./state-sources.ts"
import { fetchTigerFull } from "./tiger-full.ts"

export * from "./ban.ts"
export * from "./hrsa.ts"
export * from "./imls-pls.ts"
export * from "./nad.ts"
export * from "./nppes.ts"
export * from "./openaddresses.ts"
export * from "./state-hi-schools.ts"
export * from "./state-sources.ts"
export * from "./tiger-full.ts"

/** The fetch-source registry: id → module entry point. Each entry point takes its own options interface. */
export const FETCH_SOURCES = {
	ban: fetchBan,
	nad: fetchNAD,
	hrsa: fetchHRSA,
	"imls-pls": fetchIMLSPLS,
	nppes: fetchNPPES,
	openaddresses: fetchOpenAddresses,
	"state-sources": fetchStateSources,
	"state-hi-schools": fetchStateHISchools,
	"tiger-full": fetchTigerFull,
} as const

export type FetchSourceID = keyof typeof FETCH_SOURCES
