/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The live half of the absence-observation probe does not inject a route into the runtime pipeline.
 *   The pipeline answers first. The absence route reads the finished answer afterward.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import type { PipelineOpts, PipelineResult } from "@mailwoman/core/pipeline"
import { compareByCodePoint } from "@mailwoman/core/strings/compare"
import { poiDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { PathBuilderLike } from "path-ts"

import { buildSHA } from "#gazetteer/stamp-manifest"
import {
	type AbsenceObservation,
	type AbsenceObservationRoute,
	type AbsenceRouteIdentity,
	createAbsenceObservationRoute,
	createSemanticObservationRoute,
	describeAbsenceObservation,
	type SemanticObservationRoute,
} from "#observations"
import {
	type AbsenceCounts,
	type AbsenceExpectedResult,
	type AbsenceProbeRow,
	type AbsenceRowResult,
	type AbsenceVerdict,
	absenceProbeDefinitionHash,
	computeAbsenceCounts,
	decideAbsenceProbe,
	loadAbsenceProbeDefinition,
} from "#tools/eval-harness/absence-observation/probe"
import { createPOIBoardPipeline, type POIBoardOptions } from "#tools/eval-harness/poi/board"
import { type PreregisteredArtifactIdentity, readArtifactIdentity } from "#tools/eval-harness/preregistration"

export type AbsenceArtifactIdentity = PreregisteredArtifactIdentity

/**
 * One recorded absence, addressed to the row it happened on.
 */
export interface AbsenceRowObservation extends AbsenceObservation {
	rowID: string
	/**
	 * The one-line form a reader can check the claim from, with both provenances on it.
	 */
	line: string
}

export interface AbsenceProbeReceipt {
	probeID: string
	definitionVersion: string
	definitionSHA256: string
	generatedAt: string
	gitCommit: string
	artifact: AbsenceArtifactIdentity
	absenceRoute: AbsenceRouteIdentity
	semanticRouteInjected: boolean
	rows: AbsenceRowResult[]
	observations: AbsenceRowObservation[]
	counts: AbsenceCounts
	verdict: AbsenceVerdict
}

export interface AbsenceProbeOptions extends POIBoardOptions {
	/**
	 * Overrides the frozen pre-registration for a test that wants a synthetic definition,
	 * while a run with no override reads the committed one.
	 */
	definitionPath?: string
	freezePath?: string
	/**
	 * The sealed coverage layer whose cells qualify the absence, absent resolving the
	 * definition's own `coverageLayerFile` under `$MAILWOMAN_DATA_ROOT/db/poi/`.
	 */
	coverageDatabasePath?: PathBuilderLike
	/**
	 * Commit sha recorded in the receipt, defaulting to the checkout's own short head.
	 */
	gitCommit?: string
}

/**
 * Runs the probe, with the executor's POI database defaulting to the coverage layer itself
 * so an absence is never qualified by one layer and answered from another.
 */
export async function runAbsenceObservationProbe(options: AbsenceProbeOptions = {}): Promise<AbsenceProbeReceipt> {
	const definition = await loadAbsenceProbeDefinition(options.definitionPath, options.freezePath)

	const coverageDatabasePath = options.coverageDatabasePath ?? poiDatabasePath(definition.coverageLayerFile)

	const needsSemanticRoute = definition.rows.some((row) => row.requiresSemanticRoute)
	const semanticRoute = needsSemanticRoute ? await createSemanticObservationRoute() : undefined
	const absenceRoute = await createAbsenceObservationRoute({ coverageDatabasePath })

	using pipelineHandle = await createPOIBoardPipeline({
		...options,
		// After the spread, never before: an explicit `db: undefined` in `...options` would overwrite the default.
		db: options.db ?? coverageDatabasePath,
		...(semanticRoute ? { poiSemanticLookup: semanticRoute.lookup } : {}),
	})

	const { pipeline, db, backend } = pipelineHandle

	const rows: AbsenceRowResult[] = []
	const observations: AbsenceRowObservation[] = []

	try {
		for (const row of definition.rows) {
			const { graded, observation } = await gradeRow(pipeline, absenceRoute, semanticRoute ?? null, row)

			rows.push(graded)

			if (observation) {
				observations.push(observation)
			}
		}
	} finally {
		absenceRoute[Symbol.dispose]()
	}

	return {
		probeID: definition.probeID,
		definitionVersion: definition.version,
		definitionSHA256: absenceProbeDefinitionHash(definition),
		generatedAt: new Date().toISOString(),
		gitCommit: options.gitCommit ?? buildSHA(repoRootPath()),
		artifact: await readArtifactIdentity(db, backend, options),
		absenceRoute: absenceRoute.identity,
		semanticRouteInjected: Boolean(semanticRoute),
		rows,
		observations,
		counts: computeAbsenceCounts(definition, rows),
		verdict: decideAbsenceProbe(definition, rows),
	}
}

async function gradeRow(
	pipeline: (raw: string, runOpts?: PipelineOpts) => Promise<PipelineResult>,
	absenceRoute: AbsenceObservationRoute,
	semanticRoute: SemanticObservationRoute | null,
	row: AbsenceProbeRow
): Promise<{ graded: AbsenceRowResult; observation: AbsenceRowObservation | null }> {
	const runOpts: PipelineOpts = row.locale ? { locale: row.locale } : {}
	const result = await pipeline(row.query, runOpts)

	// Drain the semantic route's per-row firings so they are neither attributed
	// to the next row nor accumulated unbounded.
	semanticRoute?.takeObservations()

	const decision = await absenceRoute.observe(result.poiIntent ?? null)
	const observedResult: AbsenceExpectedResult = decision.fired ? "absence_observation" : decision.refusal

	const poiResult = !result.poiIntent ? "none" : result.poiIntent.type === "abstain" ? "abstain" : "intent"

	// Compared as code-point-ordered sets: the lookup's enumeration order states no preference.
	const searchedCategories =
		result.poiIntent?.type === "intent" && result.poiIntent.intent.subject.kind === "category"
			? [...result.poiIntent.intent.subject.categoryIDs].toSorted(compareByCodePoint)
			: undefined

	const searchedSetBreach =
		row.searchedCategories && row.searchedCategories.join("\u0000") !== (searchedCategories ?? []).join("\u0000")
			? `registered searched set [${row.searchedCategories.join(", ")}], observed ${
					searchedCategories ? `[${searchedCategories.join(", ")}]` : "no category intent"
				}`
			: undefined

	const graded: AbsenceRowResult = {
		id: row.id,
		group: row.group,
		query: row.query,
		expectedResult: row.expectedResult,
		observedResult,
		holds: observedResult === row.expectedResult && !searchedSetBreach,
		searchedCategories: searchedCategories ?? null,
		searchedSetBreach: searchedSetBreach ?? null,
		observationLine: decision.fired ? describeAbsenceObservation(decision.observation) : null,
		poiResult,
		abstainReason: result.poiIntent?.type === "abstain" ? result.poiIntent.reason : null,
		resultsReturned:
			result.poiIntent?.type === "intent" && result.poiIntent.results ? result.poiIntent.results.length : null,
	}

	if (!decision.fired) return { graded, observation: null }

	return {
		graded,
		observation: {
			rowID: row.id,
			line: describeAbsenceObservation(decision.observation),
			...decision.observation,
		},
	}
}

/**
 * Prints each row's registered result beside the observed one, so a reader never
 * has to open the definition to know what the row asserted.
 */
export function printAbsenceProbeReceipt(receipt: AbsenceProbeReceipt): void {
	const route = receipt.absenceRoute

	console.log(`\nabsence-observation probe ${receipt.probeID} v${receipt.definitionVersion}`)
	console.log(`definition sha256: ${receipt.definitionSHA256}`)
	console.log(`poi.db: ${receipt.artifact.poiDatabasePath}`)

	console.log(
		`layer_manifest: ${
			receipt.artifact.poiLayerManifest
				? `${receipt.artifact.poiLayerManifest.name} ${receipt.artifact.poiLayerManifest.version} (vintage ${receipt.artifact.poiLayerManifest.source_vintage})`
				: receipt.artifact.poiLayerManifestNote
		}`
	)

	console.log(
		`weights: ${receipt.artifact.weightsLocale} ${receipt.artifact.weightsVersion} · resolver: ${receipt.artifact.resolverBackend}`
	)

	console.log(
		`coverage: ${route.coverageDatabasePath}\n` +
			`  ${route.coverageLayer.name} ${route.coverageLayer.version} (${route.coverageLayer.tier}, ${route.coverageLayer.license}, ` +
			`${route.coverageLayer.source} ${route.coverageLayer.sourceVintage}) · class ${route.surveyedCategoryID}\n` +
			`  ${route.coverageCells} cells at res ${route.coverageResolution}, ${route.exclusionGradeEmptyCells} of them exclusion-grade and empty`
	)

	console.log(
		`geographic model ${route.modelVersion} → affording categories: ${route.affordingCategoryIDs.join(", ")}\n` +
			`semantic phrase route: ${receipt.semanticRouteInjected ? "injected (activity-phrased rows)" : "not injected"}\n`
	)

	console.log("  group             id           holds  registered                      observed")

	for (const row of receipt.rows) {
		console.log(
			`  ${row.group.padEnd(17)} ${row.id.padEnd(12)} ${row.holds ? " ✓  " : " ✗  "}  ${row.expectedResult.padEnd(31)} ${row.observedResult}` +
				(row.searchedCategories ? `  searched [${row.searchedCategories.join(", ")}]` : "")
		)
	}

	if (receipt.observations.length) {
		console.log("\nabsence observations — both provenances on every line:")

		for (const observation of receipt.observations) {
			console.log(`  ${observation.rowID}: ${observation.line}`)
		}
	}

	console.log("")

	for (const reason of receipt.verdict.reasons) {
		console.log(`  ${reason}`)
	}

	for (const breach of receipt.verdict.breaches) {
		console.log(`  breach — ${breach}`)
	}

	console.log(`\n  → ${receipt.verdict.decision}`)
}
