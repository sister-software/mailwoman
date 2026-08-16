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

import { formatPercent } from "@mailwoman/core/utils"
import { checkCase } from "mailwoman/eval-harness/gauntlet/check-case"
import { toGauntletResult } from "mailwoman/eval-harness/gauntlet/harness"

import { armLabel, type ArmSpec, type ExternalArm, normalizeArmSpec } from "./arms.ts"
import { checkConfounds, crossEngineReading, type ConfoundReading } from "./confound.ts"
import type { EngineConfig, EngineRegistry } from "./engine-registry.ts"
import { type ExternalAnswer, ExternalGeocoderClient, type ExternalArmIdentity } from "./external-arm.ts"
import {
	DISTANCE_THRESHOLDS_KM,
	distanceKm,
	EQUIVALENCE_THRESHOLD_KM,
	gradeAtThreshold,
	hitAt,
	thresholdKey,
	thresholdTable,
	tostEquivalence,
} from "./geo-grade.ts"
import { gradeRow, significance } from "./grade.ts"
import { resolveInputSet, type InputSetRef, type ResolvedInput, type ResolvedInputSet } from "./input-sets.ts"
import { describeObservedRate } from "./power.ts"
import {
	bucketRows,
	type ComparedRow,
	firingSignals,
	inputSetProvenance,
	provenanceFor,
	stratify,
	type StratumKey,
} from "./tool-kit.ts"

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

export interface CompareOptions {
	inputs?: InputSetRef
	armA: unknown
	armB: unknown
	declared: string[]
	stratifyBy?: StratumKey
	grade: GradeRequest
	gradeThresholdKm: number
}

export interface CompareDeps {
	/**
	 * How an external arm's client is built.
	 *
	 * The transport seam, and the only one: a test replaces the Axios adapter through this, so the real client, its
	 * pacing and its response parsing all still run against a scripted wire. A test that stubbed the ANSWER instead would
	 * be asserting its own hypothesis about the protocol.
	 */
	createExternalClient?: (arm: ExternalArm) => ExternalGeocoderClient
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
		...(args["stratify_by"] === undefined ? {} : { stratifyBy: args["stratify_by"] as StratumKey }),
		grade: (args["grade"] as GradeRequest | undefined) ?? "auto",
		gradeThresholdKm: (args["grade_threshold_km"] as number | undefined) ?? DEFAULT_GRADE_THRESHOLD_KM,
	}

	const armA = normalizeArmSpec(options.armA, "a")
	const armB = normalizeArmSpec(options.armB, "b")
	const set = await resolveInputSet(options.inputs ?? { kind: "board" })

	if (armA.kind === "mailwoman" && armB.kind === "mailwoman") {
		return compareMailwomanArms(registry, set, armA.config, armB.config, options)
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
	options: CompareOptions
): Promise<unknown> {
	// Both arms are acquired BEFORE either runs, so a source edit between them cannot go unnoticed. §3.4(d):
	// a single run may transparently rebuild, but two arms under different trees are not a comparison.
	const engineA = await registry.acquire(configA)
	const engineB = await registry.acquire(configB)

	if (engineA.fingerprint.digest !== engineB.fingerprint.digest) {
		throw new Error(
			`Arms were built against different source trees (${engineA.fingerprint.digest} vs ` +
				`${engineB.fingerprint.digest}). That is not a comparison. Restart the MCP server and re-run.`
		)
	}

	const confounds = checkConfounds(
		engineA.effective as unknown as Record<string, unknown>,
		engineB.effective as unknown as Record<string, unknown>,
		options.declared
	)

	const rows: ComparedRow[] = []
	const errors: Array<{ id: string; input: string; arm: "a" | "b"; message: string }> = []

	for (const item of set.inputs) {
		let a
		let b

		try {
			a = toGauntletResult((await engineA.session.geocode(item.input)).result)
		} catch (error) {
			errors.push({ id: item.id, input: item.input, arm: "a", message: (error as Error).message })

			continue
		}

		try {
			b = toGauntletResult((await engineB.session.geocode(item.input)).result)
		} catch (error) {
			errors.push({ id: item.id, input: item.input, arm: "b", message: (error as Error).message })

			continue
		}

		const { grade, issuesA, issuesB } = gradeRow(item.seed, a, b, checkCase)

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
		attributionSentence(confounds, zeroDifferenceCaveat),
		set.why ? `Hand-picked because: ${set.why}` : "",
	]
		.filter(Boolean)
		.join(" ")

	return {
		provenance_a: provenanceFor(engineA, set),
		provenance_b: provenanceFor(engineB, set),
		summary,
		grade_mode: mode,
		...withheldVerdict(
			mode,
			'no truth for this input set; changes are described, not graded. Run against {kind:"board"} to grade.'
		),
		attribution: confounds.attribution,
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
}

/**
 * How one arm answers one raw query string, whichever kind of arm it is.
 */
interface ArmRunner {
	label: string
	provenance: Record<string, unknown>
	answer: (input: string) => Promise<ExternalAnswer>
	warnings: string[]
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
		provenance: provenanceFor(engine, set) as unknown as Record<string, unknown>,
		warnings: [],
		answer: async (input) => {
			const { result } = await engine.session.geocode(input)

			return {
				lat: result.lat,
				lon: result.lon,
				label: result.locality ?? result.region ?? null,
				resultType: result.resolution_tier,
				noResultReason: result.lat === null ? "the pipeline resolved no coordinate" : null,
			}
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
 * One row of a cross-engine comparison.
 */
// `issues_a` / `issues_b` are dropped rather than carried empty: they are `checkCase`'s output, and an empty issue
// list on a row nothing graded reads as a row that graded clean.
interface GeoRow extends Omit<ComparedRow, "a" | "b" | "issues_a" | "issues_b"> {
	a: ExternalAnswer
	b: ExternalAnswer
	truth_lat: number | null
	truth_lon: number | null
	truth_tolerance_m: number | null
	distance_km_a: number | null
	distance_km_b: number | null
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
	const clients: ExternalGeocoderClient[] = []
	const identities: Record<string, ExternalArmIdentity> = {}

	const build = async (arm: ArmSpec, side: "a" | "b"): Promise<ArmRunner> => {
		if (arm.kind === "mailwoman") return mailwomanRunner(registry, arm.config, set)

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
		return await scoreGeoRows(set, armA, armB, runnerA, runnerB, identities, options)
	} finally {
		for (const client of clients) {
			await client[Symbol.asyncDispose]()
		}
	}
}

async function scoreGeoRows(
	set: ResolvedInputSet,
	armA: ArmSpec,
	armB: ArmSpec,
	runnerA: ArmRunner,
	runnerB: ArmRunner,
	identities: Record<string, ExternalArmIdentity>,
	options: CompareOptions
): Promise<unknown> {
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

	for (const item of set.inputs) {
		const a = await ask(runnerA, "a", item)
		const b = await ask(runnerB, "b", item)
		const truthLat = item.seed?.expectLat ?? null
		const truthLon = item.seed?.expectLon ?? null
		const hasTruth = typeof truthLat === "number" && typeof truthLon === "number"
		const distanceA = hasTruth ? distanceKm(a, truthLat, truthLon) : null
		const distanceB = hasTruth ? distanceKm(b, truthLat, truthLon) : null

		rows.push({
			id: item.id,
			input: item.input,
			country: item.country,
			address_kind: item.addressKind,
			status: item.status,
			// Across engines the coordinates essentially always differ, so a raw value diff would report 100% and mean
			// nothing. What differs usefully is the VERDICT: whether the two arms land on the same side of the
			// thresholds. Two hits 900 m apart are the same finding; a hit and a miss are not.
			differed: DISTANCE_THRESHOLDS_KM.some((threshold) => hitAt(distanceA, threshold) !== hitAt(distanceB, threshold)),
			grade: hasTruth ? gradeAtThreshold(distanceA, distanceB, options.gradeThresholdKm) : "ungradeable",
			a,
			b,
			truth_lat: truthLat,
			truth_lon: truthLon,
			truth_tolerance_m: item.seed?.expectToleranceM ?? null,
			distance_km_a: distanceA,
			distance_km_b: distanceB,
		})
	}

	const graded = rows.filter((row) => row.grade !== "ungradeable")
	const differed = rows.filter((row) => row.differed)
	const mode = resolveGradeMode(options.grade, graded.length > 0, "no row in this set carries a truth coordinate")
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
		.filter(Boolean)
		.join(" ")

	return {
		provenance_a: runnerA.provenance,
		provenance_b: runnerB.provenance,
		summary,
		grade_mode: mode,
		...withheldVerdict(
			mode,
			"no truth coordinate for this input set; a cross-engine comparison has no other grading axis, so the " +
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
		attribution: confounds.attribution,
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
		arms_differed_on_note:
			"A row counts as differed when the arms land on opposite sides of at least one threshold. Two results 900m " +
			"apart that are both hits at 1km do NOT count — across engines, the raw coordinates always differ.",
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
		significance: test,
		equivalence,
		power: changeReading,
		truth_precision_m: truthPrecision(graded),
		...(identities["a"] ? { arm_a_identity: identities["a"] } : {}),
		...(identities["b"] ? { arm_b_identity: identities["b"] } : {}),
		...(options.stratifyBy ? { strata: stratifyGeo(rows, options.stratifyBy) } : {}),
		rows_changed: differed,
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
	if (by === "truth_tolerance_m") return row.truth_tolerance_m === null ? "unstated" : `${row.truth_tolerance_m}m`

	if (by === "country") return row.country ?? "unknown"

	if (by === "address_kind") return row.address_kind ?? "unknown"

	return row.status ?? "unknown"
}

/**
 * Pick the grading mode, honouring an explicit request and refusing one that cannot be met.
 *
 * `truth` is a REFUSAL when the set carries none, not a silent downgrade: a caller who asked to be graded and was
 * quietly given a diff is the exact failure §5.5 is about, one step earlier.
 */
function resolveGradeMode(request: GradeRequest, hasTruth: boolean, absence: string): "truth" | "diff-only" {
	if (request === "diff-only") return "diff-only"

	if (request === "truth" && !hasTruth) {
		throw new Error(
			`grade: "truth" was requested but ${absence}. Nothing here can be graded — run against {kind:"board"}, or ` +
				'pass grade: "diff-only" to describe the differences without a verdict.'
		)
	}

	return hasTruth ? "truth" : "diff-only"
}

function withheldVerdict(mode: "truth" | "diff-only", reason: string): Record<string, unknown> {
	return mode === "diff-only" ? { verdict: null, verdict_withheld_reason: reason } : {}
}

function attributionSentence(confounds: ConfoundReading, exclude: string): string {
	if (confounds.attribution === "clean") return ""

	return `ATTRIBUTION ${confounds.attribution.toUpperCase()}: ${confounds.warnings.filter((warning) => warning !== exclude).join(" ")}`
}
