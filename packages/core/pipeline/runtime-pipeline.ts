/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `runPipeline` — the runtime coordinator that composes all six stages.
 *
 *   Generic over stage implementations (see `types.ts::RuntimePipelineStages`). Each stage is
 *   injected; the coordinator handles composition, timing, fast-path routing, and graceful
 *   degradation when stages are absent.
 *
 *   Implementation contract per `docs/engineering/reference/STAGES.md`.
 */

import { isBareTreeOf } from "#decoder/tree-shape"
import type { AddressNode, AddressTree } from "#decoder/types"
import { PipelineFaultStage, WORD_CONSISTENCY_SHIP_DEFAULT, deriveInputMode } from "#pipeline/types"
import type {
	AddressClassifier,
	FSTMatcherLike,
	InputMode,
	LocaleHint,
	LocaleTag,
	NormalizedInputLite,
	PhraseProposal,
	PipelineFault,
	PipelineOpts,
	PipelineResult,
	PlacetypePairPassthrough,
	QueryIntentMarker,
	QueryKindResult,
	QueryShapeLite,
	RuntimePipelineStages,
} from "#pipeline/types"
import type { ComponentTag } from "#types/component"

/**
 * Kind confidence required to skip the full pipeline. Set high deliberately: a short-circuit that fires on a wrong kind
 * cannot be recovered downstream, so the cost of being wrong is a whole mis-parse, while the cost of being cautious is
 * one extra pass.
 */
const SHORT_CIRCUIT_MIN_CONFIDENCE = 0.95

/**
 * Longest `locality_only` input allowed to short-circuit. Past it the query is likely carrying more than a locality
 * name, and the full pipeline should look for what else is in there.
 */
const SHORT_CIRCUIT_MAX_LOCALITY_LENGTH = 30

/**
 * Known QueryShape format strings that indicate "this token is a postcode". Mirrors the set in
 * `@mailwoman/kind-classifier` — kept duplicated so core/pipeline has no dep on kind-classifier.
 */
const POSTCODE_FORMATS: ReadonlySet<string> = new Set([
	"us_zip",
	"us_zip4",
	"uk_postcode",
	"fr_postcode",
	"de_postcode",
	"ca_postcode",
	"jp_postcode",
])

function isPostcodeFormat(format: string): boolean {
	return POSTCODE_FORMATS.has(format)
}

/**
 * Anchor weight for the coarse-placer's country prior (#244). Lower than the postcode anchor's 2.0 default — a
 * whole-string country guess is a broader, softer signal than a postcode that pins the country, so it blends more
 * gently with the candidate score.
 */
export const COARSE_PLACER_ANCHOR_WEIGHT = 1

/**
 * #194: minimum placer confidence to promote the soft country prior to a HARD filter (empty→unresolved). The placer
 * already abstains below 0.9 in-map MASS (open-set rule), but the per-country argmax prob can still be split across
 * neighbours (DK↔NO, EE↔LT↔LV); requiring a high argmax confidence keeps the hard filter to the cases the model is sure
 * of (FI/PL routinely score ~1.0) and leaves the ambiguous ones on the soft path. Deliberately strict — a wrong hard
 * country is the #244 M2 misroute failure.
 */
const HARD_PLACE_COUNTRY_MIN_CONF = 0.9

/**
 * #743/#194 coverage guard: countries whose candidate gazetteer is complete enough that hard-filtering is a PURE WIN —
 * measured hard-resolve-rate ≥ 95% on held-out OpenAddresses points, so a hard-filter "miss → unresolved" is rare and
 * almost always a genuine non-match, not a coverage gap. A confident placement OUTSIDE this set stays on the SOFT
 * prior, so the low-coverage tail (FI/PL/…) keeps its recall until its gazetteer is filled (#193) — the win for covered
 * countries, no recall regression for the rest (DeepSeek-advised, 2026-06-22).
 *
 * FALLBACK ROLE (survey candidate #2, 2026-07-26): this set is now the FALLBACK for gazetteer artifacts that predate
 * the coverage manifest. Facts about the artifact live IN the artifact — the candidate gazetteer's `country_coverage`
 * table carries the per-country promote-gate verdicts + the measured rates (the numbers that used to be trivia in this
 * comment), and a loaded artifact's derived safelist (`resolver.artifactCoverage.hardCountrySafelist`) takes precedence
 * over this constant. The measured record lives in `mailwoman/gazetteer-pipeline/coverage-manifest.ts`
 * (MEASURED_COUNTRY_COVERAGE — grow THAT at promotes; it updates the artifact at rebuild). Precedence: per-call
 * `PipelineOpts.hardCountrySafelist` (the eval's instrument, measures ungated to grow the list) → the loaded artifact's
 * manifest → this constant. Historical receipts now recorded structurally in MEASURED_COUNTRY_COVERAGE: US/FR/DE 100,
 * ES 99.8, NL 97.3, IT 96.8 (in); FI 69.5, PL 77.8 (measured, out); GB + CA at the #928 promote (2026-07-06, OSM
 * panels, night 34); AU with the #244 placer class (2026-07-06).
 */
export const HARD_PLACE_COUNTRY_SAFELIST: ReadonlySet<string> = new Set([
	"US",
	"ES",
	"IT",
	"NL",
	"DE",
	"FR",
	"GB",
	"CA",
	// AU added with the #244 AU placer class (2026-07-06): 150k-row G-NAF training → AU test-acc 100%,
	// and the hard filter is recall-SAFE on the AU panel (unresolved 4→2 while abroad 43→20).
	"AU",
])

/**
 * #912 lever 1 — is this parse a single BARE locality ("Paris", "Dublin")? The coarse placer is out-of-distribution on
 * one-token city names (trained on full addresses): measured on the gauntlet's bare-namesake rows it emitted Paris→IT
 * .35, Melbourne→GB .66 — all wrong, and even sub-threshold the SOFT posterior still re-ranks the resolver toward the
 * wrong country. A bare locality carries no country evidence the placer can read that the resolver's exact-tier +
 * population ranking doesn't already use better — so both production placeCountry call sites (the runtime pipeline and
 * `geocodeAddress`) ABSTAIN on this shape. Any second non-empty component makes the input address-shaped and the placer
 * runs as before.
 */
export function isBareLocalityTree(tree: AddressTree): boolean {
	return isBareTreeOf(tree, "locality")
}

/**
 * #1589's sibling of the #912 guard: true when the tree's ONLY value-bearing node is a `postcode`.
 *
 * A bare postcode under a locale-inferred country scope is the same disaster shape as a bare locality: `SW1A 1AA` under
 * the default en-US locale gets a HARD `defaultCountry: "US"` that filters the GB postalcode row the gazetteer holds,
 * and the query resolves to nothing — while the identical query under `--locale en-GB` answers 38 m from the rooftop.
 * The postcode's own FORMAT is harder evidence than the locale hint (the #928 table's premise), so the caller withholds
 * the inferred scope for this shape when the format implies countries that exclude it.
 */
export function isBarePostcodeTree(tree: AddressTree): boolean {
	return isBareTreeOf(tree, "postcode")
}

/**
 * #743/#194: the shared coverage-guard gate — decide whether a confident coarse-placer country should become a HARD
 * candidate filter. Exported so the two production placeCountry call sites (the runtime pipeline AND `geocodeAddress`)
 * apply the SAME three gates and can't drift: confidence ≥ {@link HARD_PLACE_COUNTRY_MIN_CONF}, country in the safelist
 * (override or the default {@link HARD_PLACE_COUNTRY_SAFELIST}), and no caller-set hard/default country to respect.
 * Returns the country to hard-filter, or `undefined` to stay on the soft prior.
 *
 * `safelist` precedence is the CALLER's job: pass `perCallOverride ?? resolver.artifactCoverage?.hardCountrySafelist`
 * (the eval instrument first, then the loaded artifact's own manifest) and this gate falls back to the code constant
 * only when both are absent — byte-identical to the pre-manifest behavior.
 */
export function hardCountryFor(
	placedCountry: string,
	placedConfidence: number,
	existing: { hardCountry?: string; defaultCountry?: string },
	hardPlaceCountry: boolean | undefined,
	safelist: ReadonlySet<string> | undefined
): string | undefined {
	if (!hardPlaceCountry) return undefined

	if (placedConfidence < HARD_PLACE_COUNTRY_MIN_CONF) return undefined

	if (!(safelist ?? HARD_PLACE_COUNTRY_SAFELIST).has(placedCountry)) return undefined

	if (existing.hardCountry || existing.defaultCountry) return undefined

	return placedCountry
}

function isPostcodeFormatHit(hit: { format: string }): boolean {
	return isPostcodeFormat(hit.format)
}

/**
 * Pass-through normalize used when no `normalize` stage is wired.
 */
function identityNormalize(raw: string, opts?: { locale?: string }): NormalizedInputLite {
	return { raw, normalized: raw, appliedLocale: opts?.locale }
}

/**
 * No-op query-shape used when no `computeQueryShape` stage is wired.
 */
function emptyQueryShape(): QueryShapeLite {
	return { knownFormats: [] }
}

/**
 * Default locale detector: trusts the caller's hint, or falls back to `und`.
 */
async function defaultDetectLocale(
	_input: NormalizedInputLite,
	_shape: QueryShapeLite,
	opts?: { hint?: LocaleTag }
): Promise<LocaleHint> {
	const locale = opts?.hint ?? "und"

	return {
		locale,
		confidence: opts?.hint ? 1 : 0,
		alternatives: [],
		source: opts?.hint ? "caller" : "detected",
	}
}

/**
 * Default kind classifier: always returns `structured_address` with low confidence (no fast-path).
 */
async function defaultClassifyKind(
	_input: NormalizedInputLite,
	_shape: QueryShapeLite,
	_locale: LocaleHint
): Promise<QueryKindResult> {
	return {
		kind: "structured_address",
		confidence: 0,
		alternatives: [],
	}
}

/**
 * Decide whether to short-circuit stages 3-5 and go straight to resolve. Conservative: requires high kind-classifier
 * confidence AND a matching QueryShape known-format hit. See `STAGES.md#fast-path-routing` for the rationale.
 */
function canShortCircuit(kind: QueryKindResult, shape: QueryShapeLite, opts?: PipelineOpts): boolean {
	if (opts?.forceFullPipeline) return false

	if (kind.confidence < SHORT_CIRCUIT_MIN_CONFIDENCE) return false

	if (kind.kind === "postcode_only") {
		return shape.knownFormats.some(isPostcodeFormatHit)
	}

	if (kind.kind === "locality_only") {
		return (shape.totalLength ?? Infinity) <= SHORT_CIRCUIT_MAX_LOCALITY_LENGTH && shape.characterClass === "alpha"
	}

	return false
}

/**
 * Build a stub `AddressTree` for the fast-path case (no classifier ran). Single root node tagged by the QueryShape's
 * known-format hit.
 */
function buildFastPathTree(text: string, kind: QueryKindResult, shape: QueryShapeLite): AddressTree {
	if (kind.kind === "postcode_only") {
		const hit = shape.knownFormats.find((f) => isPostcodeFormat(f.format))

		if (hit) {
			return {
				raw: text,
				roots: [
					{
						tag: "postcode",
						value: text.slice(hit.span.start, hit.span.end),
						start: hit.span.start,
						end: hit.span.end,
						confidence: hit.confidence,
						children: [],
						source: "query-shape",
						sourceID: hit.format,
					},
				],
			}
		}
	}

	if (kind.kind === "locality_only") {
		return {
			raw: text,
			roots: [
				{
					tag: "locality",
					value: text.trim(),
					start: 0,
					end: text.length,
					confidence: kind.confidence,
					children: [],
					source: "query-shape",
					sourceID: "kind:locality_only",
				},
			],
		}
	}

	return { raw: text, roots: [] }
}

/**
 * Run the runtime pipeline.
 *
 * Composition order (per STAGES.md):
 *
 * 1. Normalize (or identity)
 * 2. Compute QueryShape (or empty)
 * 3. Locale gate (or caller-trust)
 * 4. Kind classifier (or default structured_address)
 * 5. Branch: fast-path → resolver; full → classifier → resolver
 *
 * Per-stage timing recorded on `result.timing`. Fast-path stages are absent from the timing map.
 */
export async function runPipeline(
	raw: string,
	stages: RuntimePipelineStages,
	opts?: PipelineOpts
): Promise<PipelineResult> {
	const timing: Record<string, number> = {}
	// One list per run, threaded into each `safe*` wrapper. Every return site below surfaces it, so an empty array is a
	// positive statement ("no stage faulted"), not a field that happened not to be set.
	const faults: PipelineFault[] = []
	const t0 = performance.now()

	const normalize = stages.normalize ?? identityNormalize
	const computeQueryShape = stages.computeQueryShape ?? emptyQueryShape
	const detectLocale = stages.detectLocale ?? defaultDetectLocale
	const classifyKind = stages.classifyKind ?? defaultClassifyKind

	throwIfAborted(opts)
	const normalized = normalize(raw, { locale: opts?.locale })
	timing["normalize"] = performance.now() - t0

	// Coarse country router (#244, soft prior). A confident in-map guess becomes an `anchorPosterior`
	// the resolver's #369 re-rank BOOSTS (never filters); abstain/OTHER → no signal. Defers to a
	// caller-supplied posterior (a stronger postcode anchor — never overwrite it). Off (no stage) →
	// `effectiveOpts === opts` → byte-stable. See the soft-signal wiring spec.
	let effectiveOpts = opts
	// #912 lever 1: true when the anchorPosterior in effectiveOpts came from the placer (not the
	// caller) — the post-parse bare-locality abstention below only strips what the placer added.
	let placerAnchorApplied = false

	if (stages.placeCountry) {
		const tPlace = performance.now()
		const placed = stages.placeCountry(normalized.normalized)
		timing["place-country"] = performance.now() - tPlace

		if (placed.country && placed.country !== "OTHER" && !opts?.resolveOpts?.anchorPosterior) {
			// #194/#743: promote a CONFIDENT placement to a HARD country filter (empty→unresolved) when the
			// caller opts in, the confidence clears the bar, AND the country is in the coverage SAFELIST. The
			// soft posterior alone can't move a LOW-population place (a FI town loses to a high-pop namesake
			// even when FI is pinned); the hard filter does. Three gates: confidence (ambiguous DK↔NO stay
			// soft), the safelist (only well-covered countries — where a miss is a genuine non-match, not a
			// coverage gap — hard-filter; the low-coverage tail keeps its recall on the soft path), and the
			// caller's own hardCountry/defaultCountry is never overwritten. Safelist precedence: the per-call
			// `hardCountrySafelist` override (the eval measures ungated to grow it) → the loaded gazetteer
			// artifact's own coverage manifest → the code-constant fallback inside hardCountryFor.
			const hardCountry = hardCountryFor(
				placed.country,
				placed.confidence,
				opts?.resolveOpts ?? {},
				opts?.hardPlaceCountry,
				opts?.hardCountrySafelist ?? stages.resolver?.artifactCoverage?.hardCountrySafelist
			)

			placerAnchorApplied = true

			effectiveOpts = {
				...opts,
				resolveOpts: {
					...opts?.resolveOpts,
					// The full in-map distribution when the placer supplies it (resolver breaks ties); else the
					// one-hot argmax (the M2 behavior).
					anchorPosterior: placed.posterior ?? { [placed.country]: placed.confidence },
					anchorWeight: opts?.resolveOpts?.anchorWeight ?? COARSE_PLACER_ANCHOR_WEIGHT,
					...(hardCountry ? { hardCountry } : {}),
				},
			}
		}
	}

	throwIfAborted(opts)
	const tQs = performance.now()
	const queryShape = computeQueryShape(normalized, { locale: opts?.locale })
	timing["query-shape"] = performance.now() - tQs

	throwIfAborted(opts)
	const tLocale = performance.now()
	const locale = await detectLocale(normalized, queryShape, { hint: opts?.locale })
	timing["locale-gate"] = performance.now() - tLocale

	throwIfAborted(opts)
	const tKind = performance.now()
	const kind = await classifyKind(normalized, queryShape, locale)
	timing["kind-classifier"] = performance.now() - tKind

	// ROAD_TO_V9 §4. The classifier OWNS marker derivation (it is the stage that knows which intent rule fired); the
	// coordinator only lifts the optional field into an always-present array, so an empty array is this coordinator
	// stating that the vocabulary looked. A classifier with no intent vocabulary — including `defaultClassifyKind`
	// above — leaves the field unset and every result carries `[]`, which is the byte-stable pre-§4 behaviour.
	//
	// `declared_ambiguity` is deliberately ABSENT from this list: its trigger is the resolved candidate list's
	// dominance margin, and the measured 0.5-log10 cut behind it lives in `mailwoman`'s eval harness, which core
	// cannot import (the dependency runs the other way). `mailwoman/query-intent.ts` adds it on the geocode path.
	const intentMarkers: QueryIntentMarker[] = kind.intentMarkers ? [...kind.intentMarkers] : []

	// POI branch (spec §3.1). Only reachable when a poi-aware kind classifier was wired (the
	// default classifier never emits `poi_query`), and only acts when the stage is present —
	// both absent by default, so the flag-off pipeline is byte-identical by construction. A
	// `null` outcome falls through to the full pipeline: a poi_query kind with no extractable
	// subject is a mis-detection, and the address path is the safe interpretation.
	// `poi_category` (ROAD_TO_V9 §4.4) is the ANCHORLESS subset of `poi_query` — same subject, no place to search
	// near. It routes here identically on purpose: the branch condition is the only place the two would have diverged,
	// and a bare "tacos" reaching the poi-intent stage under a different kind name would have been a routing change
	// dressed up as a vocabulary addition.
	if ((kind.kind === "poi_query" || kind.kind === "poi_category") && stages.poiIntent) {
		throwIfAborted(opts)
		const tPoi = performance.now()
		const poiOutcome = await stages.poiIntent(normalized, locale, effectiveOpts)
		timing["poi-intent"] = performance.now() - tPoi

		if (poiOutcome) {
			const emptyTree: AddressTree = { raw: normalized.normalized, roots: [] }
			const tree = poiOutcome.type === "intent" ? (poiOutcome.intent.anchor?.tree ?? emptyTree) : emptyTree

			return {
				input: raw,
				normalized,
				queryShape,
				locale,
				kind,
				phraseProposals: [],
				tree,
				poiIntent: poiOutcome,
				timing,
				faults,
				intentMarkers,
				path: "poi",
			}
		}
	}

	// Fast-path: trivial inputs short-circuit stages 3-5. The fast-path tree is built from
	// QueryShape's format hits + kind alone — useful even without a wired resolver (a consumer
	// who just wants the parsed structure for a bare postcode shouldn't be forced to pay for the
	// classifier).
	if (canShortCircuit(kind, queryShape, opts)) {
		let tree = buildFastPathTree(normalized.normalized, kind, queryShape)

		if (stages.resolver) {
			throwIfAborted(opts)
			const tResolve = performance.now()
			tree = await safeResolve(faults, stages.resolver, tree, effectiveOpts)
			timing["resolve"] = performance.now() - tResolve
		}

		return {
			input: raw,
			normalized,
			queryShape,
			locale,
			kind,
			phraseProposals: [],
			tree,
			timing,
			faults,
			intentMarkers,
			path: "fast-path",
		}
	}

	// Full pipeline.
	// Stage 2.7 — phrase grouper. Optional injection; runs when wired. Proposals flow forward to
	// stages 3 + 5 (today: surfaced on the result; tomorrow: passed in as classifier conditioning).
	let phraseProposals: PhraseProposal[] = []

	if (stages.groupPhrases) {
		throwIfAborted(opts)
		const tGroup = performance.now()
		phraseProposals = await safeGroupPhrases(faults, stages.groupPhrases, normalized, queryShape, locale)
		timing["phrase-grouper"] = performance.now() - tGroup
	}

	let tree: AddressTree = { raw: normalized.normalized, roots: [] }

	if (stages.classifier) {
		throwIfAborted(opts)
		const tClassify = performance.now()

		tree = await safeClassify(faults, stages.classifier, normalized.normalized, queryShape, {
			fst: stages.fst,
			normalizeCase: opts?.normalizeCase,
			placetypePair: opts?.placetypePair,
			streetMorphology: stages.streetMorphology,
			// Decision A: explicit caller register wins; otherwise the kind verdict decides. NEVER case-keyed.
			inputMode: opts?.inputMode ?? deriveInputMode(kind.kind),
		})

		timing["token-classify"] = performance.now() - tClassify
	}

	if (phraseProposals.length && tree.roots.length >= 0) {
		const tAudit = performance.now()
		tree = grouperAudit(tree, phraseProposals, normalized.normalized)
		timing["grouper-audit"] = performance.now() - tAudit
	}

	if (stages.resolver) {
		throwIfAborted(opts)
		const tResolve = performance.now()

		// #912 lever 1: the placer abstains on a single bare locality — strip ONLY the anchor it
		// added (a caller-supplied posterior was never overwritten and passes through untouched).
		// #1589: a bare POSTCODE abstains the same way — the code's format carries the country
		// evidence, and the placer's language read of it is noise (see isBarePostcodeTree).
		if (placerAnchorApplied && (isBareLocalityTree(tree) || isBarePostcodeTree(tree))) {
			effectiveOpts = opts
		}

		tree = await safeResolve(faults, stages.resolver, tree, effectiveOpts)
		timing["resolve"] = performance.now() - tResolve
	}

	return {
		input: raw,
		normalized,
		queryShape,
		locale,
		kind,
		phraseProposals,
		tree,
		timing,
		faults,
		intentMarkers,
		path: "full",
	}
}

/**
 * Throws the signal's reason if aborted. Coarse-grained cancellation: we check between stages, so the longest
 * cancellation latency is one stage's runtime. Fine-grained mid-stage cancellation requires plumbing `signal` into each
 * stage's contract (`detectLocale`, `classifyKind`, `classifier.parse`, `resolver.resolveTree`) — a future enhancement
 * once stage authors are ready for it. For now, in-flight stages always run to completion before the abort takes
 * effect.
 */
function throwIfAborted(opts?: PipelineOpts): void {
	if (opts?.signal?.aborted) {
		throw opts.signal.reason ?? new DOMException("Pipeline aborted", "AbortError")
	}
}

/**
 * Normalize a caught throw into a {@link PipelineFault} and append it to the run's fault list.
 *
 * The wrappers below all call this instead of `catch {}`. A bare `catch {}` is what made a classifier crash
 * indistinguishable from a clean no-match (#40 / mailfail finding 4) — the tree came back empty, the grouper-audit
 * refilled it from rule-based proposals, and the caller saw a tidy parse. Degrading is still the right behavior; doing
 * it silently was not.
 */
function recordFault(faults: PipelineFault[], stage: PipelineFaultStage, cause: unknown): void {
	faults.push({
		stage,
		name: cause instanceof Error ? cause.name : "Error",
		message: cause instanceof Error ? cause.message : String(cause),
		cause,
	})
}

/**
 * Defensive wrapper: if the classifier throws, return an empty tree rather than abort the pipeline — and record the
 * throw on `faults` so the degrade is visible to the caller.
 *
 * The measured reason this matters (mailfail, 2026-08-02): with the 128-piece `pieces`/`logits` desync live, 10 of 110
 * probe inputs crashed the classifier while the pipeline reported success. `size-10kb` — 10 KB of repeated addresses —
 * came back as `{"house_number":"350","street":"5th Ave","locality":"Ave","region":"NY","postcode":"10118"}` off a
 * 3,031-node tree, which reads exactly like a correct parse of one address. The fault list is what lets a caller tell
 * those apart without instrumenting the classifier.
 */
async function safeClassify(
	faults: PipelineFault[],
	classifier: AddressClassifier,
	text: string,
	queryShape: QueryShapeLite,
	knobs: {
		fst?: FSTMatcherLike
		normalizeCase?: boolean
		placetypePair?: PlacetypePairPassthrough
		streetMorphology?: FSTMatcherLike
		inputMode?: InputMode
	} = {}
): Promise<AddressTree> {
	const { fst, normalizeCase, placetypePair, streetMorphology, inputMode } = knobs

	try {
		// Postcode regex repair on by default (v0.7 #35, operator-signed). #690 normalizeCase forwards as-is —
		// default-ON at the classifier since #895 (unset runs it; explicit false pins the raw-case parse).
		// Word-consistency heal on by default (2026-07-15): arbitrates intra-word tag disagreement only, with the
		// punctuation-separator + byte-fallback gates — clean win across golden us/fr/adversarial + parity floors.
		// Semantics in neural/word-consistency.ts.
		// placetypePair (#1278): an opaque per-parse prior handle forwarded verbatim — undefined omits it (byte-stable
		// no-prior decode), so the classifier's `opts?.placetypePair ?? cfg.placetypePair` resolution is unchanged when absent.
		return await classifier.parse(text, {
			queryShape,
			inputMode,
			fst,
			postcodeRepair: true,
			normalizeCase,
			enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
			...(placetypePair !== undefined ? { placetypePair } : {}),
			...streetContextGateFor({ fst, streetMorphology }),
		})
	} catch (error) {
		recordFault(faults, PipelineFaultStage.Classifier, error)

		return { raw: text, roots: [] }
	}
}

/**
 * The street-context gate pair (#1315): when BOTH the gazetteer FST and the street-morphology matcher are wired, the
 * classify call passes the matcher in with the morphology EMISSION prior zeroed — the gate alone (measured golden-flat,
 * fragment-positive) without the emission prior (measured US-golden −48). Absent either matcher, the spread is `{}` and
 * the decode is byte-stable.
 */
export const ZEROED_MORPHOLOGY_OPTS = { biasScale: 0, dependentLocalityPenalty: 0 } as const

/**
 * D2 remediation (#1320, ROAD_TO_MAILWOMAN_V8_1_0 §5.2): the pipeline ships the gate at FULL suppression (0.0), not the
 * classifier's 0.25 default. Measured 2026-07-26 on v8.0.0-as-shipped (branch TS == origin/main, FST md5 == published):
 * 0.0 puts FR admin-street-homonym at EXACT P0 parity (159/400 vs 157 at 0.25) with golden us/fr and every other
 * fragment class byte-identical to 0.25 — the "some admin mass for the semi-markov decoder" rationale for 0.25 carried
 * no measured benefit at the pipeline level. Satisfies the D-rule (iron rule 6) ≥P0 clause for #1318.
 */
export const STREET_CONTEXT_POSITIVE_SCALE = 0

export function streetContextGateFor(stages: { fst?: FSTMatcherLike; streetMorphology?: FSTMatcherLike }): {
	fstStreetMorphology?: FSTMatcherLike
	fstStreetMorphologyOpts?: { biasScale: number; dependentLocalityPenalty: number }
	fstStreetContextPositiveScale?: number
} {
	return stages.fst && stages.streetMorphology
		? {
				fstStreetMorphology: stages.streetMorphology,
				fstStreetMorphologyOpts: { ...ZEROED_MORPHOLOGY_OPTS },
				fstStreetContextPositiveScale: STREET_CONTEXT_POSITIVE_SCALE,
			}
		: {}
}

/**
 * Defensive wrapper: a grouper failure returns an empty proposal list rather than abort, and records the throw.
 */
async function safeGroupPhrases(
	faults: PipelineFault[],
	groupPhrases: NonNullable<RuntimePipelineStages["groupPhrases"]>,
	normalized: NormalizedInputLite,
	shape: QueryShapeLite,
	locale: LocaleHint
): Promise<PhraseProposal[]> {
	try {
		return await groupPhrases(normalized, shape, locale)
	} catch (error) {
		recordFault(faults, PipelineFaultStage.PhraseGrouper, error)

		return []
	}
}

// MARK: Grouper-audit pass

const GROUPER_TYPING_PENALTY = 0.55

const PHRASE_KIND_TO_TAG: ReadonlyMap<string, ComponentTag> = new Map([
	["VENUE_PHRASE", "venue"],
	["LOCALITY_PHRASE", "locality"],
	["REGION_ABBREVIATION", "region"],
	["POSTCODE", "postcode"],
	["STREET_PHRASE", "street"],
	["NUMERIC", "house_number"],
])

/**
 * Post-classification audit: for each phrase-grouper proposal whose span is entirely unlabeled (all-O) in the
 * classifier output, inject a provisional node using the grouper's structural hypothesis. This rescues spans the neural
 * model couldn't type — primarily venue text.
 *
 * The audit once took a classifier top-k and deferred to it on an orphaned span, and once suppressed a duplicate
 * singleton tag. Both existed for the joint-reconcile path, which fed the only top-k that ever reached here and was
 * removed in #1749; on the surviving argmax path the parameter was always `undefined`, so neither branch could fire.
 * Removed rather than left as unreachable code — the #425 reasoning they encoded is in the retirement report.
 */
export function grouperAudit(tree: AddressTree, proposals: PhraseProposal[], text: string): AddressTree {
	if (!proposals.length) return tree

	const roots = [...tree.roots]

	const allNodes: Array<{ start: number; end: number }> = []

	const collectNodes = (nodes: typeof roots): void => {
		for (const n of nodes) {
			allNodes.push({ start: n.start, end: n.end })

			if (n.children) {
				collectNodes(n.children as typeof roots)
			}
		}
	}

	collectNodes(roots)

	for (const proposal of proposals) {
		const phraseTag = PHRASE_KIND_TO_TAG.get(proposal.kindHypothesis)

		if (!phraseTag) continue

		const pStart = proposal.span.start
		const pEnd = pStart + proposal.span.body.length

		const covered = allNodes.some((node) => node.start < pEnd && pStart < node.end)

		if (covered) continue

		const tag = phraseTag

		const provisionalNode: AddressNode = {
			tag,
			value: text.slice(pStart, pEnd),
			start: pStart,
			end: pEnd,
			confidence: proposal.confidence * GROUPER_TYPING_PENALTY,
			children: [],
			source: "grouper-audit",
			sourceID: `grouper:${proposal.kindHypothesis}`,
		}

		roots.push(provisionalNode)
	}

	roots.sort((a, b) => a.start - b.start)

	return { raw: tree.raw, roots }
}

/**
 * Defensive wrapper: a resolver failure leaves the classifier tree intact, and records the throw. Unresolved-because-
 * the-backend-threw and unresolved-because-nothing-matched produce the same tree, so without the fault the caller
 * cannot tell a dead gazetteer from a genuine no-match.
 */
async function safeResolve(
	faults: PipelineFault[],
	resolver: NonNullable<RuntimePipelineStages["resolver"]>,
	tree: AddressTree,
	opts?: PipelineOpts
): Promise<AddressTree> {
	try {
		return await resolver.resolveTree(tree, opts?.resolveOpts)
	} catch (error) {
		recordFault(faults, PipelineFaultStage.Resolver, error)

		return tree
	}
}
