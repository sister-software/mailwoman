/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Runs the live half of the semantic-utility probe. It loads the frozen pre-registration and sends target and control
 *   rows through the pipeline construction used by the POI board. It then emits a receipt.
 *
 *   This module decides from `probe-definition.json`. That file supplies the rows.
 *   It also defines the baseline and thresholds. {@linkcode loadProbeDefinition} checks its content hash before returning it.
 *
 *   The receipt records artifact identity and measurement values. It reports an unreadable field at its location.
 *   A pass rate without database and weight identities cannot be reproduced.
 *
 *   A dropped route can produce the same numbers as a route with no behavior change.
 *   `semanticRoute` records whether the run built the injected route and what it built it from.
 *   Each firing is recorded beside its row with its provenance.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import type { PipelineOpts, PipelineResult } from "@mailwoman/core/pipeline"
import { JSONSpliterator } from "spliterator"

import {
	createPOIBoardPipeline,
	POI_BOARD_FIXTURES,
	type POIBoardFixture,
	type POIBoardOptions,
	type POIBoardOutcome,
} from "#eval-harness/poi/board"
import { type PreregisteredArtifactIdentity, readArtifactIdentity } from "#eval-harness/preregistration"
import {
	computeProbeCounts,
	decideProbe,
	gradeWithComparator,
	loadProbeDefinition,
	poiOutcomeShape,
	type ProbeCounts,
	type ProbeRowOutcome,
	type ProbeVerdict,
	probeDefinitionHash,
	resolveControlRows,
	type SemanticProbeDefinition,
} from "#eval-harness/semantic-utility/probe"
import { buildSHA } from "#gazetteer-pipeline/stamp-manifest"
import {
	createSemanticObservationRoute,
	type SemanticObservation,
	type SemanticObservationRoute,
	type SemanticRouteIdentity,
} from "#observations/index"

/**
 * Which arm produced a receipt; `baseline` is the pre-injection run this pre-registration commits.
 */
export type ProbeArm = string

export type ProbeArtifactIdentity = PreregisteredArtifactIdentity

/**
 * One recorded firing of the injected route, addressed to the row it happened on.
 */
export interface ProbeRowObservation extends SemanticObservation {
	rowID: string
}

/**
 * What the run did about the injected semantic route, read from the route that
 * was built rather than from the arm label.
 */
export interface ProbeSemanticRouteRecord extends Partial<SemanticRouteIdentity> {
	/**
	 * Whether a route was constructed and injected at all; `false` is the un-injected
	 * pipeline, whatever the arm is called.
	 */
	enabled: boolean
}

export interface ProbeReceipt {
	probeID: string
	definitionVersion: string
	definitionSHA256: string
	arm: ProbeArm
	generatedAt: string
	gitCommit: string
	artifact: ProbeArtifactIdentity
	/**
	 * The injected route as built, present on every receipt so an omitted field cannot make
	 * "no route was asked for" and "this receipt predates the field" the same reading.
	 */
	semanticRoute: ProbeSemanticRouteRecord
	rows: ProbeRowOutcome[]
	/**
	 * Every firing of the injected route, in row order.
	 * Empty on an un-injected run.
	 */
	semanticObservations: ProbeRowObservation[]
	counts: ProbeCounts
	verdict: ProbeVerdict
}

export interface SemanticProbeOptions extends POIBoardOptions {
	/**
	 * The arm label written into the receipt.
	 */
	arm?: ProbeArm
	/**
	 * Override the frozen pre-registration for a synthetic definition. a run with
	 * no override reads the committed one.
	 */
	definitionPath?: string
	freezePath?: string
	/**
	 * The committed board file control rows resolve against.
	 */
	boardFixturesPath?: string
	/**
	 * Commit sha recorded in the receipt.
	 *
	 * Defaults to the checkout's own short head.
	 */
	gitCommit?: string
	/**
	 * Build the semantic observation route and inject it into the pipeline for this run.
	 *
	 * `false` or an absent value runs the un-injected pipeline used to measure the frozen baseline.
	 */
	semanticObservation?: boolean
}

/**
 * Run one arm of the probe, reading control rows from the committed board file and matching
 * them against the pre-registration's frozen copies so an edited control stops the run.
 */
export async function runSemanticUtilityProbe(options: SemanticProbeOptions = {}): Promise<ProbeReceipt> {
	const definition = await loadProbeDefinition(options.definitionPath, options.freezePath)
	const boardPath = options.boardFixturesPath ?? POI_BOARD_FIXTURES
	const controlIDs = new Set(definition.controlRows.map((row) => row.id))

	const committed = await JSONSpliterator.fromAsync<POIBoardFixture>(boardPath)
		.filter((fixture) => controlIDs.has(fixture.id))
		.toArray()

	const controls = resolveControlRows(definition, committed)
	const groupByID = new Map(definition.controlRows.map((row) => [row.id, row.group]))

	const route = options.semanticObservation ? await createSemanticObservationRoute() : undefined

	using pipelineHandle = await createPOIBoardPipeline({
		...options,
		...(route ? { poiSemanticLookup: route.lookup } : {}),
	})

	const { pipeline, db, backend } = pipelineHandle

	const rows: ProbeRowOutcome[] = []
	const semanticObservations: ProbeRowObservation[] = []

	for (const target of definition.targetRows) {
		rows.push(await gradeRow(pipeline, definition, target, "target"))
		semanticObservations.push(...drainObservations(route, target.id))
	}

	for (const control of controls) {
		const outcome = await gradeRow(pipeline, definition, control, "control")

		rows.push({ ...outcome, group: groupByID.get(control.id) })
		semanticObservations.push(...drainObservations(route, control.id))
	}

	const counts = computeProbeCounts(definition, rows)

	return {
		probeID: definition.probeID,
		definitionVersion: definition.version,
		definitionSHA256: probeDefinitionHash(definition),
		arm: options.arm ?? "baseline",
		generatedAt: new Date().toISOString(),
		gitCommit: options.gitCommit ?? buildSHA(repoRootPath()),
		artifact: await readArtifactIdentity(db, backend, options),
		semanticRoute: route ? { enabled: true, ...route.identity } : { enabled: false },
		rows,
		semanticObservations,
		counts,
		verdict: decideProbe(definition, counts),
	}
}

/**
 * Take everything the route recorded while one row ran, addressed to that row. empty
 * when no route was injected.
 */
function drainObservations(route: SemanticObservationRoute | undefined, rowID: string): ProbeRowObservation[] {
	if (!route) return []

	return route.takeObservations().map((observation) => ({ rowID, ...observation }))
}

async function gradeRow(
	pipeline: (raw: string, runOpts?: PipelineOpts) => Promise<PipelineResult>,
	definition: SemanticProbeDefinition,
	fixture: POIBoardFixture,
	role: "target" | "control"
): Promise<ProbeRowOutcome> {
	const runOpts: PipelineOpts = fixture.locale ? { locale: fixture.locale } : {}
	const result = await pipeline(fixture.query, runOpts)
	const outcome: POIBoardOutcome = { path: result.path, poiIntent: result.poiIntent }
	const shape = poiOutcomeShape(outcome)

	return {
		id: fixture.id,
		role,
		query: fixture.query,
		shape,
		...(outcome.poiIntent?.type === "abstain" ? { abstainReason: outcome.poiIntent.reason } : {}),
		grade: gradeWithComparator(definition.outcomeComparator, fixture, outcome),
	}
}

/**
 * The human-readable report, printing the frozen bars beside every measurement.
 */
export function printProbeReceipt(receipt: ProbeReceipt): void {
	console.log(`\nsemantic-utility probe ${receipt.probeID} v${receipt.definitionVersion} — arm: ${receipt.arm}`)
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
		`semantic route: ${
			receipt.semanticRoute.enabled
				? `${receipt.semanticRoute.phraseLexiconID} v${receipt.semanticRoute.phraseLexiconVersion} (${receipt.semanticRoute.declaredPhrases} declared phrases) → geographic model ${receipt.semanticRoute.modelVersion} → ${receipt.semanticRoute.reachableCategoryIDs?.join(", ")}`
				: "not injected"
		}\n`
	)

	console.log("  role     id               shape                  pass  detail")

	for (const row of receipt.rows) {
		console.log(
			`  ${row.role.padEnd(8)} ${row.id.padEnd(16)} ${row.shape.padEnd(22)} ${row.grade.pass ? " ✓  " : " ✗  "}  ${row.grade.detail}`
		)
	}

	if (receipt.semanticObservations.length) {
		console.log("\nobservations recorded beside the answers — on whose authority the category was chosen:")

		for (const observation of receipt.semanticObservations) {
			console.log(
				`  ${observation.rowID.padEnd(16)} ${stringifyJSON(observation.matchedPhrase)} → ${observation.activity} → ${observation.concept} → ${observation.mapping.vocabulary}:${observation.categoryID}`
			)

			console.log(
				`  ${" ".repeat(16)} ${observation.assertion.id} (${observation.assertion.relation}, ${observation.assertion.modality}) · ${observation.assertion.provenance.source} · ${observation.assertion.provenance.sourceRecord ?? "no source record"}`
			)

			console.log(
				`  ${" ".repeat(16)} phrase from ${observation.phraseLexiconID} v${observation.phraseLexiconVersion} · ${observation.phraseProvenance.source} · attested by ${observation.phraseAttestation.kind} ${observation.phraseAttestation.reference}`
			)
		}
	}

	console.log("")

	for (const reason of receipt.verdict.reasons) {
		console.log(`  ${reason}`)
	}

	console.log(`\n  → ${receipt.verdict.decision}`)
}
