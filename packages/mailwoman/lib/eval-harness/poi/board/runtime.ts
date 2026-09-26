/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Builds the runtime pipeline that the POI board and its probes grade against.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import type { PipelineOpts, PipelineResult } from "@mailwoman/core/pipeline"
import type { Resolver } from "@mailwoman/core/resolver"
import type { POIPhraseLookup } from "@mailwoman/kind-classifier"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { poiDatabasePath, wofExtractPaths } from "@mailwoman/resolver-wof-sqlite/paths"
import { resolvePath, type PathBuilderLike } from "path-ts"

import { createRuntimePipeline } from "#index"
import { createResolverBackend } from "#resolver-backend"

/**
 * Options for the POI board and its pipeline.
 */
export interface POIBoardOptions {
	locale?: string
	weightsCacheRoot?: string
	fixturesPath?: string
	/**
	 * Sealed `poi.db` to query.
	 * It defaults to the data-root POI layer path.
	 */
	db?: PathBuilderLike
	/**
	 * Comma-separated WOF admin database paths for anchor resolution, as in `mailwoman poi --resolve-db`.
	 */
	resolveDB?: string
	/**
	 * Candidate-table database for anchor resolution, as in `mailwoman poi --candidate-db`.
	 */
	candidateDB?: string
	/**
	 * Whether to suppress the human-readable table.
	 * The CLI's `--json` mode sets it.
	 */
	quiet?: boolean
	/**
	 * Whether a floor breach returns a non-zero exit code.
	 * The floors print either way.
	 */
	enforce?: boolean
	/**
	 * Extra phrase lookup that the pipeline consults after the committed lexicon
	 * and the POI name lookup both find no entry.
	 *
	 * It is passed through as `CreateRuntimePipelineOpts.poiSemanticLookup`.
	 *
	 * A probe sets it so the injected route runs through the board's own pipeline construction.
	 */
	poiSemanticLookup?: POIPhraseLookup
	/**
	 * Whether to build the semantic observation route and use it as {@linkcode poiSemanticLookup}.
	 * It is ignored when `poiSemanticLookup` is set.
	 *
	 * It defaults to off, and the registered floors assume it is off because the
	 * shipped pipeline omits the route.
	 * Turning it on measures rows whose subject matches no committed lexicon entry.
	 */
	semanticObservation?: boolean
}

/**
 * Builds the anchor resolver the same way as `tryLoadResolver` in `commands/poi.tsx`.
 *
 * It prefers the candidate-table backend, then the WOF FTS databases.
 * With neither available it returns `undefined`, and anchored cases abstain with `anchor_required`.
 *
 * The caller must dispose the returned handle.
 */
async function loadResolver(
	options: POIBoardOptions
): Promise<({ resolver: Resolver; backend: POIBoardResolverBackend } & Disposable) | undefined> {
	const wofCandidates = options.candidateDB
		? []
		: options.resolveDB
			? options.resolveDB.split(",").map((p) => p.trim())
			: wofExtractPaths()

	const wofPaths = (await Promise.all(wofCandidates.map(async (path) => ({ path, exists: await pathExists(path) }))))
		.filter((entry) => entry.exists)
		.map((entry) => entry.path)

	if (!options.candidateDB && !wofPaths.length) {
		console.error(
			"note: no WOF resolver configured — anchor localities will not resolve to coordinates, so anchored " +
				"category/brand cases will abstain anchor_required. Set --resolve-db/--candidate-db to fix."
		)

		return undefined
	}

	try {
		const mod = await import("@mailwoman/resolver-wof-sqlite")
		const lookup = await createResolverBackend(mod, { candidateDB: options.candidateDB, wofPaths })

		return {
			resolver: createWOFResolver(lookup),
			[Symbol.dispose]: () => lookup[Symbol.dispose](),
			backend: lookup instanceof mod.WOFCandidateTableLookup ? "candidate" : "wof-fts",
		}
	} catch {
		console.error("note: `@mailwoman/resolver-wof-sqlite` is not installed — anchor localities will not resolve.")

		return undefined
	}
}

/**
 * Backend that answered anchor resolution.
 *
 * The handle reports the backend that was built.
 * `createResolverBackend` can fall back to the default candidate path,
 * so the caller's options alone do not determine it.
 */
export type POIBoardResolverBackend = "candidate" | "wof-fts" | "none"

/**
 * Board pipeline with the artifacts it opened.
 */
export interface POIBoardPipelineHandle extends Disposable {
	pipeline: (raw: string, runOpts?: PipelineOpts) => Promise<PipelineResult>
	/**
	 * Path of the `poi.db` that the pipeline opened.
	 */
	db: string
	/**
	 * Backend that was built for anchor resolution.
	 */
	backend: POIBoardResolverBackend
}

/**
 * Builds the board's pipeline from the classifier, the anchor resolver,
 * and the POI executor, the same way `commands/poi.tsx` does.
 *
 * Probes that grade with {@link gradeCase} call this too, so their results use
 * the same backend and weights locale as the board.
 */
export async function createPOIBoardPipeline(options: POIBoardOptions = {}): Promise<POIBoardPipelineHandle> {
	const db = resolvePath(options.db ?? poiDatabasePath("poi.db"))

	const classifier = await NeuralAddressClassifier.loadFromWeights({
		locale: options.locale ?? "en-US",
		cacheRoot: options.weightsCacheRoot,
	})

	const resolverHandle = await loadResolver(options)
	// A probe that passes its own lookup reads that lookup's firings afterwards, so a supplied lookup takes precedence.
	const semanticLookup = options.poiSemanticLookup ?? (await buildBoardSemanticLookup(options.semanticObservation))

	const pipeline = createRuntimePipeline({
		classifier,
		resolver: resolverHandle?.resolver,
		poiQueryKind: { poiDatabasePath: db },
		...(semanticLookup ? { poiSemanticLookup: semanticLookup } : {}),
	})

	return {
		pipeline,
		db,
		backend: resolverHandle?.backend ?? "none",
		[Symbol.dispose]: () => resolverHandle?.[Symbol.dispose](),
	}
}

/**
 * Returns the semantic observation route's lookup, or `undefined` when `semanticObservation` is off.
 *
 * The route module is imported dynamically so that a run with the option off
 * never loads its compiled artifact.
 */
async function buildBoardSemanticLookup(semanticObservation?: boolean): Promise<POIPhraseLookup | undefined> {
	if (!semanticObservation) return undefined

	const { createSemanticObservationRoute } = await import("#observations/semantic-route")

	return (await createSemanticObservationRoute()).lookup
}
