/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The live half of the semantic-utility probe (#1928): load the frozen pre-registration, run its target
 *   and control rows through the SAME pipeline construction the POI board uses, and emit a receipt.
 *
 *   THIS MODULE DECIDES NOTHING IT DID NOT READ. Every row, every threshold and the baseline it compares
 *   against come from `probe-definition.json`, which {@linkcode loadProbeDefinition} refuses to hand over
 *   if its content hash has moved. The runner adds an ARM LABEL and the measurements; #1929 supplies one
 *   semantic observation and runs the same command, and #1930 reads the two receipts.
 *
 *   THE RECEIPT CARRIES ARTIFACT IDENTITY, not just numbers. A pass rate over an unnamed database and an
 *   unnamed weights package is not reproducible, and the two arms have to be shown to have run against the
 *   same ones. So the receipt records the poi.db path with its own `layer_manifest` row, the resolver
 *   backend that answered, and the weights package version — and when one of those cannot be read it says
 *   so in place rather than omitting the field.
 *
 *   AN ARM LABEL IS NOT A MEASUREMENT OF WHAT RAN. `semanticRoute` records whether the injected route was
 *   actually built, and what it was built from — a route dropped on the way in produces exactly the numbers
 *   a route that changed nothing produces, and the two are opposite findings. Every firing is recorded
 *   beside its row as an observation carrying the assertion, its modality and every provenance record
 *   behind it, so the receipt states on whose authority each answered row's category was chosen.
 */

import { readFileSync } from "node:fs"

import { parseJSONStrict } from "@mailwoman/core/objects"
import type { PipelineOpts, PipelineResult } from "@mailwoman/core/pipeline"
import { repoRootPath } from "@mailwoman/core/utils"
import { resolveWeights } from "@mailwoman/neural/weights"
import { JSONSpliterator } from "spliterator"

import { type LayerManifest, probeManifest } from "../../data-inventory.ts"
import { buildSHA } from "../../gazetteer-pipeline/stamp-manifest.ts"
import {
	createSemanticObservationRoute,
	type SemanticObservation,
	type SemanticObservationRoute,
	type SemanticRouteIdentity,
} from "../../observations/index.ts"
import {
	createPOIBoardPipeline,
	POI_BOARD_FIXTURES,
	type POIBoardFixture,
	type POIBoardOptions,
	type POIBoardOutcome,
	type POIBoardResolverBackend,
} from "../poi-board.ts"
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
} from "./probe.ts"

/**
 * Which arm produced a receipt. `baseline` is the pre-injection run this pre-registration commits; #1929 names its own.
 */
export type ProbeArm = string

export interface ProbeArtifactIdentity {
	poiDatabasePath: string
	/**
	 * The database's own `layer_manifest` row, or the reason it could not be read. Never silently absent: an unstamped
	 * artifact and an unreadable one are different findings, and both matter to a reproduction.
	 */
	poiLayerManifest?: LayerManifest
	poiLayerManifestNote?: string
	resolverBackend: "candidate" | "wof-fts" | "none"
	weightsLocale: string
	weightsModelPath: string
	weightsVersion: string
}

/**
 * One recorded firing of the injected route, addressed to the row it happened on.
 */
export interface ProbeRowObservation extends SemanticObservation {
	rowID: string
}

/**
 * What the run did about the injected semantic route — read from the route that was BUILT, never from the arm label.
 */
export interface ProbeSemanticRouteRecord extends Partial<SemanticRouteIdentity> {
	/**
	 * Whether a route was constructed and injected at all. `false` is the un-injected pipeline, whatever the arm is
	 * called.
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
	 * The injected route as built. Present on every receipt, including a run with no route: an omitted field would make
	 * "no route was asked for" and "this receipt predates the field" the same reading.
	 */
	semanticRoute: ProbeSemanticRouteRecord
	rows: ProbeRowOutcome[]
	/**
	 * Every firing of the injected route, in row order. Empty on an un-injected run.
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
	 * Override the frozen pre-registration — for a test that wants a synthetic definition. A run with no override reads
	 * the committed one.
	 */
	definitionPath?: string
	freezePath?: string
	/**
	 * The committed board file control rows resolve against.
	 */
	boardFixturesPath?: string
	/**
	 * Commit sha recorded in the receipt. Defaults to the checkout's own short HEAD.
	 */
	gitCommit?: string
	/**
	 * Build the one semantic observation route (#1929) and inject it into the pipeline this run constructs. Absent or
	 * `false` — the default — runs the un-injected pipeline, which is what the frozen baseline was measured against.
	 */
	semanticObservation?: boolean
}

interface ModelCard {
	version: string
}

function readWeightsIdentity(options: SemanticProbeOptions): {
	weightsLocale: string
	weightsModelPath: string
	weightsVersion: string
} {
	const locale = options.locale ?? "en-US"
	const resolved = resolveWeights({ locale, cacheRoot: options.weightsCacheRoot })
	const cardPath = resolved.modelCardPath ?? resolved.baseModelCardPath

	if (!cardPath) {
		return { weightsLocale: locale, weightsModelPath: resolved.modelPath, weightsVersion: "no model-card resolved" }
	}

	const card = parseJSONStrict<ModelCard>(readFileSync(cardPath, "utf8"))

	return { weightsLocale: locale, weightsModelPath: resolved.modelPath, weightsVersion: card.version }
}

function readArtifactIdentity(
	db: string,
	backend: POIBoardResolverBackend,
	options: SemanticProbeOptions
): ProbeArtifactIdentity {
	const probed = probeManifest(db)

	return {
		poiDatabasePath: db,
		...(probed.manifest ? { poiLayerManifest: probed.manifest } : {}),
		...(probed.manifest
			? {}
			: { poiLayerManifestNote: probed.error ?? "the database carries no layer_manifest table" }),
		resolverBackend: backend,
		...readWeightsIdentity(options),
	}
}

/**
 * Run one arm of the probe.
 *
 * The control rows are read from the COMMITTED board file and matched against the pre-registration's frozen copies, so
 * a control that has been edited on the board stops the run instead of quietly grading a different row.
 */
export async function runSemanticUtilityProbe(options: SemanticProbeOptions = {}): Promise<ProbeReceipt> {
	const definition = loadProbeDefinition(options.definitionPath, options.freezePath)
	const boardPath = options.boardFixturesPath ?? POI_BOARD_FIXTURES
	const committed = await Array.fromAsync(JSONSpliterator.fromAsync<POIBoardFixture>(boardPath))
	const controls = resolveControlRows(definition, committed)
	const groupByID = new Map(definition.controlRows.map((row) => [row.id, row.group]))

	const route = options.semanticObservation ? await createSemanticObservationRoute() : undefined

	const { pipeline, db, backend, close } = await createPOIBoardPipeline({
		...options,
		...(route ? { poiSemanticLookup: route.lookup } : {}),
	})

	const rows: ProbeRowOutcome[] = []
	const semanticObservations: ProbeRowObservation[] = []

	try {
		for (const target of definition.targetRows) {
			rows.push(await gradeRow(pipeline, definition, target, "target"))
			semanticObservations.push(...drainObservations(route, target.id))
		}

		for (const control of controls) {
			const outcome = await gradeRow(pipeline, definition, control, "control")

			rows.push({ ...outcome, group: groupByID.get(control.id) })
			semanticObservations.push(...drainObservations(route, control.id))
		}
	} finally {
		close()
	}

	const counts = computeProbeCounts(definition, rows)

	return {
		probeID: definition.probeID,
		definitionVersion: definition.version,
		definitionSHA256: probeDefinitionHash(definition),
		arm: options.arm ?? "baseline",
		generatedAt: new Date().toISOString(),
		gitCommit: options.gitCommit ?? buildSHA(String(repoRootPath())),
		artifact: readArtifactIdentity(db, backend, options),
		semanticRoute: route ? { enabled: true, ...route.identity } : { enabled: false },
		rows,
		semanticObservations,
		counts,
		verdict: decideProbe(definition, counts),
	}
}

/**
 * Take everything the route recorded while one row ran, addressed to that row. Empty when no route was injected.
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
 * The human-readable report. Prints the frozen bars beside every measurement, so a reader never has to open the
 * definition to know what the number was compared against.
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
				`  ${observation.rowID.padEnd(16)} ${JSON.stringify(observation.matchedPhrase)} → ${observation.activity} → ${observation.concept} → ${observation.mapping.vocabulary}:${observation.categoryID}`
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
