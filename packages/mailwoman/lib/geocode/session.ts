// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A geocode session: the services `#geocode/services` builds for one set of options,
 *   and the operations that read them for each address.
 *
 *   The CLI, the API server and the evaluation tools geocode through this one session.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { firstNodeWhere } from "@mailwoman/core/decoder"
import type { GeocodeResult } from "@mailwoman/core/geocode"
import {
	type InputModeSelection,
	isBareLocalityTree,
	isBarePostcodeTree,
	type InputMode,
	type PipelineTiming,
	type QueryKindResult,
	type SoftChannelName,
} from "@mailwoman/core/pipeline"
import {
	type DefaultCountry,
	type ParentPlaceScope,
	type ResolveNodeTrace,
	type ResolveOpts,
	ScopeStrength,
} from "@mailwoman/core/resolver"
import { CommandError } from "@mailwoman/core/scripting/command"
import type { NeuralParseTrace } from "@mailwoman/neural"
import { countriesFromPostcodeFormat } from "@mailwoman/postcode/postcode-format"
import type { QueryShape } from "@mailwoman/postcode/recognizer/query-shape"
import { createWOFResolver } from "@mailwoman/resolver"
import { ServiceRegistry } from "async-init"
import type { PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import { resolverDefaultCountry } from "#country-scope"
import type { LayerContribution } from "#geocode/contributions"
import {
	geocodeAddress,
	geocodeParseInputs,
	parseForGeocode,
	type GeocodeDecoderSettingDeps,
	type GeocodeDeps,
} from "#geocode/core"
import { shippedGazetteerFSTPath } from "#geocode/fst-layers"
import { GEOCODE_DEFAULT_LOCALE, type GeocodeSessionOptions, type SessionOptionSource } from "#geocode/options"
import { createCountryFSTLookup } from "#geocode/parse-priors"
import { type RegionDatabaseResolver, regionSlugFromTree } from "#geocode/regions"
import {
	registerGenerationServices,
	registerProcessServices,
	resolveGenerationServices,
	unavailableLayers,
} from "#geocode/services"
import { INTERP_RADIUS_CALIBRATION, interpCalibrationForRegion } from "#interp-calibration"
import { NODE_LAYER_CONTRIBUTIONS } from "#services/entry/node"
import { recordServiceTimings, type ServiceTimings } from "#services/timings"

/**
 * The per-stage evidence behind one geocode, rendered by the `--debug` view
 * and built only when the session's `trace` option is set.
 */
export interface GeocodeTrace {
	/**
	 * The decoder's record of the parse, from input pieces and feature channels to the final tokens.
	 */
	parse: NeuralParseTrace

	/**
	 * The structural features the query classifier used.
	 */
	queryShape: QueryShape

	/**
	 * The kind verdict behind {@link inputMode}, or `null` when the caller set the input mode.
	 */
	kind: QueryKindResult | null
	inputMode: InputMode

	/**
	 * One record per backend lookup that the resolver performed.
	 */
	resolver: ResolveNodeTrace[]
}

/**
 * Why a session kept a locale-inferred country scope from the resolver as a filter.
 *
 * - `"bare_locality"`: the whole input is one place name.
 * - `"bare_postcode_format_conflict"`: the whole input is one postcode,
 *   in a format the country doesn't use.
 * - `"contradicting_evidence"`: the locale head reads the address as another country's,
 *   or the postcode's format excludes the country.
 */
export const ScopeWithheldReason = {
	BareLocality: "bare_locality",
	BarePostcodeFormatConflict: "bare_postcode_format_conflict",
	ContradictingEvidence: "contradicting_evidence",
} as const

export type ScopeWithheldReason = (typeof ScopeWithheldReason)[keyof typeof ScopeWithheldReason]

/**
 * The locale and the country scope one geocode ran under, and where each came from.
 *
 * The session records each value where it decides it, so the record states the decision
 * and never a second reading of it.
 */
export interface GeocodeApplied {
	/**
	 * The session's locale, keyed as a pipeline's `LocaleHint` keys its own.
	 */
	locale: {
		locale: string
		source: SessionOptionSource
	}

	/**
	 * The country scope of this input, or null when the geocode answered without resolving.
	 */
	countryScope: {
		/**
		 * The scope the resolver was given, or null when it resolved with none.
		 *
		 * A `"caller"` scope is a default country a caller stated, and an `"inferred"`
		 * one is read off the locale.
		 */
		resolver: Required<DefaultCountry> | null

		/**
		 * The locale's country, when the session or the address's own evidence kept it from filtering.
		 *
		 * {@linkcode resolver} is then a soft scope standing in for it, or null.
		 */
		withheld: { country: string; reason: ScopeWithheldReason } | null
	} | null
}

/**
 * One address's geocode result and the {@link AddressTree} it was resolved from.
 *
 * The tree's nodes store character offsets for span rendering.
 */
export interface GeocodeRun {
	result: GeocodeResult
	tree: AddressTree

	/**
	 * The locale and country scope the result was computed under, with the source of each.
	 */
	applied: GeocodeApplied

	/**
	 * Wall-clock milliseconds for `parse`, `resolve` and `total`, plus `trace` when the session traces,
	 * with the `trace` phase recorded even when tracing threw so the phases sum to `total`.
	 */
	timing: PipelineTiming

	/**
	 * The debug evidence, present only when the session traces and `traceParse` succeeded.
	 */
	trace?: GeocodeTrace
}

/**
 * The settings one request may set on top of its session's.
 */
export interface GeocodeRequestOptions {
	/**
	 * The register the parse reads the input in, `auto` by default.
	 */
	inputMode?: InputModeSelection

	/**
	 * Points the resolver prefers candidates near, in place of the session's `bias` when non-empty.
	 */
	bias?: GeocodeDeps["bias"]

	/**
	 * A parent place that scopes every lookup of this input, in place of the session's `parentPlace`.
	 */
	parentPlace?: ParentPlaceScope

	/**
	 * An ISO 3166-1 country the caller restricts this input's resolver to,
	 * in place of the session's `defaultCountry`.
	 *
	 * It is a caller scope, so the session never withholds it, even to the point of zero results.
	 * The next request without one reads the session's `defaultCountry` again.
	 */
	defaultCountry?: string
}

/**
 * The services a session resolved for its data generation, as `resolveGenerationServices` returns them.
 */
export type GeocodeSessionServices = Awaited<ReturnType<typeof resolveGenerationServices>>

/**
 * The scope a session builds from.
 */
export interface GeocodeSessionScope {
	/**
	 * A scope whose services the session reads in place of building its own.
	 *
	 * The session registers its services in a child of this scope, and skips each
	 * service the scope already provides.
	 * A process scope from {@link createGeocodeProcessScope} provides the classifier and the resolver module.
	 *
	 * A scope may provide any other service too, such as a resolver backend a test substitutes,
	 * by defining it under its token in `GenerationServices`.
	 *
	 * The session disposes only the services it built and leaves the parent's services loaded.
	 *
	 * Absent, the session builds every service and disposes them with itself.
	 */
	parent?: ServiceRegistry

	/**
	 * The data layers the session composes, in the order it consults their national sources.
	 *
	 * @defaultValue `NODE_LAYER_CONTRIBUTIONS` in `#services/entry/node`
	 */
	layers?: readonly LayerContribution[]
}

/**
 * A geocoder with its models and databases loaded for one set of options and one data generation.
 *
 * Its async disposal closes the database and layer handles it opened
 * and releases its lease on the data generation.
 */
export interface GeocodeSession extends AsyncDisposable {
	/**
	 * Wall-clock milliseconds of each service the session built, plus `total` for the whole construction.
	 *
	 * Services build in parallel, so the per-service figures overlap.
	 */
	initTiming: PipelineTiming

	/**
	 * Each optional layer that failed to open, with the message of what it threw.
	 *
	 * The session answers without those layers, and prints one line for each to stderr as it starts.
	 */
	unavailableLayers: { layer: string; reason: string }[]

	/**
	 * The artifact paths that this session opened, where missing artifacts are skipped
	 * without an error so these paths can differ from the options.
	 */
	artifacts: {
		fstPath?: PathBuilderLike
		streetMorphologyPath?: string

		/**
		 * The `model.onnx` path that the classifier loaded and its source, such as `package:…` or `cache:…`.
		 */
		weights?: { modelPath: string; source: string }

		/**
		 * The lexicon or lookup file behind each fed channel of the primary classifier, keyed by channel name.
		 */
		lexicons?: Partial<Record<SoftChannelName, string>>
	}

	/**
	 * The services the session geocodes with: the classifier, the gazetteer backend, the region,
	 * national and OpenStreetMap database sources, and the paths they were opened from.
	 *
	 * A server reads them for what it answers beside a geocode, such as a place's ancestry.
	 * The session owns every handle reached through this member and closes each one at its disposal.
	 * A caller never disposes one.
	 */
	readonly services: Readonly<GeocodeSessionServices>
	geocode(input: string, request?: GeocodeRequestOptions): Promise<GeocodeRun>

	/**
	 * Resolves an already-parsed tree against the session's resolver and the address-point
	 * and interpolation databases of the tree's US state.
	 *
	 * An interpolation calibration in `opts` wins, then the interpolation database's own
	 * header value, then the session's `interpCalibration`, then the per-state table.
	 */
	resolveTree(tree: AddressTree, opts?: ResolveOpts): Promise<AddressTree>

	/**
	 * Closes the handles the session opened and releases its lease, leaving a process scope's services loaded.
	 */
	[Symbol.asyncDispose](): Promise<void>
}

/**
 * A process scope holding the classifier and resolver module that sessions with these options share.
 *
 * A caller that builds several sessions over the process's life, such as a server reloading its data,
 * passes the scope to each {@link createGeocodeSession}, and disposes the scope after the last session.
 */
export function createGeocodeProcessScope(
	options: Pick<GeocodeSessionOptions, "locale" | "dataRoot" | "weightsCacheRoot">
): ServiceRegistry {
	const scope = new ServiceRegistry()

	registerProcessServices(scope, options)

	return scope
}

function parseBiasPoints(raw: string | null): NonNullable<GeocodeDeps["bias"]> {
	return TextSpliterator.from(raw ?? "", { delimiter: ";" })
		.map((part) => {
			const [coords, w] = part.split(":")
			const [lat, lon] = coords!.split(",").map(Number)

			if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new CommandError(`--bias: bad point '${part}'`)

			return { lat: lat!, lon: lon!, ...(w ? { weight: Number(w) } : {}) }
		})
		.toArray()
}

/**
 * Builds the gazetteer, neural model and optional layers for one data generation.
 *
 * Returns a {@linkcode GeocodeSession} that reuses them across inputs.
 * The services build in parallel, each once its own inputs resolve.
 *
 * When one fails, the session disposes every service that did open and rethrows that failure.
 */
export async function createGeocodeSession(
	options: GeocodeSessionOptions,
	scope: GeocodeSessionScope = {}
): Promise<GeocodeSession> {
	const initStartedAt = performance.now()
	const progress = options.onProgress ?? (() => {})
	const timings: ServiceTimings = {}

	// Each registration skips a service the parent scope provides.
	// A session without a parent therefore owns its classifier, and its one registry holds both scopes.
	const registry = scope.parent ? scope.parent.createChild() : new ServiceRegistry()

	recordServiceTimings(registry, timings)
	registerProcessServices(registry, options)
	registerGenerationServices(registry, options, scope.layers ?? NODE_LAYER_CONTRIBUTIONS)

	progress("Loading the gazetteer, neural model and data layers…")

	let services: GeocodeSessionServices
	let bias: NonNullable<GeocodeDeps["bias"]>

	try {
		services = await resolveGenerationServices(registry)
		bias = parseBiasPoints(options.bias ?? null)
	} catch (error) {
		// The caller needs the construction failure, so a failure to close a half-built scope doesn't replace it.
		await registry[Symbol.asyncDispose]().catch(() => {})

		throw error
	}

	const { routed, parsePriors, lookup, capitals, regionDatabases, explicitAddressPoints, explicitInterpolation } =
		services

	const {
		designation: designationRoute,
		soil: soilRoute,
		coastal: coastalRoute,
		zoning: zoningRoute,
	} = services.layerRoutes

	const { placer, osm: osmProvider, classifyKind: poiKindClassifier } = services
	const forkEntityDeps = services.forkEntity.deps
	const classifier = routed.primary
	const { priors, artifacts: priorArtifacts } = parsePriors
	const { fst, streetMorphology, anchorRegions } = priors
	const localeRegion = options.locale.split("-")[1]?.toUpperCase() ?? null
	const venueHeadCountry = options.defaultCountry ?? localeRegion

	const decoderSettings: GeocodeDecoderSettingDeps = {
		pairPriorWordPieces: options.pairPriorWordPieces,
		pairPriorChildPostcodeStrip: options.pairPriorChildPostcodeStrip,
		pairIndexOwnCountry: options.pairIndexOwnCountry,
		fstCountryRouting: options.fstCountryRouting,
	}

	// The caller states the parse's country by a default country, or by choosing a locale other than the default.
	const declaredCountry =
		options.defaultCountry ??
		(options.locale.toLowerCase() === GEOCODE_DEFAULT_LOCALE.toLowerCase() ? null : localeRegion)

	if (declaredCountry) {
		decoderSettings.parseCountry = declaredCountry
	}

	if (fst && decoderSettings.fstCountryRouting) {
		decoderSettings.fstForCountry = createCountryFSTLookup({
			primaryCountry: localeRegion,
			primaryFST: fst,
			fstPathFor: (country) =>
				shippedGazetteerFSTPath(country, options.dataRoot, services.selection.catalog, options.weightsCacheRoot),
		})
	}

	const venueHead = priors.venueHeadFor(venueHeadCountry)
	const resolver = createWOFResolver(lookup)
	const { nationalDatabases } = services

	const unavailable = unavailableLayers(registry).map(({ layer, error }) => ({
		layer,
		reason: error instanceof Error ? error.message : String(error),
	}))

	for (const { layer, reason } of unavailable) {
		console.error(`  unavailable: ${layer}, because ${reason}`)
	}

	const capitalLevel = capitals
		? (place: { name: string; country: string | null; lat: number; lon: number }): number =>
				capitals.levelOfPlace(place.name, place.country, place.lat, place.lon)
		: null

	const formerDivisionLookup = options.formerDivisions
		? await import("@mailwoman/resolver-wof-sqlite/former-divisions").then((module) =>
				module.readFormerDivisionLookup(options.formerDivisionsTable)
			)
		: null

	const databases: RegionDatabaseResolver =
		explicitAddressPoints || explicitInterpolation
			? (slug) => {
					const base = explicitAddressPoints && explicitInterpolation ? {} : regionDatabases.for(slug)

					return {
						addressPoints: explicitAddressPoints ?? base.addressPoints,
						interpolation: explicitInterpolation ?? base.interpolation,
					}
				}
			: regionDatabases.for

	const initializedAt = performance.now()
	progress("Ready; geocoding…")

	const initTiming: PipelineTiming = { ...timings, total: initializedAt - initStartedAt }

	const parseDeps: Pick<
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
		| "channelPins"
	> &
		GeocodeDecoderSettingDeps = {
		...decoderSettings,
		classifier: routed,
		...(fst ? { fst } : {}),
		...(streetMorphology ? { streetMorphology } : {}),
		...(anchorRegions ? { anchorRegions } : {}),
		...(options.channelPins ? { channelPins: options.channelPins } : {}),
		streetMorphologyPrior: options.streetMorphologyPrior,
		...(venueHead
			? {
					venueHead,
					venueHeadOpts: {
						...priors.venueHeadOptsFor(venueHeadCountry),
						...(options.venueHeadBiasScale ? { biasScale: options.venueHeadBiasScale } : {}),
					},
				}
			: {}),
	}

	const traceOf = async (
		input: string,
		requestParseDeps: typeof parseDeps
	): Promise<Omit<GeocodeTrace, "resolver"> | null> => {
		if (!options.trace) return null

		const inputs = geocodeParseInputs(input, requestParseDeps)

		try {
			return {
				parse: await routed.traceParse(inputs.parseInput, inputs.opts),
				queryShape: inputs.queryShape,
				kind: inputs.kind,
				inputMode: inputs.inputMode,
			}
		} catch {
			return null
		}
	}

	const geocode = async (input: string, request: GeocodeRequestOptions = {}): Promise<GeocodeRun> => {
		const startedAt = performance.now()
		const requestParseDeps = request.inputMode ? { ...parseDeps, inputMode: request.inputMode } : parseDeps
		const requestBias = request.bias?.length ? request.bias : bias

		const parsedTree = await parseForGeocode(input, requestParseDeps)
		const parsedAt = performance.now()
		const trace = await traceOf(input, requestParseDeps)
		const tracedAt = performance.now()

		const resolverTrace: ResolveNodeTrace[] = []

		const routedAway = (await routed.forInput(input)) !== routed.primary

		// A request's country takes the place of the session's default country for this input.
		const scopeOptions = request.defaultCountry ? { ...options, defaultCountry: request.defaultCountry } : options
		const countryScope = routedAway && !scopeOptions.defaultCountry ? null : resolverDefaultCountry(scopeOptions)
		const localeCountry = countryScope?.country ?? null

		const barePostcodeFormatConflict = (): boolean => {
			if (!isBarePostcodeTree(parsedTree)) return false
			const inferred = localeCountry

			if (!inferred) return false
			const postcodeValue = firstNodeWhere(parsedTree.roots, (node) => node.tag === "postcode")?.value ?? null

			const implied = countriesFromPostcodeFormat(postcodeValue)

			return implied.length > 0 && !implied.includes(inferred)
		}

		// Only an inferred scope is ever withheld, and the reason found here is the one the run states.
		const withheldReason =
			countryScope?.source !== "inferred"
				? null
				: isBareLocalityTree(parsedTree)
					? ScopeWithheldReason.BareLocality
					: barePostcodeFormatConflict()
						? ScopeWithheldReason.BarePostcodeFormatConflict
						: null

		const withheldBySession =
			countryScope && withheldReason ? { country: countryScope.country, reason: withheldReason } : null

		const inferredScopeOK = withheldReason == null
		const withheldCountry = inferredScopeOK ? null : localeCountry

		// A withheld locale country stays a soft scope under either prior.
		const softScope: DefaultCountry | null =
			withheldCountry && (options.localeCountryPrior || options.scopeCountryRetrieval)
				? { country: withheldCountry, source: "inferred", strength: ScopeStrength.Soft }
				: null

		const resolverScope = inferredScopeOK && countryScope ? countryScope : softScope
		const parentPlace = request.parentPlace ?? options.parentPlace

		// The resolver's scope is recorded as `geocodeAddress` reports it, since that function may still drop it.
		let appliedScope: GeocodeApplied["countryScope"] = null

		const result = await geocodeAddress(input, {
			countryScopeSink: ({ resolver: given, dropped }) => {
				appliedScope = {
					resolver: given ? { ...given, strength: given.strength ?? ScopeStrength.Hard } : null,
					withheld:
						withheldBySession ??
						(dropped ? { country: dropped.country, reason: ScopeWithheldReason.ContradictingEvidence } : null),
				}
			},
			...decoderSettings,
			classifier: routed,
			...(request.inputMode ? { inputMode: request.inputMode } : {}),
			...(fst ? { fst } : {}),
			...(streetMorphology ? { streetMorphology } : {}),
			...(anchorRegions ? { anchorRegions } : {}),
			resolver,
			databases,
			nationalDatabases,
			...(osmProvider ? { osmDatabases: osmProvider.for } : {}),
			parsedTree,
			...(requestBias.length ? { bias: requestBias } : {}),
			...(resolverScope ? { defaultCountry: resolverScope } : {}),
			...(parentPlace ? { parentPlace } : {}),

			...(capitalLevel ? { capitalLevel } : {}),

			...(localeCountry ? { fuzzyCountryScope: localeCountry } : {}),

			postcodeCountryCoherence: options.postcodeCountryCoherence,
			postcodeShapeCoherence: options.postcodeShapeCoherence,
			postcodeContainmentCoherence: options.postcodeContainmentCoherence,
			adminContainmentRerank: options.adminContainmentRerank,
			dependentLocalityContainment: options.dependentLocalityContainment,
			countyDesignatorFallback: options.countyDesignatorFallback,
			formerDivisions: options.formerDivisions,
			...(formerDivisionLookup ? { formerDivisionLookup } : {}),
			scopeCountryRetrieval: options.scopeCountryRetrieval,
			siblingLocalityContainment: options.siblingLocalityContainment,

			interpCalibration: options.interpCalibration ?? INTERP_RADIUS_CALIBRATION,

			placeCountry: placer ? (t: string) => placer.predict(t) : "none",

			classifyKind: poiKindClassifier,
			...forkEntityDeps,

			poiVenueTier: options.poiVenueTier,

			...(designationRoute ? { authorityDesignationRoute: designationRoute } : {}),

			...(soilRoute ? { soilCapabilityRoute: soilRoute } : {}),

			...(coastalRoute ? { coastalErosionRoute: coastalRoute } : {}),

			...(zoningRoute ? { zoningDesignationRoute: zoningRoute } : {}),
			...(trace ? { resolveTraceSink: (record) => resolverTrace.push(record) } : {}),
			diagnoseUnreachable: !!trace && options.diagnoseUnreachable,
		})

		const finishedAt = performance.now()

		return {
			result,
			tree: parsedTree,
			applied: { locale: { locale: options.locale, source: options.localeSource }, countryScope: appliedScope },
			timing: {
				parse: parsedAt - startedAt,

				...(options.trace ? { trace: tracedAt - parsedAt } : {}),
				resolve: finishedAt - tracedAt,
				total: finishedAt - startedAt,
			},
			...(trace ? { trace: { ...trace, resolver: resolverTrace } } : {}),
		}
	}

	const defaultScope = resolverDefaultCountry(options)

	const resolveTree = (tree: AddressTree, incoming: ResolveOpts = {}): Promise<AddressTree> => {
		const slug = regionSlugFromTree(tree)
		const { addressPoints, interpolation } = databases(slug)
		const defaultCountry = incoming.defaultCountry ?? defaultScope

		const calibration =
			incoming.interpolationRadiusCalibration == null && interpolation?.radiusCalibration == null
				? (options.interpCalibration ?? interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, slug))
				: null

		return resolver.resolveTree(tree, {
			...incoming,
			...(defaultCountry ? { defaultCountry } : {}),
			...(addressPoints ? { addressPoints } : {}),
			...(interpolation ? { interpolation } : {}),
			...(interpolation && calibration != null ? { interpolationRadiusCalibration: calibration } : {}),
		})
	}

	return {
		initTiming,
		unavailableLayers: unavailable,
		services,

		artifacts: {
			...(fst && priorArtifacts.fstPath ? { fstPath: priorArtifacts.fstPath } : {}),
			...(streetMorphology && priorArtifacts.streetMorphologyPath
				? { streetMorphologyPath: priorArtifacts.streetMorphologyPath }
				: {}),
			...(classifier.resolvedWeights ? { weights: classifier.resolvedWeights } : {}),
			...(Object.keys(classifier.lexiconPaths).length ? { lexicons: { ...classifier.lexiconPaths } } : {}),
		},
		geocode,
		resolveTree,
		[Symbol.asyncDispose]: () => registry[Symbol.asyncDispose](),
	}
}
