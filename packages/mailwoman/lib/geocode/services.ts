// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The services a geocode session composes, registered on an `async-init` `ServiceRegistry`.
 *
 *   The services sit in two scopes.
 *   The process scope holds the neural classifier and the resolver module.
 *
 *   A data reload leaves both unchanged.
 *   The generation scope holds every service that reads the data root's active selection:
 *   the selection lease, the parse priors, the resolver backend, the region
 *   and national databases, and the optional layers.
 *
 *   A server keeps one process scope and builds a child generation scope per data generation,
 *   so a reload neither reloads the model nor holds two copies of it.
 *
 *   Each service's factory awaits the services it reads, so independent services resolve in parallel.
 *   The registry disposes its services in the reverse of their registration order.
 *   The selection lease, registered first, is released last.
 */

import type { CoarsePlacer } from "@mailwoman/core/coarse-placer"
import { allKeyed } from "@mailwoman/core/promises"
import type { RegionDatabases } from "@mailwoman/core/resolver"
import { CommandError } from "@mailwoman/core/scripting/command"
import { readLibPostalSingleWordStopwords } from "@mailwoman/dictionaries/libpostal"
import { createKindClassifier } from "@mailwoman/kind-classifier"
import type { ServiceRegistry } from "async-init"
import { resolvePath } from "path-ts"

import type { LayerCatalog } from "#data/catalog"
import { holdActiveSelection } from "#data/retention"
import { loadBundledCoarsePlacer } from "#default/placer"
import { $public } from "#env"
import { openBANRegionDatabases } from "#geocode/ban-layers"
import type { GeocodeDeps } from "#geocode/core"
import { selectedParsePriorArtifacts } from "#geocode/fst-layers"
import { OvertureNationalDatabaseProvider } from "#geocode/national-overture"
import { openOSMRegionDatabases } from "#geocode/osm-layers"
import { USStateDatabaseProvider } from "#geocode/regions"
import type { GeocodeSessionOptions, GeocodeSessionSettings } from "#geocode/session"
import { type ForkEntityProbe, type LayerRoutes, loadForkEntityDeps, loadLayerRoutes } from "#geocode/session/layers"
import { createStopwordPOIPhraseLookup } from "#poi/intent"
import {
	capitalIndexFor,
	createResolverBackend,
	existingWOFDatabasePaths,
	resolveCandidateDBPath,
	resolveWOFDatabasePaths,
} from "#resolver-backend"
import { ClassifierService, registerClassifierService } from "#services/classifier"
import { ParsePriorsService, registerParsePriorsService } from "#services/parse-priors"
import { need, noInputs, provide, type ServiceKey, serviceKey, type ServiceTimings } from "#services/registry"

type ResolverModule = typeof import("@mailwoman/resolver-wof-sqlite")

/**
 * Releases a value that's a disposable handle or `null`.
 */
function disposeHandle(handle: Disposable | null | undefined): void {
	handle?.[Symbol.dispose]()
}

/**
 * The token of the resolver module.
 *
 * The process scope holds it beside {@link ClassifierService}.
 */
export const ResolverModuleService = serviceKey<ResolverModule>("resolver-module")

/**
 * The tokens of the generation scope, besides {@link ParsePriorsService}.
 */
export const GenerationServices = {
	selection: serviceKey<Awaited<ReturnType<typeof holdActiveSelection>>>("selection"),
	candidateDB: serviceKey<string | null>("candidate-db"),
	wofPaths: serviceKey<string[]>("wof-paths"),
	lookup: serviceKey<Awaited<ReturnType<typeof createResolverBackend>>>("resolver-backend"),
	capitals: serviceKey<Awaited<ReturnType<typeof capitalIndexFor>>>("capitals"),
	regionDatabases: serviceKey<USStateDatabaseProvider>("region-databases"),
	explicitAddressPoints: serviceKey<InstanceType<ResolverModule["AddressPointSqliteLookup"]> | null>(
		"explicit-address-points"
	),
	explicitInterpolation: serviceKey<InstanceType<ResolverModule["StreetInterpolator"]> | null>(
		"explicit-interpolation"
	),
	ban: serviceKey<Awaited<ReturnType<typeof openBANRegionDatabases>>>("ban"),
	overture: serviceKey<OvertureNationalDatabaseProvider>("overture"),
	osm: serviceKey<Awaited<ReturnType<typeof openOSMRegionDatabases>>>("osm"),
	classifyKind: serviceKey<NonNullable<GeocodeDeps["classifyKind"]>>("kind-classifier"),
	placer: serviceKey<CoarsePlacer | null>("coarse-placer"),
	forkEntity: serviceKey<ForkEntityProbe>("fork-entity"),
	layerRoutes: serviceKey<LayerRoutes>("layer-routes"),
} as const

/**
 * Registers the process-scope services: the routed neural classifier and the resolver module.
 *
 * A scope serves only sessions built with the same `locale`, `dataRoot` and `weightsCacheRoot`,
 * because the classifier reads its weights from those options.
 */
export function registerProcessServices(
	registry: ServiceRegistry,
	options: Pick<GeocodeSessionOptions, "locale" | "dataRoot" | "weightsCacheRoot">,
	timings: ServiceTimings = {}
): void {
	registerClassifierService(registry, options, timings)

	provide(registry, timings, ResolverModuleService, noInputs, async () => {
		try {
			return await import("@mailwoman/resolver-wof-sqlite")
		} catch {
			throw new CommandError(
				"geocode requires `@mailwoman/resolver-wof-sqlite` to be installed. " +
					"Run `npm install @mailwoman/resolver-wof-sqlite` and try again."
			)
		}
	})
}

async function resolveWOFPath(
	options: Pick<GeocodeSessionOptions, "dataRoot" | "resolveDB">,
	catalog: LayerCatalog
): Promise<string[]> {
	// A pinned list (`--resolve-db` or `$MAILWOMAN_WOF_DB`) is read as given.
	// Otherwise the active selection's WOF extracts, else the conventional set.
	const pinned = options.resolveDB || $public.MAILWOMAN_WOF_DB ? resolveWOFDatabasePaths(options.resolveDB) : null
	const paths = await existingWOFDatabasePaths(pinned, options.dataRoot, catalog)

	if (!paths.length) {
		throw new CommandError(
			`geocode found no resolver database under ${options.dataRoot}. Run \`mailwoman data pull candidate\`, ` +
				"set $MAILWOMAN_DATA_ROOT, or pass --candidate-db / --resolve-db."
		)
	}

	return paths
}

/**
 * Registers the generation-scope services on `registry`, which reads the process-scope
 * services from itself or from a parent scope.
 */
export function registerGenerationServices(
	registry: ServiceRegistry,
	options: GeocodeSessionOptions,
	settings: GeocodeSessionSettings,
	timings: ServiceTimings = {}
): void {
	const S = GenerationServices
	const get = <T>(key: ServiceKey<T>) => need(registry, key)
	const catalog = async () => (await get(S.selection)).catalog

	// A session reading an active selection holds a lease on its generation,
	// so a prune keeps those artifacts until the session is disposed.
	// A data root with no selection takes no lease and receives no write.
	// Every service below reads this one snapshot, so the session reads one generation throughout.
	provide(
		registry,
		timings,
		S.selection,
		noInputs,
		() => holdActiveSelection(options.dataRoot),
		(selection) => disposeHandle(selection.lease)
	)

	provide(registry, timings, S.candidateDB, catalog, (snapshot) =>
		resolveCandidateDBPath(options.candidateDB, options.dataRoot, snapshot)
	)

	provide(
		registry,
		timings,
		S.wofPaths,
		() => allKeyed({ candidateDB: get(S.candidateDB), catalog: catalog() }),
		({ candidateDB, catalog: snapshot }) => (candidateDB ? [] : resolveWOFPath(options, snapshot))
	)

	registerParsePriorsService(
		registry,
		{
			// The FSTs the active selection lists, else the files beside the weights.
			select: async (primary) =>
				selectedParsePriorArtifacts(primary, options.locale, options.dataRoot, await catalog()),
			load: {
				gazetteerPrior: settings.gazetteerPrior,
				venueHeadPrior: settings.venueHeadPrior,
				label: `locale ${options.locale}`,
			},
		},
		timings
	)

	provide(
		registry,
		timings,
		S.lookup,
		() =>
			allKeyed({
				mod: get(ResolverModuleService),
				candidateDB: get(S.candidateDB),
				wofPaths: get(S.wofPaths),
				catalog: catalog(),
			}),
		({ mod, candidateDB, wofPaths, catalog: snapshot }) =>
			createResolverBackend(mod, {
				candidateDB,
				catalog: snapshot,
				dataRoot: options.dataRoot,
				wofPaths,
				variantAliasExemption: settings.variantAliasExemption,
			}),
		disposeHandle
	)

	provide(
		registry,
		timings,
		S.capitals,
		() => get(S.candidateDB),
		(candidateDB) => capitalIndexFor(settings.capitalTier, candidateDB)
	)

	provide(
		registry,
		timings,
		S.regionDatabases,
		() => allKeyed({ mod: get(ResolverModuleService), catalog: catalog() }),
		({ mod, catalog: snapshot }) => USStateDatabaseProvider.create(mod, options.dataRoot, snapshot),
		disposeHandle
	)

	const explicitAddressPointLocale = options.locale.split("-")[1]?.toLowerCase() === "fr" ? "fr" : "us"

	provide(
		registry,
		timings,
		S.explicitAddressPoints,
		() => get(ResolverModuleService),
		(mod) =>
			options.addressPointsDB
				? new mod.AddressPointSqliteLookup(options.addressPointsDB, { streetLocale: explicitAddressPointLocale })
				: null,
		disposeHandle
	)

	provide(
		registry,
		timings,
		S.explicitInterpolation,
		() => get(ResolverModuleService),
		(mod) => (options.interpolationDB ? new mod.StreetInterpolator({ dbPath: options.interpolationDB }) : null),
		disposeHandle
	)

	provide(
		registry,
		timings,
		S.ban,
		catalog,
		(snapshot) => openBANRegionDatabases(options.dataRoot, snapshot),
		disposeHandle
	)

	provide(
		registry,
		timings,
		S.overture,
		catalog,
		(snapshot) => OvertureNationalDatabaseProvider.create(resolvePath(options.dataRoot), snapshot),
		disposeHandle
	)

	// A refusal under MAILWOMAN_REFUSE_OBLIGATIONS isn't caught: it stops the session.
	provide(
		registry,
		timings,
		S.osm,
		catalog,
		(snapshot) => openOSMRegionDatabases(options.dataRoot, snapshot),
		disposeHandle
	)

	provide(registry, timings, S.classifyKind, noInputs, async () => {
		const locale = options.locale ?? "en-US"
		const leadingStopwords = await readLibPostalSingleWordStopwords(locale.split("-")[0]!)
		const classify = createKindClassifier({ poiLexicon: createStopwordPOIPhraseLookup(leadingStopwords) })

		return (input, shape) =>
			classify(input, shape, { locale, confidence: 1, alternatives: [], script: [], evidence: null, source: "caller" })
	})

	provide(registry, timings, S.placer, noInputs, () =>
		options.placeCountry
			? loadBundledCoarsePlacer({ abstainBelow: options.placeCountryThreshold, openSet: true })
			: null
	)

	provide(
		registry,
		timings,
		S.forkEntity,
		catalog,
		(snapshot) => loadForkEntityDeps(options, snapshot),
		(probe) => disposeHandle(probe.handle)
	)

	provide(
		registry,
		timings,
		S.layerRoutes,
		catalog,
		(snapshot) => loadLayerRoutes(options, snapshot),
		(routes) => {
			for (const route of Object.values(routes)) {
				disposeHandle(route)
			}
		}
	)
}

/**
 * Every generation-scope service, resolved together.
 *
 * A service that fails rejects this call.
 * The caller then disposes the scope.
 * Its disposal releases every service that did open.
 */
export async function resolveGenerationServices(registry: ServiceRegistry) {
	const S = GenerationServices
	const get = <T>(key: ServiceKey<T>) => need(registry, key)

	return allKeyed({
		routed: get(ClassifierService),
		selection: get(S.selection),
		candidateDB: get(S.candidateDB),
		parsePriors: get(ParsePriorsService),
		lookup: get(S.lookup),
		capitals: get(S.capitals),
		regionDatabases: get(S.regionDatabases),
		explicitAddressPoints: get(S.explicitAddressPoints),
		explicitInterpolation: get(S.explicitInterpolation),
		ban: get(S.ban),
		overture: get(S.overture),
		osm: get(S.osm),
		classifyKind: get(S.classifyKind),
		placer: get(S.placer),
		forkEntity: get(S.forkEntity),
		layerRoutes: get(S.layerRoutes),
	})
}

/**
 * The national databases for a country: the BAN extract when it holds address points
 * or street centroids, else the Overture provider's.
 */
export function nationalDatabasesOf(
	ban: Awaited<ReturnType<typeof openBANRegionDatabases>>,
	overture: OvertureNationalDatabaseProvider
): (country: string) => RegionDatabases {
	return (country) => {
		const fromBAN = ban.for(country)

		return fromBAN.addressPoints || fromBAN.streetCentroids ? fromBAN : overture.for(country)
	}
}
