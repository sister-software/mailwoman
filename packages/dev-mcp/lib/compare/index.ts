/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `mwdev_compare`: runs one input set through two arms and reports differences.
 *
 * Two graders are used on purpose:
 * - mailwoman vs mailwoman uses `checkCase`.
 * - cross-engine comparisons use distance-based grading (`geo-grade.ts`).
 *
 * Shared reporting logic is reused across both paths.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { formatPercent } from "@mailwoman/core/stats"
import { checkCase } from "mailwoman/eval-harness/gauntlet/check-case"
import type { GauntletResult } from "mailwoman/eval-harness/gauntlet/harness"
import { toGauntletResult } from "mailwoman/eval-harness/gauntlet/harness"
import type { PathBuilderLike } from "path-ts"

import {
	armLabel,
	type ArmSpec,
	type ExternalArm,
	normalizeArmSpec,
	type OracleArm,
	type ArmRunner,
	type RecordedArm,
} from "#arms"
import {
	armsDiffered,
	tierDiffered,
	ARM_SEPARATION_THRESHOLD_KM,
	assertedStratum,
	type GeoRow,
	isolationSentence,
	recordAnswers,
	resolveGradeMode,
	withheldVerdict,
} from "#compare/helpers"
import { crossEngineReading, worktreePairReading, worktreeTreeDelta } from "#confound"
import type { EngineConfig, EngineRegistryLike } from "#engine/registry"
import { type ExternalAnswer, ExternalGeocoderClient, type ExternalArmIdentity } from "#external-arm"
import {
	DISTANCE_THRESHOLDS_KM,
	distanceKm,
	EQUIVALENCE_THRESHOLD_KM,
	gradeAtThreshold,
	thresholdKey,
	thresholdTable,
	tostEquivalence,
} from "#geo-grade"
import { gradeRow, significance } from "#grade"
import { resolveInputSet, type InputSetRef, type ResolvedInput, type ResolvedInputSet } from "#input-sets"
import { prepareMailwomanArms } from "#mailwoman-comparison-arms"
import {
	answerFromOracle,
	createOracleClient,
	OracleMeter,
	type OracleArmIdentity,
	type OracleGeocoderLike,
	ORACLE_GRADE_MODE,
	ORACLE_VERDICT_NOTE,
	OracleProviderName,
} from "#oracle-arm"
import { describeObservedRate } from "#power"
import {
	getRun,
	replayIndex,
	RETENTION_DAYS,
	RETENTION_MAX_RUNS,
	RUN_STORE_DIR,
	tryPutRun,
	type StoredRun,
	type RecordedAnswer,
} from "#run-store"
import {
	bucketRows,
	type ComparedRow,
	firingSignals,
	inputSetProvenance,
	provenanceFor,
	stratify,
	type StratumKey,
} from "#tool-kit"
import { worktreeArmRunner } from "#worktree/runner"

/**
 * Requested grading mode.
 *
 * `auto` picks `truth` when available.
 */
export type GradeRequest = "auto" | "truth" | "diff-only"

/**
 * Abort a run after this many consecutive query failures on one arm.
 */
const ABORT_AFTER_CONSECUTIVE_FAILURES = 5

/**
 * Default grading threshold in km.
 */
const DEFAULT_GRADE_THRESHOLD_KM = EQUIVALENCE_THRESHOLD_KM

interface CompareOptions {
	inputs?: InputSetRef
	armA: unknown
	armB: unknown
	declared: string[]
	stratifyBy?: StratumKey
	grade: GradeRequest
	gradeThresholdKm: number
	executionPath: "single-config" | "board-routed"
}

export interface CompareDeps {
	buildRoutedMailwomanArm?: Parameters<typeof prepareMailwomanArms>[6]["buildRoutedMailwomanArm"]
	/**
	 * Factory for external-arm clients.
	 */
	createExternalClient?: (arm: ExternalArm) => ExternalGeocoderClient
	/**
	 * Factory for oracle clients.
	 */
	createOracleClient?: (provider: OracleProviderName) => OracleGeocoderLike
	/**
	 * Shared oracle spend meter.
	 */
	oracleMeter?: OracleMeter
	/**
	 * Storage and clock/id injection for deterministic tests.
	 */
	runStoreDir?: PathBuilderLike
	now?: () => Date
	newRunID?: () => string
}

function now(deps: CompareDeps): Date {
	return deps.now ? deps.now() : new Date()
}

/**
 * Parse args and run the requested comparison.
 */
export async function runCompare(
	registry: EngineRegistryLike,
	args: Record<string, unknown>,
	deps: CompareDeps = {}
): Promise<unknown> {
	const options: CompareOptions = {
		...(args["inputs"] === undefined ? {} : { inputs: args["inputs"] as InputSetRef }),
		armA: args["arm_a"],
		armB: args["arm_b"],
		declared: args["variable"] as string[],
		...(args["stratify_by"] === undefined ? {} : { stratifyBy: assertedStratum(args["stratify_by"] as string) }),
		grade: (args["grade"] as GradeRequest | undefined) ?? "auto",
		gradeThresholdKm: (args["grade_threshold_km"] as number | undefined) ?? DEFAULT_GRADE_THRESHOLD_KM,
		executionPath: (args["execution_path"] as CompareOptions["executionPath"] | undefined) ?? "single-config",
	}

	const armA = normalizeArmSpec(options.armA, "a")
	const armB = normalizeArmSpec(options.armB, "b")
	const set = await resolveInputSet(options.inputs ?? { kind: "board" })

	if (armA.kind === "mailwoman" && armB.kind === "mailwoman") {
		return await compareMailwomanArms(registry, set, armA.config, armB.config, options, deps)
	}

	return await compareAcrossEngines(registry, set, armA, armB, options, deps)
}

/**
 * Compare two mailwoman configs using `checkCase`.
 */
async function compareMailwomanArms(
	registry: EngineRegistryLike,
	set: ResolvedInputSet,
	configA: EngineConfig,
	configB: EngineConfig,
	options: CompareOptions,
	deps: CompareDeps
): Promise<unknown> {
	using arms = await prepareMailwomanArms(
		registry,
		set,
		configA,
		configB,
		options.declared,
		options.executionPath,
		deps
	)

	const { geocodeA, geocodeB, provenanceA, provenanceB, comparisonEngineID, confounds } = arms

	const fingerprint = await registry.fingerprint()

	const rows: ComparedRow[] = []
	const errors: Array<{ id: string; input: string; arm: "a" | "b"; message: string }> = []
	// Keep recorded answers in parallel with rows to avoid unsafe casting later.
	const recorded: Record<"a" | "b", RecordedAnswer[]> = { a: [], b: [] }

	for (const item of set.inputs) {
		let a
		let b

		try {
			a = await geocodeA(item)
		} catch (error) {
			errors.push({ id: item.id, input: item.input, arm: "a", message: (error as Error).message })

			continue
		}

		try {
			b = await geocodeB(item)
		} catch (error) {
			errors.push({ id: item.id, input: item.input, arm: "b", message: (error as Error).message })

			continue
		}

		const { grade, issuesA, issuesB } = gradeRow(item.seed, a, b, checkCase)

		recorded.a.push({ id: item.id, input: item.input, ...answerFromGauntletResult(a) })
		recorded.b.push({ id: item.id, input: item.input, ...answerFromGauntletResult(b) })

		rows.push({
			id: item.id,
			input: item.input,
			country: item.country,
			address_kind: item.addressKind,
			status: item.status,
			differed: stringifyJSON(a) !== stringifyJSON(b),
			grade,
			a,
			b,
			issues_a: issuesA,
			issues_b: issuesB,
		})
	}

	const gradeable = rows.filter((row) => row.grade !== "ungradeable")
	const differed = rows.filter((row) => row.differed)

	const graded = {
		improved: rows.filter((row) => row.grade === "improved").length,
		regressed: rows.filter((row) => row.grade === "regressed").length,
		neutral: rows.filter((row) => row.grade === "neutral").length,
		ungradeable: rows.filter((row) => row.grade === "ungradeable").length,
	}

	// If there is no truth, this run can only report differences.
	const mode = resolveGradeMode(options.grade, gradeable.length > 0, "no row in this set carries expectations")

	const test = significance(
		gradeable.filter((row) => row.issues_a.length === 0).length,
		gradeable.filter((row) => row.issues_b.length === 0).length,
		gradeable.length
	)

	const changeReading = describeObservedRate({
		events: differed.length,
		n: rows.length,
		selection: set.selection,
		eventLabel: "differed between the arms",
		...(set.populationN === undefined ? {} : { populationN: set.populationN }),
	})

	// A zero-difference result may mean no change, or no effective execution.
	const zeroDifferenceCaveat = !differed.length
		? "A zero here has two readings — the pin moved nothing, or the pin never ran. This comparison " +
			"cannot separate them. Confirm participation with mwdev_trace on an input the pin should move " +
			"before reporting this as no effect."
		: ""

	if (zeroDifferenceCaveat) {
		confounds.warnings.push(zeroDifferenceCaveat)
	}

	const summary = [
		changeReading.sentence,
		mode === "truth"
			? `Of those, ${graded.improved} improved and ${graded.regressed} regressed against truth; ${graded.ungradeable} rows carry no expectations and were not graded. ${test.sentence}`
			: `No row in this set carries expectations, so nothing here is graded — these are described changes, not improvements.`,
		zeroDifferenceCaveat,
		isolationSentence(confounds, zeroDifferenceCaveat),
		set.why ? `Hand-picked because: ${set.why}` : "",
	]
		.filter((sentence) => sentence.length)
		.join(" ")

	// Record both arms with distinct labels.
	const run: StoredRun = {
		run_id: (deps.newRunID ?? (() => crypto.randomUUID()))(),
		tool: "mwdev_compare",
		created_at: now(deps).toISOString(),
		tree_fingerprint: fingerprint.digest,
		engine_id: comparisonEngineID,
		input_set_id: set.setID,
		answers: { "mailwoman:a": recorded.a, "mailwoman:b": recorded.b },
		payload: null,
	}

	const storeWarning = await tryPutRun(run, deps.runStoreDir ?? RUN_STORE_DIR, now(deps))

	if (storeWarning) {
		confounds.warnings.push(storeWarning)
	}

	const result = {
		run_id: run.run_id,
		run_id_note:
			`Stored for ${RETENTION_DAYS} days. Replay either side as an arm with ` +
			`{kind:"recorded", run_id:"${run.run_id}", arm:"mailwoman:a"}.`,
		provenance_a: provenanceA,
		provenance_b: provenanceB,
		summary,
		grade_mode: mode,
		...withheldVerdict(
			mode,
			'no truth for this input set; changes are described, not graded. Run against {kind:"board"} to grade.'
		),
		variable_isolation: confounds.variable_isolation,
		variable_declared: confounds.declared,
		variable_effective: confounds.variable_effective,
		n_requested: set.n,
		n_evaluated_both: rows.length,
		n_errored: errors.length,
		errors,
		arms_differed_on: { n: differed.length, of: rows.length },
		// Separate from coordinate differences.
		mechanism_fired_on: firingSignals(rows),
		mechanism_fired_on_note:
			"Only signals a GauntletResult carries for free are counted here. A pin with no signal of its own " +
			"cannot be confirmed to have run from this result — use mwdev_trace.",
		graded,
		significance: test,
		power: changeReading,
		...(options.stratifyBy ? { strata: stratify(rows, options.stratifyBy) } : {}),
		// Full changed-row list.
		rows_changed: differed,
		warnings: confounds.warnings,
	}

	return result
}

/**
 * Project a mailwoman arm into the external-answer shape.
 */
async function mailwomanRunner(
	registry: EngineRegistryLike,
	config: EngineConfig,
	set: ResolvedInputSet
): Promise<ArmRunner> {
	const engine = await registry.acquire(config)

	return {
		label: "mailwoman",
		provenance: { ...provenanceFor(engine, set) },
		warnings: [],
		answer: async (input) => answerFromGauntletResult(toGauntletResult((await engine.session.geocode(input)).result)),
	}
}

/**
 * Convert a `GauntletResult` to `ExternalAnswer`.
 */
function answerFromGauntletResult(result: GauntletResult): ExternalAnswer {
	const placeIDs = result.hierarchy.map((rung) => rung.placeID).filter((id): id is string => typeof id === "string")

	return {
		lat: result.lat,
		lon: result.lon,
		label: result.locality ?? result.region ?? null,
		resultType: result.tier,
		noResultReason: result.lat === null ? "the pipeline resolved no coordinate" : null,
		...(placeIDs.length ? { place_ids: placeIDs } : {}),
	}
}

/**
 * Build an oracle runner after meter admission.
 *
 * @throws When the meter refuses.
 */
function oracleRunner(
	spec: OracleArm,
	set: ResolvedInputSet,
	meter: OracleMeter,
	deps: CompareDeps
): { runner: ArmRunner; identity: OracleArmIdentity; client: OracleGeocoderLike } {
	const admission = meter.admit(spec.provider, set.inputs.length)

	if (!admission.allowed) throw new Error(admission.reason)

	const client = deps.createOracleClient ? deps.createOracleClient(spec.provider) : createOracleClient(spec.provider)

	const identity: OracleArmIdentity = {
		arm: "oracle",
		provider: spec.provider,
		grade_mode: ORACLE_GRADE_MODE,
		calls_admitted: set.inputs.length,
		calls_remaining: admission.callsRemaining,
		admission_reason: admission.reason,
		warnings: [ORACLE_VERDICT_NOTE],
	}

	return {
		client,
		identity,
		runner: {
			label: `oracle:${spec.provider}`,
			provenance: { ...identity, input_set: inputSetProvenance(set) },
			warnings: identity.warnings,
			answer: async (input) => {
				const answer = await answerFromOracle(client, input)

				if (spec.provider === OracleProviderName.Google) {
					meter.recordGoogleCalls(1)
				}

				return answer
			},
		},
	}
}

/**
 * Replay a stored run by matching on input string.
 */
async function recordedRunner(spec: RecordedArm, set: ResolvedInputSet, dir: PathBuilderLike): Promise<ArmRunner> {
	const run = await getRun(spec.runID, dir)

	if (!run) {
		throw new Error(
			`Arm: no stored run ${stringifyJSON(spec.runID)}. It was pruned or never existed — the store keeps runs for ` +
				`${RETENTION_DAYS} days and at most ${RETENTION_MAX_RUNS} of them. Those two are indistinguishable after ` +
				"the fact, so re-measure. mwdev_runs lists what is still there."
		)
	}

	const byInput = new Map([...replayIndex(run, spec.arm).values()].map((answer) => [answer.input, answer]))
	const missing = set.inputs.filter((item) => !byInput.has(item.input)).length

	// Keep tree-fingerprint confound warning for replayed arms.
	const warnings = [
		`This arm is a replay of run ${run.run_id}, recorded at ${run.created_at} against tree ` +
			`${run.tree_fingerprint.slice(0, 12)}. Declare tree_fingerprint as a variable — everything that changed ` +
			"between the two trees is inside this comparison, not only what you changed on purpose.",
	]

	if (missing) {
		warnings.push(
			`${missing} of ${set.inputs.length} rows in this set are not in run ${run.run_id}, so this arm scores them as ` +
				"no-results. They are inside every rate below. Re-run both arms live if that share is material."
		)
	}

	return {
		label: `recorded:${spec.arm}`,
		provenance: {
			arm: "recorded",
			run_id: run.run_id,
			replayed_arm: spec.arm,
			recorded_at: run.created_at,
			recorded_tree_fingerprint: run.tree_fingerprint,
			recorded_engine_id: run.engine_id,
			recorded_input_set_id: run.input_set_id,
			rows_replayed: set.inputs.length - missing,
			rows_absent_from_run: missing,
			input_set: inputSetProvenance(set),
		},
		warnings,
		answer: async (input) => {
			const hit = byInput.get(input)

			if (!hit) {
				return {
					lat: null,
					lon: null,
					label: null,
					resultType: null,
					noResultReason: `run ${run.run_id} carries no answer for this input`,
				}
			}

			return { lat: hit.lat, lon: hit.lon, label: hit.label, resultType: hit.resultType, noResultReason: null }
		},
	}
}

async function externalRunner(
	spec: ExternalArm,
	set: ResolvedInputSet,
	deps: CompareDeps
): Promise<{ runner: ArmRunner; identity: ExternalArmIdentity; client: ExternalGeocoderClient }> {
	const client = deps.createExternalClient
		? deps.createExternalClient(spec)
		: new ExternalGeocoderClient(spec.engine, spec.endpoint)

	const identity = await client.probeIdentity(spec.version)

	return {
		client,
		identity,
		runner: {
			label: spec.engine,
			provenance: { arm: "external", ...identity, input_set: inputSetProvenance(set) },
			warnings: identity.warnings,
			answer: (input) => client.search(input),
		},
	}
}

/**
 * Compare two arms when at least one is not mailwoman.
 */
async function compareAcrossEngines(
	registry: EngineRegistryLike,
	set: ResolvedInputSet,
	armA: ArmSpec,
	armB: ArmSpec,
	options: CompareOptions,
	deps: CompareDeps
): Promise<unknown> {
	const clients: AsyncDisposable[] = []
	const identities: Record<string, ExternalArmIdentity | OracleArmIdentity> = {}
	const meter = deps.oracleMeter ?? (await OracleMeter.create())

	const build = async (arm: ArmSpec, side: "a" | "b"): Promise<ArmRunner> => {
		if (arm.kind === "mailwoman") return mailwomanRunner(registry, arm.config, set)

		if (arm.kind === "recorded") return await recordedRunner(arm, set, deps.runStoreDir ?? RUN_STORE_DIR)

		if (arm.kind === "worktree") return worktreeArmRunner(registry, arm, set)

		if (arm.kind === "oracle") {
			const { runner, identity, client } = oracleRunner(arm, set, meter, deps)

			clients.push(client)

			identities[side] = identity

			return runner
		}

		const { runner, identity, client } = await externalRunner(arm, set, deps)

		clients.push(client)

		identities[side] = identity

		return runner
	}

	// Build sequentially so both identities succeed before scoring rows.
	const runnerA = await build(armA, "a")
	const runnerB = await build(armB, "b")

	try {
		return await scoreGeoRows({ registry, set, armA, armB, runnerA, runnerB, identities, options, deps })
	} finally {
		for (const client of clients) {
			await client[Symbol.asyncDispose]()
		}
	}
}

/**
 * Inputs for one cross-engine scoring pass.
 */
interface GeoScoringContext {
	registry: EngineRegistryLike
	set: ResolvedInputSet
	armA: ArmSpec
	armB: ArmSpec
	runnerA: ArmRunner
	runnerB: ArmRunner
	identities: Record<string, ExternalArmIdentity | OracleArmIdentity>
	options: CompareOptions
	deps: CompareDeps
}

async function scoreGeoRows(context: GeoScoringContext): Promise<unknown> {
	const { registry, set, armA, armB, runnerA, runnerB, identities, options, deps } = context
	const rows: GeoRow[] = []
	const errors: Array<{ id: string; input: string; arm: "a" | "b"; message: string }> = []
	const consecutive = { a: 0, b: 0 }

	const ask = async (runner: ArmRunner, side: "a" | "b", item: ResolvedInput): Promise<ExternalAnswer> => {
		try {
			const answer = await runner.answer(item.input)

			consecutive[side] = 0

			return answer
		} catch (error) {
			const message = (error as Error).message

			errors.push({ id: item.id, input: item.input, arm: side, message })

			consecutive[side]++

			if (consecutive[side] >= ABORT_AFTER_CONSECUTIVE_FAILURES) {
				throw new Error(
					`Arm ${side} (${runner.label}) failed ${consecutive[side]} queries in a row, last: ${message}. ` +
						"Abandoning the run rather than scoring the remaining rows as misses — an arm that stopped answering " +
						"is not an arm that lost. Check the endpoint and re-run."
				)
			}

			// Failed queries are treated as misses with a reason.
			return { lat: null, lon: null, label: null, resultType: null, noResultReason: `query failed: ${message}` }
		}
	}

	// Oracle comparisons are always ungradeable.
	const hasOracle = armA.kind === "oracle" || armB.kind === "oracle"

	for (const item of set.inputs) {
		const a = await ask(runnerA, "a", item)
		const b = await ask(runnerB, "b", item)
		// Use unified truth fields populated by input-sets.
		const truthLat = item.truthLat ?? null
		const truthLon = item.truthLon ?? null
		const hasTruth = typeof truthLat === "number" && typeof truthLon === "number"
		const distanceA = hasTruth ? distanceKm(a, truthLat, truthLon) : null
		const distanceB = hasTruth ? distanceKm(b, truthLat, truthLon) : null

		rows.push({
			id: item.id,
			input: item.input,
			country: item.country,
			address_kind: item.addressKind,
			status: item.status,
			differed: armsDiffered(a, b, distanceA, distanceB, hasTruth, item.toleranceM ?? null),
			// Optional identity and tier deltas are tracked separately from coordinate diffs.
			...(a.place_ids && b.place_ids ? { identity_differed: a.place_ids.join(">") !== b.place_ids.join(">") } : {}),
			...(tierDiffered(a, b) === undefined ? {} : { tier_differed: tierDiffered(a, b) }),
			grade: hasTruth && !hasOracle ? gradeAtThreshold(distanceA, distanceB, options.gradeThresholdKm) : "ungradeable",
			a,
			b,
			truth_lat: truthLat,
			truth_lon: truthLon,
			truth_tolerance_m: item.toleranceM ?? null,
			truth_type: item.truthType ?? null,
			distance_km_a: distanceA,
			distance_km_b: distanceB,
		})
	}

	const graded = rows.filter((row) => row.grade !== "ungradeable")
	const differed = rows.filter((row) => row.differed)
	// Include coordinate, identity-only, and tier-only changes.
	const changedRows = rows.filter((row) => row.differed || row.identity_differed === true || row.tier_differed === true)

	const withTruth = rows.filter((row) => row.truth_lat !== null).length
	const withRowTolerance = rows.filter((row) => row.truth_tolerance_m !== null && row.truth_tolerance_m > 0).length

	const mode = hasOracle
		? ORACLE_GRADE_MODE
		: resolveGradeMode(options.grade, graded.length > 0, "no row in this set carries a truth coordinate")

	const distances = graded.map((row) => ({ distanceKmA: row.distance_km_a, distanceKmB: row.distance_km_b }))
	const thresholds = thresholdTable(distances)
	const gradeKey = thresholdKey(options.gradeThresholdKm)
	const gradedHits = thresholdTable(distances, [options.gradeThresholdKm])[gradeKey]!
	const test = significance(gradedHits.a, gradedHits.b, graded.length)
	const equivalenceHits = thresholds[thresholdKey(EQUIVALENCE_THRESHOLD_KM)]
	const equivalence = tostEquivalence(equivalenceHits?.a ?? 0, equivalenceHits?.b ?? 0, graded.length)

	const changeReading = describeObservedRate({
		events: differed.length,
		n: rows.length,
		selection: set.selection,
		eventLabel: "were classified differently by the two arms at one or more thresholds",
		...(set.populationN === undefined ? {} : { populationN: set.populationN }),
	})

	const confounds =
		armA.kind === "worktree" && armB.kind === "worktree"
			? worktreePairReading(
					armLabel(armA),
					armLabel(armB),
					options.declared,
					worktreeTreeDelta(registry.repoRoot, runnerA.provenance, runnerB.provenance)
				)
			: crossEngineReading(armLabel(armA), armLabel(armB), options.declared)

	const noResult = {
		a: rows.filter((row) => row.a.lat === null).length,
		b: rows.filter((row) => row.b.lat === null).length,
	}

	const errored = {
		a: errors.filter((error) => error.arm === "a").length,
		b: errors.filter((error) => error.arm === "b").length,
	}

	const warnings = [
		...confounds.warnings,
		...runnerA.warnings.map((warning) => `arm a (${runnerA.label}): ${warning}`),
		...runnerB.warnings.map((warning) => `arm b (${runnerB.label}): ${warning}`),
		...precisionWarnings(graded, errored),
	]

	const summary = [
		mode === "truth"
			? `${runnerA.label} vs ${runnerB.label} over ${graded.length} of ${rows.length} rows carrying a truth ` +
				`coordinate. At ${gradeKey}: ${gradedHits.a} (${formatPercent(gradedHits.a, graded.length)}) for ` +
				`${runnerA.label}, ${gradedHits.b} (${formatPercent(gradedHits.b, graded.length)}) for ${runnerB.label}. ` +
				`${test.sentence} ${equivalence.sentence}`
			: // Keep separate messages for "no truth" vs "oracle present".
				hasOracle
				? `${runnerA.label} vs ${runnerB.label} over ${rows.length} rows. ${ORACLE_VERDICT_NOTE}`
				: `${runnerA.label} vs ${runnerB.label} over ${rows.length} rows, none of which carries a truth coordinate — ` +
					"so this describes where the two arms disagree and grades nothing.",
		changeReading.sentence,
		`Neither arm answered on ${noResult.a} (${runnerA.label}) and ${noResult.b} (${runnerB.label}) rows respectively` +
			(errored.a + errored.b
				? `, of which ${errored.a} and ${errored.b} were query FAILURES rather than empty results.`
				: ", all of them empty results rather than failures."),
		confounds.warnings.join(" "),
		set.why ? `Hand-picked because: ${set.why}` : "",
	]
		.filter((sentence) => sentence.length)
		.join(" ")

	const run: StoredRun = {
		run_id: (deps.newRunID ?? (() => crypto.randomUUID()))(),
		tool: "mwdev_compare",
		created_at: now(deps).toISOString(),
		tree_fingerprint: (await registry.fingerprint()).digest,
		engine_id: null,
		input_set_id: set.setID,
		answers: {
			[runnerA.label]: recordAnswers(rows, "a"),
			[runnerB.label]: recordAnswers(rows, "b"),
		},
		payload: null,
	}

	const storeWarning = await tryPutRun(run, deps.runStoreDir ?? RUN_STORE_DIR, now(deps))

	if (storeWarning) {
		warnings.push(storeWarning)
	}

	return {
		run_id: run.run_id,
		run_id_note:
			`Stored for ${RETENTION_DAYS} days. Pass {kind:"recorded", run_id:"${run.run_id}"} as an arm to compare a ` +
			"later run against this one without re-running it.",
		provenance_a: runnerA.provenance,
		provenance_b: runnerB.provenance,
		summary,
		grade_mode: mode,
		...withheldVerdict(
			mode,
			hasOracle
				? ORACLE_VERDICT_NOTE
				: "no truth coordinate for this input set; a cross-engine comparison has no other grading axis, so the " +
						"differences are described rather than graded."
		),
		protocol: {
			source: "docs/superpowers/plans/2026-08-06-local-pelias-benchmark-rig.md §4, spec §2.4",
			top_n: 1,
			thresholds_km: [...DISTANCE_THRESHOLDS_KM],
			graded_at_km: options.gradeThresholdKm,
			no_result_is_a_miss: true,
			per_arm_normalization: "none — the same raw query string reaches both arms",
		},
		variable_isolation: confounds.variable_isolation,
		variable_declared: confounds.declared,
		variable_effective: confounds.variable_effective,
		n_requested: set.n,
		n_evaluated_both: rows.length,
		n_graded: graded.length,
		n_no_result_a: noResult.a,
		n_no_result_b: noResult.b,
		n_errored_a: errored.a,
		n_errored_b: errored.b,
		errors,
		arms_differed_on: { n: differed.length, of: rows.length },
		identity_changed: {
			n: rows.filter((row) => row.identity_differed === true).length,
			of_comparable: rows.filter((row) => row.identity_differed !== undefined).length,
			note:
				"Rows where both arms stated a place-identity chain and the chains differ. Separate from " +
				"arms_differed_on: a wrong-instance swap under a stable coordinate counts HERE and not there. " +
				"of_comparable below the row count means at least one arm (an external engine, an oracle, or a run " +
				'recorded before identity was stored) states no identity — incomparable, never "same".',
		},
		tier_changed: {
			n: rows.filter((row) => row.tier_differed === true).length,
			of_comparable: rows.filter((row) => row.tier_differed !== undefined).length,
			note:
				"Rows where both arms answered with a result tier and the tiers differ (address_point → interpolated, say). " +
				"Separate from arms_differed_on: a tier change under a stable coordinate is a different claim about the " +
				"answer and counts HERE. of_comparable below the row count means an arm states no tier — incomparable.",
		},
		differed_basis:
			withTruth === rows.length
				? withRowTolerance > 0
					? "threshold-crossing-vs-truth+row-tolerance"
					: "threshold-crossing-vs-truth"
				: "arm-separation",
		rows_graded_at_own_tolerance: { n: withRowTolerance, of: rows.length },
		arms_differed_on_note:
			withTruth === rows.length
				? "A row counts as differed when the arms land on opposite sides of at least one protocol threshold " +
					`(1/5/25km) or, for the ${withRowTolerance} rows that state their own tolerance, of that tolerance. ` +
					"Two results 900m apart that are both hits at 1km on a row with no stated tolerance do NOT count — " +
					"across engines, the raw coordinates always differ."
				: `${rows.length - withTruth} of ${rows.length} rows carry no truth coordinate, so there is no verdict for ` +
					`the arms to land on opposite sides of. Those rows count as differed when exactly one arm answered, or ` +
					`when both answered more than ${ARM_SEPARATION_THRESHOLD_KM}km apart.`,
		// No internal firing signal is available for external engines.
		mechanism_fired_on: null,
		graded: {
			improved: rows.filter((row) => row.grade === "improved").length,
			regressed: rows.filter((row) => row.grade === "regressed").length,
			neutral: rows.filter((row) => row.grade === "neutral").length,
			ungradeable: rows.filter((row) => row.grade === "ungradeable").length,
		},
		thresholds,
		// Emit verdict stats only for truth-graded runs.
		significance: mode === "truth" ? test : null,
		equivalence: mode === "truth" ? equivalence : null,
		significance_withheld_reason:
			mode === "truth"
				? undefined
				: hasOracle
					? ORACLE_VERDICT_NOTE
					: "nothing in this set is graded, so there are no two proportions to test.",
		power: changeReading,
		truth_precision_m: truthPrecision(graded),
		...(identities["a"] ? { arm_a_identity: identities["a"] } : {}),
		...(identities["b"] ? { arm_b_identity: identities["b"] } : {}),
		...(options.stratifyBy ? { strata: stratifyGeo(rows, options.stratifyBy) } : {}),
		rows_changed: changedRows,
		warnings,
	}
}

/**
 * Histogram of declared truth tolerances.
 */
function truthPrecision(rows: GeoRow[]): Record<string, number> {
	const histogram: Record<string, number> = {}

	for (const row of rows) {
		const key = row.truth_tolerance_m === null ? "unstated" : String(row.truth_tolerance_m)

		histogram[key] = (histogram[key] ?? 0) + 1
	}

	return histogram
}

/**
 * Build warnings about truth precision and query failures.
 */
function precisionWarnings(rows: GeoRow[], errored: { a: number; b: number }): string[] {
	const warnings: string[] = []
	const tightest = DISTANCE_THRESHOLDS_KM[0]
	const coarse = rows.filter((row) => (row.truth_tolerance_m ?? 0) / METRES_PER_KM > tightest).length

	if (coarse) {
		warnings.push(
			`${coarse} of ${rows.length} graded rows declare a truth tolerance coarser than ${tightest}km — their truth ` +
				`point is an area centroid, not the address. Read the ${tightest}km column for those rows as a property of ` +
				"the truth, not of the arm."
		)
	}

	if (errored.a || errored.b) {
		warnings.push(
			`${errored.a + errored.b} rows failed rather than answering (arm a ${errored.a}, arm b ${errored.b}). The ` +
				"pre-registered protocol counts a failure as a miss, so those rows are inside every rate above."
		)
	}

	return warnings
}

/**
 * Metres per kilometre.
 */
const METRES_PER_KM = 1000

/**
 * Per-stratum threshold summaries.
 */
function stratifyGeo(rows: GeoRow[], by: StratumKey): Record<string, unknown> {
	const buckets = bucketRows(rows, (row) => stratumValue(row, by))
	const out: Record<string, unknown> = {}

	for (const [key, bucket] of [...buckets.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
		const graded = bucket.filter((row) => row.grade !== "ungradeable")

		out[key] = {
			n: bucket.length,
			n_graded: graded.length,
			differed: bucket.filter((row) => row.differed).length,
			improved: bucket.filter((row) => row.grade === "improved").length,
			regressed: bucket.filter((row) => row.grade === "regressed").length,
			ungradeable: bucket.filter((row) => row.grade === "ungradeable").length,
			thresholds: thresholdTable(
				graded.map((row) => ({ distanceKmA: row.distance_km_a, distanceKmB: row.distance_km_b }))
			),
		}
	}

	return out
}

function stratumValue(row: GeoRow, by: StratumKey): string {
	// Keep explicit support for truth_type stratification.
	if (by === "truth_type") return row.truth_type ?? "unstated"

	if (by === "truth_tolerance_m") return row.truth_tolerance_m === null ? "unstated" : `${row.truth_tolerance_m}m`

	if (by === "country") return row.country ?? "unknown"

	if (by === "address_kind") return row.address_kind ?? "unknown"

	return row.status ?? "unknown"
}
