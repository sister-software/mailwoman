/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The flag contract for the OpenAddresses real-point resolver eval.
 */

/**
 * Options for {@linkcode oaResolverEval}. Keys mirror the command's kebab flags (`--out-md` → `outMd`); booleans default
 * off, tri-states are the paired on/off flags the gate legs pin (`adminCoherence`/`noAdminCoherence`).
 */
export interface OAResolverEvalOptions {
	/**
	 * #722 baseline: ablate to anchor-only (gazetteer + conventions OFF).
	 */
	ablateToAnchor?: boolean
	/**
	 * #476 street-level exact-point shard (single-state).
	 */
	addressPoints?: string
	/**
	 * #895 tri-state pin: force adminCoherence ON.
	 */
	adminCoherence?: boolean
	/**
	 * Minimum anchor confidence to trust the anchor coordinate. Default 0.5.
	 */
	anchorMinConf?: number
	/**
	 * #887 declared ablation of the model's postcode-anchor input channel.
	 */
	anchorOff?: boolean
	/**
	 * #369 S8: feed the anchor's country posterior into the locality re-rank.
	 */
	anchorRerank?: boolean
	/**
	 * Per-locale FST gazetteer (`fst-<locale>.bin`) for the ASSEMBLED arms (#1497).
	 *
	 * Only the assembled arms can use it — the FST is a decode-time prior applied by `createRuntimePipeline`, and the
	 * bare `neural` arm calls `classifier.parse` directly. Omit for the byte-stable no-FST default.
	 *
	 * This is the tree's only FST-sensitive eval. `eval gauntlet` grades through `parseForGeocode`, which takes no FST at
	 * all, so an FST change is invisible to it — see the note on `assembledPipeline` below.
	 */
	adminFST?: string
	/**
	 * #478 leg 2: add the assembled (pipeline) arms.
	 */
	assembled?: boolean
	/**
	 * Swap the FTS backend for the byte-range candidate-table lookup (demo parity).
	 */
	candidateDB?: string
	/**
	 * #718 situs-eval: grade the production coordinate cascade (per-state shards).
	 */
	cascade?: boolean
	/**
	 * Shard root for `cascade`. Default `$MAILWOMAN_DATA_ROOT`.
	 */
	dataRoot?: string
	/**
	 * Hard country filter for admin lookups (`none` disables). Default `US`.
	 */
	defaultCountry?: string
	/**
	 * Write per-row failure dump here.
	 */
	errorsJSON?: string
	/**
	 * Eval JSONL. Default `data/eval/external/openaddresses-us-sample.jsonl`.
	 */
	eval?: string
	/**
	 * #405: recover the locality dropped for a dual-role place.
	 */
	hierarchyCompletion?: boolean
	/**
	 * #483 house-number interpolation shard (single-state).
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
	modelAnchorLookup?: string
	/**
	 * Candidate model-card.
	 */
	modelCard?: string
	/**
	 * #895 tri-state pin: force adminCoherence OFF.
	 */
	noAdminCoherence?: boolean
	/**
	 * #42 tri-state pin: force postcodeCountryCoherence OFF — the pre-2026-08-05 configuration. This is the leg that
	 * measures whether letting a coherent (postcode, locality) pair override `defaultCountry` is byte-flat on a US panel,
	 * which is the one number the default-on promotion needed and could not get from a confound board.
	 */
	noPostcodeCountryCoherence?: boolean
	/**
	 * #690/#895 tri-state pin: force normalizeCase ON.
	 */
	normalizeCase?: boolean
	/**
	 * #42 tri-state pin: force postcodeCountryCoherence ON. The library default has been ON since 2026-08-05, so this pin
	 * is now a no-op restatement; it stays because a gate leg that says what it graded is the point of a tri-state.
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
	 * #743: production-representative placer (soft country prior).
	 */
	placeCountry?: boolean
	/**
	 * #194/#743: promote a confident placer guess to a hard country filter (safelist-gated).
	 */
	placeCountryHard?: boolean
	/**
	 * Ungated hard-filter measurement (full in-map safelist).
	 */
	placeCountryHardAll?: boolean
	/**
	 * #475 opt-in postal-city alias scorer on the FTS path.
	 */
	postalCityAliasDB?: string
	/**
	 * Add the `neural+anchor` row (coordinate from the postcode anchor centroid).
	 */
	postcodeAnchor?: boolean
	/**
	 * Postcode shards for the anchor rows (comma-separated).
	 */
	postcodeShards?: string
	/**
	 * #690/#895 tri-state pin: force normalizeCase OFF.
	 */
	rawCase?: boolean
	/**
	 * Candidate tokenizer.
	 */
	tokenizer?: string
	/**
	 * WOF shard list (comma-separated). Default admin + postcode-locality-intl.
	 */
	wof?: string
}
