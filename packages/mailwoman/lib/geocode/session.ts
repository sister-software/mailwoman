/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { CoarsePlacer } from "@mailwoman/core/coarse-placer"
import type { AddressTree } from "@mailwoman/core/decoder"
import { firstNodeWhere } from "@mailwoman/core/decoder"
import { readLocalBuffer, pathExists } from "@mailwoman/core/fs/readers"
import type { GeocodeResult } from "@mailwoman/core/geocode"
import {
	isBareLocalityTree,
	isBarePostcodeTree,
	type InputMode,
	type PipelineTiming,
	type QueryKindResult,
	type FSTMatcherLike,
} from "@mailwoman/core/pipeline"
import {
	type RegionDatabaseProvider,
	type RegionDatabases,
	type ResolveNodeTrace,
	type Resolver,
	countriesFromPostcodeFormat,
} from "@mailwoman/core/resolver"
import { CommandError } from "@mailwoman/core/scripting/command"
import { createKindClassifier } from "@mailwoman/kind-classifier"
import { NeuralAddressClassifier, type ScriptRoutedClassifier, type NeuralParseTrace } from "@mailwoman/neural"
import type { QueryShape } from "@mailwoman/query-shape"
import { createWOFResolver } from "@mailwoman/resolver"
import { resolvePath, resolvePathBuilder, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import { resolverDefaultCountry } from "#country-scope"
import {
	GEOCODE_SWITCH_DEFAULTS,
	geocodeAddress,
	geocodeParseInputs,
	parseForGeocode,
	type GeocodeDeps,
} from "#geocode/core"
import { layerDatabasePath } from "#geocode/layer-paths"
import { OvertureNationalDatabaseProvider } from "#geocode/national-overture"
import { type RegionDatabaseResolver, USStateDatabaseProvider } from "#geocode/regions"
import { INTERP_RADIUS_CALIBRATION } from "#interp-calibration"
import type { CoastalErosionRoute } from "#observations/coastal-route"
import type { AuthorityDesignationRoute } from "#observations/flood-route"
import type { SoilCapabilityRoute } from "#observations/soil-route"
import type { ZoningDesignationRoute } from "#observations/zoning-route"
import { poiTaxonomyLookup } from "#poi/intent"
import {
	capitalIndexFor,
	type CapitalTier,
	createResolverBackend,
	existingWOFDatabasePaths,
	resolveCandidateDBPath,
	resolveWOFDatabasePaths,
} from "#resolver-backend"

export type { CapitalTier } from "#resolver-backend"

/**
 * The session settings that have a default, resolved once by {@link geocodeSessionSettings}.
 */
export interface GeocodeSessionSettings {
	gazetteerPrior: boolean
	capitalTier: CapitalTier
	variantAliasExemption: boolean
}

/**
 * The defaults behind every unset {@link GeocodeSessionSettings} key.
 */
export const GEOCODE_SESSION_DEFAULTS: Readonly<GeocodeSessionSettings> = {
	gazetteerPrior: true,
	capitalTier: "auto",
	variantAliasExemption: true,
}

/**
 * Fills each unset session setting from {@link GEOCODE_SESSION_DEFAULTS}.
 */
export function geocodeSessionSettings(options: Partial<GeocodeSessionSettings>): GeocodeSessionSettings {
	return {
		gazetteerPrior: options.gazetteerPrior ?? GEOCODE_SESSION_DEFAULTS.gazetteerPrior,
		capitalTier: options.capitalTier ?? GEOCODE_SESSION_DEFAULTS.capitalTier,
		variantAliasExemption: options.variantAliasExemption ?? GEOCODE_SESSION_DEFAULTS.variantAliasExemption,
	}
}

/**
 * The parsed geocode command options that a session reads, structural
 * so this module does not import the CLI specification.
 */
export interface GeocodeSessionOptions {
	/**
	 * Whether to feed the gazetteer FST prior to the parse.
	 * Defaults to {@link GEOCODE_SESSION_DEFAULTS}.
	 */
	gazetteerPrior?: boolean
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
	 * Defaults to {@link GEOCODE_SESSION_DEFAULTS}; see {@link CapitalTier}.
	 */
	capitalTier?: CapitalTier

	/**
	 * Whether own-name `variant` aliases skip the cross-country primary-name penalty,
	 * affecting only the candidate backend and requiring the `name_role` column.
	 * Defaults to {@link GEOCODE_SESSION_DEFAULTS}.
	 */
	variantAliasExemption?: boolean
	postcodeShapeCoherence: boolean
	postcodeContainmentCoherence: boolean

	/**
	 * Whether a parsed region re-ranks locality candidates by admin containment,
	 * where only `false` disables it.
	 */
	adminContainmentRerank?: boolean

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
 * A geocoder with its models and databases loaded for one set of options,
 * disposable to close its database and layer handles.
 */
export interface GeocodeSession extends Disposable {
	/**
	 * Session construction phases in wall-clock milliseconds.
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
	}
	geocode(input: string): Promise<GeocodeRun>
}

async function resolveWOFPath(options: Pick<GeocodeSessionOptions, "dataRoot" | "resolveDB">): Promise<string[]> {
	const paths = await existingWOFDatabasePaths(resolveWOFDatabasePaths(options.resolveDB, options.dataRoot))

	if (!paths.length) {
		throw new CommandError(
			`geocode found no resolver database under ${options.dataRoot}. Run \`mailwoman data pull candidate\`, ` +
				"set $MAILWOMAN_DATA_ROOT, or pass --candidate-db / --resolve-db."
		)
	}

	return paths
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
 * The fork-to-entity probe's dependencies and the `poi.db` handle to dispose.
 */
export interface ForkEntityProbe {
	deps: Pick<GeocodeDeps, "poiLookup" | "isStreetGeneric">

	/**
	 * The `poi.db` handle behind `deps.poiLookup`, kept separately because
	 * `POIExecutorLookup` declares no disposal.
	 */
	handle?: Disposable
}

/**
 * Opens the authority-designation route from the sealed flood layer in the data root,
 * returning `undefined` when the layer is missing or fails to open.
 */
export async function loadAuthorityDesignationRoute(
	options: Pick<GeocodeSessionOptions, "dataRoot">
): Promise<AuthorityDesignationRoute | null> {
	const floodDBPath = layerDatabasePath(options.dataRoot, "flood")

	if (!(await pathExists(floodDBPath))) return null

	try {
		const { createAuthorityDesignationRoute } = await import("#observations/flood-route")

		return createAuthorityDesignationRoute({ databasePath: floodDBPath })
	} catch {
		return null
	}
}

/**
 * Opens the soil-capability route from the sealed soil layer in the data root,
 * returning `undefined` when the layer is missing or fails to open.
 */
export async function loadSoilCapabilityRoute(
	options: Pick<GeocodeSessionOptions, "dataRoot">
): Promise<SoilCapabilityRoute | null> {
	const soilDBPath = layerDatabasePath(options.dataRoot, "soil")

	if (!(await pathExists(soilDBPath))) return null

	try {
		const { createSoilCapabilityRoute } = await import("#observations/soil-route")

		return createSoilCapabilityRoute({ databasePath: soilDBPath })
	} catch {
		return null
	}
}

/**
 * Opens the coastal-erosion route from the sealed England coastal layer in the data root,
 * returning `undefined` when the layer is missing or fails to open.
 */
export async function loadCoastalErosionRoute(
	options: Pick<GeocodeSessionOptions, "dataRoot">
): Promise<CoastalErosionRoute | null> {
	const coastalDBPath = layerDatabasePath(options.dataRoot, "coastal")

	if (!(await pathExists(coastalDBPath))) return null

	try {
		const { createCoastalErosionRoute } = await import("#observations/coastal-route")

		return createCoastalErosionRoute({ databasePath: coastalDBPath })
	} catch {
		return null
	}
}

/**
 * Opens the zoning route from the sealed Irish zoning layer in the data root,
 * returning `undefined` when the layer is missing or fails to open.
 */
export async function loadZoningDesignationRoute(
	options: Pick<GeocodeSessionOptions, "dataRoot">
): Promise<ZoningDesignationRoute | null> {
	const zoningDBPath = layerDatabasePath(options.dataRoot, "zoning")

	if (!(await pathExists(zoningDBPath))) return null

	try {
		const { createZoningDesignationRoute } = await import("#observations/zoning-route")

		return createZoningDesignationRoute({ databasePath: zoningDBPath })
	} catch {
		return null
	}
}

/**
 * Loads the fork-to-entity probe's POI lookup and street-generic test, neither
 * when `poi.db` is absent or the probe is disabled, because the probe needs the
 * street-generic test to keep street queries from matching venues.
 */
export async function loadForkEntityDeps(
	options: Pick<GeocodeSessionOptions, "dataRoot" | "forkEntity">
): Promise<ForkEntityProbe> {
	const poiDBPath = layerDatabasePath(options.dataRoot, "poi")

	if (options.forkEntity === false || !(await pathExists(poiDBPath))) return { deps: {} }

	const [{ POILookup }, { loadStreetMorphologyFST }] = await Promise.all([
		import("@mailwoman/resolver-wof-sqlite/poi"),
		import("@mailwoman/resolver-wof-sqlite/street"),
	])

	const morphology = await loadStreetMorphologyFST()
	const poiLookup = new POILookup({ databasePath: poiDBPath })

	return {
		deps: {
			poiLookup,
			isStreetGeneric: (token: string) => morphology.matcher.walk([token]) !== null,
		},
		handle: poiLookup,
	}
}

/**
 * Loads the gazetteer, neural model and optional layers.
 *
 * Returns a {@linkcode GeocodeSession} that reuses them across inputs.
 */
export async function createGeocodeSession(options: GeocodeSessionOptions): Promise<GeocodeSession> {
	const initStartedAt = performance.now()
	const progress = options.onProgress ?? (() => {})
	const settings = geocodeSessionSettings(options)

	progress("Checking gazetteer…")

	const candidateDB = await resolveCandidateDBPath(options.candidateDB, options.dataRoot)
	const wofPath = candidateDB ? [] : await resolveWOFPath(options)
	const pathsResolvedAt = performance.now()

	progress("Loading neural model…")

	let routed: ScriptRoutedClassifier<NeuralAddressClassifier>

	try {
		routed = await NeuralAddressClassifier.loadRoutedFromWeights({
			locale: options.locale,
			overlayRoot: resolvePath(options.dataRoot, "weights"),

			...(options.weightsCacheRoot ? { cacheRoot: options.weightsCacheRoot } : {}),
		})
	} catch {
		throw new CommandError(
			"geocode requires the neural weights. Install @mailwoman/neural-weights-en-us (or pass --locale with installed weights)."
		)
	}

	const classifier = routed.primary

	let fst: FSTMatcherLike | null = null
	let streetMorphology: FSTMatcherLike | null = null

	if (settings.gazetteerPrior) {
		const [{ deserializeFST }, { loadStreetMorphologyFST }] = await Promise.all([
			import("@mailwoman/resolver-wof-sqlite/fst"),
			import("@mailwoman/resolver-wof-sqlite/street"),
		])

		const fstPath = classifier.fstPath

		if (fstPath) {
			try {
				fst = deserializeFST(await readLocalBuffer(fstPath))
			} catch (error) {
				console.warn(`[mailwoman] failed to load the gazetteer FST at ${fstPath}: ${(error as Error).message}`)
			}
		}

		if (!fst) {
			console.warn(
				`[mailwoman] --gazetteer-prior was requested for locale ${options.locale} but no FST artifact resolved` +
					`${classifier.fstPath ? ` at ${classifier.fstPath}` : " (the weights package ships none)"} — the gazetteer ` +
					"channel is OFF for this run. Results are the base model's, not the prior's."
			)
		}

		if (fst) {
			try {
				streetMorphology = (
					await loadStreetMorphologyFST({
						...(classifier.streetMorphologyPath ? { artifactPath: classifier.streetMorphologyPath } : {}),
						onWarn: (message) => console.warn(`[mailwoman] ${message}`),
					})
				).matcher
			} catch (error) {
				console.warn(`[mailwoman] street-morphology FST unavailable: ${(error as Error).message} — check off`)
			}
		}
	}

	const weightsLoadedAt = performance.now()

	progress("Opening resolver…")

	let mod: typeof import("@mailwoman/resolver-wof-sqlite")

	try {
		mod = await import("@mailwoman/resolver-wof-sqlite")
	} catch {
		throw new CommandError(
			"geocode requires `@mailwoman/resolver-wof-sqlite` to be installed. " +
				"Run `npm install @mailwoman/resolver-wof-sqlite` and try again."
		)
	}

	const resolverImportedAt = performance.now()

	const lookup = await createResolverBackend(mod, {
		candidateDB,
		dataRoot: options.dataRoot,
		wofPaths: wofPath,
		variantAliasExemption: settings.variantAliasExemption,
	})

	const capitals = await capitalIndexFor(settings.capitalTier, candidateDB)

	const capitalLevel = capitals
		? (place: { name: string; country: string | null; lat: number; lon: number }): number =>
				capitals.levelOfPlace(place.name, place.country, place.lat, place.lon)
		: undefined

	const regionDatabaseProvider = await USStateDatabaseProvider.create(mod, options.dataRoot)

	const explicitApLocale = options.locale.split("-")[1]?.toLowerCase() === "fr" ? ("fr" as const) : ("us" as const)

	const explicitAp = options.addressPointsDB
		? new mod.AddressPointSqliteLookup(options.addressPointsDB, { streetLocale: explicitApLocale })
		: null

	const explicitIp = options.interpolationDB ? new mod.StreetInterpolator({ dbPath: options.interpolationDB }) : null

	const databases: RegionDatabaseResolver =
		explicitAp || explicitIp
			? (slug) => {
					const base = explicitAp && explicitIp ? {} : regionDatabaseProvider.for(slug)

					return { addressPoints: explicitAp ?? base.addressPoints, interpolation: explicitIp ?? base.interpolation }
				}
			: regionDatabaseProvider.for

	const backendsOpenedAt = performance.now()
	progress("Loading optional data providers…")

	let nationalDatabases: ((country: string) => RegionDatabases) | null = null

	try {
		const { BANRegionDatabaseProvider } = await import("@mailwoman/ban/region-database-provider")
		nationalDatabases = (await BANRegionDatabaseProvider.create(resolvePathBuilder(options.dataRoot))).for
	} catch {
		nationalDatabases = null
	}

	const overtureProvider = await OvertureNationalDatabaseProvider.create(resolvePath(options.dataRoot))
	const banDatabases = nationalDatabases

	nationalDatabases = (country: string): RegionDatabases => {
		const ban = banDatabases?.(country)

		return ban?.addressPoints || ban?.streetCentroids ? ban : overtureProvider.for(country)
	}

	let osmProvider: RegionDatabaseProvider | null = null

	try {
		const { OSMRegionDatabaseProvider } = await import("@mailwoman/osm/region-database-provider")
		osmProvider = await OSMRegionDatabaseProvider.create(resolvePathBuilder(options.dataRoot))
	} catch {
		osmProvider = null
	}

	const optionalProvidersLoadedAt = performance.now()

	let poiHandle: Disposable | null = null
	let designationRoute: AuthorityDesignationRoute | null = null
	let soilRoute: SoilCapabilityRoute | null = null
	let coastalRoute: CoastalErosionRoute | null = null
	let zoningRoute: ZoningDesignationRoute | null = null

	const disposeQuietly = (handle: Disposable | null): void => {
		try {
			handle?.[Symbol.dispose]()
		} catch {}
	}

	const dispose = (): void => {
		disposeQuietly(explicitAp)
		disposeQuietly(explicitIp)
		disposeQuietly(regionDatabaseProvider)
		disposeQuietly(osmProvider)
		disposeQuietly(lookup)
		disposeQuietly(poiHandle)
		disposeQuietly(designationRoute)
		disposeQuietly(soilRoute)
		disposeQuietly(coastalRoute)
		disposeQuietly(zoningRoute)
	}

	let placer: CoarsePlacer | null = null
	let resolver: Resolver
	let bias: NonNullable<GeocodeDeps["bias"]>
	let forkEntityDeps: Pick<GeocodeDeps, "poiLookup" | "isStreetGeneric">

	const kindClassifierWithLexicon = createKindClassifier({ poiLexicon: poiTaxonomyLookup })

	const poiKindClassifier: NonNullable<GeocodeDeps["classifyKind"]> = (input, shape) =>
		kindClassifierWithLexicon(input, shape, {
			locale: options.locale ?? "en-US",
			confidence: 1,
			alternatives: [],
			script: [],
			evidence: null,
			source: "caller",
		})

	try {
		progress("Loading geographic priors…")

		placer = options.placeCountry
			? await CoarsePlacer.fromBundled({ abstainBelow: options.placeCountryThreshold, openSet: true })
			: null

		resolver = createWOFResolver(lookup)
		bias = parseBiasPoints(options.bias ?? null)

		const probe = await loadForkEntityDeps(options)

		forkEntityDeps = probe.deps
		poiHandle = probe.handle ?? null
		designationRoute = await loadAuthorityDesignationRoute(options)
		soilRoute = await loadSoilCapabilityRoute(options)
		coastalRoute = await loadCoastalErosionRoute(options)
		zoningRoute = await loadZoningDesignationRoute(options)
	} catch (error) {
		dispose()

		throw error
	}

	const initializedAt = performance.now()
	progress("Ready; geocoding…")

	const initTiming: PipelineTiming = {
		paths: pathsResolvedAt - initStartedAt,
		weights: weightsLoadedAt - pathsResolvedAt,
		resolver_import: resolverImportedAt - weightsLoadedAt,
		backends: backendsOpenedAt - resolverImportedAt,
		optional_providers: optionalProvidersLoadedAt - backendsOpenedAt,
		placer_and_priors: initializedAt - optionalProvidersLoadedAt,
		total: initializedAt - initStartedAt,
	}

	const parseDeps: Pick<
		GeocodeDeps,
		"classifier" | "normalizeInput" | "caseNormalization" | "inputMode" | "fst" | "streetMorphology"
	> = {
		classifier: routed,
		...(fst ? { fst } : {}),
		...(streetMorphology ? { streetMorphology } : {}),
	}

	const traceOf = async (input: string): Promise<Omit<GeocodeTrace, "resolver"> | null> => {
		if (!options.trace) return null

		const inputs = geocodeParseInputs(input, parseDeps)

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

	const geocode = async (input: string): Promise<GeocodeRun> => {
		const startedAt = performance.now()

		const parsedTree = await parseForGeocode(input, parseDeps)
		const parsedAt = performance.now()
		const trace = await traceOf(input)
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
			...(fst ? { fst } : {}),
			...(streetMorphology ? { streetMorphology } : {}),
			resolver,
			databases,
			nationalDatabases,
			...(osmProvider ? { osmDatabases: osmProvider.for } : {}),
			parsedTree,
			...(bias.length ? { bias } : {}),
			...(inferredScopeOK && countryScope ? { defaultCountry: countryScope } : {}),
			...(options.localeCountryPrior && withheldCountry ? { localeCountryPrior: withheldCountry } : {}),

			...(capitalLevel ? { capitalLevel } : {}),

			...(localeCountry ? { fuzzyCountryScope: localeCountry } : {}),

			postcodeCountryCoherence: options.postcodeCountryCoherence,
			postcodeShapeCoherence: options.postcodeShapeCoherence,
			postcodeContainmentCoherence: options.postcodeContainmentCoherence,
			adminContainmentRerank: options.adminContainmentRerank ?? GEOCODE_SWITCH_DEFAULTS.adminContainmentRerank,

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

	return {
		initTiming,

		artifacts: {
			...(fst && classifier.fstPath ? { fstPath: classifier.fstPath } : {}),
			...(streetMorphology && classifier.streetMorphologyPath
				? { streetMorphologyPath: classifier.streetMorphologyPath }
				: {}),
			...(classifier.resolvedWeights ? { weights: classifier.resolvedWeights } : {}),
		},
		geocode,
		[Symbol.dispose]: dispose,
	}
}
