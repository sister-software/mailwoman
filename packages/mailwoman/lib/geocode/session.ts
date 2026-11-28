// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A geocode session: the services `#geocode/session/services` builds for one set
 *   of options, and the operations that read them for each address.
 *
 *   The CLI, the API server and the evaluation tools geocode through this one session.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { GeocodeResult } from "@mailwoman/core/geocode"
import {
	createRequestContext,
	type InputModeSelection,
	type InputMode,
	type PipelineFault,
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
import { hasOutcomeOptions, type OutcomeOptions } from "@mailwoman/core/resolver/outcome"
import { CommandError } from "@mailwoman/core/scripting/command"
import { OUTCOME_VOCABULARY } from "@mailwoman/gazetteer/whosonfirst/outcomes/vocabulary"
import type { NeuralParseTrace } from "@mailwoman/neural"
import type { QueryShape } from "@mailwoman/postcode/recognizer/query-shape"
import { createWOFResolver } from "@mailwoman/resolver"
import { ServiceRegistry } from "async-init"
import type { PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import { geocodeAddress, parseForGeocode, type GeocodeDecoderSettingDeps, type GeocodeDeps } from "#geocode/core"
import type { LayerContribution } from "#geocode/layers/contributions"
import { shippedGazetteerFSTPath } from "#geocode/layers/fst"
import { type RegionDatabaseResolver, regionSubdivisionOfTree } from "#geocode/layers/regions"
import { GEOCODE_DEFAULT_LOCALE, type GeocodeSessionOptions, type SessionOptionSource } from "#geocode/options"
import { createCountryFSTLookup } from "#geocode/parse-priors"
import { resolverDefaultCountry } from "#geocode/scope/country"
import type { CountryScopeDecision } from "#geocode/scope/inferred"
import {
	registerGenerationServices,
	registerProcessServices,
	resolveGenerationServices,
	unavailableLayers,
} from "#geocode/session/services"
import type { DecodeRecord, GeocodeStageRecord } from "#geocode/stages"
import { NODE_LAYER_CONTRIBUTIONS } from "#services/entry/node"
import { recordServiceTimings, type ServiceTimings } from "#services/timings"
import { INTERP_RADIUS_CALIBRATION, interpCalibrationForRegion } from "#street/interp-calibration"

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

	/**
	 * The records the request's stages wrote, in the order they ran, without the decode's.
	 *
	 * The decode's record is {@link parse}, {@link queryShape}, {@link kind} and {@link inputMode}.
	 *
	 * - A `tree-rewrite` record states what a pass after the decode changed in the tree,
	 *   so {@link parse} and the resolved tree can be told apart.
	 * - A `country-scope` record states the scope a resolve pass ran under.
	 * - A `rooftop-selection` record states the address-point source of each resolve
	 *   of a pass, and why a second resolve ran.
	 */
	stages: Exclude<GeocodeStageRecord, DecodeRecord>[]

	/**
	 * The milliseconds of each stage the request ran, keyed by stage identifier.
	 */
	stageTiming: PipelineTiming
}

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
		 * The locale's country, when the address's own evidence kept it from filtering.
		 *
		 * {@linkcode resolver} is then a soft scope standing in for it, or null.
		 */
		withheld: CountryScopeDecision["withheld"]
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
	 * Wall-clock milliseconds for `parse`, `resolve` and `total`.
	 *
	 * A tracing session's `parse` includes the work of building the decode's trace.
	 */
	timing: PipelineTiming

	/**
	 * Every failure the geocode caught and answered past, in order.
	 *
	 * The array is always present, and an empty one states that the run degraded past zero failures.
	 * A `decode-trace` fault states that the decode's trace couldn't be built:
	 * the answer is the one an untraced run gives, and {@link trace} is absent.
	 */
	faults: PipelineFault[]

	/**
	 * The debug evidence, present only when the session traces and the classifier traced its decode.
	 */
	trace?: GeocodeTrace
}

/**
 * The settings one request may set on top of its session's.
 */
export interface GeocodeRequestOptions extends OutcomeOptions {
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

	/**
	 * The country the typo-fuzzy tier scopes its matches to, in place of the country scope's country.
	 */
	fuzzyCountryScope?: string

	/**
	 * Cancels the request.
	 *
	 * The geocode rejects with the signal's reason before its next stage starts,
	 * and a running stage finishes first.
	 */
	signal?: AbortSignal
}

/**
 * The services a session resolved for its data generation, as `resolveGenerationServices` returns them.
 */
export type GeocodeSessionServices = Awaited<ReturnType<typeof resolveGenerationServices>>

/**
 * What a session's parse reads: its routed classifier, the loaded priors and the decoder settings.
 */
export type GeocodeSessionParseDeps = Pick<
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
	GeocodeDecoderSettingDeps & { classifier: GeocodeSessionServices["routed"] }

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

	/**
	 * The dependencies each geocode's parse reads, for a diagnostic that decodes
	 * an input as the session would.
	 */
	readonly parseDeps: Readonly<GeocodeSessionParseDeps>
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

/**
 * The geocode deps of a request's outcome fields and the head's opt-in order, or none
 * when neither applies, so a request without them geocodes exactly as before.
 */
function outcomeDepsOf(
	request: OutcomeOptions,
	options: Pick<GeocodeSessionOptions, "outcomeHeadOrdering">
): Pick<GeocodeDeps, "outcome" | "outcomeVocabulary" | "outcomeHeadOrdering"> {
	const requested = hasOutcomeOptions(request)

	if (!requested && !options.outcomeHeadOrdering) return {}

	return {
		...(requested
			? {
					outcome: {
						...(request.outcomeHint != null ? { outcomeHint: request.outcomeHint } : {}),
						...(request.outcomeFilter ? { outcomeFilter: request.outcomeFilter } : {}),
					},
				}
			: {}),
		outcomeVocabulary: OUTCOME_VOCABULARY,
		outcomeHeadOrdering: options.outcomeHeadOrdering,
	}
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

	const { placeCountry, osm: osmProvider, classifyKind: poiKindClassifier } = services
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

	const formerDivisionLookup = services.formerDivisions

	const databases: RegionDatabaseResolver =
		explicitAddressPoints || explicitInterpolation
			? (subdivision) => {
					const base = explicitAddressPoints && explicitInterpolation ? {} : regionDatabases.for(subdivision)

					return {
						addressPoints: explicitAddressPoints ?? base.addressPoints,
						interpolation: explicitInterpolation ?? base.interpolation,
					}
				}
			: regionDatabases.for

	const initializedAt = performance.now()
	progress("Ready; geocoding…")

	const initTiming: PipelineTiming = { ...timings, total: initializedAt - initStartedAt }

	const parseDeps: GeocodeSessionParseDeps = {
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

	const geocode = async (input: string, request: GeocodeRequestOptions = {}): Promise<GeocodeRun> => {
		const startedAt = performance.now()
		const requestParseDeps = request.inputMode ? { ...parseDeps, inputMode: request.inputMode } : parseDeps
		const requestBias = request.bias?.length ? request.bias : bias
		const stageRecords: GeocodeTrace["stages"] = []
		let decode: DecodeRecord | null = null

		// `geocodeAddress` decides whether the scope filters, ranks or is withheld, and the run states its decision.
		let appliedScope: GeocodeApplied["countryScope"] = null

		// Every request reads the scope decision off the trace, and only a tracing session keeps the other records.
		const context = createRequestContext<GeocodeStageRecord>({
			signal: request.signal ?? null,
			detail: options.trace,
			trace: (record) => {
				if (record.kind === "country-scope") {
					const { resolver: given, withheld } = record

					appliedScope = {
						resolver: given ? { ...given, strength: given.strength ?? ScopeStrength.Hard } : null,
						withheld,
					}
				}

				if (!options.trace) return

				if (record.kind === "decode") {
					decode = record
				} else {
					stageRecords.push(record)
				}
			},
		})

		const parsedTree = await parseForGeocode(input, requestParseDeps, context)
		const parsedAt = performance.now()

		// The decode that built `parsedTree` wrote its own trace, so the trace and the tree come from one decode.
		const trace = decode as DecodeRecord | null

		const resolverTrace: ResolveNodeTrace[] = []

		const routedAway = (await routed.forInput(input)) !== routed.primary

		// A request's country takes the place of the session's default country for this input.
		const scopeOptions = request.defaultCountry ? { ...options, defaultCountry: request.defaultCountry } : options
		const countryScope = routedAway && !scopeOptions.defaultCountry ? null : resolverDefaultCountry(scopeOptions)
		const fuzzyCountryScope = request.fuzzyCountryScope ?? countryScope?.country ?? null

		const parentPlace = request.parentPlace ?? options.parentPlace

		const result = await geocodeAddress(
			input,
			{
				localeCountryPrior: options.localeCountryPrior,
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
				...(countryScope ? { defaultCountry: countryScope } : {}),
				...(parentPlace ? { parentPlace } : {}),

				...(capitalLevel ? { capitalLevel } : {}),

				...(fuzzyCountryScope ? { fuzzyCountryScope } : {}),

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

				placeCountry: placeCountry ?? "none",

				classifyKind: poiKindClassifier,
				...forkEntityDeps,

				poiVenueTier: options.poiVenueTier,
				...(options.spanRescoreWeakResolution ? { spanRescoreWeakResolution: options.spanRescoreWeakResolution } : {}),

				...(designationRoute ? { authorityDesignationRoute: designationRoute } : {}),

				...(soilRoute ? { soilCapabilityRoute: soilRoute } : {}),

				...(coastalRoute ? { coastalErosionRoute: coastalRoute } : {}),

				...(zoningRoute ? { zoningDesignationRoute: zoningRoute } : {}),
				...(trace ? { resolveTraceSink: (record) => resolverTrace.push(record) } : {}),
				diagnoseUnreachable: !!trace && options.diagnoseUnreachable,

				...outcomeDepsOf(request, options),
			},
			context
		)

		const finishedAt = performance.now()

		return {
			result,
			tree: parsedTree,
			applied: { locale: { locale: options.locale, source: options.localeSource }, countryScope: appliedScope },
			timing: {
				parse: parsedAt - startedAt,
				resolve: finishedAt - parsedAt,
				total: finishedAt - startedAt,
			},
			faults: context.faults,
			...(trace
				? {
						trace: {
							parse: trace.parse,
							queryShape: trace.queryShape,
							kind: trace.queryKind,
							inputMode: trace.inputMode,
							resolver: resolverTrace,
							stages: stageRecords,
							stageTiming: context.timing,
						},
					}
				: {}),
		}
	}

	const defaultScope = resolverDefaultCountry(options)

	const resolveTree = (tree: AddressTree, incoming: ResolveOpts = {}): Promise<AddressTree> => {
		const subdivision = regionSubdivisionOfTree(tree)
		const { addressPoints, interpolation } = databases(subdivision)
		const defaultCountry = incoming.defaultCountry ?? defaultScope

		const calibration =
			incoming.interpolationRadiusCalibration == null && interpolation?.radiusCalibration == null
				? (options.interpCalibration ?? interpCalibrationForRegion(INTERP_RADIUS_CALIBRATION, subdivision))
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
		parseDeps,

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
