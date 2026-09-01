#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize the fr-fr overlay's dev artifacts. See
 *   @mailwoman/neural-weights-en-us/scripts/link-dev-weights.ts for the base rationale.
 *
 *   #1179 OVERLAY FORM (2026-07-23 rewrite): fr-fr declares `mailwoman.baseWeights:
 *   "@mailwoman/neural-weights-en-us"`, so `resolveWeights` falls through to the en-us package
 *   for `model.onnx` / `tokenizer.model` / the card. This script therefore no longer links a
 *   model or tokenizer at all — it REMOVES any leftover local pair so the base fallback engages.
 *   (The previous version re-symlinked a pinned v241-fr-nsplice model on every `yarn test`;
 *   since #1179 that local file SHADOWED the base fallback, silently running the stale model for
 *   every dev fr-fr parse, and its #397 md5 guard could never pass against the en-us card. One
 *   model, one pin — en-us's script owns it.)
 *
 *   What fr-fr DOES own locally (locale-specific soft-feed siblings; `resolveFromPackageDir`
 *   resolves these from the overlay dir with no base fallback):
 *
 *   - `anchor-lexicon-v1.json` / `country-surface-lexicon-v1.json` — checked-in repo files,
 *       symlinked from `data/gazetteer/`.
 *   - `postcode-fr.bin` — derived from the WOF intl postcode extract
 *       (`softFeed.postcodeDBByCountry.fr` = postalcode-intl.db), built in place via the compiled
 *       `gazetteer postcode-binary` CLI (skip-if-exists; rebuilds in seconds). Without it a fresh
 *       worktree parses anchor-OFF — see the en-us script's section comment for the CI failure
 *       this caused.
 *   - `pair-index-fr.bin` (hierarchy campaign R6, 2026-08-01) — built from the raw BAN dump through
 *       the shared `buildPairIndexOverlay`. The FR source is BAN's `nom_ld` (lieu-dit), read through
 *       `ban/sdk`'s `cleanLieuDit` — NOT WOF (WOF's French neighbourhood records are Paris quartiers,
 *       which never appear in a postal address). BAN is a directory of 101 département files, so the
 *       guard md5s nothing (hashing all of them costs more than it saves; a BAN refresh is a
 *       deliberate act — delete the artifact after one) and instead refuses an implausibly SMALL
 *       artifact: the BAN-derived index is ~6 MB, while a pair index built here from the WRONG source
 *       (the admin-DB borough recipe) is ~1.9 kB with matching magnitudes. The calibrated magnitudes
 *       are the R6 bars' (board 0/80 → 76/80, 0/60 confound FPs); the parent-bias δ=5 leg is the one
 *       that CAUGHT the whole-edge mechanism's real defect — see
 *       `docs/records/evals/2026-08-04-pix1-whole-edge-verdict.md`.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { spawnProcessSync } from "@mailwoman/core/process"
import { dataRootPath, repoRootPath, weightsOverlayPath, workspacePath } from "@mailwoman/core/utils"
import {
	buildPairIndexOverlay,
	linkLocaleFST,
	linkSoftFeedSibling,
	linkStreetMorphologyFST,
	PAIR_INDEX_DELTA,
	PAIR_INDEX_PARENT_DELTA,
	PAIR_INDEX_TRANSITION_BETA,
	removeIfPresent,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"
import { resolvePath } from "path-ts"

/**
 * Where the artifacts LAND — the data-root overlay, never this tracked package.
 *
 * The binaries are not in git, so materializing them here made a fresh worktree unable to geocode, made `yarn test`
 * mutate a tracked directory as a side effect, and put a symlink into a publish tarball (`YN0035`).
 */
const DEST_DIR = String(weightsOverlayPath("fr-fr"))

await makeDirectories(DEST_DIR)

await removeIfPresent(resolvePath(DEST_DIR, "model.onnx"))
await removeIfPresent(resolvePath(DEST_DIR, "tokenizer.model"))

/**
 * --- soft-feed siblings (locale-owned; the fresh-worktree anchor-OFF gap) ----------------.
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
 * WOF postcode database the FR postcode binary is built from — the international build, not the US one.
 */
const FR_WOF_DB = dataRootPath("wof", "postalcode-intl.db")
/**
 * Compiled CLI used to run the build steps below. Requires `yarn compile` to have run.
 */
const CLI = workspacePath("mailwoman", "out", "cli.js")
/**
 * Where the postcode binary is written — a soft-feed sibling, absent in a lean install.
 */
const POSTCODE_BIN_DEST = resolvePath(DEST_DIR, "postcode-fr.bin")

if (await pathExists(POSTCODE_BIN_DEST)) {
	console.log(`skipped postcode-fr.bin build — ${POSTCODE_BIN_DEST} already present`)
} else if (!(await pathExists(CLI))) {
	console.error(
		`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run this script to build postcode-fr.bin.`
	)
} else if (!(await pathExists(FR_WOF_DB))) {
	console.error(
		`WARNING: missing ${FR_WOF_DB} — postcode-fr.bin not built; the anchor channel will resolve OFF for FR.`
	)
} else {
	const result = spawnProcessSync(
		process.execPath,
		[CLI, "gazetteer", "postcode-binary", "--out", DEST_DIR, "--locale", `FR:${FR_WOF_DB}`],
		{ stdio: "inherit" }
	)

	if (result.status !== 0 || !(await pathExists(POSTCODE_BIN_DEST))) {
		console.error(`ERROR: failed to build ${POSTCODE_BIN_DEST} (exit ${result.status})`)

		process.exit(1)
	}

	console.log(`built ${POSTCODE_BIN_DEST}`)
}

await linkLocaleFST(DEST_DIR, "fr-fr")
await linkStreetMorphologyFST(DEST_DIR)

/**
 * Raw BAN dump the lieu-dit pairs are extracted from — a DIRECTORY, so it rides `inputs` (existence only), not
 * `sources` (md5).
 */
const BAN_DIR = String(dataRootPath("corpus", "sources", "ban"))

await buildPairIndexOverlay({
	packageDir: "neural-weights-fr-fr",
	country: "fr",
	delta: PAIR_INDEX_DELTA,
	transitionBeta: PAIR_INDEX_TRANSITION_BETA,
	parentDelta: PAIR_INDEX_PARENT_DELTA,
	sources: [],
	inputs: [BAN_DIR],
	extraArgs: ["--ban-dir", BAN_DIR],
	minimumPlausibleBytes: 1_000_000,
})
