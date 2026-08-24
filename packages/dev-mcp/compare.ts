/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mwdev_compare`'s body: one input set through two arms, diffed.
 *
 *   **Two graders, deliberately not one.** Two mailwoman arms are graded by `checkCase` — the board's own grader, over
 *   components, place identity and tier, the things this repo asserts about a parse. An arm that is another geocoder
 *   asserts none of those: it answers with a point and a label from a vocabulary that is not ours, so the only claim
 *   both sides genuinely make is *where the address is*, and the grading axis collapses to distance (`geo-grade.ts`,
 *   the pre-registered 1/5/25 km protocol). Merging the two into one grader would mean either grading mailwoman on the
 *   thinner axis everywhere, or inventing a component mapping for engines that never agreed to one.
 *
 *   What the two paths DO share is everything about honest reporting, and they share it by calling the same functions:
 *   the input set and its denominators, {@link describeObservedRate}'s bound-carrying sentence, the bucketing behind
 *   the strata, the provenance block. A number that differs between the paths differs because the measurement does.
 */

import { randomUUID } from "node:crypto"

import { formatPercent } from "@mailwoman/core/utils"
import { checkCase } from "mailwoman/eval-harness/gauntlet/check-case"
import type { GauntletResult } from "mailwoman/eval-harness/gauntlet/harness"
import { toGauntletResult } from "mailwoman/eval-harness/gauntlet/harness"

import {
	armLabel,
	type ArmSpec,
	type ExternalArm,
	normalizeArmSpec,
	type OracleArm,
	type ArmRunner,
	type RecordedArm,
} from "./arms.ts"
import {
	armsDiffered,
	ARM_SEPARATION_THRESHOLD_KM,
	assertedStratum,
	type GeoRow,
	isolationSentence,
	recordAnswers,
	resolveGradeMode,
	withheldVerdict,
} from "./compare-helpers.ts"
import { crossEngineReading } from "./confound.ts"
import type { EngineConfig, EngineRegistry } from "./engine-registry.ts"
import { type ExternalAnswer, ExternalGeocoderClient, type ExternalArmIdentity } from "./external-arm.ts"
import {
	DISTANCE_THRESHOLDS_KM,
	distanceKm,
	EQUIVALENCE_THRESHOLD_KM,
	gradeAtThreshold,
	thresholdKey,
	thresholdTable,
	tostEquivalence,
} from "./geo-grade.ts"
import { gradeRow, significance } from "./grade.ts"
import { resolveInputSet, type InputSetRef, type ResolvedInput, type ResolvedInputSet } from "./input-sets.ts"
import { prepareMailwomanArms } from "./mailwoman-comparison-arms.ts"
import {
	answerFromOracle,
	createOracleClient,
	OracleMeter,
	type OracleArmIdentity,
	type OracleGeocoderLike,
	ORACLE_GRADE_MODE,
	ORACLE_VERDICT_NOTE,
	OracleProviderName,
} from "./oracle-arm.ts"
import { describeObservedRate } from "./power.ts"
import {
	getRun,
	replayIndex,
	RETENTION_DAYS,
	RETENTION_MAX_RUNS,
	RUN_STORE_DIR,
	tryPutRun,
	type StoredRun,
	type RecordedAnswer,
} from "./run-store.ts"
import {
	bucketRows,
	type ComparedRow,
	firingSignals,
	inputSetProvenance,
	provenanceFor,
	stratify,
	type StratumKey,
} from "./tool-kit.ts"
import { worktreeArmRunner } from "./worktree-runner.ts"

/**
 * What the caller asked for on the grading axis. `auto` picks `truth` where the set has it — see spec §5.5: a diff is
 * not a verdict, and the failure this whole surface exists for was a diff-only result read as a truth result.
 */
export type GradeRequest = "auto" | "truth" | "diff-only"

/**
 * Consecutive failed queries on one arm before the whole run is abandoned.
 *
 * The pre-registered protocol counts a query failure as a miss, which is right for the row that fails and catastrophic
 * for the run where the service died at row 12: every remaining row scores as a miss and the arm loses a benchmark it
 * never played. Five in a row is far past any plausible per-query fault against a local endpoint, so it is read as the
 * endpoint rather than the query, and the run fails loudly instead of quietly producing a number.
 */
const ABORT_AFTER_CONSECUTIVE_FAILURES = 5

/**
 * The threshold rows are graded at by default, in kilometres.
 *
 * The coarsest of the three, and matched to {@link EQUIVALENCE_THRESHOLD_KM} so the graded axis is the one the parity
 * claim is made on. It is also the only defensible default for a set whose truth points are mostly city centroids:
 * grading at one kilometre against a 25 km-tolerance truth row measures the truth's precision, not the arm's.
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
	 * How an external arm's client is built.
	 *
	 * The transport seam, and the only one: a test replaces the Axios adapter through this, so the real client, its
	 * pacing and its response parsing all still run against a scripted wire. A test that stubbed the ANSWER instead would
	 * be asserting its own hypothesis about the protocol.
	 */
	createExternalClient?: (arm: ExternalArm) => ExternalGeocoderClient
	/**
	 * How an oracle arm's client is built. The same seam, for the same reason.
	 */
	createOracleClient?: (provider: OracleProviderName) => OracleGeocoderLike
	/**
	 * The spend meter, shared across a daemon's lifetime. A fresh one per call would make the cap per-call, which is not
	 * a cap.
	 */
	oracleMeter?: OracleMeter
	/**
	 * Where completed runs are written, and what to stamp them with. Injected so a test does not write into the
	 * operator's store, and because `Date`/`randomUUID` are exactly what a deterministic replay cannot call.
	 */
	runStoreDir?: string
	now?: () => Date
	newRunID?: () => string
}

function now(deps: CompareDeps): Date {
	return deps.now ? deps.now() : new Date()
}

/**
 * Read `mwdev_compare`'s arguments and run whichever comparison they describe.
 */
export async function runCompare(
	registry: EngineRegistry,
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
		return compareMailwomanArms(registry, set, armA.config, armB.config, options, deps)
	}

	return compareAcrossEngines(registry, set, armA, armB, options, deps)
}

/**
 * Two mailwoman configurations, graded by the board's own `checkCase`.
 */
async function compareMailwomanArms(
	registry: EngineRegistry,
	set: ResolvedInputSet,
	configA: EngineConfig,
	configB: EngineConfig,
	options: CompareOptions,
	deps: CompareDeps
): Promise<unknown> {
	const { geocodeA, geocodeB, provenanceA, provenanceB, comparisonEngineID, confounds, close } =
		await prepareMailwomanArms(registry, set, configA, configB, options.declared, options.executionPath, deps)

	const fingerprint = registry.fingerprint()

	const rows: ComparedRow[] = []
	const errors: Array<{ id: string; input: string; arm: "a" | "b"; message: string }> = []
	// Kept alongside `rows` rather than derived from it afterwards: `ComparedRow.a` is `unknown`, and recovering the
	// type with a cast would let a future change to that field pass the compiler and produce a store full of nulls.
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
			differed: JSON.stringify(a) !== JSON.stringify(b),
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

	// A diff is not a verdict (§5.5). With no truth anywhere in the set, the change count is ALL this can say.
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

	// §5.4, learned the hard way on 2026-08-16: this tool's first real run reported "0 of 558 differed —
	// tight enough to read as a real absence" for a lever that was never reaching a decode at all
	// (`geocode-session`'s parseDeps omitted `fst`, and the path parses once up front). A zero-difference
	// result has TWO readings and the number cannot separate them, so it must not be relayed as one.
	const zeroDifferenceCaveat = !differed.length
		? "A zero here has two readings — the lever changed nothing, or the lever never ran. This comparison " +
			"cannot separate them. Confirm participation with mwdev_trace on an input the lever should move " +
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
		.filter((sentence) => sentence.length > 0)
		.join(" ")

	// Both arms are recorded under distinct labels: they are two configurations of the same engine, so `mailwoman` alone
	// would name whichever one was written last and a recorded arm would replay a config nobody asked for.
	const run: StoredRun = {
		run_id: (deps.newRunID ?? randomUUID)(),
		tool: "mwdev_compare",
		created_at: now(deps).toISOString(),
		tree_fingerprint: fingerprint.digest,
		engine_id: comparisonEngineID,
		input_set_id: set.setID,
		answers: { "mailwoman:a": recorded.a, "mailwoman:b": recorded.b },
		payload: null,
	}

	const storeWarning = tryPutRun(run, deps.runStoreDir ?? RUN_STORE_DIR, now(deps))

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
		// Separate from arms_differed_on on purpose: a lever that fired on 400 rows and moved 0 outcomes is a
		// different fact from a lever that never fired.
		mechanism_fired_on: firingSignals(rows),
		mechanism_fired_on_note:
			"Only signals a GauntletResult carries for free are counted here. A lever with no signal of its own " +
			"cannot be confirmed to have run from this result — use mwdev_trace.",
		graded,
		significance: test,
		power: changeReading,
		...(options.stratifyBy ? { strata: stratify(rows, options.stratifyBy) } : {}),
		// Complete, never truncated. The 837-row FST run produced 24 changed rows; that is the evidence, and a
		// "first 30" cap would have hidden the tail on a larger one.
		rows_changed: differed,
		warnings: confounds.warnings,
	}

	close()

	return result
}

/**
 * A mailwoman arm projected onto the same answer shape an external one produces: a point, a label, a type, or a stated
 * absence. Everything else the pipeline knows is deliberately dropped here — the other arm cannot answer it, so
 * carrying it into a cross-engine row would invite a comparison that has no other side.
 */
async function mailwomanRunner(
	registry: EngineRegistry,
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
 * A mailwoman result as an arm answer.
 *
 * Reads the GAUNTLET projection rather than the raw `GeocodeResult`, so the two-mailwoman path — which already holds
 * `GauntletResult`s — and the cross-engine path answer through one function. Two projections of the same run is how a
 * recorded arm and the live arm it was recorded from stop agreeing.
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
 * A reference geocoder as a runner, admitted through the meter before a single query is issued.
 *
 * @throws When the meter refuses. Refusing here rather than per row is what keeps a half-spent run from existing: the
 *   caller is told it cannot afford the set before any of it is billed.
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
 * A stored run replayed row by row.
 *
 * MATCHED BY INPUT STRING, not by row id. A row id is only meaningful inside the corpus that minted it, and a recorded
 * arm exists to compare across time — the board may have gained rows, or the comparison may be against a different set
 * entirely. The input string is the one key that means the same thing in both runs.
 *
 * A row the stored run does not carry is a no-result with that reason rather than a throw, so a set that grew by three
 * rows is still readable on the rest. How many were missing is counted BEFORE the run and warned about, not discovered
 * from the miss rate afterwards.
 */
function recordedRunner(spec: RecordedArm, set: ResolvedInputSet, dir: string): ArmRunner {
	const run = getRun(spec.runID, dir)

	if (!run) {
		throw new Error(
			`Arm: no stored run ${JSON.stringify(spec.runID)}. It was pruned or never existed — the store keeps runs for ` +
				`${RETENTION_DAYS} days and at most ${RETENTION_MAX_RUNS} of them. Those two are indistinguishable after ` +
				"the fact, so re-measure. mwdev_runs lists what is still there."
		)
	}

	const byInput = new Map([...replayIndex(run, spec.arm).values()].map((answer) => [answer.input, answer]))
	const missing = set.inputs.filter((item) => !byInput.has(item.input)).length

	// The confound guard is not relaxed for a recorded arm: comparing across a tree change IS comparing across a tree
	// change, and `tree_fingerprint` has to be a declared variable for the isolation reading to be `clean`.
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
 * A comparison with at least one arm that is not mailwoman.
 *
 * Everything here is the pre-registered protocol and nothing here is a choice made after seeing the numbers: the same
 * raw query to both arms, top-1, haversine, 1/5/25 km, and a no-result — empty OR failed — a miss at every threshold.
 */
async function compareAcrossEngines(
	registry: EngineRegistry,
	set: ResolvedInputSet,
	armA: ArmSpec,
	armB: ArmSpec,
	options: CompareOptions,
	deps: CompareDeps
): Promise<unknown> {
	const clients: AsyncDisposable[] = []
	const identities: Record<string, ExternalArmIdentity | OracleArmIdentity> = {}
	const meter = deps.oracleMeter ?? new OracleMeter()

	const build = async (arm: ArmSpec, side: "a" | "b"): Promise<ArmRunner> => {
		if (arm.kind === "mailwoman") return mailwomanRunner(registry, arm.config, set)

		if (arm.kind === "recorded") return recordedRunner(arm, set, deps.runStoreDir ?? RUN_STORE_DIR)

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

	// Sequential, and A before B: the identity probes must both succeed before any row is scored, so a rig that is
	// down costs one refusal rather than a partial run.
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
 * Everything one cross-engine scoring pass needs. A single object rather than nine positional parameters — at that
 * count a transposed pair of same-typed arguments (`runnerA`, `runnerB`) compiles and silently swaps the arms.
 */
interface GeoScoringContext {
	registry: EngineRegistry
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

			// The protocol counts a query failure as a miss at every threshold. It stays a miss WITH its reason
			// attached, and the error list keeps the count separately, so a reader can see how much of a miss rate is
			// failure rather than absence.
			return { lat: null, lon: null, label: null, resultType: null, noResultReason: `query failed: ${message}` }
		}
	}

	// Decided before the loop, because it changes what a row's `grade` may be. An oracle is never a grading truth
	// (`oracle-arm.ts`), so a row in an oracle comparison is ungradeable however much truth the set carries.
	const hasOracle = armA.kind === "oracle" || armB.kind === "oracle"

	for (const item of set.inputs) {
		const a = await ask(runnerA, "a", item)
		const b = await ask(runnerB, "b", item)
		// The unified field, not `seed.expectLat`: only the board has a SeedCase, and a panel row's truth would
		// otherwise be invisible here. `input-sets.ts` populates it for every corpus that carries one.
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
			differed: armsDiffered(a, b, distanceA, distanceB, hasTruth),
			// Tri-state, and separate from `differed` ON PURPOSE: identity comparison runs only when BOTH
			// arms state a place-identity chain (absent = incomparable, never "same"), and it does not feed
			// `arms_differed_on` — a battery pinned on the coordinate-level zero-diff contract keeps its
			// meaning, while a wrong-instance swap under a stable coordinate becomes visible beside it.
			...(a.place_ids && b.place_ids ? { identity_differed: a.place_ids.join(">") !== b.place_ids.join(">") } : {}),
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
	// The emitted change list also carries identity-only rows (differed stays coordinate-level; the row's
	// own identity_differed flag says which kind of change a reader is looking at).
	const changedRows = rows.filter((row) => row.differed || row.identity_differed === true)
	const withTruth = rows.filter((row) => row.truth_lat !== null).length

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

	const confounds = crossEngineReading(armLabel(armA), armLabel(armB), options.declared)

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
			: // The two reasons for withholding a grade are not the same fact and must not share a sentence. "No truth
				// here" is about the set; "an oracle is present" is a refusal that holds even when the set has truth for
				// every row, and a reader told the wrong one will go looking for a corpus that already exists.
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
		.filter((sentence) => sentence.length > 0)
		.join(" ")

	const run: StoredRun = {
		run_id: (deps.newRunID ?? randomUUID)(),
		tool: "mwdev_compare",
		created_at: now(deps).toISOString(),
		tree_fingerprint: registry.fingerprint().digest,
		engine_id: null,
		input_set_id: set.setID,
		answers: {
			[runnerA.label]: recordAnswers(rows, "a"),
			[runnerB.label]: recordAnswers(rows, "b"),
		},
		payload: null,
	}

	const storeWarning = tryPutRun(run, deps.runStoreDir ?? RUN_STORE_DIR, now(deps))

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
		differed_basis: withTruth === rows.length ? "threshold-crossing-vs-truth" : "arm-separation",
		arms_differed_on_note:
			withTruth === rows.length
				? "A row counts as differed when the arms land on opposite sides of at least one threshold. Two results 900m " +
					"apart that are both hits at 1km do NOT count — across engines, the raw coordinates always differ."
				: `${rows.length - withTruth} of ${rows.length} rows carry no truth coordinate, so there is no verdict for ` +
					`the arms to land on opposite sides of. Those rows count as differed when exactly one arm answered, or ` +
					`when both answered more than ${ARM_SEPARATION_THRESHOLD_KM}km apart.`,
		// No mechanism inside another geocoder reports whether it fired, and inventing a signal for it would be worse
		// than the null §5.4 asks for.
		mechanism_fired_on: null,
		graded: {
			improved: rows.filter((row) => row.grade === "improved").length,
			regressed: rows.filter((row) => row.grade === "regressed").length,
			neutral: rows.filter((row) => row.grade === "neutral").length,
			ungradeable: rows.filter((row) => row.grade === "ungradeable").length,
		},
		thresholds,
		// A significance test and an equivalence claim are both VERDICTS, so a diff-only result carries neither. Emitting
		// them over an empty graded set would print a test at n = 0, which reads as a test that was run.
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
 * How precise the truth itself is, as a histogram of the rows' own declared tolerances.
 *
 * Reported because a threshold table read without it is a trap: a board row asserting a 25 km tolerance is a city
 * centroid, and its @1km column measures how close the arm came to a centroid nobody claimed was the address.
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
 * How many graded rows have a truth tolerance at least as coarse as the tightest reported threshold — the rows whose
 *
 * @1km column cannot mean what it appears to.
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
 * Metres in a kilometre — the truth tolerance is stated in metres and the thresholds in kilometres.
 */
const METRES_PER_KM = 1000

/**
 * Per-stratum threshold tables. The benchmark plan's rule in mechanical form: a headline "@1km" over mixed strata hides
 * an arm that won one and lost another, so the strata are reported rather than blended.
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
	// The benchmark plan names this one specifically — "@1km lives or dies on truth_type" — so a panel comparison that
	// cannot split by it is reporting a number about its own row mix.
	if (by === "truth_type") return row.truth_type ?? "unstated"

	if (by === "truth_tolerance_m") return row.truth_tolerance_m === null ? "unstated" : `${row.truth_tolerance_m}m`

	if (by === "country") return row.country ?? "unknown"

	if (by === "address_kind") return row.address_kind ?? "unknown"

	return row.status ?? "unknown"
}
