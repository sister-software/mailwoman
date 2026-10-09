/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
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
	streetContextRequirementFor,
} from "@mailwoman/core/pipeline"
import type {
	AuthoritativeProvider,
	DefaultCountry,
	AddressPointLookup,
	PostcodePrefixIndexLike,
	RegionDatabases,
	ResolveOpts,
	Resolver,
	WeakResolutionReading,
} from "@mailwoman/core/resolver"
import {
	countriesFromPostcodeFormat,
	countryFromPostcodeFormat,
	RESOLVE_SWITCH_DEFAULTS,
} from "@mailwoman/core/resolver"
import { classifyKindSync } from "@mailwoman/kind-classifier"
import { computeQueryShape, type QueryShape } from "@mailwoman/query-shape"

import { authoritativeQueryFrom, consultAuthoritativeProvider } from "#authoritative"
import { loadDefaultPlaceCountry, type PlaceCountryFn } from "#default/placer"
import { applyEntityTiers } from "#fork-entity"
import { classifierForInput, type GeocodeClassifier, normalizeGeocodeInput } from "#geocode/classifier"
import { traceCollector } from "#geocode/derivation"
import { type RegionDatabaseResolver, regionSlugFromTree } from "#geocode/regions"
import { extractGeocodeResult } from "#geocode/result"
import {
	postcodeCountryScopeOf,
	recognizeBarePostcode,
	resolvedCountryOf,
	treePostcodeValue,
} from "#geocode/tree-reads"
import { shouldDropInferredScope } from "#inferred-scope"
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

/**
 * The on/off settings of a geocode.
 *
 * Every setting has an explicit default in {@link GEOCODE_SWITCH_DEFAULTS}.
 */
export interface GeocodeSwitches {
	/**
	 * Lets `poi.db` entity upgrades reach the venue tier.
	 */
	poiVenueTier: boolean
	/**
	 * Applies deterministic input normalization before the parse.
	 */
	normalizeInput: boolean
	/**
	 * Prefers the postcode-format country prior over the placer when available.
	 */
	postcodeCountryPrior: boolean
	/**
	 * Enforces admin descendant consistency.
	 */
	adminCoherence: boolean
	/**
	 * Re-probes unresolved values across admin bands.
	 * It needs a trace sink.
	 */
	diagnoseUnreachable: boolean
	/**
	 * Attaches resolved-node ancestors to metadata.
	 */
	includeAncestors: boolean
	/**
	 * Lets the postcode's country override the country scope.
	 */
	postcodeCountryCoherence: boolean
	/**
	 * Narrows the postcode systems by the postcode's shape.
	 */
	postcodeShapeCoherence: boolean
	/**
	 * Passes the postcode as a containment hint to locality lookups.
	 */
	postcodeContainmentCoherence: boolean
	/**
	 * Reranks locality candidates by containment in a parsed region.
	 */
	adminContainmentRerank: boolean
	/**
	 * Requires span-rescore recovery to leave a context remainder.
	 */
	spanRescoreRequireContextRemainder: boolean
	/**
	 * Uses the postcode-prefix prior.
	 * It needs {@link GeocodeDeps.postcodePrefixIndex}.
	 */
	postcodePrefixPrior: boolean
}

/**
 * The value of each {@link GeocodeSwitches} setting that a geocode leaves unset.
 *
 * A switch the geocode only forwards to the resolver takes the resolver's default.
 * `includeAncestors` departs from it on purpose, because the admin-coherence verdicts read the ancestors.
 */
export const GEOCODE_SWITCH_DEFAULTS: Readonly<GeocodeSwitches> = {
	poiVenueTier: false,
	normalizeInput: true,
	postcodeCountryPrior: true,
	adminCoherence: RESOLVE_SWITCH_DEFAULTS.adminCoherence,
	diagnoseUnreachable: RESOLVE_SWITCH_DEFAULTS.diagnoseUnreachable,
	includeAncestors: true,
	postcodeCountryCoherence: RESOLVE_SWITCH_DEFAULTS.postcodeCountryCoherence,
	postcodeShapeCoherence: RESOLVE_SWITCH_DEFAULTS.postcodeShapeCoherence,
	postcodeContainmentCoherence: RESOLVE_SWITCH_DEFAULTS.postcodeContainmentCoherence,
	adminContainmentRerank: RESOLVE_SWITCH_DEFAULTS.adminContainmentRerank,
	spanRescoreRequireContextRemainder: RESOLVE_SWITCH_DEFAULTS.spanRescoreRequireContextRemainder,
	postcodePrefixPrior: RESOLVE_SWITCH_DEFAULTS.postcodePrefixPrior,
}

/**
 * Fills each unset switch from {@link GEOCODE_SWITCH_DEFAULTS}.
 */
export function geocodeSwitches(deps: Partial<GeocodeSwitches>): GeocodeSwitches {
	const switches = { ...GEOCODE_SWITCH_DEFAULTS }

	for (const key of Object.keys(GEOCODE_SWITCH_DEFAULTS) as (keyof GeocodeSwitches)[]) {
		switches[key] = deps[key] ?? GEOCODE_SWITCH_DEFAULTS[key]
	}

	return switches
}

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
	 * Gazetteer FST prior.
	 */
	fst?: import("@mailwoman/core/pipeline").FSTMatcherLike
	/**
	 * Street-morphology matcher for street-context checks.
	 */
	streetMorphology?: import("@mailwoman/core/pipeline").FSTMatcherLike
	/**
	 * Venue-head lookups for the session's locale.
	 * Absent, the venue-head prior does not run.
	 */
	venueHead?: import("@mailwoman/neural/venue-head-prior").VenueHeadLexiconLike
	/**
	 * Overrides for the venue-head prior's bias scale, cap and extension.
	 */
	venueHeadOpts?: import("@mailwoman/neural/venue-head-prior").VenueHeadPriorOpts
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
	 * Country constraint passed to the resolver, and who chose it.
	 * When it is unset, the resolver has no default country.
	 */
	defaultCountry?: DefaultCountry
	/**
	 * Locale country as a soft ranking prior when no hard country scope is set.
	 */
	localeCountryPrior?: string
	/**
	 * Weight for localeCountryPrior.
	 */
	localeCountryPriorWeight?: number
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
export function deriveGeocodeRegister(parseInput: string, queryShape = computeQueryShape(parseInput)): InputMode {
	return deriveInputMode("auto", classifyKindSync({ raw: parseInput, normalized: parseInput }, queryShape).kind)
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

export function geocodeParseInputs(
	input: string,
	deps: Pick<
		GeocodeDeps,
		"normalizeInput" | "caseNormalization" | "inputMode" | "fst" | "streetMorphology" | "venueHead" | "venueHeadOpts"
	> &
		Partial<Pick<GeocodeDeps, "classifier">>
): GeocodeParseInputs {
	// Stage-1 input normalization before parse.
	const parseInput = geocodeSwitches(deps).normalizeInput
		? normalizeGeocodeInput(input, deps.classifier).normalized
		: input

	// Query shape used as a parse prior.
	const queryShape = computeQueryShape(parseInput)

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
			// Default word-consistency enforcement.
			enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT,
			// Optional gazetteer prior.
			...(deps.fst ? { fst: deps.fst } : {}),
			// Street-context requirements from shared helper.
			...streetContextRequirementFor({
				...(deps.fst ? { fst: deps.fst } : {}),
				...(deps.streetMorphology ? { streetMorphology: deps.streetMorphology } : {}),
			}),
			...(deps.venueHead ? { venueHead: deps.venueHead } : {}),
			...(deps.venueHead && deps.venueHeadOpts ? { venueHeadOpts: deps.venueHeadOpts } : {}),
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
		| "venueHead"
		| "venueHeadOpts"
	>
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

		const refusal = await thingQueryRefusalMarkers(deps.classifyKind, parseInput)

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
	if (deps.defaultCountry && !shouldDropInferredScope(tree, deps.defaultCountry, formatCountries)) {
		opts.defaultCountry = deps.defaultCountry
	}

	// Pass format-implied countries to postcode probe.
	if (formatCountries.length) {
		opts.postcodeFormatCountries = formatCountries
	}

	// Locale hint for fuzzy matching scope.
	if (deps.fuzzyCountryScope) {
		opts.fuzzyCountryScope = deps.fuzzyCountryScope
	}

	// Soft locale prior when no hard scope is active.
	if (deps.localeCountryPrior && !opts.defaultCountry) {
		opts.localeCountryPrior = deps.localeCountryPrior

		if (deps.localeCountryPriorWeight !== undefined) {
			opts.localeCountryPriorWeight = deps.localeCountryPriorWeight
		}
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
	"spanRescoreRequireContextRemainder",
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

async function geocodeAddressOnce(input: string, deps: GeocodeDeps): Promise<GeocodeResult> {
	// Normalize input for parse/placer while keeping raw input for output.
	const switches = geocodeSwitches(deps)

	const parseInput = switches.normalizeInput
		? normalizeGeocodeInput(input, await classifierForInput(deps.classifier, input)).normalized
		: input

	const tree = deps.parsedTree ?? (await parseForGeocode(input, deps))
	const queryShape = computeQueryShape(parseInput)
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
	if (switches.postcodeCountryPrior && !opts.defaultCountry && !opts.anchorPosterior && !isBareLocalityTree(tree)) {
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
					: undefined

			const dominantBearer = dominant?.country !== undefined && dominant.exactMatch !== false ? dominant.country : null

			const dominantDisagreesWithPlacer =
				dominantBearer !== null && dominantBearer.toUpperCase() !== placed.country.toUpperCase()

			// Apply anchor only when placer does not contradict dominant locality bearer.
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
	const preResolveCountry = (deps.defaultCountry?.country ?? placedCountry)?.toLowerCase() ?? null

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
	}

	// Optional country-keyed street-centroid tier with country hints.
	const streetHints: string[] = []

	if (deps.nationalDatabases) {
		const provider = deps.nationalDatabases

		opts.streetCentroids = (country: string) => provider(country).streetCentroids ?? null

		for (const c of [deps.defaultCountry?.country.toLowerCase(), placedCountry?.toLowerCase(), streetPlacerCountry]) {
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
		const explicit = typeof deps.interpCalibration === "number" ? deps.interpCalibration : undefined

		const fallback =
			interpolation.radiusCalibration == null && typeof deps.interpCalibration === "object"
				? interpCalibrationForRegion(deps.interpCalibration, stateSlug)
				: undefined

		const calibration = explicit ?? fallback

		// Skip no-op calibration unless explicitly overriding artifact calibration.
		if (calibration && (calibration !== 1 || (explicit !== undefined && interpolation.radiusCalibration != null))) {
			opts.interpolationRadiusCalibration = calibration
		}
	}

	for (const key of FORWARDED_RESOLVER_SWITCHES) {
		opts[key] = switches[key]
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

	let result = extractGeocodeResult(input, resolved)

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

	// Apply entity tiers (declared-fork rescue and optional venue tier).
	applyEntityTiers(result, markers, parseInput, resolved.roots, deps)

	// Append designation markers from attached spatial layers.
	result.intent_markers = [...markers, ...layerDesignationMarkers(deps, result.lat, result.lon, verdict)]

	// Optional authoritative consult runs last and is attached beside open result.
	if (deps.authoritativeProvider) {
		const query = authoritativeQueryFrom(input, parseInput, result)

		result.authoritative = await consultAuthoritativeProvider(deps.authoritativeProvider, query)
	}

	return trace.attach(result)
}
