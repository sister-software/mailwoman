/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The live half of the absence-observation probe (#1965): load the frozen row set, run every row through
 *   the SAME pipeline construction the POI board uses, ask the negative-evidence route what it makes of
 *   each answer, and emit a receipt.
 *
 *   THIS MODULE DECIDES NOTHING IT DID NOT READ. Every row and its registered outcome come from
 *   `probe-definition.json`, which {@linkcode loadAbsenceProbeDefinition} refuses to hand over if its
 *   content hash has moved. The runner adds the measurements and the artifact identity.
 *
 *   THE PIPELINE IS UNCHANGED, AND THAT IS THE POINT. No route is injected into the runtime pipeline for
 *   the absence work: the pipeline answers, and the route reads the finished answer afterwards. The one
 *   route this runner does inject is the semantic phrase route (#1929), and only because the
 *   activity-phrased rows cannot reach a category without it — a row that never formed a POI intent would
 *   record a silence the absence route never caused.
 *
 *   THE RECEIPT CARRIES BOTH IDENTITIES. A silence over an unnamed coverage layer is not reproducible, and
 *   neither is a firing. So the receipt records the coverage layer's own manifest, the recovered coverage
 *   resolution, the exclusion-grade empty cell count, the compiled model version, the poi.db the executor
 *   queried, the resolver backend that answered and the weights version — and when one of those cannot be
 *   read it says so in place rather than omitting the field.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { repoRootPath } from "@mailwoman/core/paths"
import type { PipelineOpts, PipelineResult } from "@mailwoman/core/pipeline"
import { compareByCodePoint } from "@mailwoman/core/strings/compare"

import {
	type AbsenceCounts,
	type AbsenceExpectedOutcome,
	type AbsenceProbeRow,
	type AbsenceRowOutcome,
	type AbsenceVerdict,
	absenceProbeDefinitionHash,
	computeAbsenceCounts,
	decideAbsenceProbe,
	loadAbsenceProbeDefinition,
} from "#eval-harness/absence-observation/probe"
import { createPOIBoardPipeline, type POIBoardOptions } from "#eval-harness/poi-board"
import { type PreregisteredArtifactIdentity, readArtifactIdentity } from "#eval-harness/preregistration"
import { buildSHA } from "#gazetteer-pipeline/stamp-manifest"
import {
	type AbsenceObservation,
	type AbsenceObservationRoute,
	type AbsenceRouteIdentity,
	createAbsenceObservationRoute,
	createSemanticObservationRoute,
	describeAbsenceObservation,
	type SemanticObservationRoute,
} from "#observations/index"

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
	/**
	 * The negative-evidence route as built — the coverage layer, the recovered resolution, the model version.
	 */
	absenceRoute: AbsenceRouteIdentity
	/**
	 * Whether the semantic phrase route was injected for the activity-phrased rows.
	 */
	semanticRouteInjected: boolean
	rows: AbsenceRowOutcome[]
	observations: AbsenceRowObservation[]
	counts: AbsenceCounts
	verdict: AbsenceVerdict
}

export interface AbsenceProbeOptions extends POIBoardOptions {
	/**
	 * Override the frozen pre-registration — for a test that wants a synthetic definition. A run with no override reads
	 * the committed one.
	 */
	definitionPath?: string
	freezePath?: string
	/**
	 * The sealed coverage layer whose cells qualify the absence. Absent resolves the definition's own `coverageLayerFile`
	 * under `$MAILWOMAN_DATA_ROOT/poi/`.
	 */
	coverageDatabasePath?: string
	/**
	 * Commit sha recorded in the receipt. Defaults to the checkout's own short HEAD.
	 */
	gitCommit?: string
}

/**
 * Run the probe.
 *
 * The POI database the executor queries DEFAULTS to the coverage layer itself, and that default is required: an absence
 * qualified by one layer's coverage while the answer came out of a different layer is a claim about two artifacts that
 * were never compared. Pass `db` explicitly only to measure that mismatch on purpose.
 */
export async function runAbsenceObservationProbe(options: AbsenceProbeOptions = {}): Promise<AbsenceProbeReceipt> {
	const definition = await loadAbsenceProbeDefinition(options.definitionPath, options.freezePath)

	const coverageDatabasePath = options.coverageDatabasePath ?? String(dataRootPath("poi", definition.coverageLayerFile))

	const needsSemanticRoute = definition.rows.some((row) => row.requiresSemanticRoute)
	const semanticRoute = needsSemanticRoute ? await createSemanticObservationRoute() : undefined
	const absenceRoute = await createAbsenceObservationRoute({ coverageDatabasePath })

	using pipelineHandle = await createPOIBoardPipeline({
		...options,
		// After the spread, never before: `...options` carries an explicit `db: undefined` when the caller passed
		// none, which would overwrite the default and send the executor to the data root's general poi.db.
		db: options.db ?? coverageDatabasePath,
		...(semanticRoute ? { poiSemanticLookup: semanticRoute.lookup } : {}),
	})

	const { pipeline, db, backend } = pipelineHandle

	const rows: AbsenceRowOutcome[] = []
	const observations: AbsenceRowObservation[] = []

	try {
		for (const row of definition.rows) {
			const { outcome, observation } = await gradeRow(pipeline, absenceRoute, semanticRoute, row)

			rows.push(outcome)

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
		gitCommit: options.gitCommit ?? buildSHA(String(repoRootPath())),
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
	semanticRoute: SemanticObservationRoute | undefined,
	row: AbsenceProbeRow
): Promise<{ outcome: AbsenceRowOutcome; observation?: AbsenceRowObservation }> {
	const runOpts: PipelineOpts = row.locale ? { locale: row.locale } : {}
	const result = await pipeline(row.query, runOpts)

	// The semantic route records a firing per probe of its lexicon rung; draining keeps one row's firings from being
	// attributed to the next. This probe does not report them — #1928's receipt owns that — but leaving them to
	// accumulate would grow unbounded across a run.
	semanticRoute?.takeObservations()

	const decision = await absenceRoute.observe(result.poiIntent)
	const observedOutcome: AbsenceExpectedOutcome = decision.fired ? "absence_observation" : decision.refusal

	const poiOutcome = !result.poiIntent ? "none" : result.poiIntent.type === "abstain" ? "abstain" : "intent"

	// The set the branch searched, after the anchor's country bound it (#1999). Compared as sets: the lookup's
	// enumeration order states no preference, so the registration is code-point ordered and so is this.
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

	const outcome: AbsenceRowOutcome = {
		id: row.id,
		group: row.group,
		query: row.query,
		expectedOutcome: row.expectedOutcome,
		observedOutcome,
		holds: observedOutcome === row.expectedOutcome && !searchedSetBreach,
		...(searchedCategories ? { searchedCategories } : {}),
		...(searchedSetBreach ? { searchedSetBreach } : {}),
		...(decision.fired ? { observationLine: describeAbsenceObservation(decision.observation) } : {}),
		poiOutcome,
		...(result.poiIntent?.type === "abstain" ? { abstainReason: result.poiIntent.reason } : {}),
		...(result.poiIntent?.type === "intent" && result.poiIntent.results
			? { resultsReturned: result.poiIntent.results.length }
			: {}),
	}

	if (!decision.fired) return { outcome }

	return {
		outcome,
		observation: {
			rowID: row.id,
			line: describeAbsenceObservation(decision.observation),
			...decision.observation,
		},
	}
}

/**
 * The human-readable report. Prints each row's registered outcome beside the observed one, so a reader never has to
 * open the definition to know what the row was asserting.
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
			`  ${row.group.padEnd(17)} ${row.id.padEnd(12)} ${row.holds ? " ✓  " : " ✗  "}  ${row.expectedOutcome.padEnd(31)} ${row.observedOutcome}` +
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
