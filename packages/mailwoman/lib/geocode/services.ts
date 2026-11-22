// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The services a geocode session composes, defined on an `async-init` `ServiceRegistry`.
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
 *   Each service declares the services it needs, and the registry resolves those first.
 *   Independent services therefore build in parallel.
 *
 *   The registry disposes a service after every service built from it.
 *   Every service that reads the selection needs it, so the selection lease is released last.
 */

import type { CoarsePlacer } from "@mailwoman/core/coarse-placer"
import { isPresent } from "@mailwoman/core/objects"
import { allKeyed } from "@mailwoman/core/promises"
import type { RegionDatabases } from "@mailwoman/core/resolver"
import { CommandError } from "@mailwoman/core/scripting/command"
import { readLibPostalSingleWordStopwords } from "@mailwoman/dictionaries/libpostal"
import { createKindClassifier } from "@mailwoman/kind-classifier"
import {
	createToken,
	optional,
	type OptionalNeed,
	type ServiceGraphNode,
	ServiceRegistry,
	type ServiceToken,
} from "async-init"

import type { LayerCatalog } from "#data/catalog"
import { holdActiveSelection } from "#data/retention"
import { loadBundledCoarsePlacer } from "#default/placer"
import { $public } from "#env"
import {
	firstCoveringSource,
	type LayerContribution,
	type NationalDatabaseSource,
	type RegionDatabaseSource,
	type UnavailableLayer,
} from "#geocode/contributions"
import type { GeocodeDeps } from "#geocode/core"
import { selectedParsePriorArtifacts } from "#geocode/fst-layers"
import type { GeocodeSessionOptions } from "#geocode/options"
import type { openOSMRegionDatabases } from "#geocode/osm-layers"
import type { ForkEntityProbe, LayerRoutes } from "#geocode/session/layers"
import { createStopwordPOIPhraseLookup } from "#poi/intent"
import {
	capitalIndexFor,
	createResolverBackend,
	existingWOFDatabasePaths,
	resolveCandidateDBPath,
	resolveWOFDatabasePaths,
} from "#resolver-backend"
import { ClassifierService, registerClassifierService } from "#services/classifier"
import { defineUnlessProvided } from "#services/define"
import { ParsePriorArtifactsService, ParsePriorsService, registerParsePriorsService } from "#services/parse-priors"

type ResolverModule = typeof import("@mailwoman/resolver-wof-sqlite")

type ActiveSelection = Awaited<ReturnType<typeof holdActiveSelection>>

type ResolverBackend = Awaited<ReturnType<typeof createResolverBackend>>

type OSMRegionDatabases = Awaited<ReturnType<typeof openOSMRegionDatabases>>

/**
 * The token of the resolver module.
 *
 * The process scope holds it beside {@link ClassifierService}.
 *
 * A caller that builds its own scope registers a service under this token.
 *
 * @public
 */
export const ResolverModuleService: ServiceToken<ResolverModule> = createToken("resolver-module")

/**
 * The tokens of the generation scope, besides {@link ParsePriorArtifactsService}
 * and {@link ParsePriorsService}.
 *
 * A caller reads a session's service, or substitutes one in a child scope, by its token here.
 *
 * @public
 */
export const GenerationServices = {
	selection: createToken<ActiveSelection>("selection"),
	candidateDB: createToken<string | null>("candidate-db"),
	wofPaths: createToken<string[]>("wof-paths"),
	lookup: createToken<ResolverBackend>("resolver-backend"),
	capitals: createToken<Awaited<ReturnType<typeof capitalIndexFor>>>("capitals"),
	regionDatabases: createToken<RegionDatabaseSource>("region-databases"),
	explicitAddressPoints: createToken<InstanceType<ResolverModule["AddressPointSqliteLookup"]> | null>(
		"explicit-address-points"
	),
	explicitInterpolation: createToken<InstanceType<ResolverModule["StreetInterpolator"]> | null>(
		"explicit-interpolation"
	),
	nationalDatabases: createToken<(country: string) => RegionDatabases>("national-databases"),
	osm: createToken<OSMRegionDatabases>("osm"),
	classifyKind: createToken<NonNullable<GeocodeDeps["classifyKind"]>>("kind-classifier"),
	placer: createToken<CoarsePlacer | null>("coarse-placer"),
	forkEntity: createToken<ForkEntityProbe>("fork-entity"),
	layerRoutes: createToken<LayerRoutes>("layer-routes"),
} as const

/**
 * Registers the process-scope services: the routed neural classifier and the resolver module.
 *
 * A scope serves only sessions built with the same `locale`, `dataRoot` and `weightsCacheRoot`,
 * because the classifier reads its weights from those options.
 */
export function registerProcessServices(
	registry: ServiceRegistry,
	options: Pick<GeocodeSessionOptions, "locale" | "dataRoot" | "weightsCacheRoot">
): void {
	registerClassifierService(registry, options)

	defineUnlessProvided(registry, ResolverModuleService, {
		build: async () => {
			try {
				return await import("@mailwoman/resolver-wof-sqlite")
			} catch {
				throw new CommandError(
					"geocode requires `@mailwoman/resolver-wof-sqlite` to be installed. " +
						"Run `npm install @mailwoman/resolver-wof-sqlite` and try again."
				)
			}
		},
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
 *
 * Each of `contributions` registers one data layer.
 * The national sources they add are consulted in the order of the list.
 */
export function registerGenerationServices(
	registry: ServiceRegistry,
	options: GeocodeSessionOptions,
	contributions: readonly LayerContribution[]
): void {
	const S = GenerationServices

	// A session reading an active selection holds a lease on its generation,
	// so a prune keeps those artifacts until the session is disposed.
	// A data root with no selection takes no lease and receives no write.
	// Every service below reads this one snapshot, so the session reads one generation throughout.
	defineUnlessProvided(registry, S.selection, {
		build: () => holdActiveSelection(options.dataRoot),
		release: (selection) => selection.lease?.[Symbol.dispose](),
	})

	defineUnlessProvided(registry, S.candidateDB, {
		needs: { selection: S.selection },
		build: ({ selection }) => resolveCandidateDBPath(options.candidateDB, options.dataRoot, selection.catalog),
	})

	defineUnlessProvided(registry, S.wofPaths, {
		needs: { candidateDB: S.candidateDB, selection: S.selection },
		build: ({ candidateDB, selection }) => (candidateDB ? [] : resolveWOFPath(options, selection.catalog)),
	})

	// The FSTs the active selection lists, else the files beside the weights.
	defineUnlessProvided(registry, ParsePriorArtifactsService, {
		needs: { routed: ClassifierService, selection: S.selection },
		build: ({ routed, selection }) =>
			selectedParsePriorArtifacts(routed.primary, options.locale, options.dataRoot, selection.catalog),
	})

	registerParsePriorsService(registry, {
		gazetteerPrior: options.gazetteerPrior,
		venueHeadPrior: options.venueHeadPrior,
		label: `locale ${options.locale}`,
	})

	defineUnlessProvided(registry, S.lookup, {
		needs: {
			mod: ResolverModuleService,
			candidateDB: S.candidateDB,
			wofPaths: S.wofPaths,
			selection: S.selection,
		},
		build: ({ mod, candidateDB, wofPaths, selection }) =>
			createResolverBackend(mod, {
				candidateDB,
				catalog: selection.catalog,
				dataRoot: options.dataRoot,
				wofPaths,
				variantAliasExemption: options.variantAliasExemption,
			}),
	})

	defineUnlessProvided(registry, S.capitals, {
		needs: { candidateDB: S.candidateDB },
		build: ({ candidateDB }) => capitalIndexFor(options.capitalTier, candidateDB),
	})

	const explicitAddressPointLocale = options.locale.split("-")[1]?.toLowerCase() === "fr" ? "fr" : "us"

	defineUnlessProvided(registry, S.explicitAddressPoints, {
		needs: { mod: ResolverModuleService },
		build: ({ mod }) =>
			options.addressPointsDB
				? new mod.AddressPointSqliteLookup(options.addressPointsDB, { streetLocale: explicitAddressPointLocale })
				: null,
	})

	defineUnlessProvided(registry, S.explicitInterpolation, {
		needs: { mod: ResolverModuleService },
		build: ({ mod }) =>
			options.interpolationDB ? new mod.StreetInterpolator({ dbPath: options.interpolationDB }) : null,
	})

	defineUnlessProvided(registry, S.classifyKind, {
		build: async () => {
			const locale = options.locale ?? "en-US"
			const leadingStopwords = await readLibPostalSingleWordStopwords(locale.split("-")[0]!)
			const classify = createKindClassifier({ poiLexicon: createStopwordPOIPhraseLookup(leadingStopwords) })

			return (input, shape) =>
				classify(input, shape, {
					locale,
					confidence: 1,
					alternatives: [],
					script: [],
					evidence: null,
					source: "caller",
				})
		},
	})

	defineUnlessProvided(registry, S.placer, {
		build: () =>
			options.placeCountry
				? loadBundledCoarsePlacer({ abstainBelow: options.placeCountryThreshold, openSet: true })
				: null,
	})

	const nationalSources: ServiceToken<NationalDatabaseSource>[] = []

	for (const contribute of contributions) {
		contribute({ registry, options, nationalSource: (token) => void nationalSources.push(token) })
	}

	// Each source is an optional need, so a source that fails to open is left out and the others still answer.
	const sourceNeeds: Record<string, OptionalNeed<NationalDatabaseSource>> = Object.fromEntries(
		nationalSources.map((token) => [token.description, optional(token)])
	)

	defineUnlessProvided(registry, S.nationalDatabases, {
		needs: sourceNeeds,
		build: (sources) => firstCoveringSource(Object.values(sources).filter(isPresent)),
	})
}

/**
 * The services a session with these options would compose, each with the services it declares a need on.
 *
 * It registers the process and generation services on a registry of its own and reads the graph.
 * It builds no service, so it opens no database and loads no weights.
 */
export async function describeGeocodeServices(
	options: GeocodeSessionOptions,
	contributions: readonly LayerContribution[]
): Promise<ServiceGraphNode[]> {
	await using registry = new ServiceRegistry()

	registerProcessServices(registry, options)
	registerGenerationServices(registry, options, contributions)

	return registry.graph()
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

	return allKeyed({
		routed: registry.resolve(ClassifierService),
		selection: registry.resolve(S.selection),
		candidateDB: registry.resolve(S.candidateDB),
		parsePriors: registry.resolve(ParsePriorsService),
		lookup: registry.resolve(S.lookup),
		capitals: registry.resolve(S.capitals),
		regionDatabases: registry.resolve(S.regionDatabases),
		explicitAddressPoints: registry.resolve(S.explicitAddressPoints),
		explicitInterpolation: registry.resolve(S.explicitInterpolation),
		nationalDatabases: registry.resolve(S.nationalDatabases),
		osm: registry.resolve(S.osm),
		classifyKind: registry.resolve(S.classifyKind),
		placer: registry.resolve(S.placer),
		forkEntity: registry.resolve(S.forkEntity),
		layerRoutes: registry.resolve(S.layerRoutes),
	})
}

/**
 * The layers whose service failed to build, among the services another service declares an optional need on.
 *
 * Read it after the scope's services have resolved.
 */
export function unavailableLayers(registry: ServiceRegistry): UnavailableLayer[] {
	const graph = registry.graph()

	const optionalTokens = new Set(
		graph.flatMap((service) => service.needs.filter((need) => need.optional).map((need) => need.token))
	)

	return graph
		.filter((service) => service.state === "failed" && optionalTokens.has(service.token))
		.map((service) => ({ layer: service.token.description, error: service.error }))
}
