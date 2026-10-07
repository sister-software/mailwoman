/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The flag interface for the OpenAddresses real-point resolver eval.
 */

import type { WeakResolutionReading } from "@mailwoman/core/resolver"
import type { PathBuilderLike } from "path-ts"

/**
 * Options for {@linkcode oaResolverEval}.
 *
 * Keys mirror the command's kebab flags (`--out-md` → `outMd`).
 * Booleans default off.
 *
 * Tri-states are paired on/off flags that eval legs pin (`adminCoherence`/`noAdminCoherence`).
 */
export interface OAResolverEvalOptions {
	/**
	 * Ablate to anchor-only (gazetteer + conventions off).
	 */
	ablateToAnchor?: boolean
	/**
	 * Street-level exact-point database (single-state).
	 */
	addressPoints?: string
	/**
	 * Tri-state pin: force `adminCoherence` on.
	 */
	adminCoherence?: boolean
	/**
	 * Minimum anchor confidence to trust the anchor coordinate.
	 *
	 * Default 0.5.
	 */
	anchorMinConf?: number
	/**
	 * Declared ablation of the model's postcode-anchor input channel.
	 */
	anchorOff?: boolean
	/**
	 * Feed the anchor's country posterior into the locality re-rank.
	 */
	anchorRerank?: boolean
	/**
	 * Per-locale FST gazetteer (`fst-<locale>.bin`) for the assembled arms only,
	 * since the FST is a decode-time prior applied by `createRuntimePipeline`
	 * while the bare `neural` arm calls `classifier.parse` directly.
	 *
	 * Omit this option to use the byte-stable no-FST default.
	 * This is the tree's only FST-sensitive eval.
	 */
	adminFST?: string
	/**
	 * Add the assembled (pipeline) arms.
	 */
	assembled?: boolean
	/**
	 * Swap the FTS backend for the byte-range candidate-table lookup (demo parity).
	 */
	candidateDB?: string
	/**
	 * Grade the production coordinate cascade (per-state databases).
	 */
	cascade?: boolean
	/**
	 * Database root for `cascade`.
	 *
	 * Default `$MAILWOMAN_DATA_ROOT`.
	 */
	dataRoot?: string
	/**
	 * Hard country filter for admin lookups (`none` disables).
	 *
	 * Default `US`.
	 */
	defaultCountry?: string
	/**
	 * Write per-row failure dump here.
	 */
	errorsJSON?: string
	/**
	 * Eval jsonl.
	 *
	 * Default `data/eval/external/openaddresses-us-sample.jsonl`.
	 */
	eval?: string
	/**
	 * Recover the locality dropped for a dual-role place.
	 */
	hierarchyCompletion?: boolean
	/**
	 * House-number interpolation database (single-state).
	 */
	interpolation?: string
	/**
	 * Row cap (0/omitted = all rows).
	 */
	limit?: number
	/**
	 * Candidate ONNX.
	 */
	model?: string
	/**
	 * Pin the anchor lookup source.
	 */
	modelAnchorLookup?: PathBuilderLike
	/**
	 * Candidate model-card.
	 */
	modelCard?: string
	/**
	 * Tri-state pin: force `adminCoherence` off.
	 */
	noAdminCoherence?: boolean
	/**
	 * Tri-state pin: force `postcodeCountryCoherence` off, the leg that measures whether a
	 * coherent (postcode, locality) pair overriding `defaultCountry` is byte-flat on a US panel.
	 */
	noPostcodeCountryCoherence?: boolean
	/**
	 * Tri-state pin: force `postcodeConsistency` off.
	 *
	 * Paired with {@link postcodeConsistencyMaxMoveKm} this prices the cap without a sweep,
	 * because the rows whose answer differs from the shipped arm are exactly the ones the
	 * pass touched and the coordinate distance is how far its fallback moved each.
	 */
	noPostcodeConsistency?: boolean
	/**
	 * How far {@link noPostcodeConsistency}'s pass may move a coordinate onto the postcode point.
	 * Unset is the library default.
	 */
	postcodeConsistencyMaxMoveKm?: number
	/**
	 * A span-rescore sub-span may drop context but never a word of the name.
	 *
	 * Default-off in the library until a measurement supports it, so an unset
	 * pin leaves this eval byte-identical.
	 */
	spanRescoreRequireContextRemainder?: boolean
	/**
	 * Which reading of a weak resolution lifts the span-rescore brake.
	 *
	 * Unset is the shipped brake, so an unset pin leaves this eval byte-identical.
	 */
	spanRescoreWeakResolution?: WeakResolutionReading
	/**
	 * Pins `caseNormalization` to `"title-case"`.
	 */
	normalizeCase?: boolean
	/**
	 * Tri-state pin: force `postcodeCountryCoherence` on.
	 *
	 * The library default is on, so this is a no-op restatement kept because a check
	 * leg saying what it graded is the point of a tri-state.
	 */
	postcodeCountryCoherence?: boolean
	/**
	 * Write the aggregate JSON dump here.
	 */
	outJSON?: string
	/**
	 * Also write the markdown report here (self-reporting safeguard).
	 */
	outMd?: string
	/**
	 * Per-row resolved-locality dump for the PIP-containment metric.
	 */
	outResolved?: string
	/**
	 * Per-row neural-vs-v0 outcome dump (every row).
	 */
	outRows?: string
	/**
	 * Production-representative placer (soft country prior).
	 */
	placeCountry?: boolean
	/**
	 * Promote a confident placer guess to a hard country filter (safelist-conditional).
	 */
	placeCountryHard?: boolean
	/**
	 * Unrestricted hard-filter measurement (full in-map safelist).
	 */
	placeCountryHardAll?: boolean
	/**
	 * Opt-in postal-city alias scorer on the FTS path.
	 */
	postalCityAliasDB?: string
	/**
	 * Add the `neural+anchor` row (coordinate from the postcode anchor centroid).
	 */
	postcodeAnchor?: boolean
	/**
	 * Postcode databases for the anchor rows (comma-separated).
	 */
	postcodeDatabases?: string
	/**
	 * Answer a repeated `findPlace` query from a per-run memo.
	 *
	 * The databases a run reads are sealed and read-only, so a query is a pure function
	 * of its arguments and the memo cannot go stale, though it does share the hit objects
	 * between callers (the array itself is fresh each time so an in-place sort stays local).
	 */
	lookupMemo?: boolean
	/**
	 * Write a wall-time attribution JSON here: rig setup and the per-row
	 * `neural.parse` / `resolver.resolveTree` split.
	 *
	 * The promotion comparator reads every file under the output directory byte-for-byte,
	 * so this path must name somewhere outside it.
	 * Omitted, the harness writes no file and costs two `performance.now()` calls per row.
	 */
	profileJSON?: string
	/**
	 * Pins `caseNormalization` to `"preserve"`.
	 */
	rawCase?: boolean
	/**
	 * Candidate tokenizer.
	 */
	tokenizer?: PathBuilderLike
	/**
	 * WOF database list (comma-separated).
	 *
	 * Default admin + postcode-locality-intl.
	 */
	wof?: string
}
