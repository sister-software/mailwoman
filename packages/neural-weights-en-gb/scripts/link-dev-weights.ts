#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materializes the en-gb overlay's development artifacts.
 *   It also builds or removes the card-conditional GB postcode binary, a step absent from manifests.
 *
 *   One multilingual model serves en-us and en-gb. The en-gb overlay adds its own retrieval data.
 *   This overlay links the same pair as the base and checks it against en-us's
 *   `model-card.json` `files_md5`, since en-gb's own `files_md5` names only its pair index.
 *
 *   The evidence lexicons (`street_type`, `locality_surface`) are linked by the generation this
 *   overlay's card records under `requires.<channel>.lexicon`. The card claims its `requires`
 *   block matches the base card verbatim. The base model is trained with both channels.
 *   An overlay without them would run a GB parse with expected channels disabled.
 *
 *   `pair-index-gb.bin` is derived from the WOF admin DB's borough pairs and three checked-in pairs
 *   JSONL files. It reads no tuple CSV: the HM Land Registry Price Paid Data it read until 2026-10-17
 *   is refused by the license register, and `gazetteer pair-index` refuses a GB `--source`. The shared
 *   `buildPairIndexOverlay` freshness guard compares artifact format, calibrated magnitudes and every
 *   source MD5. `weights.test.ts` invokes this script on every `yarn test`. The shipped bundle's delta is 10.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { removePath } from "@mailwoman/core/fs/writers"
import { repoRootPathBuilder } from "@mailwoman/core/paths"
import { spawnProcessSync } from "@mailwoman/core/process"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import {
	committedSoftFeedLinks,
	materializeDevOverlay,
	PAIR_INDEX_DELTA,
	PAIR_INDEX_PARENT_DELTA,
	PAIR_INDEX_TRANSITION_BETA,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

/**
 * Secondary pair sources.
 *
 * Declared here rather than inline at the call site, because the freshness guard md5s the same
 * files the build reads and two lists that drift apart let the guard bless a stale artifact.
 */
const BOROUGH_DB = wofDatabasePath("admin-global-priority.db")
const LONDON_PAIRS_JSONL = repoRootPathBuilder("data", "gazetteer", "london-pairs-v2.jsonl")
/**
 * Northern Ireland neighborhood pairs.
 *
 * A separate file rather than merged into the London one, so each source keeps its own
 * provenance md5 in the header and the freshness guard can tell which one moved.
 */
const NI_PAIRS_JSONL = repoRootPathBuilder("data", "gazetteer", "ni-pairs-v1.jsonl")
/**
 * Scotland, Wales and England neighborhood pairs, the rest of Great Britain
 * after London and Northern Ireland.
 */
const GB_REGIONS_JSONL = repoRootPathBuilder("data", "gazetteer", "gb-regions-v1.jsonl")

// The `sources` list is what the shared freshness guard md5s, in the order the
// build records the entries (borough DB, pairs JSONLs).
// A dev rebuild whose list drifts from the build's lets the guard bless a stale artifact.
const softFeed = await committedSoftFeedLinks()

const overlay = await materializeDevOverlay({
	locale: "en-gb",
	model: { kind: "link", digestCard: "neural-weights-en-us" },
	softFeed: [softFeed.anchor, softFeed.country],
	evidenceLexiconsFromCard: true,
	pairIndex: {
		country: "gb",
		delta: PAIR_INDEX_DELTA,
		transitionBeta: PAIR_INDEX_TRANSITION_BETA,
		parentDelta: PAIR_INDEX_PARENT_DELTA,
		sources: [BOROUGH_DB, LONDON_PAIRS_JSONL, NI_PAIRS_JSONL, GB_REGIONS_JSONL],
		extraArgs: [
			"--borough-db",
			BOROUGH_DB,
			"--pairs-jsonl",
			[LONDON_PAIRS_JSONL, NI_PAIRS_JSONL, GB_REGIONS_JSONL].map((path) => path.toString()).join(","),
		],
	},
	localeFST: true,
	streetMorphologyFST: true,
	// The Northern Ireland scope stays out: its source is OpenStreetMap under ODbL, tier build-local.
	postcodePrefixScopes: ["gb-esw"],
})

// Build `postcode-gb.bin` only when the model card declares `requires.anchor.span_mode === "shaped"`.
//
// Build this binary only for a model trained with shaped (letter-containing) GB anchor lookups.
// On an older model, the binary regresses results.
// A stale binary from another checkout can re-enable that behavior.
//
// Policy:
// - `span_mode: "shaped"` -> build the binary
// - otherwise -> remove any existing binary

/**
 * Where the GB anchor binary lives when the card warrants it.
 */
const POSTCODE_BIN_DEST = overlay.destDir("postcode-gb.bin")

/**
 * The license-clean GB postcode source, Ordnance Survey Code-Point Open (OGL v3.0),
 * carrying 1,746,976 units with every one placed.
 *
 * The source has zero Northern Ireland (`BT`) codes.
 * The shaped keyer's outward fallback handles those rows.
 */
const GB_POSTCODE_EXTRACT = "postalcode-gb-codepoint.db"

/**
 * Keys the built binary must include (1,746,976 units and 2,863 outward districts),
 * the GB half of the training lookup `pilot-anchor-lookup-v2` verbatim.
 *
 * `gazetteer postcode-binary` enforces its own floor and exits nonzero below it,
 * so this number is documentation rather than a second check.
 */
const GB_POSTCODE_BIN_KEYS = 1_749_839

if (overlay.card?.requires?.anchor?.span_mode === "shaped") {
	console.log(
		`model-card declares requires.anchor.span_mode "shaped" — building postcode-gb.bin ` +
			`(${GB_POSTCODE_BIN_KEYS.toLocaleString()} keys expected from ${GB_POSTCODE_EXTRACT})`
	)

	const built = spawnProcessSync(
		process.execPath,
		[overlay.cli, "gazetteer", "postcode-binary", "--out", overlay.destDir, "--locale", `GB:${GB_POSTCODE_EXTRACT}`],
		{ stdio: "inherit" }
	)

	if (built.status !== 0) {
		console.error(`WARNING: gazetteer postcode-binary failed — the GB anchor channel will resolve OFF here.`)
	}
} else if (await pathExists(POSTCODE_BIN_DEST)) {
	await removePath(POSTCODE_BIN_DEST)

	console.log(
		`removed stale ${POSTCODE_BIN_DEST} — this card does not declare span_mode "shaped", so the bin's ` +
			`unit keys are unreachable and feeding slot 4 is a measured regression (see the block comment)`
	)
}
