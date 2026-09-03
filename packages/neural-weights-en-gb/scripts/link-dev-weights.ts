#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize the en-gb overlay's dev artifacts. The steps live in
 *   `@mailwoman/resolver-wof-sqlite/weights-overlay-linker`; this file is the manifest plus the one step no manifest
 *   expresses, the card-conditional GB postcode binary.
 *
 *   A single multilingual model serves both en-us and en-gb (byte-identical artifact; en-gb carries its own retrieval
 *   data on top), so this overlay links the SAME pair the base does and holds it to en-us's `model-card.json`
 *   `files_md5` — one truth for the one artifact (en-gb's own card carries no `files_md5` block).
 *
 *   The evidence lexicons (`street_type`, `locality_surface`, #1511) are linked by the generation this overlay's card
 *   names under `requires.<channel>.lexicon`: the card claims its `requires` block is a verbatim copy of the base's,
 *   and the base model is trained WITH both channels, so an overlay without them runs a GB parse with the channels
 *   off on a model that expects them.
 *
 *   `pair-index-gb.bin` is derived from the HM Land Registry PPD tuples CSV + the WOF admin DB + three checked-in pairs
 *   JSONLs, through the shared `buildPairIndexOverlay`, whose freshness guard compares the format, EVERY calibrated
 *   magnitude, and EVERY source md5 (sidecar-cached — the PPD CSV is ~25.6M rows and a cold build is ~4–5 min, while
 *   `weights.test.ts` invokes this script on every `yarn test`). The shipped bundle's δ is 10 (#1269).
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { removePath } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { spawnProcessSync } from "@mailwoman/core/process"
import {
	ANCHOR_LEXICON_LINK,
	COUNTRY_SURFACE_LEXICON_LINK,
	materializeDevOverlay,
	PAIR_INDEX_DELTA,
	PAIR_INDEX_PARENT_DELTA,
	PAIR_INDEX_TRANSITION_BETA,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"
import { resolvePath } from "path-ts"

/**
 * Secondary pair sources (campaign R2/R3/R4b). Named here rather than inline at the call site because the freshness
 * guard has to md5 the SAME files the build reads — when those two lists drift apart the guard silently blesses a stale
 * artifact.
 */
const PPD_SOURCE_CSV = String(dataRootPath("ppd", "2026-07-22", "gb-tuples.csv"))
const BOROUGH_DB = String(dataRootPath("wof", "admin-global-priority.db"))
const LONDON_PAIRS_JSONL = String(repoRootPath("data", "gazetteer", "london-pairs-v2.jsonl"))
/**
 * Northern Ireland neighbourhood pairs (campaign R7). A SEPARATE file rather than merged into the London one, so each
 * source keeps its own provenance md5 in the header and the freshness guard can tell which of them moved.
 */
const NI_PAIRS_JSONL = String(repoRootPath("data", "gazetteer", "ni-pairs-v1.jsonl"))
/**
 * Scotland + Wales + England neighbourhood pairs (campaign R8) — the rest of Great Britain, after London (R3/R4b) and
 * Northern Ireland (R7).
 */
const GB_REGIONS_JSONL = String(repoRootPath("data", "gazetteer", "gb-regions-v1.jsonl"))

// Hierarchy campaign R2+R3: the WOF borough pairs + the checked-in ONSPD London ward pairs join the
// build — without these flags a dev rebuild would silently DROP them. The `sources` list is what the
// shared freshness guard md5s, in the order the build records them (CSV, borough DB, pairs JSONLs).
const overlay = await materializeDevOverlay({
	locale: "en-gb",
	model: { kind: "link", digestCard: "neural-weights-en-us" },
	softFeed: [ANCHOR_LEXICON_LINK, COUNTRY_SURFACE_LEXICON_LINK],
	evidenceLexiconsFromCard: true,
	pairIndex: {
		country: "gb",
		delta: PAIR_INDEX_DELTA,
		transitionBeta: PAIR_INDEX_TRANSITION_BETA,
		parentDelta: PAIR_INDEX_PARENT_DELTA,
		sources: [PPD_SOURCE_CSV, BOROUGH_DB, LONDON_PAIRS_JSONL, NI_PAIRS_JSONL, GB_REGIONS_JSONL],
		inputs: [PPD_SOURCE_CSV],
		extraArgs: [
			"--source",
			PPD_SOURCE_CSV,
			"--borough-db",
			BOROUGH_DB,
			"--pairs-jsonl",
			[LONDON_PAIRS_JSONL, NI_PAIRS_JSONL, GB_REGIONS_JSONL].join(","),
		],
	},
	localeFST: true,
	streetMorphologyFST: true,
})

// --- postcode-gb.bin: CARD-CONDITIONAL, not unconditional -------------------------------------
//
// The GB anchor binary is the one artifact whose correctness depends on WHICH MODEL is loaded, so it
// is built only when the card says the model can use it.
//
// The history in one paragraph. This script used to build the bin unconditionally. #1467 removed it,
// because the encoder's GB anchor slot (slot 4 of `LOCALE_ORDER`, `neural/anchor-inference.ts`) had
// taken no gradient — every recipe's `anchor_lookup_path` was `pilot-anchor-lookup.json`, 67,708 keys,
// zero letter-bearing, US/DE/FR only. Feeding slot 4 on a model that never trained it cost 24 exact
// postcodes on the 120-row gb-golden board (294/318 anchor-ON vs 318/318 anchor-OFF). Then a bare
// `existsSync` skip turned out to be worse than never building: a bin left by an older checkout is
// found package-dir-relative and silently re-enables the regression with no warning, because a present
// artifact is exactly what the loader expects.
//
// The check that resolves both states is the CARD's `requires.anchor.span_mode`. `shaped` is declared
// only by a model trained against a lookup with letter-bearing keys (`pilot-anchor-lookup-v2` and
// after), and that is precisely the model for which the bin helps. So: declared `shaped` → build it;
// anything else → remove any stale copy, loudly. No flag, no lockstep constant to forget — the same
// card the loader reads decides.
//
// Receipts either way: `docs/records/evals/2026-08-05-en-gb-anchor-off.md` (the anchor-OFF mitigation)
// and `docs/records/evals/2026-08-05-v420-base-anchor-v2-run-b.md` (the retrain that earns it back).

/**
 * Where the GB anchor binary lives when the card earns it.
 */
const POSTCODE_BIN_DEST = resolvePath(overlay.destDir, "postcode-gb.bin")

/**
 * The licence-clean GB postcode source: Ordnance Survey Code-Point Open (OGL v3.0), 1,746,976 units, every one placed.
 * The retired GeoNames-lineage `postalcode-gb.db` is NOT it. Coverage gap, measured: zero Northern Ireland (`BT`) codes
 * — the shaped keyer's outward fallback is what carries those rows.
 */
const GB_POSTCODE_EXTRACT = "postalcode-gb-codepoint.db"

/**
 * Keys the built binary must carry (1,746,976 units + 2,863 outward districts) — the GB half of the training lookup
 * `pilot-anchor-lookup-v2` verbatim. `gazetteer postcode-binary` enforces its own floor and exits nonzero below it, so
 * this number is documentation rather than a second check.
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
