/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file POI board runtime construction.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import type { PipelineOpts, PipelineResult } from "@mailwoman/core/pipeline"
import type { Resolver } from "@mailwoman/core/resolver"
import { dataRootPath, wofExtractPaths } from "@mailwoman/core/utils"
import type { POIPhraseLookup } from "@mailwoman/kind-classifier"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { resolvePath, type PathBuilderLike } from "path-ts"

import { createRuntimePipeline } from "#index"
import { createResolverBackend } from "#resolver-backend"

export interface POIBoardOptions {
	locale?: string
	weightsCacheRoot?: string
	fixturesPath?: string
	/**
	 * Sealed poi.db to query. Defaults to the standard data-root layer path — see `gazetteer build poi`'s own default.
	 */
	db?: PathBuilderLike
	/**
	 * WOF admin database path(s) for anchor resolution — same semantics as `mailwoman poi --resolve-db`.
	 */
	resolveDB?: string
	/**
	 * Byte-range candidate.db for anchor resolution (demo-parity backend) — same semantics as `mailwoman poi
	 * --candidate-db`.
	 */
	candidateDB?: string
	/**
	 * Suppress the human-readable table (the CLI's `--json` mode prints the full report instead).
	 */
	quiet?: boolean
	/**
	 * Enforce the pre-registered floors: return a non-zero exit code on any breach (floors are always printed).
	 */
	enforce?: boolean
	/**
	 * An additional positive-evidence phrase rung for the constructed pipeline, consulted only after the committed
	 * lexicon and the POI name lookup have both returned nothing (`CreateRuntimePipelineOpts.poiSemanticLookup`).
	 *
	 * Carried on the board's own options so a probe measuring an injected route runs through the SAME construction the
	 * board does. Absent — the default — constructs the pipeline the board has always constructed.
	 */
	poiSemanticLookup?: POIPhraseLookup
	/**
	 * Build `mailwoman/observations`' semantic route and inject it as {@linkcode poiSemanticLookup}.
	 *
	 * DEFAULT OFF, and the floors are registered against the off arm: the board grades the construction that ships, and a
	 * floor measured under an opt-in rung would describe a pipeline no caller runs. On, it measures the activity-phrase
	 * family — the rows whose subject reaches no committed lexicon entry, and which therefore take no POI branch at all
	 * with the rung absent. Ignored when {@linkcode poiSemanticLookup} is supplied directly.
	 */
	semanticObservation?: boolean
}

/**
 * Build the WOF resolver, mirroring `commands/poi.tsx`'s `tryLoadResolver`: candidate-table backend when configured,
 * else the FTS admin database set, else no resolver at all (anchored category cases then abstain `anchor_required`,
 * exactly like the CLI probe degrades). Caller owns closing the returned handle.
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
 * Which lookup answered anchor resolution. Reported rather than re-derived: `createResolverBackend` falls back to the
 * convention candidate path, so a caller that reads only its own options names the wrong backend on any box where that
 * file exists.
 */
export type POIBoardResolverBackend = "candidate" | "wof-fts" | "none"

export interface POIBoardPipelineHandle extends Disposable {
	pipeline: (raw: string, runOpts?: PipelineOpts) => Promise<PipelineResult>
	/**
	 * The sealed poi.db the executor queries — carried here so a caller reporting artifact identity reads the path the
	 * pipeline actually opened rather than re-deriving the default.
	 */
	db: string
	/**
	 * Which lookup answered anchor resolution, as built rather than as requested.
	 */
	backend: POIBoardResolverBackend
}

/**
 * Construct the board's pipeline: classifier + resolver + poi executor, exactly as `commands/poi.tsx` builds it
 * (`NeuralAddressClassifier.loadFromWeights` + the shared resolver-backend selector + `createRuntimePipeline({
 * poiQueryKind: { poiDatabasePath } })`).
 *
 * Extracted so a probe that grades with {@link gradeCase} runs against the SAME construction the board does. A second
 * copy of these four calls would let the two drift — a different backend or a different weights locale would change
 * what the probe measures while the grader stayed identical, and the difference would read as a pipeline result.
 */
export async function createPOIBoardPipeline(options: POIBoardOptions = {}): Promise<POIBoardPipelineHandle> {
	const db = resolvePath(options.db ?? dataRootPath("poi", "poi.db"))

	const classifier = await NeuralAddressClassifier.loadFromWeights({
		locale: options.locale ?? "en-US",
		cacheRoot: options.weightsCacheRoot,
	})

	const resolverHandle = await loadResolver(options)
	// A caller-supplied rung wins: the probe hands one in AND drains it afterwards, so building a second here would give
	// it a route whose firings nobody reads.
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
 * The semantic route as a phrase rung, or nothing when the arm was not asked for.
 *
 * Dynamically imported so a board run with the arm off never loads the compiled artifact reader — the same containment
 * `createRuntimePipeline` gets from taking the rung as an argument rather than constructing one.
 */
async function buildBoardSemanticLookup(semanticObservation?: boolean): Promise<POIPhraseLookup | undefined> {
	if (!semanticObservation) return undefined

	const { createSemanticObservationRoute } = await import("#observations/semantic-route")

	return (await createSemanticObservationRoute()).lookup
}

/**
 * Build the runtime pipeline once (classifier + resolver + poi executor), run every fixture through it, grade, and
 * aggregate.
 */
