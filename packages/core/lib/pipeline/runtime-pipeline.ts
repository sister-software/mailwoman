/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Coordinate normalization, query-shape analysis, locale and kind detection, parsing, and resolution.
 */

import type { ComponentTag } from "@mailwoman/codex/component"

import { isBareTreeOf } from "#decoder/tree/shape"
import type { AddressNode, AddressTree } from "#decoder/types"
import { errorMessage } from "#errors/schema"
import { PipelineFaultStage, WORD_CONSISTENCY_SHIP_DEFAULT, deriveInputMode } from "#pipeline/types"
import type {
	AddressClassifier,
	FSTMatcherLike,
	InputMode,
	LocaleHint,
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

/**
 * Minimum kind confidence required for a fast path.
 */
const SHORT_CIRCUIT_MIN_CONFIDENCE = 0.95

/**
 * Maximum length of a locality-only input eligible for a fast path.
 */
const SHORT_CIRCUIT_MAX_LOCALITY_LENGTH = 30

/**
 * Recognize postcode format names without importing the query-shape format table.
 */
function isPostcodeFormat(format: string): boolean {
	return format === "us_zip" || format === "us_zip4" || format.endsWith("_postcode")
}

/**
 * Default resolver weight for the coarse-placer country prior.
 */
export const COARSE_PLACER_ANCHOR_WEIGHT = 1

/**
 * Minimum placer confidence for converting a soft country prior to a hard filter.
 */
const HARD_PLACE_COUNTRY_MIN_CONF = 0.9

/**
 * Fallback countries for artifacts without a coverage manifest.
 *
 * A per-call override or the loaded artifact's safelist takes precedence.
 * Countries outside this set keep a soft prior.
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
	// and the hard filter is recall-safe on the AU panel (unresolved 4→2 while abroad 43→20).
	"AU",
])

/**
 * Return whether the tree contains only a locality.
 */
export function isBareLocalityTree(tree: AddressTree): boolean {
	return isBareTreeOf(tree, "locality")
}

/**
 * Return whether the tree contains only a postcode.
 * Its format can outweigh inferred locale scope.
 */
export function isBarePostcodeTree(tree: AddressTree): boolean {
	return isBareTreeOf(tree, "postcode")
}

/**
 * Return a hard country filter only when confidence and coverage qualify and the caller supplied none.
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
 * Return the input unchanged when no normalizer is configured.
 */
function identityNormalize(raw: string, opts?: { locale?: string }): NormalizedInputLite {
	return { raw, normalized: raw, appliedLocale: opts?.locale }
}

/**
 * Return an empty shape when no query-shape stage is configured.
 */
function emptyQueryShape(): QueryShapeLite {
	return { knownFormats: [] }
}

/**
 * Use the caller's locale hint, or `und` when absent.
 */
async function defaultDetectLocale(
	_input: NormalizedInputLite,
	_shape: QueryShapeLite,
	opts?: { hint?: Intl.UnicodeBCP47LocaleIdentifier }
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
 * Default to `structured_address` without enabling a fast path.
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
 * Decide whether a confident postcode or short locality query can skip classification.
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
 * Build a one-node tree for an eligible postcode or locality query.
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
 * Run configured stages in order and return timings, faults, and the decoded tree.
 */
export async function runPipeline(
	raw: string,
	stages: RuntimePipelineStages,
	opts?: PipelineOpts
): Promise<PipelineResult> {
	const timing: Record<string, number> = {}
	// Collect stage failures for the result.
	const faults: PipelineFault[] = []
	const t0 = performance.now()

	const normalize = stages.normalize ?? identityNormalize
	const computeQueryShape = stages.computeQueryShape ?? emptyQueryShape
	const detectLocale = stages.detectLocale ?? defaultDetectLocale
	const classifyKind = stages.classifyKind ?? defaultClassifyKind

	throwIfAborted(opts)
	const normalized = normalize(raw, { locale: opts?.locale })
	timing["normalize"] = performance.now() - t0

	// Add a soft country prior unless the caller already supplied one.
	let effectiveOpts = opts
	// Track whether the placer supplied the posterior so bare queries can omit it.
	let placerAnchorApplied = false

	if (stages.placeCountry) {
		const tPlace = performance.now()
		const placed = stages.placeCountry(normalized.normalized)
		timing["place-country"] = performance.now() - tPlace

		if (placed.country && placed.country !== "OTHER" && !opts?.resolveOpts?.anchorPosterior) {
			// Promote to a hard filter only when confidence, coverage, and caller settings allow it.
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
					// The full in-map distribution when the placer supplies it (resolver breaks ties);
					// else the one-hot argmax (the M2 behavior).
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
	timing["locale-hint"] = performance.now() - tLocale

	throwIfAborted(opts)
	const tKind = performance.now()
	const kind = await classifyKind(normalized, queryShape, locale)
	timing["kind-classifier"] = performance.now() - tKind

	// Normalize optional classifier markers to an array.
	// Resolve-time markers are added later.
	const intentMarkers: QueryIntentMarker[] = kind.intentMarkers ? [...kind.intentMarkers] : []

	// Route POI-shaped queries through the intent stage when configured.
	// A null result falls back to parsing.
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

	// Build a tree directly from query-shape data for eligible simple inputs.
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

	// Collect phrase proposals when the optional grouper is configured.
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
			// Use the caller's register, or derive one from the query kind.
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

		// Omit the placer prior for bare locality and postcode queries.
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
 * Throw the abort reason between stages.
 * In-flight stages run to completion.
 */
function throwIfAborted(opts?: PipelineOpts): void {
	if (opts?.signal?.aborted) {
		throw opts.signal.reason ?? new DOMException("Pipeline aborted", "AbortError")
	}
}

/**
 * Record a stage failure so callers can distinguish degraded output from a clean result.
 */
function recordFault(faults: PipelineFault[], stage: PipelineFaultStage, cause: unknown): void {
	faults.push({
		stage,
		name: cause instanceof Error ? cause.name : "Error",
		message: errorMessage(cause),
		cause,
	})
}

/**
 * Return an empty tree on classifier failure and record the failure.
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
		// Forward parser options; preserve classifier defaults when optional values are absent.
		return await classifier.parse(text, {
			queryShape,
			inputMode,
			fst,
			postcodeRepair: true,
			normalizeCase,
			enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
			...(placetypePair !== undefined ? { placetypePair } : {}),
			...streetContextRequirementFor({ fst, streetMorphology }),
		})
	} catch (error) {
		recordFault(faults, PipelineFaultStage.Classifier, error)

		return { raw: text, roots: [] }
	}
}

/**
 * Enable street-context checks only when both matchers are available.
 */
export const ZEROED_MORPHOLOGY_OPTS = { biasScale: 0, dependentLocalityPenalty: 0 } as const

/**
 * Scale for positive street-context emissions.
 */
export const STREET_CONTEXT_POSITIVE_SCALE = 0

export function streetContextRequirementFor(stages: { fst?: FSTMatcherLike; streetMorphology?: FSTMatcherLike }): {
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
 * Return no phrase proposals on grouper failure and record the error.
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
 * Add a provisional node for each uncovered phrase proposal.
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
 * Preserve the classifier tree and record the error when resolution fails.
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
