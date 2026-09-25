/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runs the parse pipeline: normalization, query shape, locale and kind detection, classification and resolution.
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
 * A query kind needs at least this confidence to take the fast path.
 */
const SHORT_CIRCUIT_MIN_CONFIDENCE = 0.95

/**
 * A locality-only input longer than this many characters takes the full pipeline.
 */
const SHORT_CIRCUIT_MAX_LOCALITY_LENGTH = 30

/**
 * Reports whether a query-shape format name denotes a postcode.
 */
function isPostcodeFormat(format: string): boolean {
	return format === "us_zip" || format === "us_zip4" || format.endsWith("_postcode")
}

/**
 * The default resolver weight for the coarse-placer country prior.
 */
export const COARSE_PLACER_ANCHOR_WEIGHT = 1

/**
 * The placer needs at least this confidence to turn its country prior into a hard filter.
 */
const HARD_PLACE_COUNTRY_MIN_CONF = 0.9

/**
 * The countries eligible for a hard country filter when the artifact has no coverage manifest.
 *
 * A per-call override or the loaded artifact's safelist takes precedence.
 * Countries outside the set keep a soft prior.
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
	"AU",
])

/**
 * Reports whether the tree contains only a locality.
 */
export function isBareLocalityTree(tree: AddressTree): boolean {
	return isBareTreeOf(tree, "locality")
}

/**
 * Reports whether the tree contains only a postcode.
 */
export function isBarePostcodeTree(tree: AddressTree): boolean {
	return isBareTreeOf(tree, "postcode")
}

/**
 * Returns the placed country as a hard filter, or `undefined` when the option is off,
 * confidence is too low, the country is outside the safelist, or the caller already set a country.
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
 * Returns the input unchanged.
 * The pipeline uses it when no normalizer is configured.
 */
function identityNormalize(raw: string, opts?: { locale?: string }): NormalizedInputLite {
	return { raw, normalized: raw, appliedLocale: opts?.locale }
}

/**
 * Returns an empty query shape.
 *
 * The pipeline uses it when no query-shape stage is configured.
 */
function emptyQueryShape(): QueryShapeLite {
	return { knownFormats: [] }
}

/**
 * Returns the caller's locale hint, or `und` when the caller gave none.
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
 * Returns `structured_address` with zero confidence, so the fast path never applies.
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
 * Reports whether a confident postcode or short alphabetic locality query can skip classification.
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
 * Builds a one-node tree for a fast-path postcode or locality query.
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
 * Runs the configured stages in order and returns the decoded tree with per-stage timings and faults.
 *
 * A failing classifier, grouper or resolver records a fault and the run continues.
 * An aborted signal throws between stages.
 */
export async function runPipeline(
	raw: string,
	stages: RuntimePipelineStages,
	opts?: PipelineOpts
): Promise<PipelineResult> {
	const timing: Record<string, number> = {}
	const faults: PipelineFault[] = []
	const t0 = performance.now()

	const normalize = stages.normalize ?? identityNormalize
	const computeQueryShape = stages.computeQueryShape ?? emptyQueryShape
	const detectLocale = stages.detectLocale ?? defaultDetectLocale
	const classifyKind = stages.classifyKind ?? defaultClassifyKind

	throwIfAborted(opts)
	const normalized = normalize(raw, { locale: opts?.locale })
	timing["normalize"] = performance.now() - t0

	// The coarse placer adds a country prior unless the caller already supplied one.
	let effectiveOpts = opts
	let placerAnchorApplied = false

	if (stages.placeCountry) {
		const tPlace = performance.now()
		const placed = stages.placeCountry(normalized.normalized)
		timing["place-country"] = performance.now() - tPlace

		if (placed.country && placed.country !== "OTHER" && !opts?.resolveOpts?.anchorPosterior) {
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
					// The resolver uses the full posterior when the placer supplies one, and a one-hot argmax otherwise.
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

	const intentMarkers: QueryIntentMarker[] = kind.intentMarkers ? [...kind.intentMarkers] : []

	// A POI-shaped query goes to the intent stage first.
	// A null outcome falls through to parsing.
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

		// A bare locality or postcode query resolves without the placer's prior.
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
 * Throws the signal's abort reason.
 *
 * The pipeline checks between stages, so a running stage finishes first.
 */
function throwIfAborted(opts?: PipelineOpts): void {
	if (opts?.signal?.aborted) {
		throw opts.signal.reason ?? new DOMException("Pipeline aborted", "AbortError")
	}
}

/**
 * Records a stage failure so callers can tell degraded output from a clean result.
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
 * Runs the classifier.
 * On failure it records a fault and returns an empty tree.
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
		// The spreads omit unset options so the classifier keeps its own defaults.
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
 * The street-morphology options the pipeline passes to the classifier.
 * Both weights are zero.
 */
export const ZEROED_MORPHOLOGY_OPTS = { biasScale: 0, dependentLocalityPenalty: 0 } as const

/**
 * The scale for positive street-context emissions.
 * Zero disables the positive boost.
 */
export const STREET_CONTEXT_POSITIVE_SCALE = 0

/**
 * Returns the street-context classifier options, or an empty object unless both the FST
 * and the street-morphology matcher are available.
 */
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
 * Runs the phrase grouper.
 * On failure it records a fault and returns no proposals.
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

/**
 * The factor applied to a grouper proposal's confidence when it becomes a provisional node.
 */
const GROUPER_TYPING_PENALTY = 0.55

/**
 * Maps phrase-grouper kinds to component tags.
 * The audit ignores kinds absent from the map.
 */
const PHRASE_KIND_TO_TAG: ReadonlyMap<string, ComponentTag> = new Map([
	["VENUE_PHRASE", "venue"],
	["LOCALITY_PHRASE", "locality"],
	["REGION_ABBREVIATION", "region"],
	["POSTCODE", "postcode"],
	["STREET_PHRASE", "street"],
	["NUMERIC", "house_number"],
])

/**
 * Adds a provisional root node for each phrase proposal that no existing node overlaps.
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
 * Runs the resolver.
 *
 * On failure it records a fault and returns the unresolved tree.
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
