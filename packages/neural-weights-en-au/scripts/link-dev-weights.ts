#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize the en-au overlay's dev artifacts. See
 *   @mailwoman/neural-weights-en-us/scripts/link-dev-weights.ts for the base rationale.
 *
 *   #1179 OVERLAY FORM (same shape as en-nz/en-gb/fr-fr): en-au declares
 *   `mailwoman.baseWeights: "@mailwoman/neural-weights-en-us"`, so `resolveWeights` falls through
 *   to the en-us package for `model.onnx` / `tokenizer.model`. This script therefore links no
 *   model or tokenizer at all — it REMOVES any leftover local pair so the base fallback engages
 *   (a stale local file would SHADOW the base fallback and silently serve outdated bytes; see the
 *   fr-fr script's header for the incident that taught this).
 *
 *   What en-au owns locally (locale-specific soft-feed siblings; `resolveFromPackageDir`
 *   resolves these from the overlay dir with no base fallback):
 *
 *   - `country-surface-lexicon-v1.json` — checked-in repo file, symlinked from `data/gazetteer/`.
 *     The country channel loads this to constrain the resolver.
 *
 *   en-au is INITIAL (2026-08-08): NO postcode-au.bin (no WOF AU postcode extract exists), NO
 *   pair-index-au.bin (PIX1 not yet calibrated for AU), NO anchor-lexicon (anchor channel OFF).
 *   The overlay exists so `--locale en-AU` resolves and the resolver's country scope constrains
 *   the candidate lookup — that alone fixes the WA→Washington-State homonym class diagnosed in the
 *   2026-08-07 FIRST-PASS benchmark.
 *
 *   FRESHNESS GUARD: none needed yet — no derived artifacts are built. The lexicons are
 *   checked-in repo files symlinked in place; there's nothing to go stale.
 */

import { makeDirectories } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { weightsOverlayPath } from "@mailwoman/core/utils"
import {
	linkSoftFeedSibling,
	linkStreetMorphologyFST,
	removeIfPresent,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"
import { resolvePath } from "path-ts"

/**
 * Where the artifacts LAND — the data-root overlay, never this tracked package.
 *
 * The binaries are not in git, so materializing them here made a fresh worktree unable to geocode, made `yarn test`
 * mutate a tracked directory as a side effect, and put a symlink into a publish tarball (`YN0035`).
 */
const DEST_DIR = String(weightsOverlayPath("en-au"))

await makeDirectories(DEST_DIR)

await removeIfPresent(resolvePath(DEST_DIR, "model.onnx"))
await removeIfPresent(resolvePath(DEST_DIR, "tokenizer.model"))

/**
 * --- soft-feed siblings (locale-owned; the fresh-worktree country-OFF gap) -----.
 */
await linkSoftFeedSibling(
	repoRootPath("data", "gazetteer", "country-surface-lexicon-v1.json"),
	resolvePath(DEST_DIR, "country-surface-lexicon-v1.json"),
	"country channel will resolve OFF in this worktree."
)

await linkStreetMorphologyFST(DEST_DIR)
