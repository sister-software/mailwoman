// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Runs the parse pipeline: normalization, query shape, locale and kind detection,
 *   classification and resolution.
 */

import type { ComponentTag } from "@mailwoman/codex/component"

import { isBareTreeOf } from "#decoder/tree/shape"
import type { AddressNode, AddressTree } from "#decoder/types"
import type { PipelineResult } from "#pipeline/result"
import { createRequestContext, type PipelineStage, runStage, StageID } from "#pipeline/stage"
import {
	DEFAULT_CASE_NORMALIZATION,
	DEFAULT_PLACER_COUNTRY_USE,
	WORD_CONSISTENCY_SHIP_DEFAULT,
	deriveInputMode,
	isPostcodeFormat,
} from "#pipeline/types"
import type {
	AddressClassifier,
	NormalizedInputLite,
	CaseNormalization,
	AnchorRegionLookupLike,
	FSTMatcherLike,
	InputMode,
	LocaleHint,
	PhraseProposal,
	PipelineOpts,
	PlacerCountryUse,
	PlacetypePairSelection,
	QueryIntentMarker,
	QueryKindResult,
	QueryShapeLite,
	RuntimePipelineStages,
	VenueHeadStage,
} from "#pipeline/types"
import type { ResolveOpts } from "#resolver/types"

/**
 * A query kind needs at least this confidence to take the fast path.
 */
const SHORT_CIRCUIT_MIN_CONFIDENCE = 0.95

/**
 * A locality-only input longer than this number of characters takes the full pipeline.
 */
const SHORT_CIRCUIT_MAX_LOCALITY_LENGTH = 30

/**
 * The default resolver weight for the coarse-placer country prior.
 */
export const COARSE_PLACER_ANCHOR_WEIGHT = 1

/**
 * The placer needs at least this confidence to turn its country prior into a hard filter.
 */
const HARD_PLACE_COUNTRY_MIN_CONF = 0.9

// country-branch: the fallback for an artifact without a coverage manifest.
// The coverage manifest is the planetary source and takes precedence whenever it is present.
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
 * Returns the placed country as a hard filter, or `null` when the use is `"prior"`, confidence
 * is too low, the country is outside the safelist, or the caller already set a country.
 *
 * A `null` safelist means {@link HARD_PLACE_COUNTRY_SAFELIST}.
 */
export function hardCountryFor(
	placed: { country: string; confidence: number },
	existing: Pick<ResolveOpts, "hardCountry" | "defaultCountry">,
	setting: { use: PlacerCountryUse; safelist: ReadonlySet<string> | null }
): string | null {
	if (setting.use !== "filter") return null

	if (placed.confidence < HARD_PLACE_COUNTRY_MIN_CONF) return null

	if (!(setting.safelist ?? HARD_PLACE_COUNTRY_SAFELIST).has(placed.country)) return null

	if (existing.hardCountry || existing.defaultCountry) return null

	return placed.country
}

function isPostcodeFormatHit(hit: { format: string }): boolean {
	return isPostcodeFormat(hit.format)
}

/**
 * Returns the input unchanged.
 * The pipeline uses it when no normalizer is configured.
 */
function identityNormalize(raw: string, opts?: { locale?: string }): NormalizedInputLite {
	return { raw, normalized: raw, appliedLocale: opts?.locale ?? null }
}

/**
 * Returns the normalized input with each line break, and the spaces around it,
 * written as `, ` when `mode` is `"comma"`.
 *
 * The parse tree's offsets point into the normalized text.
 * The normalizer already reshapes that text, and a caller reads offsets against
 * the tree, so the rewrite moves none of them.
 */
export function rewriteLineBreaks(input: NormalizedInputLite, mode: "keep" | "comma"): NormalizedInputLite {
	if (mode === "keep" || !/[\r\n]/.test(input.normalized)) return input

	return { ...input, normalized: input.normalized.replaceAll(/[ \t]*(?:\r\n|[\r\n])[ \t]*/g, ", ") }
}

/**
 * Returns an empty query shape.
 *
 * The pipeline uses it when no query-shape stage is configured.
 */
function emptyQueryShape(): QueryShapeLite {
	return {
		knownFormats: [],
		segments: null,
		characterClass: null,
		scripts: null,
		tokenClasses: null,
		totalLength: null,
	}
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
		script: [],
		evidence: null,
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
		intentMarkers: null,
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
 * Each stage runs through {@linkcode runStage}, which times it and checks the abort signal before it.
 * A failing classifier, grouper or resolver records a fault and the run continues.
 */
export async function runPipeline(
	raw: string,
	stages: RuntimePipelineStages,
	opts?: PipelineOpts
): Promise<PipelineResult> {
	const context = createRequestContext({ signal: opts?.signal })
	const { timing, faults } = context

	const normalize = stages.normalize ?? identityNormalize
	const computeQueryShape = stages.computeQueryShape ?? emptyQueryShape
	const detectLocale = stages.detectLocale ?? defaultDetectLocale
	const classifyKind = stages.classifyKind ?? defaultClassifyKind

	const normalized = await runStage(
		{
			id: StageID.Normalize,
			run: (text: string) => rewriteLineBreaks(normalize(text, { locale: opts?.locale }), opts?.lineBreaks ?? "keep"),
		},
		raw,
		context
	)

	// The coarse placer adds a country prior unless the caller already supplied one.
	let effectiveOpts = opts
	let placerAnchorApplied = false

	if (stages.placeCountry) {
		const placeCountry = stages.placeCountry

		const placed = await runStage(
			{ id: StageID.PlaceCountry, run: (text: string) => placeCountry(text) },
			normalized.normalized,
			context
		)

		if (placed.country && placed.country !== "OTHER" && !opts?.resolveOpts?.anchorPosterior) {
			const hardCountry = hardCountryFor(
				{ country: placed.country, confidence: placed.confidence },
				opts?.resolveOpts ?? {},
				{
					use: opts?.placerCountryUse ?? DEFAULT_PLACER_COUNTRY_USE,
					safelist: opts?.hardCountrySafelist ?? stages.resolver?.artifactCoverage?.hardCountrySafelist ?? null,
				}
			)

			placerAnchorApplied = true

			effectiveOpts = {
				...opts,
				resolveOpts: {
					...opts?.resolveOpts,
					// The resolver uses the placer's full posterior when available.
					// Otherwise it uses a one-hot argmax.
					anchorPosterior: placed.posterior ?? { [placed.country]: placed.confidence },
					anchorWeight: opts?.resolveOpts?.anchorWeight ?? COARSE_PLACER_ANCHOR_WEIGHT,
					...(hardCountry ? { hardCountry } : {}),
				},
			}
		}
	}

	const queryShape = await runStage(
		{ id: StageID.QueryShape, run: (input: NormalizedInputLite) => computeQueryShape(input) },
		normalized,
		context
	)

	const locale = await runStage(
		{
			id: StageID.LocaleHint,
			run: (input: NormalizedInputLite) => detectLocale(input, queryShape, { hint: opts?.locale }),
		},
		normalized,
		context
	)

	const kind = await runStage(
		{ id: StageID.KindClassifier, run: (input: NormalizedInputLite) => classifyKind(input, queryShape, locale) },
		normalized,
		context
	)

	const intentMarkers: QueryIntentMarker[] = [...(kind.intentMarkers ?? [])]

	// A POI-shaped query goes to the intent stage first.
	// A null result falls through to parsing.
	if ((kind.kind === "poi_query" || kind.kind === "poi_category") && stages.poiIntent) {
		const poiIntent = stages.poiIntent

		const poiOutcome = await runStage(
			{ id: StageID.POIIntent, run: (input: NormalizedInputLite) => poiIntent(input, locale, effectiveOpts) },
			normalized,
			context
		)

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
			tree = await runStage(resolveStage(stages.resolver, effectiveOpts), tree, context)
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
			poiIntent: null,
			faults,
			intentMarkers,
			path: "fast-path",
		}
	}

	let phraseProposals: PhraseProposal[] = []

	if (stages.groupPhrases) {
		const groupPhrases = stages.groupPhrases

		phraseProposals = await runStage(
			{
				id: StageID.PhraseGrouper,
				run: (input: NormalizedInputLite) => groupPhrases(input, queryShape, locale),
				recover: (): PhraseProposal[] => [],
			},
			normalized,
			context
		)
	}

	let tree: AddressTree = { raw: normalized.normalized, roots: [] }

	if (stages.classifier) {
		tree = await runStage(
			classifyStage(stages.classifier, queryShape, {
				fst: stages.fst ?? null,
				caseNormalization: opts?.caseNormalization ?? DEFAULT_CASE_NORMALIZATION,
				placetypePair: opts?.placetypePair ?? "inherit",
				streetMorphology: stages.streetMorphology ?? null,
				streetMorphologyPrior: stages.streetMorphologyPrior ?? false,
				anchorRegions: stages.anchorRegions ?? null,
				venueHead: stages.venueHead?.(locale) ?? null,
				inputMode: deriveInputMode(opts?.inputMode ?? "auto", kind.kind),
				localeHint: opts?.localeHint ?? null,
			}),
			normalized.normalized,
			context
		)
	}

	if (phraseProposals.length && tree.roots.length >= 0) {
		tree = await runStage(
			{
				id: StageID.GrouperAudit,
				run: (decoded: AddressTree) => grouperAudit(decoded, phraseProposals, normalized.normalized),
			},
			tree,
			context
		)
	}

	if (stages.resolver) {
		// A bare locality or postcode query resolves without the placer's prior.
		if (placerAnchorApplied && (isBareLocalityTree(tree) || isBarePostcodeTree(tree))) {
			effectiveOpts = opts
		}

		tree = await runStage(resolveStage(stages.resolver, effectiveOpts), tree, context)
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
		poiIntent: null,
		faults,
		intentMarkers,
		path: "full",
	}
}

/**
 * The stage that runs the classifier over the normalized text.
 *
 * When the classifier throws, the run continues with an empty tree.
 */
function classifyStage(
	classifier: AddressClassifier,
	queryShape: QueryShapeLite,
	knobs: {
		fst: FSTMatcherLike | null
		caseNormalization: CaseNormalization
		placetypePair: PlacetypePairSelection
		streetMorphology: FSTMatcherLike | null
		streetMorphologyPrior: boolean
		anchorRegions: AnchorRegionLookupLike | null
		venueHead: VenueHeadStage | null
		inputMode: InputMode
		localeHint: string | null
	}
): PipelineStage<string, AddressTree> {
	const {
		fst,
		caseNormalization,
		placetypePair,
		streetMorphology,
		streetMorphologyPrior,
		anchorRegions,
		venueHead,
		inputMode,
		localeHint,
	} = knobs

	return {
		id: StageID.TokenClassify,
		run: (text) =>
			classifier.parse(text, {
				queryShape,
				inputMode,
				...(localeHint ? { localeHint } : {}),
				fst,
				postcodeRepair: true,
				caseNormalization,
				enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
				placetypePair,
				...streetContextRequirementFor({ fst, streetMorphology }, { streetMorphologyPrior }),
				...(fst && anchorRegions ? { anchorRegions } : {}),
				...(venueHead ? { venueHead: venueHead.venueHead } : {}),
				...(venueHead?.venueHeadOpts ? { venueHeadOpts: venueHead.venueHeadOpts } : {}),
			}),
		recover: (text) => ({ raw: text, roots: [] }),
	}
}

/**
 * The street-morphology options the pipeline passes to the classifier.
 * Both weights are zero.
 */
export const ZEROED_MORPHOLOGY_OPTS = { biasScale: 0, dependentLocalityPenalty: 0 } as const

/**
 * The street-morphology options that bias a street affix at the prior's own weights,
 * on a segment that opens with a house number only.
 */
export const NUMBERED_MORPHOLOGY_OPTS = {
	biasScale: 1,
	dependentLocalityPenalty: 2,
	numberedSegmentOnly: true,
} as const

/**
 * The scale for positive street-context emissions.
 * Zero disables the positive boost.
 */
export const STREET_CONTEXT_POSITIVE_SCALE = 0

/**
 * Returns the street-context classifier options, or an empty object unless both the FST
 * and the street-morphology matcher are available.
 *
 * With `streetMorphologyPrior` the matcher also biases a street affix on a numbered segment.
 * Without it the matcher serves the street-context check at zero emission weight.
 */
export function streetContextRequirementFor(
	stages: {
		fst?: FSTMatcherLike | null
		streetMorphology?: FSTMatcherLike | null
	},
	options: { streetMorphologyPrior?: boolean } = {}
): {
	fstStreetMorphology?: FSTMatcherLike
	fstStreetMorphologyOpts?: { biasScale: number; dependentLocalityPenalty: number; numberedSegmentOnly?: boolean }
	fstStreetContextPositiveScale?: number
} {
	return stages.fst && stages.streetMorphology
		? {
				fstStreetMorphology: stages.streetMorphology,
				fstStreetMorphologyOpts: options.streetMorphologyPrior
					? { ...NUMBERED_MORPHOLOGY_OPTS }
					: { ...ZEROED_MORPHOLOGY_OPTS },
				fstStreetContextPositiveScale: STREET_CONTEXT_POSITIVE_SCALE,
			}
		: {}
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
 * The stage that resolves the decoded tree.
 *
 * When the resolver throws, the run continues with the unresolved tree.
 */
function resolveStage(
	resolver: NonNullable<RuntimePipelineStages["resolver"]>,
	opts?: PipelineOpts
): PipelineStage<AddressTree, AddressTree> {
	return {
		id: StageID.Resolve,
		run: (tree) => resolver.resolveTree(tree, opts?.resolveOpts),
		recover: (tree) => tree,
	}
}
