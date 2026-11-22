// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Shared street-level geocode core used by CLI and service.
 *
 * Cascade:
 * 1. Parse with neural classifier.
 * 2. Select region databases.
 * 3. Resolve with available coordinate tiers.
 * 4. Extract best coordinate and tier.
 *
 * Database access is injected via {@link RegionDatabaseResolver}.
 */

import { placetypeMapForCountry } from "@mailwoman/codex/placetype-map"
import type { AddressTree } from "@mailwoman/core/decoder"
import { decodeAsJSON } from "@mailwoman/core/decoder"
import type { GeocodeResult } from "@mailwoman/core/geocode"
import {
	COARSE_PLACER_ANCHOR_WEIGHT,
	type CaseNormalization,
	type ClassifierOpts,
	DEFAULT_CASE_NORMALIZATION,
	DEFAULT_PLACER_COUNTRY_USE,
	deriveInputMode,
	type InputMode,
	type InputModeSelection,
	hardCountryFor,
	isBareLocalityTree,
	isBarePostcodeTree,
	type PlacerCountryUse,
	type QueryKindResult,
	type StageSource,
	WORD_CONSISTENCY_SHIP_DEFAULT,
} from "@mailwoman/core/pipeline"
import type {
	AuthoritativeProvider,
	DefaultCountry,
	AddressPointLookup,
	ParentPlaceScope,
	PostcodePrefixIndexLike,
	RegionDatabases,
	ResolveOpts,
	Resolver,
	WeakResolutionReading,
} from "@mailwoman/core/resolver"
import { hardCountryOf, ScopeStrength } from "@mailwoman/core/resolver"
import { classifyKindSync } from "@mailwoman/kind-classifier"
import { countriesFromPostcodeFormat, countryFromPostcodeFormat } from "@mailwoman/postcode/postcode-format"
import { computeQueryShape, type QueryShape } from "@mailwoman/postcode/recognizer/query-shape"
import { QueryShapeGeneration, queryShapeGenerationOf } from "@mailwoman/postcode/recognizer/rule-generation"

import { authoritativeQueryFrom, consultAuthoritativeProvider } from "#authoritative"
import { loadDefaultPlaceCountry, type PlaceCountryFn } from "#default/placer"
import { applyEntityTiers, nameDroppingRescoreToWithdraw, repickLocalityByVenue } from "#fork-entity"
import { classifierForInput, type GeocodeClassifier, normalizeGeocodeInput } from "#geocode/classifier"
import { traceCollector } from "#geocode/derivation"
import { parsePriorOptions } from "#geocode/parse-priors"
import { type RegionDatabaseResolver, regionSlugFromTree } from "#geocode/regions"
import { extractGeocodeResult } from "#geocode/result"
import { type GeocodeSwitches, geocodeSwitches } from "#geocode/switches"
import {
	postcodeCountryScopeOf,
	recognizeBarePostcode,
	resolvedCountryOf,
	treePostcodeValue,
} from "#geocode/tree-reads"
import { shouldDropInferredScope, softScopeFromLocaleHead } from "#inferred-scope"
import { thingQueryRefusalMarkers } from "#intent-refusal"
import { interpCalibrationForRegion, type InterpCalibrationTable } from "#interp-calibration"
// Observation-layer routes are imported from one barrel.
import { layerDesignationMarkers, type LayerDesignationRoutes } from "#observations"
import { applyPlusCodeOverride } from "#plus-code-override"
import type { POIExecutorLookup } from "#poi/executor"
import { repairPostcodeContradiction } from "#postcode-repair"
import { coarserAnswerMarker, declaredAmbiguityMarker } from "#query-intent"
import { recognizeUSRegions } from "#region-recognition"
import { repairStrandedAffix } from "#stranded-affix-repair"
import { applyStreetMissFallback } from "#street/miss-fallback"

// Spatial layers are passed as one route bundle.
export interface GeocodeDeps extends LayerDesignationRoutes, Partial<GeocodeSwitches> {
	/**
	 * Poi.db reader for the fork→entity probe.
	 */
	poiLookup?: POIExecutorLookup
	/**
	 * Street-morphology token test used by the fork→entity probe.
	 */
	isStreetGeneric?: (token: string) => boolean
	/**
	 * Returns whether a POI row's category agrees with the venue name that found it.
	 */
	rowFitsVenueHead?: (name: string, categoryID: string | null) => boolean
	/**
	 * Returns whether a word is a POI category, read by span rescore for a venue's last word.
	 */
	isVenueCategoryWord?: (word: string) => boolean
	/**
	 * The landmark layer.
	 * It answers an input that's a place's name.
	 */
	landmarks?: import("@mailwoman/core/resolver").LandmarkLookup
	/**
	 * The OpenStreetMap place layer, read after span rescore.
	 */
	osmPlaces?: import("@mailwoman/core/resolver").LandmarkLookup
	/**
	 * The former divisions table, read under {@link GeocodeSwitches.formerDivisions}.
	 */
	formerDivisionLookup?: import("@mailwoman/core/resolver").FormerDivisionLookup
	/**
	 * Gazetteer FST prior.
	 */
	fst?: import("@mailwoman/core/pipeline").FSTMatcherLike
	/**
	 * The gazetteer FST shipped for each country, read under {@link GeocodeSwitches.fstCountryRouting}.
	 */
	fstForCountry?: import("@mailwoman/core/pipeline").CountryFSTLookup
	/**
	 * The country the caller states for the parse, such as the session's default
	 * or locale country, read under {@link GeocodeSwitches.pairIndexOwnCountry}.
	 */
	parseCountry?: string
	/**
	 * Street-morphology matcher for street-context checks.
	 */
	streetMorphology?: import("@mailwoman/core/pipeline").FSTMatcherLike
	/**
	 * Whether the street-morphology matcher also biases a street affix on a numbered segment.
	 *
	 * Absent, the matcher serves the street-context check at zero weight.
	 */
	streetMorphologyPrior?: boolean
	/**
	 * The admin ancestry of an anchored postcode, for the anchor-region prior.
	 * Absent, the prior doesn't run.
	 */
	anchorRegions?: import("@mailwoman/core/pipeline").AnchorRegionLookupLike
	/**
	 * Venue-head lookups for the session's locale.
	 * Absent, the venue-head prior doesn't run.
	 */
	venueHead?: import("@mailwoman/core/pipeline").VenueHeadLexiconLike
	/**
	 * Overrides for the venue-head prior's bias scale, cap and extension.
	 */
	venueHeadOpts?: import("@mailwoman/core/pipeline").VenueHeadPriorOpts
	/**
	 * Per-channel feed pins for a diagnostic parse.
	 *
	 * A channel pinned `off` is fed zeros.
	 * An absent pin set feeds every channel as built.
	 */
	channelPins?: import("@mailwoman/core/pipeline").ChannelPins
	/**
	 * Optional lexicon-aware kind classifier used for early refusal.
	 */
	classifyKind?: (
		input: { raw: string; normalized: string },
		shape: ReturnType<typeof computeQueryShape>
	) => Promise<QueryKindResult>
	classifier: GeocodeClassifier
	resolver: Resolver
	/**
	 * The input register.
	 * The default `"auto"` derives it from the query kind.
	 */
	inputMode?: InputModeSelection
	/**
	 * Per-state database resolver.
	 */
	databases?: RegionDatabaseResolver
	/**
	 * Country-keyed national rooftop databases (preferred over OSM).
	 */
	nationalDatabases?: (country: string) => RegionDatabases
	/**
	 * Country-keyed OSM rooftop databases used when no national database exists.
	 */
	osmDatabases?: (country: string) => RegionDatabases
	/**
	 * Optional authoritative provider consulted after open resolution.
	 */
	authoritativeProvider?: AuthoritativeProvider
	/**
	 * Country scope passed to the resolver, who chose it, and whether it filters or ranks.
	 * When it is unset, the resolver has no default country.
	 */
	defaultCountry?: DefaultCountry
	/**
	 * The bonus a soft country scope gives a candidate in its country, in log10-population units.
	 */
	softCountryWeight?: number
	/**
	 * A caller-supplied parent place that scopes every lookup.
	 */
	parentPlace?: ParentPlaceScope
	/**
	 * Capital status callback for bounded capital promotion.
	 */
	capitalLevel?: (place: { name: string; country: string | null; lat: number; lon: number }) => number
	/**
	 * Locale hint country for fuzzy matching only.
	 */
	fuzzyCountryScope?: string
	/**
	 * How the classifier treats letter case.
	 *
	 * @defaultValue {@linkcode DEFAULT_CASE_NORMALIZATION}
	 */
	caseNormalization?: CaseNormalization
	/**
	 * Pre-parsed tree to skip internal parsing.
	 */
	parsedTree?: AddressTree
	/**
	 * Interpolation radius calibration override or per-region table.
	 */
	interpCalibration?: number | InterpCalibrationTable
	/**
	 * Coarse country router for soft country priors.
	 * The default `"auto"` loads the bundled placer.
	 */
	placeCountry?: StageSource<PlaceCountryFn>
	/**
	 * Proximity bias points forwarded to resolver bias.
	 */
	bias?: Array<{ lat: number; lon: number; weight?: number }>
	/**
	 * How a confident placer or postcode-format country constrains resolution.
	 *
	 * @defaultValue {@linkcode DEFAULT_PLACER_COUNTRY_USE}
	 */
	placerCountryUse?: PlacerCountryUse
	/**
	 * Optional override for the hard-country coverage safelist.
	 */
	hardCountrySafelist?: ReadonlySet<string>
	/**
	 * Optional resolver trace sink.
	 */
	resolveTraceSink?: import("@mailwoman/core/resolver").ResolveOpts["traceSink"]
	/**
	 * Weak-resolution reading.
	 */
	spanRescoreWeakResolution?: WeakResolutionReading
	/**
	 * PFX1 postcode-prefix index used by postcodePrefixPrior.
	 */
	postcodePrefixIndex?: PostcodePrefixIndexLike
}

/**
 * Kind-derived register for geocode input.
 */
export function deriveGeocodeRegister(
	parseInput: string,
	queryShape?: QueryShape,
	generation: QueryShapeGeneration = QueryShapeGeneration.Legacy
): InputMode {
	const shape = queryShape ?? computeQueryShape(parseInput, generation)

	return deriveInputMode("auto", classifyKindSync({ raw: parseInput, normalized: parseInput }, shape).kind)
}

/**
 * Inputs derived before parse: normalized text, query shape, register and parse opts.
 */
export interface GeocodeParseInputs {
	/**
	 * Exact text sent to the classifier.
	 */
	parseInput: string
	queryShape: QueryShape
	inputMode: InputMode
	/**
	 * The kind verdict behind `inputMode`, or `null` when the caller chose the register.
	 */
	kind: QueryKindResult | null
	opts: NonNullable<Parameters<GeocodeClassifier["parse"]>[1]>
}

/**
 * The geocode switches that change only the parse's decode, each off by default.
 */
export const DECODER_SETTING_KEYS = [
	"pairPriorWordPieces",
	"pairPriorChildPostcodeStrip",
	"pairIndexOwnCountry",
	"fstCountryRouting",
] as const satisfies readonly (keyof GeocodeSwitches)[]

/**
 * A choice of {@link DECODER_SETTING_KEYS} values, where an unset key keeps its default.
 */
export type DecoderSettings = Partial<Pick<GeocodeSwitches, (typeof DECODER_SETTING_KEYS)[number]>>

/**
 * The decoder settings a geocode's parse reads, and the inputs they read.
 */
export type GeocodeDecoderSettingDeps = Pick<
	GeocodeDeps,
	| "pairPriorWordPieces"
	| "pairPriorChildPostcodeStrip"
	| "pairIndexOwnCountry"
	| "fstCountryRouting"
	| "fstForCountry"
	| "parseCountry"
>

/**
 * The classifier options for the decoder settings that are on.
 *
 * An unset setting adds no option, so the classifier runs as it does without the setting.
 */
export function decoderSettingOptions(
	deps: GeocodeDecoderSettingDeps & Pick<GeocodeDeps, "fst">
): Pick<
	ClassifierOpts,
	"pairPriorWordPieces" | "pairPriorChildPostcodeStrip" | "pairIndexOwnCountry" | "fstForCountry"
> {
	const switches = geocodeSwitches(deps)

	return {
		...(switches.pairPriorWordPieces ? { pairPriorWordPieces: true } : {}),
		...(switches.pairPriorChildPostcodeStrip ? { pairPriorChildPostcodeStrip: true } : {}),
		...(switches.pairIndexOwnCountry
			? { pairIndexOwnCountry: { declaredCountry: deps.parseCountry?.toUpperCase() || null } }
			: {}),
		...(switches.fstCountryRouting && deps.fst && deps.fstForCountry ? { fstForCountry: deps.fstForCountry } : {}),
	}
}

export function geocodeParseInputs(
	input: string,
	deps: Pick<
		GeocodeDeps,
		| "normalizeInput"
		| "caseNormalization"
		| "inputMode"
		| "fst"
		| "streetMorphology"
		| "streetMorphologyPrior"
		| "anchorRegions"
		| "venueHead"
		| "venueHeadOpts"
		| "channelPins"
	> &
		GeocodeDecoderSettingDeps &
		Partial<Pick<GeocodeDeps, "classifier">>
): GeocodeParseInputs {
	// Stage-1 input normalization before parse.
	const parseInput = geocodeSwitches(deps).normalizeInput
		? normalizeGeocodeInput(input, deps.classifier).normalized
		: input

	// Query shape used as a parse prior, in the generation the model card declares.
	const queryShape = computeQueryShape(parseInput, queryShapeGenerationOf(deps.classifier))

	// An explicit register wins.
	// Otherwise the mode derives from the kind.
	const inputModeSelection = deps.inputMode ?? "auto"
	let kind: QueryKindResult | null = null
	let inputMode: InputMode

	if (inputModeSelection === "auto") {
		kind = classifyKindSync({ raw: parseInput, normalized: parseInput }, queryShape)
		inputMode = deriveInputMode(inputModeSelection, kind.kind)
	} else {
		inputMode = inputModeSelection
	}

	return {
		parseInput,
		queryShape,
		inputMode,
		kind,
		opts: {
			postcodeRepair: true,
			caseNormalization: deps.caseNormalization ?? DEFAULT_CASE_NORMALIZATION,
			queryShape,
			inputMode,
			// The classifier zeros each pinned channel at feed time.
			...(deps.channelPins ? { channels: deps.channelPins } : {}),
			// Default word-consistency enforcement.
			enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
			// The loaded priors, through the options builder every production parse path uses.
			...parsePriorOptions(
				{
					fst: deps.fst ?? null,
					streetMorphology: deps.streetMorphology ?? null,
					anchorRegions: deps.anchorRegions ?? null,
				},
				{
					streetMorphologyPrior: deps.streetMorphologyPrior ?? false,
					venueHead: deps.venueHead ?? null,
					...(deps.venueHeadOpts ? { venueHeadOpts: deps.venueHeadOpts } : {}),
				}
			),
			...decoderSettingOptions(deps),
		},
	}
}

/**
 * The parse path `geocodeAddress` runs.
 * It is exported so a caller can reuse the parse.
 */
export async function parseForGeocode(
	input: string,
	deps: Pick<
		GeocodeDeps,
		| "classifier"
		| "normalizeInput"
		| "caseNormalization"
		| "inputMode"
		| "fst"
		| "streetMorphology"
		| "streetMorphologyPrior"
		| "anchorRegions"
		| "venueHead"
		| "venueHeadOpts"
	> &
		GeocodeDecoderSettingDeps
): Promise<AddressTree> {
	const classifier = await classifierForInput(deps.classifier, input)
	const { parseInput, opts, queryShape } = geocodeParseInputs(input, { ...deps, classifier })

	// Retag bare unambiguous postcodes before resolve.
	const tree = recognizeBarePostcode(recognizeUSRegions(await classifier.parse(parseInput, opts)))

	// Repair split postcode contradictions from query shape.
	repairPostcodeContradiction(tree, queryShape)

	// Repair stranded street affixes.
	repairStrandedAffix(tree)

	return tree
}

/**
 * Run full geocode cascade for one address.
 *
 * Returns a result.
 * It throws only on a fatal parse or resolve error.
 */
export async function geocodeAddress(input: string, deps: GeocodeDeps): Promise<GeocodeResult> {
	// Optional first-refusal check for thing queries.
	if (deps.classifyKind && (deps.inputMode ?? "auto") === "auto") {
		const parseInput = geocodeSwitches(deps).normalizeInput
			? normalizeGeocodeInput(input, await classifierForInput(deps.classifier, input)).normalized
			: input

		const refusal = await thingQueryRefusalMarkers(
			deps.classifyKind,
			parseInput,
			queryShapeGenerationOf(deps.classifier)
		)

		if (refusal) {
			// Return abstain with parsed components but no resolved coordinates.
			const tree = deps.parsedTree ?? (await parseForGeocode(input, deps))
			const abstained = extractGeocodeResult(input, tree)

			abstained.intent_markers = refusal

			return abstained
		}
	}

	// Single-pass geocoding.
	return geocodeAddressOnce(input, deps)
}

/**
 * Resolves the coarse country router from its source, loading the bundled placer for `"auto"`.
 */
async function resolvePlaceCountry(source: StageSource<PlaceCountryFn>): Promise<PlaceCountryFn | null> {
	if (source === "none") return null

	return source === "auto" ? loadDefaultPlaceCountry() : source
}

/**
 * Apply country-related evidence to resolver options.
 */
function applyCountryEvidence(opts: ResolveOpts, tree: AddressTree, deps: GeocodeDeps): void {
	// Countries implied by postcode format.
	const formatCountries = countriesFromPostcodeFormat(treePostcodeValue(tree))

	// An inferred scope is dropped when contradictory evidence is stronger.
	// Under scope retrieval the locale head's contradicting country stands in as a soft scope.
	if (deps.defaultCountry) {
		const legacySoft =
			deps.defaultCountry.strength === ScopeStrength.Soft && !geocodeSwitches(deps).scopeCountryRetrieval

		if (legacySoft || !shouldDropInferredScope(tree, deps.defaultCountry, formatCountries)) {
			opts.defaultCountry = deps.defaultCountry
		} else if (geocodeSwitches(deps).scopeCountryRetrieval) {
			const headScope = softScopeFromLocaleHead(tree, deps.defaultCountry)

			if (headScope) {
				opts.defaultCountry = headScope
			}
		}
	}

	if (deps.softCountryWeight != null) {
		opts.softCountryWeight = deps.softCountryWeight
	}

	if (deps.parentPlace) {
		opts.parentPlace = deps.parentPlace
	}

	// Pass format-implied countries to postcode probe.
	if (formatCountries.length) {
		opts.postcodeFormatCountries = formatCountries
	}

	// Locale hint for fuzzy matching scope.
	if (deps.fuzzyCountryScope) {
		opts.fuzzyCountryScope = deps.fuzzyCountryScope
	}

	// Capital-level callback for bounded promotion.
	if (deps.capitalLevel) {
		opts.capitalLevel = deps.capitalLevel
	}
}

/**
 * The geocode switches the resolver reads under the same name, each forwarded as an explicit value.
 */
const FORWARDED_RESOLVER_SWITCHES = [
	"postcodeCountryCoherence",
	"postcodeShapeCoherence",
	"postcodeContainmentCoherence",
	"adminContainmentRerank",
	"dependentLocalityContainment",
	"countyDesignatorFallback",
	"formerDivisions",
	"scopeCountryRetrieval",
	"siblingLocalityContainment",
	"postcodePrefixPrior",
] as const satisfies readonly (keyof GeocodeSwitches & keyof ResolveOpts)[]

/**
 * The hard-country setting for a geocode: the caller's use and safelist, then the artifact's safelist.
 */
function placerCountrySetting(deps: GeocodeDeps): { use: PlacerCountryUse; safelist: ReadonlySet<string> | null } {
	return {
		use: deps.placerCountryUse ?? DEFAULT_PLACER_COUNTRY_USE,
		safelist: deps.hardCountrySafelist ?? deps.resolver.artifactCoverage?.hardCountrySafelist ?? null,
	}
}

/**
 * Extracts the result after the parsed venue picks between towns that share a name,
 * and without a name-dropping span-rescore locality.
 *
 * {@linkcode repickLocalityByVenue} moves the locality to the namesake the venue stands in.
 * The name-dropping locality is removed when no venue answers near it, so the input abstains.
 * See {@linkcode nameDroppingRescoreToWithdraw}.
 *
 * It leaves `resolved.roots` in place, so later tiers read the tree as these steps left it.
 */
function extractWithoutNameDroppingRescore(
	input: string,
	resolved: AddressTree,
	deps: Parameters<typeof nameDroppingRescoreToWithdraw>[2]
): GeocodeResult {
	repickLocalityByVenue(resolved.roots, deps)

	const result = extractGeocodeResult(input, resolved)
	const withdrawn = nameDroppingRescoreToWithdraw(result, resolved.roots, deps)

	if (!withdrawn) return result

	resolved.roots.splice(resolved.roots.indexOf(withdrawn), 1)

	return extractGeocodeResult(input, resolved)
}

async function geocodeAddressOnce(input: string, deps: GeocodeDeps): Promise<GeocodeResult> {
	// Normalize input for parse/placer while keeping raw input for output.
	const switches = geocodeSwitches(deps)

	const parseInput = switches.normalizeInput
		? normalizeGeocodeInput(input, await classifierForInput(deps.classifier, input)).normalized
		: input

	const tree = deps.parsedTree ?? (await parseForGeocode(input, deps))
	const queryShape = computeQueryShape(parseInput, queryShapeGenerationOf(deps.classifier))
	const stateSlug = regionSlugFromTree(tree)
	const usDatabases = deps.databases?.(stateSlug) ?? {}
	let addressPoints = usDatabases.addressPoints
	const interpolation = usDatabases.interpolation

	// Wrap trace sink so records can also be attached to the final result.
	const trace = traceCollector(deps.resolveTraceSink)
	const traceSink = trace.traceSink

	const opts: ResolveOpts = {
		adminCoherence: switches.adminCoherence,
		includeAncestors: switches.includeAncestors,
		...(traceSink ? { traceSink } : {}),
		...(switches.diagnoseUnreachable ? { diagnoseUnreachable: true } : {}),
	}

	applyCountryEvidence(opts, tree, deps)

	if (deps.bias && deps.bias.length) {
		opts.bias = deps.bias
	}

	// Coarse country router: default loader, custom function, or disabled.
	const placeCountry = await resolvePlaceCountry(deps.placeCountry ?? "auto")

	// Placer country reused for later country-dependent steps.
	let placedCountry: string | null = null

	// Compute placer prediction once and reuse it.
	const placerResult = placeCountry ? placeCountry(parseInput) : null

	const streetPlacerCountry =
		placerResult?.country && placerResult.country !== "OTHER" ? placerResult.country.toLowerCase() : null

	// Prefer postcode-format country prior when eligible.
	if (
		switches.postcodeCountryPrior &&
		!hardCountryOf(opts.defaultCountry) &&
		!opts.anchorPosterior &&
		!isBareLocalityTree(tree)
	) {
		const pcCountry = countryFromPostcodeFormat(decodeAsJSON(tree).postcode as string | null)

		if (pcCountry) {
			placedCountry = pcCountry
			opts.anchorPosterior = { [pcCountry]: 1 }
			opts.anchorWeight = COARSE_PLACER_ANCHOR_WEIGHT

			// Hard-country safelist precedence: override -> artifact -> fallback.
			const hardCountry = hardCountryFor({ country: pcCountry, confidence: 1 }, opts, placerCountrySetting(deps))

			if (hardCountry) {
				opts.hardCountry = hardCountry
			}
		}
	}

	// Skip placer anchoring on bare locality/postcode trees.
	if (placeCountry && placerResult && !isBareLocalityTree(tree) && !isBarePostcodeTree(tree)) {
		const placed = placerResult
		placedCountry = placed.country && placed.country !== "OTHER" ? placed.country : null

		if (placed.country && placed.country !== "OTHER" && !opts.anchorPosterior) {
			// Probe dominant locality bearer once for disagreement checks.
			const localityValue = decodeAsJSON(tree).locality as string | undefined

			const dominant =
				localityValue && deps.resolver.findPlace
					? (await deps.resolver.findPlace({ text: localityValue, placetype: "locality", limit: 1 }).catch(() => []))[0]
					: null

			const dominantBearer = dominant?.country && dominant.exactMatch !== false ? dominant.country : null

			const dominantDisagreesWithPlacer =
				dominantBearer !== null && dominantBearer.toUpperCase() !== placed.country.toUpperCase()

			// Apply anchor only when placer doesn't contradict dominant locality bearer.
			if (!dominantDisagreesWithPlacer) {
				opts.anchorPosterior = placed.posterior ?? { [placed.country]: placed.confidence }
				opts.anchorWeight = COARSE_PLACER_ANCHOR_WEIGHT
			}

			// Optional hard-country filter with shared coverage guard.
			const hardCountry = hardCountryFor(
				{ country: placed.country, confidence: placed.confidence },
				opts,
				placerCountrySetting(deps)
			)

			if (hardCountry) {
				// Apply hard country only when not contradicted by dominant locality bearer.
				const dominantDisagrees = dominantBearer !== null && dominantBearer.toUpperCase() !== hardCountry.toUpperCase()

				if (!dominantDisagrees) {
					opts.hardCountry = hardCountry
				}
			}
		}
	}

	// Non-US rooftop selection: national DB first, then OSM fallback.
	const rooftopFor = (country: string | null): AddressPointLookup | null => {
		if (!country || country.toLowerCase() === "us") return null
		const slug = country.toLowerCase()

		return deps.nationalDatabases?.(slug)?.addressPoints ?? deps.osmDatabases?.(slug)?.addressPoints ?? null
	}

	// Pre-resolve country: explicit default first, then placer.
	const preResolveCountry = (hardCountryOf(deps.defaultCountry) ?? placedCountry)?.toLowerCase() ?? null

	// Country-specific placetype map.
	opts.placetypeMap = placetypeMapForCountry(preResolveCountry)

	// Non-US rooftop DB outranks any state-slug US DB match.
	{
		const rooftop = rooftopFor(preResolveCountry)

		if (rooftop) {
			addressPoints = rooftop
			opts.addressPointBboxFallback = true
		}
	}

	if (addressPoints) {
		opts.addressPoints = addressPoints
		// A register's row can state no locality or postcode, so the search around the resolved locality reaches it.
		opts.addressPointBboxFallback = true
	}

	// Optional country-keyed street-centroid tier with country hints.
	const streetHints: string[] = []

	if (deps.nationalDatabases) {
		const provider = deps.nationalDatabases

		opts.streetCentroids = (country: string) => provider(country).streetCentroids ?? null

		for (const c of [
			hardCountryOf(deps.defaultCountry)?.toLowerCase(),
			placedCountry?.toLowerCase(),
			streetPlacerCountry,
		]) {
			if (c && !streetHints.includes(c)) {
				streetHints.push(c)
			}
		}

		if (streetHints.length) {
			opts.streetCountryHints = streetHints
		}
	}

	if (interpolation) {
		opts.interpolation = interpolation
		// An explicit calibration overrides the artifact's own value.
		// Otherwise a legacy database falls back to the in-code table.
		const explicit = typeof deps.interpCalibration === "number" ? deps.interpCalibration : null

		const fallback =
			interpolation.radiusCalibration == null && typeof deps.interpCalibration === "object"
				? interpCalibrationForRegion(deps.interpCalibration, stateSlug)
				: null

		const calibration = explicit ?? fallback

		// Skip no-op calibration unless explicitly overriding artifact calibration.
		if (calibration && (calibration !== 1 || (explicit && interpolation.radiusCalibration != null))) {
			opts.interpolationRadiusCalibration = calibration
		}
	}

	for (const key of FORWARDED_RESOLVER_SWITCHES) {
		opts[key] = switches[key]
	}

	if (deps.isVenueCategoryWord) {
		opts.isVenueCategoryWord = deps.isVenueCategoryWord
	}

	// The lookups the resolver reads under the same name, each passed only when the caller supplied it.
	Object.assign(opts, {
		...(deps.osmPlaces ? { osmPlaces: deps.osmPlaces } : {}),
		...(deps.formerDivisionLookup ? { formerDivisionLookup: deps.formerDivisionLookup } : {}),
	})

	if (deps.landmarks) {
		opts.landmarks = deps.landmarks
		opts.writtenInput = input
	}

	// Pin weak-resolution mode only when explicitly set.
	if (deps.spanRescoreWeakResolution) {
		opts.spanRescoreWeakResolution = deps.spanRescoreWeakResolution
	}

	if (deps.postcodePrefixIndex) {
		opts.postcodePrefixIndex = deps.postcodePrefixIndex
	}

	let resolved = await deps.resolver.resolveTree(tree, opts)

	// Re-resolve once if resolved country differs from pre-selected database country.
	const scopeCountry = resolvedCountryOf(resolved) ?? postcodeCountryScopeOf(resolved)

	if (scopeCountry && scopeCountry.toLowerCase() !== preResolveCountry && !usDatabases.addressPoints) {
		const rooftop = rooftopFor(scopeCountry)
		let changed = false

		if (rooftop) {
			opts.addressPoints = rooftop
			opts.addressPointBboxFallback = true
			changed = true
		}

		// Update placetype map for corrected country.
		const scopedMap = placetypeMapForCountry(scopeCountry)

		if (scopedMap !== opts.placetypeMap) {
			opts.placetypeMap = scopedMap
			changed = true
		}

		if (opts.streetCentroids && !streetHints.includes(scopeCountry.toLowerCase())) {
			opts.streetCountryHints = [scopeCountry.toLowerCase(), ...streetHints]
			changed = true
		}

		if (changed) {
			resolved = await deps.resolver.resolveTree(tree, opts)
		}
	}

	let result = extractWithoutNameDroppingRescore(input, resolved, { ...deps, poiVenueTier: switches.poiVenueTier })

	// Compute kind verdict over parseInput for downstream markers and fallback behavior.
	const verdict = classifyKindSync({ raw: parseInput, normalized: parseInput }, queryShape)
	const forkDeclared = (verdict.intentMarkers ?? []).some((m) => m.code === "declared_fork")

	result = await applyStreetMissFallback(result, {
		tree,
		opts,
		deps,
		input,
		forkDeclared,
		extract: extractGeocodeResult,
	})

	applyPlusCodeOverride(result, input, resolved)

	// Build intent markers from verdict plus resolve-time checks.
	const markers = [...(verdict.intentMarkers ?? [])]

	// Add ambiguity/coarser-answer markers when those checks fire.
	const kinds = [verdict.kind, ...verdict.alternatives.map((a) => a.kind)]

	markers.push(
		...[
			declaredAmbiguityMarker({ kinds, tree: resolved, lat: result.lat, lon: result.lon }),
			coarserAnswerMarker({
				kinds,
				// Pass only component surface fields.
				components: {
					house_number: result.house_number,
					unit: result.unit,
					street: result.street,
					postcode: result.postcode,
				},
				reachedTier: result.resolution_tier,
			}),
		].filter((marker) => marker !== null)
	)

	// Apply entity tiers (declared-fork rescue and the venue tier).
	// The tier reads the merged switch, so a caller that leaves `poiVenueTier` unset
	// gets the switch's default as a session does.
	applyEntityTiers(result, markers, parseInput, resolved.roots, {
		...deps,
		poiVenueTier: switches.poiVenueTier,
		kind: verdict.kind,
	})

	// Append designation markers from attached spatial layers.
	result.intent_markers = [...markers, ...layerDesignationMarkers(deps, result.lat, result.lon, verdict)]

	// Optional authoritative consult runs last and is attached beside open result.
	if (deps.authoritativeProvider) {
		const query = authoritativeQueryFrom(input, parseInput, result)

		result.authoritative = await consultAuthoritativeProvider(deps.authoritativeProvider, query)
	}

	return trace.attach(result)
}
