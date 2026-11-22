// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Builds the runtime pipeline that the POI board and its probes grade against.
 */

import type { PipelineOpts, PipelineResult } from "@mailwoman/core/pipeline"
import type { POIPhraseLookup } from "@mailwoman/kind-classifier"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { DEFAULT_WEIGHTS_LOCALE } from "@mailwoman/neural/weights/families"
import { poiDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { resolvePath, type PathBuilderLike } from "path-ts"

import { openPOIAnchorResolver, type POIAnchorBackend, type POIAnchorResolver } from "#poi/anchor-resolver"
import { createRuntimePipeline } from "#runtime-pipeline"

/**
 * Options for the POI board and its pipeline.
 */
export interface POIBoardOptions {
	locale?: string
	weightsCacheRoot?: string
	fixturesPath?: string
	/**
	 * Sealed `poi.db` to query.
	 *
	 * @defaultValue the data-root POI layer path.
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
	 * Extra phrase lookup consulted after the committed lexicon and the POI name lookup
	 * both find no entry, passed through as `CreateRuntimePipelineOpts.poiSemanticLookup`;
	 * a probe sets it so the injected route runs through the board's own pipeline construction.
	 */
	poiSemanticLookup?: POIPhraseLookup
	/**
	 * Whether to build the semantic observation route and use it as {@linkcode poiSemanticLookup},
	 * ignored when `poiSemanticLookup` is set.
	 *
	 * @defaultValue `false`. The registered floors assume it, because the shipped pipeline omits the route.
	 */
	semanticObservation?: boolean
}

/**
 * Opens the anchor resolver `mailwoman poi` opens, through the builder the command calls.
 *
 * With zero gazetteer available it returns `null`, so anchored cases abstain with `anchor_required`.
 * The caller disposes the returned resolver.
 */
async function loadResolver(options: POIBoardOptions): Promise<POIAnchorResolver | null> {
	const opened = await openPOIAnchorResolver({
		...(options.candidateDB ? { candidateDB: options.candidateDB } : {}),
		...(options.resolveDB ? { resolveDB: options.resolveDB } : {}),
	})

	if (opened === "unconfigured") {
		console.error(
			"note: no WOF resolver configured — anchor localities will not resolve to coordinates, so anchored " +
				"category/brand cases will abstain anchor_required. Set --resolve-db/--candidate-db to fix."
		)

		return null
	}

	if (opened === "unavailable") {
		console.error("note: `@mailwoman/resolver-wof-sqlite` is not installed — anchor localities will not resolve.")

		return null
	}

	return opened
}

/**
 * Backend that answered anchor resolution, or `none` when zero resolver opened.
 */
export type POIBoardResolverBackend = POIAnchorBackend | "none"

/**
 * Board pipeline with the artifacts it opened.
 *
 * Its async disposal closes the pipeline's scope and the anchor resolver.
 */
export interface POIBoardPipelineHandle extends AsyncDisposable {
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
 * Builds the board's pipeline from the classifier, anchor resolver, plus POI executor.
 * It uses the same setup as `commands/poi.tsx`.
 *
 * Probes that grade with {@link gradeCase} call this too, so their results use
 * the same backend and weights locale as the board.
 */
export async function createPOIBoardPipeline(options: POIBoardOptions = {}): Promise<POIBoardPipelineHandle> {
	const db = resolvePath(options.db ?? poiDatabasePath("poi.db"))

	const classifier = await NeuralAddressClassifier.loadFromWeights({
		locale: options.locale ?? DEFAULT_WEIGHTS_LOCALE,
		cacheRoot: options.weightsCacheRoot,
	})

	const resolverHandle = await loadResolver(options)
	// A probe that passes its own lookup reads its firings afterwards, so a supplied lookup takes precedence.
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
		[Symbol.asyncDispose]: async () => {
			await pipeline[Symbol.asyncDispose]()
			resolverHandle?.[Symbol.dispose]()
		},
	}
}

/**
 * Returns the semantic observation route's lookup, or `undefined` when `semanticObservation` is off.
 *
 * The route module is imported dynamically so a run with the option off never loads its compiled artifact.
 */
async function buildBoardSemanticLookup(semanticObservation?: boolean): Promise<POIPhraseLookup | null> {
	if (!semanticObservation) return null

	const { createSemanticObservationRoute } = await import("#observations/semantic-route")

	return (await createSemanticObservationRoute()).lookup
}
