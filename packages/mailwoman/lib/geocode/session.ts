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
import type { GeocodeResult, VariantAliasExemption } from "@mailwoman/core/geocode"
import {
	type ChannelPins,
	type InputModeSelection,
	isBareLocalityTree,
	isBarePostcodeTree,
	type InputMode,
	type PipelineTiming,
	type QueryKindResult,
	type SoftChannelName,
} from "@mailwoman/core/pipeline"
import type { ResolveNodeTrace, ResolveOpts } from "@mailwoman/core/resolver"
import { CommandError } from "@mailwoman/core/scripting/command"
import type { NeuralParseTrace } from "@mailwoman/neural"
import { countriesFromPostcodeFormat } from "@mailwoman/postcode/postcode-format"
import type { QueryShape } from "@mailwoman/query-shape"
import { createWOFResolver } from "@mailwoman/resolver"
import { ServiceRegistry } from "async-init"
import type { PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import { resolverDefaultCountry } from "#country-scope"
import {
	GEOCODE_SWITCH_DEFAULTS,
	geocodeAddress,
	geocodeParseInputs,
	parseForGeocode,
	type GeocodeDeps,
} from "#geocode/core"
import { type RegionDatabaseResolver, regionSlugFromTree } from "#geocode/regions"
import {
	nationalDatabasesOf,
	registerGenerationServices,
	registerProcessServices,
	resolveGenerationServices,
	type ServiceTimings,
} from "#geocode/services"
import { INTERP_RADIUS_CALIBRATION, interpCalibrationForRegion } from "#interp-calibration"
import type { CapitalTier } from "#resolver-backend"

/**
 * The session settings that have a default, resolved once by {@link geocodeSessionSettings}.
 */
export interface GeocodeSessionSettings {
	gazetteerPrior: boolean
	venueHeadPrior: boolean
	streetMorphologyPrior: boolean
	capitalTier: CapitalTier
	variantAliasExemption: VariantAliasExemption
}

/**
 * The defaults behind every unset {@link GeocodeSessionSettings} key.
 */
export const GEOCODE_SESSION_DEFAULTS: Readonly<GeocodeSessionSettings> = {
	gazetteerPrior: true,
	venueHeadPrior: true,
	streetMorphologyPrior: true,
	capitalTier: "auto",
	variantAliasExemption: "applied",
}

/**
 * Fills each unset session setting from {@link GEOCODE_SESSION_DEFAULTS}.
 */
export function geocodeSessionSettings(options: Partial<GeocodeSessionSettings>): GeocodeSessionSettings {
	return {
		gazetteerPrior: options.gazetteerPrior ?? GEOCODE_SESSION_DEFAULTS.gazetteerPrior,
		venueHeadPrior: options.venueHeadPrior ?? GEOCODE_SESSION_DEFAULTS.venueHeadPrior,
		streetMorphologyPrior: options.streetMorphologyPrior ?? GEOCODE_SESSION_DEFAULTS.streetMorphologyPrior,
		capitalTier: options.capitalTier ?? GEOCODE_SESSION_DEFAULTS.capitalTier,
		variantAliasExemption: options.variantAliasExemption ?? GEOCODE_SESSION_DEFAULTS.variantAliasExemption,
	}
}

/**
 * The parsed geocode command options that a session reads, structural
 * so this module doesn't import the CLI specification.
 */
export interface GeocodeSessionOptions {
	/**
	 * Whether to feed the gazetteer FST prior to the parse.
	 *
	 * @defaultValue {@linkcode GEOCODE_SESSION_DEFAULTS}
	 */
	gazetteerPrior?: boolean
	/**
	 * Whether to feed the venue-head prior to the parse, using the head words of the
	 * default country, or of the locale's country when no default country is set.
	 *
	 * @defaultValue {@linkcode GEOCODE_SESSION_DEFAULTS}
	 */
	venueHeadPrior?: boolean
	/**
	 * Multiplier on the venue-head table's biases.
	 * Each bias is a log rate ratio.
	 *
	 * @defaultValue `1`
	 */
	venueHeadBiasScale?: number
	/**
	 * Whether the street-morphology matcher biases a street affix on a segment that opens
	 * with a house number, as `Plaza` in `30 Rockefeller Plaza, New York, NY 10112`.
	 *
	 * @defaultValue {@linkcode GEOCODE_SESSION_DEFAULTS}
	 */
	streetMorphologyPrior?: boolean
	locale: string

	/**
	 * An npm `--prefix` cache root to load weights from instead of the installed package. session
	 * creation fails when this root lacks the locale's package because it never falls back.
	 */
	weightsCacheRoot?: string
	bias?: string
	defaultCountry?: string
	countryScope: "auto" | "locale" | "none"
	resolveDB?: string
	candidateDB?: string
	dataRoot: PathBuilderLike
	addressPointsDB?: string
	interpolationDB?: string
	interpCalibration?: number
	localeCountryPrior: boolean
	placeCountry: boolean
	postcodeCountryCoherence: boolean
	forkEntity: boolean

	/**
	 * Whether to enable the venue tier for `poi.db` entity upgrades, where only `true` enables it.
	 */
	poiVenueTier?: boolean

	/**
	 * The national-capital promotion among same-name candidates for a bare place name.
	 *
	 * @defaultValue {@linkcode GEOCODE_SESSION_DEFAULTS}; see {@link CapitalTier}.
	 */
	capitalTier?: CapitalTier

	/**
	 * Whether own-name `variant` aliases skip the cross-country primary-name penalty,
	 * affecting only the candidate backend and requiring the `name_role` column.
	 *
	 * @defaultValue {@linkcode GEOCODE_SESSION_DEFAULTS}
	 */
	variantAliasExemption?: VariantAliasExemption
	postcodeShapeCoherence: boolean
	postcodeContainmentCoherence: boolean

	/**
	 * Whether a parsed region re-ranks locality candidates by admin containment.
	 *
	 * @defaultValue {@linkcode GEOCODE_SWITCH_DEFAULTS}
	 */
	adminContainmentRerank?: boolean

	/**
	 * Whether a parsed dependent locality resolves inside its parent and answers the coordinate.
	 *
	 * @defaultValue {@linkcode GEOCODE_SWITCH_DEFAULTS}
	 */
	dependentLocalityContainment?: boolean

	placeCountryThreshold: number

	/**
	 * Whether to record a {@link GeocodeTrace} per input.
	 * This setting costs one extra decode per input.
	 */
	trace?: boolean

	/**
	 * Whether a lookup that resolves no candidate re-probes the value in the other admin bands,
	 * leaving the result unchanged and requiring {@link trace}.
	 */
	diagnoseUnreachable?: boolean

	/**
	 * Per-channel feed pins for the classifier's soft-feature channels, for a diagnostic session.
	 *
	 * A channel pinned `off` is fed zeros in place of its built features.
	 * Unset feeds every channel as built, as every production session does.
	 */
	channelPins?: ChannelPins

	/**
	 * Receives initialization progress messages.
	 */
	onProgress?: (message: string) => void
}

/**
 * The per-stage evidence behind one geocode, rendered by the `--debug` view
 * and built only when {@link GeocodeSessionOptions.trace} is set.
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
	 * The session's configured locale.
	 */
	locale: string

	/**
	 * One record per backend lookup that the resolver performed.
	 */
	resolver: ResolveNodeTrace[]
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
}

/**
 * The scopes a session builds from.
 */
export interface GeocodeSessionScope {
	/**
	 * A process scope from {@link createGeocodeProcessScope}, which the session
	 * reads its classifier and resolver module from.
	 *
	 * The session then disposes only its own generation services and leaves the scope's services loaded.
	 *
	 * Absent, the session builds its own process services and disposes them with itself.
	 */
	process?: ServiceRegistry
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
	const settings = geocodeSessionSettings(options)
	const timings: ServiceTimings = {}

	// A session without a process scope owns its classifier, so its one registry holds both scopes.
	const registry = scope.process ? scope.process.createChild() : new ServiceRegistry()

	if (!scope.process) {
		registerProcessServices(registry, options, timings)
	}

	registerGenerationServices(registry, options, settings, timings)

	progress("Loading the gazetteer, neural model and data layers…")

	let services: Awaited<ReturnType<typeof resolveGenerationServices>>
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
	const venueHeadCountry = options.defaultCountry ?? options.locale.split("-")[1] ?? null
	const venueHead = priors.venueHeadFor(venueHeadCountry)
	const resolver = createWOFResolver(lookup)
	const nationalDatabases = nationalDatabasesOf(services.ban, services.overture)

	const capitalLevel = capitals
		? (place: { name: string; country: string | null; lat: number; lon: number }): number =>
				capitals.levelOfPlace(place.name, place.country, place.lat, place.lon)
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
	> = {
		classifier: routed,
		...(fst ? { fst } : {}),
		...(streetMorphology ? { streetMorphology } : {}),
		...(anchorRegions ? { anchorRegions } : {}),
		...(options.channelPins ? { channelPins: options.channelPins } : {}),
		streetMorphologyPrior: settings.streetMorphologyPrior,
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
				locale: options.locale,
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

		const countryScope = routedAway && !options.defaultCountry ? null : resolverDefaultCountry(options)
		const localeCountry = countryScope?.country ?? null

		const barePostcodeFormatConflict = (): boolean => {
			if (!isBarePostcodeTree(parsedTree)) return false
			const inferred = localeCountry

			if (!inferred) return false
			const postcodeValue = firstNodeWhere(parsedTree.roots, (node) => node.tag === "postcode")?.value ?? null

			const implied = countriesFromPostcodeFormat(postcodeValue)

			return implied.length > 0 && !implied.includes(inferred)
		}

		const inferredScopeOK =
			countryScope?.source === "caller" || (!isBareLocalityTree(parsedTree) && !barePostcodeFormatConflict())

		const withheldCountry = inferredScopeOK ? null : localeCountry

		const result = await geocodeAddress(input, {
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
			...(inferredScopeOK && countryScope ? { defaultCountry: countryScope } : {}),
			...(options.localeCountryPrior && withheldCountry ? { localeCountryPrior: withheldCountry } : {}),

			...(capitalLevel ? { capitalLevel } : {}),

			...(localeCountry ? { fuzzyCountryScope: localeCountry } : {}),

			postcodeCountryCoherence: options.postcodeCountryCoherence,
			postcodeShapeCoherence: options.postcodeShapeCoherence,
			postcodeContainmentCoherence: options.postcodeContainmentCoherence,
			adminContainmentRerank: options.adminContainmentRerank ?? GEOCODE_SWITCH_DEFAULTS.adminContainmentRerank,
			dependentLocalityContainment:
				options.dependentLocalityContainment ?? GEOCODE_SWITCH_DEFAULTS.dependentLocalityContainment,

			interpCalibration: options.interpCalibration ?? INTERP_RADIUS_CALIBRATION,

			placeCountry: placer ? (t: string) => placer.predict(t) : "none",

			classifyKind: poiKindClassifier,
			...forkEntityDeps,

			poiVenueTier: options.poiVenueTier ?? GEOCODE_SWITCH_DEFAULTS.poiVenueTier,

			...(designationRoute ? { authorityDesignationRoute: designationRoute } : {}),

			...(soilRoute ? { soilCapabilityRoute: soilRoute } : {}),

			...(coastalRoute ? { coastalErosionRoute: coastalRoute } : {}),

			...(zoningRoute ? { zoningDesignationRoute: zoningRoute } : {}),
			...(trace ? { resolveTraceSink: (record) => resolverTrace.push(record) } : {}),
			diagnoseUnreachable: !!trace && (options.diagnoseUnreachable ?? GEOCODE_SWITCH_DEFAULTS.diagnoseUnreachable),
		})

		const finishedAt = performance.now()

		return {
			result,
			tree: parsedTree,
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
