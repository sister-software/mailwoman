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

import type { GeocodeOutcomeLike } from "@mailwoman/api"
import { placetypeMapForCountry } from "@mailwoman/codex/placetype-map"
import type { AddressTree } from "@mailwoman/core/decoder"
import { decodeAsJSON } from "@mailwoman/core/decoder"
import {
	COARSE_PLACER_ANCHOR_WEIGHT,
	deriveInputMode,
	type InputMode,
	hardCountryFor,
	isBareLocalityTree,
	isBarePostcodeTree,
	type QueryKindResult,
	WORD_CONSISTENCY_SHIP_DEFAULT,
	streetContextRequirementFor,
} from "@mailwoman/core/pipeline"
import type {
	AuthoritativeProvider,
	AddressPointLookup,
	PostcodePrefixIndexLike,
	ResolveOpts,
	Resolver,
	WeakResolutionReading,
} from "@mailwoman/core/resolver"
import { countriesFromPostcodeFormat, countryFromPostcodeFormat } from "@mailwoman/core/resolver"
import { classifyKindSync } from "@mailwoman/kind-classifier"
import { computeQueryShape, type QueryShape } from "@mailwoman/query-shape"

import { authoritativeQueryFrom, consultAuthoritativeProvider } from "#authoritative"
import { loadDefaultPlaceCountry, type PlaceCountryFn } from "#default/placer"
import { applyEntityTiers } from "#fork-entity"
import { classifierForInput, type GeocodeClassifier, normalizeGeocodeInput } from "#geocode/classifier"
import { traceCollector } from "#geocode/derivation"
import { type RegionDatabaseResolver, type RegionDatabases, regionSlugFromTree } from "#geocode/regions"
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
import { layerDesignationMarkers, type LayerDesignationRoutes } from "#observations/index"
import { applyPlusCodeOverride } from "#plus-code-override"
import type { POIExecutorLookup } from "#poi/executor"
import { repairPostcodeContradiction } from "#postcode-repair"
import { coarserAnswerMarker, declaredAmbiguityMarker } from "#query-intent"
import { recognizeUSRegions } from "#region-recognition"
import { repairStrandedAffix } from "#stranded-affix-repair"
import { applyStreetMissFallback } from "#street/miss-fallback"

export type { GeocodeClassifier } from "#geocode/classifier"

// Spatial layers are passed as one route bundle.
export interface GeocodeDeps extends LayerDesignationRoutes {
	/**
	 * Poi.db reader for the fork→entity probe.
	 */
	poiLookup?: POIExecutorLookup
	/**
	 * Opt-in venue tier for poi.db entity upgrades.
	 */
	poiVenueTier?: boolean
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
	 * True when defaultCountry came from locale inference.
	 */
	defaultCountryIsInferred?: boolean
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
	 * Explicit input register.
	 * If unset, it is derived from kind.
	 */
	inputMode?: InputMode
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
	 * Country constraint passed to the resolver.
	 */
	defaultCountry?: string
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
	capitalLevel?: (place: { name: string; country?: string; lat: number; lon: number }) => number
	/**
	 * Locale hint country for fuzzy matching only.
	 */
	fuzzyCountryScope?: string
	/**
	 * Normalize ALL-CAPS ASCII to title case before parsing.
	 * Default true.
	 */
	normalizeCase?: boolean
	/**
	 * Deterministic input normalization before parse.
	 * Default true.
	 */
	normalizeInput?: boolean
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
	 */
	placeCountry?: PlaceCountryFn | false
	/**
	 * Proximity bias points forwarded to resolver bias.
	 */
	bias?: Array<{ lat: number; lon: number; weight?: number }>
	/**
	 * Enable hard-country filtering from confident placer output (default on).
	 */
	hardPlaceCountry?: boolean
	/**
	 * Optional override for the hard-country coverage safelist.
	 */
	hardCountrySafelist?: ReadonlySet<string>
	/**
	 * Prefer postcode-format country prior over placer when available.
	 * Default on.
	 */
	postcodeCountryPrior?: boolean
	/**
	 * Admin descendant-consistency control.
	 * Default on.
	 */
	adminCoherence?: boolean
	/**
	 * Optional resolver trace sink.
	 */
	resolveTraceSink?: import("@mailwoman/core/resolver").ResolveOpts["traceSink"]
	/**
	 * Diagnostic unresolved re-probe across admin bands.
	 */
	diagnoseUnreachable?: boolean
	/**
	 * Include resolved-node ancestors in metadata.
	 * Default on.
	 */
	includeAncestors?: boolean
	/**
	 * Postcode-country coherence control.
	 * Default on.
	 */
	postcodeCountryCoherence?: boolean
	/**
	 * Opt-in postcode-shape coherence.
	 */
	postcodeShapeCoherence?: boolean
	/**
	 * Opt-in postcode-containment coherence.
	 */
	postcodeContainmentCoherence?: boolean
	/**
	 * Admin-containment rerank control.
	 */
	adminContainmentRerank?: boolean
	/**
	 * Require context remainder in span-rescore recovery.
	 */
	spanRescoreRequireContextRemainder?: boolean
	/**
	 * Weak-resolution reading.
	 */
	spanRescoreWeakResolution?: WeakResolutionReading
	/**
	 * Opt-in postcode-prefix prior (requires postcodePrefixIndex).
	 */
	postcodePrefixPrior?: boolean
	/**
	 * PFX1 postcode-prefix index used by postcodePrefixPrior.
	 */
	postcodePrefixIndex?: PostcodePrefixIndexLike
}

/**
 * Kind-derived register for geocode input.
 */
export function deriveGeocodeRegister(parseInput: string, queryShape = computeQueryShape(parseInput)): InputMode {
	return deriveInputMode(classifyKindSync({ raw: parseInput, normalized: parseInput }, queryShape).kind)
}

/**
 * Inputs derived before parse: normalized text, query shape, register, and parse opts.
 */
export interface GeocodeParseInputs {
	/**
	 * Exact text sent to the classifier.
	 */
	parseInput: string
	queryShape: QueryShape
	inputMode: InputMode
	/**
	 * Kind verdict used to derive inputMode, when derived.
	 */
	kind?: QueryKindResult
	opts: NonNullable<Parameters<GeocodeClassifier["parse"]>[1]>
}

export function geocodeParseInputs(
	input: string,
	deps: Pick<GeocodeDeps, "normalizeInput" | "normalizeCase" | "inputMode" | "fst" | "streetMorphology"> &
		Partial<Pick<GeocodeDeps, "classifier">>
): GeocodeParseInputs {
	// Stage-1 input normalization before parse.
	const parseInput = deps.normalizeInput === false ? input : normalizeGeocodeInput(input, deps.classifier).normalized

	// Query shape used as a parse prior.
	const queryShape = computeQueryShape(parseInput)

	// An explicit register wins.
	// Otherwise the mode derives from the kind.
	let inputMode = deps.inputMode
	let kind: QueryKindResult | undefined

	if (!inputMode) {
		kind = classifyKindSync({ raw: parseInput, normalized: parseInput }, queryShape)
		inputMode = deriveInputMode(kind.kind)
	}

	return {
		parseInput,
		queryShape,
		inputMode,
		...(kind ? { kind } : {}),
		opts: {
			postcodeRepair: true,
			normalizeCase: deps.normalizeCase ?? true,
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
		},
	}
}

/**
 * The parse path `geocodeAddress` runs.
 * It is exported so a caller can reuse the parse.
 */
export async function parseForGeocode(
	input: string,
	deps: Pick<GeocodeDeps, "classifier" | "normalizeInput" | "normalizeCase" | "inputMode" | "fst" | "streetMorphology">
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
export async function geocodeAddress(input: string, deps: GeocodeDeps): Promise<GeocodeOutcomeLike> {
	// Optional first-refusal check for thing queries.
	if (deps.classifyKind && !deps.inputMode) {
		const parseInput =
			deps.normalizeInput === false
				? input
				: normalizeGeocodeInput(input, await classifierForInput(deps.classifier, input)).normalized

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
 * Apply country-related evidence to resolver options.
 */
function applyCountryEvidence(opts: ResolveOpts, tree: AddressTree, deps: GeocodeDeps): void {
	// Countries implied by postcode format.
	const formatCountries = countriesFromPostcodeFormat(treePostcodeValue(tree))

	if (deps.defaultCountry) {
		// Drop inferred scope when contradictory evidence is stronger.
		if (shouldDropInferredScope(tree, deps.defaultCountry, deps.defaultCountryIsInferred === true, formatCountries)) {
			// No hard scope.
		} else {
			opts.defaultCountry = deps.defaultCountry

			// Mark inferred default scope so resolver can treat it specially.
			if (deps.defaultCountryIsInferred === true) {
				opts.defaultCountryIsInferred = true
			}
		}
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
 * Resolver options that are explicit opt-ins.
 */
const OPT_IN_RESOLVER_PINS = [
	"postcodeShapeCoherence",
	"postcodeContainmentCoherence",
	"spanRescoreRequireContextRemainder",
	"postcodePrefixPrior",
] as const satisfies readonly (keyof GeocodeDeps & keyof ResolveOpts)[]

async function geocodeAddressOnce(input: string, deps: GeocodeDeps): Promise<GeocodeOutcomeLike> {
	// Normalize input for parse/placer while keeping raw input for output.
	const parseInput =
		deps.normalizeInput === false
			? input
			: normalizeGeocodeInput(input, await classifierForInput(deps.classifier, input)).normalized

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
		// Keep explicit opt-out behavior for admin coherence.
		adminCoherence: deps.adminCoherence !== false,
		// Keep explicit opt-out behavior for ancestor attachment.
		includeAncestors: deps.includeAncestors !== false,
		...(traceSink ? { traceSink } : {}),
		...(deps.diagnoseUnreachable ? { diagnoseUnreachable: true } : {}),
	}

	applyCountryEvidence(opts, tree, deps)

	if (deps.bias && deps.bias.length) {
		opts.bias = deps.bias
	}

	// Coarse country router: default loader, custom function, or disabled.
	const placeCountry: PlaceCountryFn | null =
		deps.placeCountry === false ? null : (deps.placeCountry ?? (await loadDefaultPlaceCountry()))

	// Placer country reused for later country-dependent steps.
	let placedCountry: string | null = null

	// Compute placer prediction once and reuse it.
	const placerResult = placeCountry ? placeCountry(parseInput) : null

	const streetPlacerCountry =
		placerResult?.country && placerResult.country !== "OTHER" ? placerResult.country.toLowerCase() : null

	// Prefer postcode-format country prior when eligible.
	if (
		deps.postcodeCountryPrior !== false &&
		!opts.defaultCountry &&
		!opts.anchorPosterior &&
		!isBareLocalityTree(tree)
	) {
		const pcCountry = countryFromPostcodeFormat(decodeAsJSON(tree).postcode as string | undefined)

		if (pcCountry) {
			placedCountry = pcCountry
			opts.anchorPosterior = { [pcCountry]: 1 }
			opts.anchorWeight = COARSE_PLACER_ANCHOR_WEIGHT

			// Hard-country safelist precedence: override -> artifact -> fallback.
			const hardCountry = hardCountryFor(
				pcCountry,
				1,
				opts,
				deps.hardPlaceCountry ?? true,
				deps.hardCountrySafelist ?? deps.resolver.artifactCoverage?.hardCountrySafelist
			)

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
				placed.country,
				placed.confidence,
				opts,
				deps.hardPlaceCountry ?? true,
				deps.hardCountrySafelist ?? deps.resolver.artifactCoverage?.hardCountrySafelist
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
	const rooftopFor = (country: string | undefined): AddressPointLookup | undefined => {
		if (!country || country.toLowerCase() === "us") return undefined
		const slug = country.toLowerCase()

		return deps.nationalDatabases?.(slug)?.addressPoints ?? deps.osmDatabases?.(slug)?.addressPoints
	}

	// Pre-resolve country: explicit default first, then placer.
	const preResolveCountry = (deps.defaultCountry ?? placedCountry)?.toLowerCase()

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

		opts.streetCentroids = (country: string) => provider(country).streetCentroids

		for (const c of [deps.defaultCountry?.toLowerCase(), placedCountry?.toLowerCase(), streetPlacerCountry]) {
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

	// Keep explicit opt-out behavior for postcode-country coherence.
	opts.postcodeCountryCoherence = deps.postcodeCountryCoherence !== false

	for (const pin of OPT_IN_RESOLVER_PINS) {
		if (deps[pin] === true) {
			opts[pin] = true
		}
	}

	// Default on unless explicitly disabled.
	if (deps.adminContainmentRerank !== false) {
		opts.adminContainmentRerank = true
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
