/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The live half of the phase-2 decision (#1967): load the frozen pre-registration, run the instruments its
 *   checks read, and emit one receipt carrying the arithmetic against every bar.
 *
 *   THIS MODULE DECIDES NOTHING IT DID NOT READ. Lanes, checks, denominators, bars, artifact pins and the one
 *   marker query all come from `decision-definition.json`, which {@linkcode loadPhase2Definition} refuses to
 *   hand over if its content hash has moved. The runner supplies measurements and nothing else.
 *
 *   IT RUNS THE EXISTING INSTRUMENTS RATHER THAN RE-DERIVING THEM. Both probe arms come from
 *   {@linkcode runSemanticUtilityProbe}, the asymmetry from {@linkcode runAbsenceObservationProbe}, the floors
 *   from {@linkcode runPOIBoard} and the laws from {@linkcode measureConformance} — the same call the
 *   `eval conformance` command narrates. A second orchestration free to load a different suite set or a
 *   different backend would report numbers that look like these and answer a different question.
 *
 *   THE RECEIPT CARRIES ARTIFACT IDENTITY AND SAYS WHERE IT DEVIATES. A run on a rebuilt `poi.db` or a bumped
 *   weights package is still a run; it is simply not comparable to the merged-PR receipts the ruler names as
 *   baselines. So the observed identity is recorded beside the pins, every difference is named, and the
 *   verdict carries `comparability` — reported, never a decision input.
 *
 *   THE RECORDING IS THE OPERATOR'S. The receipt states what the ruler maps to and carries `recorded: false`.
 *   Nothing here writes a verdict onto the issue.
 */

import { readActivityLexicon } from "@mailwoman/activity-lexicon/lexicon"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { QueryIntentCode } from "@mailwoman/core/pipeline"
import { repoRootPath } from "@mailwoman/core/utils"
import { basename } from "path-ts"

import { runAbsenceObservationProbe } from "#eval-harness/absence-observation/run"
import { measureConformance } from "#eval-harness/conformance/command"
import {
	decidePhase2,
	evaluatePhase2Checks,
	describeBar,
	loadPhase2Definition,
	type Phase2ArtifactPins,
	type Phase2CheckOutcome,
	type Phase2DecisionDefinition,
	type Phase2Instrument,
	type Phase2Measurement,
	type Phase2Reading,
	type Phase2Verdict,
	phase2DefinitionHash,
	instrumentFor,
} from "#eval-harness/phase-2-decision/decision"
import { createPOIBoardPipeline, type POIBoardOptions, runPOIBoard } from "#eval-harness/poi-board"
import { runSemanticUtilityProbe } from "#eval-harness/semantic-utility/run"
import { buildSHA } from "#gazetteer-pipeline/stamp-manifest"
import { createSemanticObservationRoute, semanticObservationMarkers } from "#observations/index"

/**
 * The committed collision census the recognition lane's control checks read.
 *
 * Read rather than re-run on purpose: the census scans every `name_key` in the shipped `poi.db` and takes about eleven
 * minutes, and its own reader header says why the fast path is wrong. Its recorded lexicon and layer identity are
 * checked against the pins, so a stale census is a named deviation instead of a silent one.
 */
export const COLLISION_CENSUS_PATH = "packages/mailwoman/eval-harness/activity-lexicon/collision-census.json"

interface CollisionCensus {
	lexicon: { lexiconID: string; version: string; declaredPhrases: number }
	poiDatabase: { layerManifest?: { version: string; build_sha: string } }
	probes: { distinct: number }
	categoryLexicon: { collisions: unknown[] }
	nameLexicon: { counts: { exactQueryShaped: number; exactLegitimate: number } }
}

/**
 * What one instrument was, as it ran.
 */
export interface Phase2InstrumentRecord {
	instrument: Phase2Instrument
	/**
	 * The instrument's own identity line — the artifacts and the frozen ruler it read.
	 */
	identity: string
}

export interface Phase2ObservedArtifacts {
	poiDatabasePath: string
	poiLayerManifestVersion: string
	poiLayerBuildSHA: string
	weightsLocale: string
	weightsVersion: string
	resolverBackend: string
	geographicModelVersion: string
	phraseLexiconID: string
	phraseLexiconVersion: string
	declaredPhrases: number
	semanticUtilityDefinitionSHA256: string
	absenceDefinitionSHA256: string
	coverageLayerFile: string
	coverageLayerVersion: string
}

export interface Phase2LaneReport {
	id: string
	status: string
	issue: string
	claim: string
	landed: string
	registeredChecks: number
	checksMet: number
	blockedBy?: string
	blockedReason?: string
	/**
	 * The rows a blocked lane will read once it is unblocked, and what each reads today. Present only on a blocked lane,
	 * and never counted anywhere.
	 */
	plannedChecks?: { id: string; measures: string; todayReads: string }[]
}

export interface Phase2Receipt {
	decisionID: string
	definitionVersion: string
	definitionSHA256: string
	generatedAt: string
	gitCommit: string
	artifact: Phase2ObservedArtifacts
	artifactPins: Phase2ArtifactPins
	artifactPinDeviations: string[]
	instruments: Phase2InstrumentRecord[]
	readings: Phase2Reading[]
	lanes: Phase2LaneReport[]
	checks: Phase2CheckOutcome[]
	verdict: Phase2Verdict
	/**
	 * Always `false`. The ruler maps measurements onto one decision; recording it is the operator's, per #1967.
	 */
	recorded: false
	recordingNote: string
}

export interface Phase2RunOptions extends POIBoardOptions {
	/**
	 * Override the frozen pre-registration — for a test that wants a synthetic definition. A run with no override reads
	 * the committed one.
	 */
	definitionPath?: string
	freezePath?: string
	/**
	 * The committed board file the semantic-utility control rows resolve against.
	 */
	boardFixturesPath?: string
	/**
	 * The sealed coverage layer the absence lane reads. Absent resolves the absence pre-registration's own file.
	 */
	coverageDatabasePath?: string
	/**
	 * The committed collision census. Absent reads the one in this repository.
	 */
	collisionCensusPath?: string
	/**
	 * Commit sha recorded in the receipt. Defaults to the checkout's own short HEAD.
	 */
	gitCommit?: string
}

function record(readings: Phase2Reading[], measurement: Phase2Measurement, observed: number, detail: string): void {
	readings.push({ measurement, observed, detail })
}

function matches(observed: string | number, pinned: string | number): number {
	return observed === pinned ? 1 : 0
}

/**
 * Run every instrument the registered checks read, and answer with one reading per measurement.
 *
 * Instruments are selected from the CHECKS rather than run unconditionally: a definition that registers no absence
 * check must not need a build-local coverage layer to produce a receipt.
 */
async function measure(
	definition: Phase2DecisionDefinition,
	options: Phase2RunOptions
): Promise<{
	readings: Phase2Reading[]
	instruments: Phase2InstrumentRecord[]
	artifact: Phase2ObservedArtifacts
	deviations: string[]
}> {
	const needed = new Set<Phase2Instrument>(definition.checks.map((check) => instrumentFor(check.measurement)))
	const readings: Phase2Reading[] = []
	const instruments: Phase2InstrumentRecord[] = []
	const pins = definition.artifactPins

	const baseline = await runSemanticUtilityProbe({
		...options,
		arm: "baseline",
		...(options.boardFixturesPath ? { boardFixturesPath: options.boardFixturesPath } : {}),
	})

	const treatment = await runSemanticUtilityProbe({
		...options,
		arm: "semantic-observation",
		semanticObservation: true,
		...(options.boardFixturesPath ? { boardFixturesPath: options.boardFixturesPath } : {}),
	})

	const route = treatment.semanticRoute
	const manifest = treatment.artifact.poiLayerManifest

	instruments.push({
		instrument: "semantic_utility_probe",
		identity:
			`#1928 ruler ${treatment.definitionSHA256.slice(0, 8)} · both arms · ` +
			`route ${route.enabled ? `${route.phraseLexiconID} v${route.phraseLexiconVersion} (${route.declaredPhrases} phrases) → model ${route.modelVersion}` : "not injected"}`,
	})

	record(
		readings,
		"semantic_utility.baseline.primary_passes",
		baseline.counts.primaryNumerator,
		`un-injected arm: ${baseline.counts.primaryNumerator}/${baseline.counts.primaryDenominator} target rows answered, verdict ${baseline.verdict.decision}`
	)

	record(
		readings,
		"semantic_utility.baseline.control_holds",
		baseline.counts.controlHoldNumerator,
		`un-injected arm: ${baseline.counts.controlHoldNumerator}/${baseline.counts.controlDenominator} controls hold`
	)

	record(
		readings,
		"semantic_utility.treatment.primary_passes",
		treatment.counts.primaryNumerator,
		`route-injected arm: ${treatment.counts.primaryNumerator}/${treatment.counts.primaryDenominator} target rows answered on the board's own comparator`
	)

	record(
		readings,
		"semantic_utility.treatment.diagnostic_reaches",
		treatment.counts.diagnosticNumerator,
		`route-injected arm: ${treatment.counts.diagnosticNumerator}/${treatment.counts.diagnosticDenominator} target rows reached the POI branch`
	)

	record(
		readings,
		"semantic_utility.treatment.frozen_verdict_is_go",
		matches(treatment.verdict.decision, "GO"),
		`the frozen #1928 ruler reads ${treatment.verdict.decision} on the route-injected arm`
	)

	record(
		readings,
		"semantic_utility.treatment.control_holds",
		treatment.counts.controlHoldNumerator,
		`route-injected arm: ${treatment.counts.controlHoldNumerator}/${treatment.counts.controlDenominator} controls hold`
	)

	const hashesHold =
		treatment.definitionSHA256 === pins.semanticUtilityDefinitionSHA256 &&
		baseline.definitionSHA256 === pins.semanticUtilityDefinitionSHA256

	record(
		readings,
		"semantic_utility.definition_hash_matches_pin",
		hashesHold ? 1 : 0,
		hashesHold
			? `both arms read #1928 ruler ${treatment.definitionSHA256}`
			: `#1928 ruler moved: baseline ${baseline.definitionSHA256}, treatment ${treatment.definitionSHA256}, pinned ${pins.semanticUtilityDefinitionSHA256}`
	)

	const routeHolds =
		route.enabled &&
		route.phraseLexiconID === pins.phraseLexiconID &&
		route.phraseLexiconVersion === pins.phraseLexiconVersion &&
		route.declaredPhrases === pins.declaredPhrases &&
		route.modelVersion === pins.geographicModelVersion

	record(
		readings,
		"semantic_utility.route_identity_matches_pins",
		routeHolds ? 1 : 0,
		route.enabled
			? `built from ${route.phraseLexiconID} v${route.phraseLexiconVersion} (${route.declaredPhrases} declared phrases) → geographic model ${route.modelVersion} → ${route.reachableCategoryIDs?.join(", ")}`
			: "no route was built on the treatment arm — an arm label is not a measurement of what ran"
	)

	if (needed.has("activity_lexicon")) {
		const lexicon = await readActivityLexicon()
		const classes = new Set(lexicon.phrases.map((entry) => entry.attestation.kind))
		const scoped = lexicon.phrases.filter((entry) => entry.locales?.length).length

		instruments.push({
			instrument: "activity_lexicon",
			identity: `${lexicon.lexiconID} v${lexicon.version} · ${lexicon.phrases.length} entries`,
		})

		record(
			readings,
			"activity_lexicon.declared_phrases",
			lexicon.phrases.length,
			`${lexicon.lexiconID} v${lexicon.version} declares ${lexicon.phrases.length} surface forms`
		)

		record(
			readings,
			"activity_lexicon.attestation_classes",
			classes.size,
			`attestation classes in use: ${[...classes].toSorted().join(", ")}`
		)

		record(
			readings,
			"activity_lexicon.locale_scoped_entries",
			scoped,
			`${scoped} entries carry a locale scope: ${lexicon.phrases
				.filter((entry) => entry.locales?.length)
				.map((entry) => `${JSON.stringify(entry.phrase)} ${entry.locales?.join("/")}`)
				.join(", ")}`
		)
	}

	if (needed.has("committed_collision_census")) {
		const censusPath = options.collisionCensusPath ?? String(repoRootPath(COLLISION_CENSUS_PATH))
		const census = await readLocalJSONFile<CollisionCensus>(censusPath)

		const censusHolds =
			census.lexicon.lexiconID === pins.phraseLexiconID &&
			census.lexicon.version === pins.phraseLexiconVersion &&
			census.lexicon.declaredPhrases === pins.declaredPhrases &&
			census.poiDatabase.layerManifest?.version === pins.poiLayerManifestVersion

		instruments.push({
			instrument: "committed_collision_census",
			identity: `${COLLISION_CENSUS_PATH} · ${census.probes.distinct} probes · lexicon ${census.lexicon.lexiconID} v${census.lexicon.version} · poi ${census.poiDatabase.layerManifest?.version ?? "unstamped"}`,
		})

		record(
			readings,
			"collision_census.category_lexicon_collisions",
			census.categoryLexicon.collisions.length,
			`claimed by the committed category lexicon: ${census.categoryLexicon.collisions.length} of ${census.probes.distinct} probes`
		)

		record(
			readings,
			"collision_census.name_exact_legitimate_collisions",
			census.nameLexicon.counts.exactLegitimate,
			`claimed by a POI name adjudicated legitimate: ${census.nameLexicon.counts.exactLegitimate} of ${census.probes.distinct} probes`
		)

		record(
			readings,
			"collision_census.name_exact_query_shaped_collisions",
			census.nameLexicon.counts.exactQueryShaped,
			`claimed by a POI name adjudicated query-shaped: ${census.nameLexicon.counts.exactQueryShaped} of ${census.probes.distinct} probes`
		)

		record(
			readings,
			"collision_census.identity_matches_pins",
			censusHolds ? 1 : 0,
			censusHolds
				? `census taken at the pinned lexicon and layer`
				: `census identity differs from the pins: lexicon ${census.lexicon.lexiconID} v${census.lexicon.version} (${census.lexicon.declaredPhrases} phrases), poi ${census.poiDatabase.layerManifest?.version ?? "unstamped"}`
		)
	}

	let absenceHash = "not measured"
	let coverageFile = "not measured"
	let coverageVersion = "not measured"

	if (needed.has("absence_observation_probe")) {
		// `db` is deliberately NOT forwarded. The absence probe defaults the layer the executor queries to the COVERAGE
		// layer itself, and that default is the whole claim: an absence qualified by one layer's coverage while the
		// answer came out of another is a statement about two artifacts nobody compared. A `--db` meant for the board
		// would silently cross them.
		const absence = await runAbsenceObservationProbe({
			locale: options.locale,
			weightsCacheRoot: options.weightsCacheRoot,
			resolveDB: options.resolveDB,
			candidateDB: options.candidateDB,
			...(options.coverageDatabasePath ? { coverageDatabasePath: options.coverageDatabasePath } : {}),
			...(options.gitCommit ? { gitCommit: options.gitCommit } : {}),
		})

		absenceHash = absence.definitionSHA256
		coverageFile = basename(absence.absenceRoute.coverageDatabasePath)
		coverageVersion = absence.absenceRoute.coverageLayer.version

		instruments.push({
			instrument: "absence_observation_probe",
			identity:
				`#1965 ruler ${absence.definitionSHA256.slice(0, 8)} · coverage ${coverageFile} ` +
				`(${absence.absenceRoute.coverageLayer.name} ${coverageVersion}, ${absence.absenceRoute.coverageCells} cells at res ${absence.absenceRoute.coverageResolution}, ` +
				`${absence.absenceRoute.exclusionGradeEmptyCells} exclusion-grade and empty) · model ${absence.absenceRoute.modelVersion}`,
		})

		record(
			readings,
			"absence_probe.rows_holding",
			absence.counts.holds,
			`${absence.counts.holds}/${absence.counts.rows} registered rows produced the outcome registered for them, verdict ${absence.verdict.decision}`
		)

		record(
			readings,
			"absence_probe.targets_fired",
			absence.counts.targetsFired,
			`${absence.counts.targetsFired}/${absence.counts.targets} targets carry a coverage-qualified absence observation`
		)

		record(
			readings,
			"absence_probe.controls_silent",
			absence.counts.controlsSilent,
			`${absence.counts.controlsSilent}/${absence.counts.controls} controls stayed silent`
		)

		record(
			readings,
			"absence_probe.definition_hash_matches_pin",
			matches(absence.definitionSHA256, pins.absenceDefinitionSHA256),
			`#1965 ruler ${absence.definitionSHA256}`
		)
	}

	if (needed.has("poi_board")) {
		// `quiet` because this receipt is the report: the board's own table would print 56 rows between two of this
		// ruler's lines. `enforce` is left off deliberately — the floors are read as a MEASUREMENT here, and a breach
		// belongs in the verdict rather than in an exit code the ruler would have to interpret.
		const { report } = await runPOIBoard({
			...options,
			quiet: true,
			...(options.boardFixturesPath ? { fixturesPath: options.boardFixturesPath } : {}),
		})

		const unmet = report.floors.lines.filter((line) => !line.met)
		const countedPassing = Object.values(report.byExpectKind).reduce((sum, bucket) => sum + bucket.pass, 0)

		instruments.push({
			instrument: "poi_board",
			identity: `${report.db} · ${report.totalCases} committed rows, ${report.countedCases} counted, ${report.trackedCases} tracked`,
		})

		record(
			readings,
			"poi_board.floors_unmet",
			unmet.length,
			unmet.length
				? `floors unmet: ${unmet.map((line) => `${line.label} ${line.fraction}`).join(", ")}`
				: `all ${report.floors.lines.length} floors met: ${report.floors.lines.map((line) => `${line.label} ${line.fraction}`).join(", ")}`
		)

		record(
			readings,
			"poi_board.counted_rows",
			report.countedCases,
			`${report.countedCases} of ${report.totalCases} committed rows are counted toward the floors`
		)

		record(
			readings,
			"poi_board.counted_passing",
			countedPassing,
			`${countedPassing}/${report.countedCases} counted rows pass (${(report.overallPassRate * 100).toFixed(1)}%)`
		)

		record(
			readings,
			"poi_board.tracked_rows",
			report.trackedCases,
			`tracked rows: ${report.trackedCases} of ${report.totalCases} committed — run, graded, reported, never counted`
		)
	}

	if (needed.has("conformance_laws")) {
		// Named fields rather than the whole options object: the laws run through the Gauntlet's deps, which take a
		// weights root and a candidate gazetteer and nothing the POI board's options mean.
		const { laws, problems, measured } = await measureConformance({
			weightsCacheRoot: options.weightsCacheRoot,
			candidateDB: options.candidateDB,
		})

		if (!measured) {
			throw new Error(
				[
					"phase-2 decision: the conformance suites refused to run, so the surface lane has no reading:",
					...problems.map((problem) => `  - ${problem}`),
				].join("\n")
			)
		}

		instruments.push({
			instrument: "conformance_laws",
			identity: `${laws.length} laws (${laws.join(", ")})${measured.tracedObserver ? " · resolver trace ON" : ""}`,
		})

		record(
			readings,
			"conformance.decided_rows",
			measured.summary.gated,
			`${measured.summary.gated} rows gated and decided across ${laws.length} laws`
		)

		record(
			readings,
			"conformance.decided_failures",
			measured.summary.failures.length,
			measured.summary.failures.length
				? `violations: ${measured.summary.failures.map((finding) => finding.fixture.id).join(", ")}`
				: `every decided row holds; ${measured.summary.tracked.length} tracked`
		)

		record(
			readings,
			"conformance.unmeasured_rows",
			measured.summary.unmeasured.length,
			`unmeasured rows: ${measured.summary.unmeasured.length} — the comparator read its axis and the observation could not decide`
		)
	}

	if (needed.has("observation_marker")) {
		const markers = await measureMarker(definition, options)

		instruments.push({
			instrument: "observation_marker",
			identity: `${JSON.stringify(definition.markerProbe.query)} → ${markers.detail}`,
		})

		record(readings, "observation_marker.semantic_marker_reaches_caller", markers.observed, markers.detail)
	}

	const artifact: Phase2ObservedArtifacts = {
		poiDatabasePath: treatment.artifact.poiDatabasePath,
		poiLayerManifestVersion: manifest?.version ?? treatment.artifact.poiLayerManifestNote ?? "unreadable",
		poiLayerBuildSHA: manifest?.build_sha ?? treatment.artifact.poiLayerManifestNote ?? "unreadable",
		weightsLocale: treatment.artifact.weightsLocale,
		weightsVersion: treatment.artifact.weightsVersion,
		resolverBackend: treatment.artifact.resolverBackend,
		geographicModelVersion: route.modelVersion ?? "no route built",
		phraseLexiconID: route.phraseLexiconID ?? "no route built",
		phraseLexiconVersion: route.phraseLexiconVersion ?? "no route built",
		declaredPhrases: route.declaredPhrases ?? 0,
		semanticUtilityDefinitionSHA256: treatment.definitionSHA256,
		absenceDefinitionSHA256: absenceHash,
		coverageLayerFile: coverageFile,
		coverageLayerVersion: coverageVersion,
	}

	return { readings, instruments, artifact, deviations: comparePins(pins, artifact) }
}

/**
 * Every pinned artifact whose observed identity differs, named with both values.
 *
 * A measurement not taken is NOT a deviation: a definition registering no absence check leaves the absence pins
 * unmeasured, and reporting that as a difference would turn "this ruler did not ask" into "the artifact moved".
 */
function comparePins(pins: Phase2ArtifactPins, artifact: Phase2ObservedArtifacts): string[] {
	const deviations: string[] = []

	const compare = (field: keyof Phase2ArtifactPins, observed: string | number): void => {
		if (observed === "not measured") return

		if (observed !== pins[field]) {
			deviations.push(`${field}: observed ${JSON.stringify(observed)}, pinned ${JSON.stringify(pins[field])}`)
		}
	}

	compare("poiLayerManifestVersion", artifact.poiLayerManifestVersion)
	compare("poiLayerBuildSHA", artifact.poiLayerBuildSHA)
	compare("weightsLocale", artifact.weightsLocale)
	compare("weightsVersion", artifact.weightsVersion)
	compare("resolverBackend", artifact.resolverBackend)
	compare("geographicModelVersion", artifact.geographicModelVersion)
	compare("phraseLexiconID", artifact.phraseLexiconID)
	compare("phraseLexiconVersion", artifact.phraseLexiconVersion)
	compare("declaredPhrases", artifact.declaredPhrases)
	compare("semanticUtilityDefinitionSHA256", artifact.semanticUtilityDefinitionSHA256)
	compare("absenceDefinitionSHA256", artifact.absenceDefinitionSHA256)
	compare("coverageLayerFile", artifact.coverageLayerFile)
	compare("coverageLayerVersion", artifact.coverageLayerVersion)

	return deviations
}

/**
 * Run the one frozen marker query and count the markers that reach a caller with the registered code and mechanism.
 *
 * This is the only instrument that builds its own pipeline, and it needs one: the probe runner grades an answer and
 * never hands back the query-kind verdict a marker is attached to. Everything the check reads comes from the definition
 * — the query, the locale, the code and the mechanism.
 */
async function measureMarker(
	definition: Phase2DecisionDefinition,
	options: Phase2RunOptions
): Promise<{ observed: number; detail: string }> {
	const probe = definition.markerProbe
	const route = await createSemanticObservationRoute()
	using pipelineHandle = await createPOIBoardPipeline({ ...options, poiSemanticLookup: route.lookup })
	const { pipeline } = pipelineHandle

	try {
		const result = await pipeline(probe.query, probe.locale ? { locale: probe.locale } : {})
		const observations = route.takeObservations()
		const markers = semanticObservationMarkers(observations, result.kind)

		const matching = markers.filter(
			(marker) => marker.code === probe.expectedCode && marker.mechanism === probe.expectedMechanism
		)

		if (!matching.length) {
			return {
				observed: 0,
				detail: `${observations.length} observation(s) drained, ${markers.length} marker(s) built, none carrying code ${probe.expectedCode} with mechanism ${probe.expectedMechanism}`,
			}
		}

		const first = matching[0]!

		return {
			observed: matching.length,
			detail: `marker kind ${first.kind}, code ${first.code}, mechanism ${first.mechanism}, evidence names assertion ${String((first.evidence as { assertion?: { id?: string } }).assertion?.id)}`,
		}
	} finally {
		// The runtime pipeline never opens the artifact reader itself, so the route owns nothing to close; draining
		// keeps one query's firings from being attributed to the next.
		route.takeObservations()
	}
}

/**
 * Run the phase-2 decision ruler and emit a receipt.
 */
export async function runPhase2Decision(options: Phase2RunOptions = {}): Promise<Phase2Receipt> {
	const definition = await loadPhase2Definition(options.definitionPath, options.freezePath)
	const { readings, instruments, artifact, deviations } = await measure(definition, options)
	const byMeasurement = new Map(readings.map((reading) => [reading.measurement, reading]))
	const checks = evaluatePhase2Checks(definition, byMeasurement)
	const verdict = decidePhase2(definition, checks, { deviations })

	const lanes: Phase2LaneReport[] = definition.lanes.map((lane) => {
		const laneChecks = checks.filter((check) => check.lane === lane.id)

		return {
			id: lane.id,
			status: lane.status,
			issue: lane.issue,
			claim: lane.claim,
			landed: lane.landed,
			registeredChecks: laneChecks.length,
			checksMet: laneChecks.filter((check) => check.met).length,
			...(lane.blockedBy ? { blockedBy: lane.blockedBy } : {}),
			...(lane.blockedReason ? { blockedReason: lane.blockedReason } : {}),
			...(lane.plannedChecks ? { plannedChecks: lane.plannedChecks.map((planned) => ({ ...planned })) } : {}),
		}
	})

	return {
		decisionID: definition.decisionID,
		definitionVersion: definition.version,
		definitionSHA256: phase2DefinitionHash(definition),
		generatedAt: new Date().toISOString(),
		gitCommit: options.gitCommit ?? buildSHA(String(repoRootPath())),
		artifact,
		artifactPins: definition.artifactPins,
		artifactPinDeviations: deviations,
		instruments,
		readings,
		lanes,
		checks,
		verdict,
		recorded: false,
		recordingNote: definition.recordingNote,
	}
}

/**
 * The human-readable report. Prints the frozen bar beside every measurement, so a reader never has to open the
 * definition to know what the number was compared against.
 */
export function printPhase2Receipt(receipt: Phase2Receipt): void {
	console.log(`\nphase-2 decision ${receipt.decisionID} v${receipt.definitionVersion}`)
	console.log(`definition sha256: ${receipt.definitionSHA256}`)
	console.log(`commit: ${receipt.gitCommit}`)

	console.log(
		`\nartifacts: poi ${receipt.artifact.poiLayerManifestVersion} (build ${receipt.artifact.poiLayerBuildSHA}) · ` +
			`weights ${receipt.artifact.weightsLocale} ${receipt.artifact.weightsVersion} · resolver ${receipt.artifact.resolverBackend}\n` +
			`  geographic model ${receipt.artifact.geographicModelVersion} · ` +
			`${receipt.artifact.phraseLexiconID} v${receipt.artifact.phraseLexiconVersion} (${receipt.artifact.declaredPhrases} phrases)\n` +
			`  coverage ${receipt.artifact.coverageLayerFile} ${receipt.artifact.coverageLayerVersion}\n` +
			`  pins: ${receipt.artifactPinDeviations.length ? `${receipt.artifactPinDeviations.length} deviation(s)` : "held"}`
	)

	for (const deviation of receipt.artifactPinDeviations) {
		console.log(`    ! ${deviation}`)
	}

	console.log("\ninstruments:")

	for (const instrument of receipt.instruments) {
		console.log(`  ${instrument.instrument.padEnd(27)} ${instrument.identity}`)
	}

	for (const lane of receipt.lanes) {
		console.log(`\nlane ${lane.id} (${lane.issue}) — ${lane.status}`)
		console.log(`  claim: ${lane.claim}`)

		if (lane.status === "blocked") {
			console.log(`  blocked by ${lane.blockedBy}: ${lane.blockedReason}`)
			console.log(`  landed anyway: ${lane.landed}`)
			console.log(`  NOT MEASURED by this ruler. Rows it will read once unblocked:`)

			for (const planned of lane.plannedChecks ?? []) {
				console.log(`    ${planned.id.padEnd(12)} ${planned.measures}`)
				console.log(`    ${" ".repeat(12)} today: ${planned.todayReads}`)
			}

			continue
		}

		console.log(`  checks met ${lane.checksMet}/${lane.registeredChecks}`)

		for (const check of receipt.checks.filter((entry) => entry.lane === lane.id)) {
			console.log(
				`    ${check.met ? "✓" : "✗"} ${check.id.padEnd(14)} ${`${check.role}${check.tier ? `/${check.tier}` : ""}`.padEnd(18)} ` +
					`${String(check.observed).padStart(3)}/${String(check.denominator).padEnd(3)} bar ${describeBar(check.bar).padEnd(6)} ${check.detail}`
			)
		}
	}

	console.log("")

	for (const reason of receipt.verdict.reasons) {
		console.log(`  ${reason}`)
	}

	if (receipt.verdict.misses.length) {
		console.log("\n  checks that missed their bar:")

		for (const miss of receipt.verdict.misses) {
			console.log(`    ✗ ${miss}`)
		}
	}

	console.log(
		`\n  → ${receipt.verdict.decision} (coverage ${receipt.verdict.coverage}, comparability ${receipt.verdict.comparability})`
	)

	console.log(`  ${receipt.recordingNote}`)
}

/**
 * The `QueryIntentCode` the marker check registers, re-exported so the pre-registration's literal can be pinned against
 * the runtime vocabulary in a test rather than compared by eye.
 */
export const MARKER_PROBE_EXPECTED_CODE: string = QueryIntentCode.POICategory
