#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize the en-nz overlay's dev artifacts. See
 *   @mailwoman/neural-weights-en-us/scripts/link-dev-weights.ts for the base rationale.
 *
 *   #1179 OVERLAY FORM (fr-fr's rewritten shape, adopted here from day one): en-nz declares
 *   `mailwoman.baseWeights: "@mailwoman/neural-weights-en-us"`, so `resolveWeights` falls through
 *   to the en-us package for `model.onnx` / `tokenizer.model`. This script therefore links no
 *   model or tokenizer at all — it REMOVES any leftover local pair so the base fallback engages
 *   (a stale local file would SHADOW the base fallback and silently serve outdated bytes; see the
 *   fr-fr script's header for the incident that taught this).
 *
 *   What en-nz DOES own locally (locale-specific soft-feed siblings; `resolveFromPackageDir`
 *   resolves these from the overlay dir with no base fallback):
 *
 *   - `anchor-lexicon-v1.json` / `country-surface-lexicon-v1.json` — checked-in repo files,
 *       symlinked from `data/gazetteer/`.
 *   - `pair-index-nz.bin` (NZ arc, #1277) — no committed source (derived from the LINZ-derived
 *       OpenAddresses NZ countrywide CSV, the same register `synth-nz-v2` was built from), built in
 *       place via the compiled `gazetteer pair-index` CLI through the shared `buildPairIndexOverlay`
 *       (whose freshness guard compares the format, every calibrated magnitude, and the source md5;
 *       sidecar-cached — the CSV is 2.12M rows). `--delta 10` is the NZ-sweep-calibrated value
 *       (task-8 report, 2026-07-24 § "NZ arc": saturates at δ=10, identical to 12/15, 0/54 golden-FP
 *       throughout) baked into the artifact's header. Note this locale deliberately ships WITHOUT a
 *       `transitionBeta` (unmeasured there); the parent-bias δ=5 is measured — NZ's own shipped board
 *       moved 230/246 → 246/246 whole-edge, identical at δ 4/6/8/20 — see
 *       `docs/records/evals/2026-08-04-pix1-whole-edge-verdict.md`.
 *
 *   UNLIKE en-gb there is NO postcode binary to build: no WOF NZ postcode extract exists
 *   (release.config.json's softFeed.postcodeDBByCountry has no `nz` entry), so the anchor channel
 *   resolves OFF for en-nz until that extract is built — the tracked follow-up in this package's
 *   model-card.json (`nz_artifacts.no_postcode_bin`).
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { weightsOverlayPath } from "@mailwoman/core/utils"
import {
	buildPairIndexOverlay,
	linkSoftFeedSibling,
	linkStreetMorphologyFST,
	PAIR_INDEX_DELTA,
	PAIR_INDEX_PARENT_DELTA,
	removeIfPresent,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"
import { resolvePath } from "path-ts"

/**
 * Where the artifacts LAND — the data-root overlay, never this tracked package.
 *
 * The binaries are not in git, so materializing them here made a fresh worktree unable to geocode, made `yarn test`
 * mutate a tracked directory as a side effect, and put a symlink into a publish tarball (`YN0035`).
 */
const DEST_DIR = String(weightsOverlayPath("en-nz"))

await makeDirectories(DEST_DIR)

await removeIfPresent(resolvePath(DEST_DIR, "model.onnx"))
await removeIfPresent(resolvePath(DEST_DIR, "tokenizer.model"))

/**
 * --- soft-feed siblings (locale-owned; the fresh-worktree gazetteer/country-OFF gap) -----.
 */
await linkSoftFeedSibling(
	repoRootPath("data", "gazetteer", "anchor-lexicon-v1.json"),
	resolvePath(DEST_DIR, "anchor-lexicon-v1.json"),
	"gazetteer channel will resolve OFF in this worktree."
)

await linkSoftFeedSibling(
	repoRootPath("data", "gazetteer", "country-surface-lexicon-v1.json"),
	resolvePath(DEST_DIR, "country-surface-lexicon-v1.json"),
	"country channel will resolve OFF in this worktree."
)

/**
 * The LINZ-derived OpenAddresses NZ countrywide CSV — the build's one source, md5-recorded in the header.
 */
const NZ_SOURCE_CSV = String(dataRootPath("openaddresses", "extracted", "nz", "countrywide.csv"))

await buildPairIndexOverlay({
	packageDir: "neural-weights-en-nz",
	country: "nz",
	delta: PAIR_INDEX_DELTA,
	parentDelta: PAIR_INDEX_PARENT_DELTA,
	sources: [NZ_SOURCE_CSV],
	extraArgs: ["--source", NZ_SOURCE_CSV],
})

await linkStreetMorphologyFST(DEST_DIR)
