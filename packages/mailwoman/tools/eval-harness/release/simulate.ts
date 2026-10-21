/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Statistical validation of the release evaluator. A scenario fixes the true per-country exact parse rates of
 *   the published and candidate models, the rows per country, the group size and within-group correlation of
 *   derived variants, and the discordance between the arms. The harness draws paired outcomes from that truth,
 *   evaluates a synthetic specification through `evaluateReleaseSpec`, and repeats with distinct seeds.
 *
 *   Every threshold a scenario carries is a simulation parameter. None is a registered release requirement.
 *
 *   Generative model, per country:
 *
 *   - The joint distribution of one row's (published, candidate) pair follows from the two true rates and the
 *       discordance d = P(published != candidate): P(1, 0) = (d - delta) / 2 and P(0, 1) = (d + delta) / 2, with
 *       delta the true candidate minus published rate.
 *   - Rows come in groups of `groupSize`. With probability `correlation` a group shares one pair for every
 *       member, as derived variants of one address would. Otherwise each member draws its own pair. Each arm's
 *       marginal rate is preserved, and the within-group correlation of either arm's outcome is `correlation`.
 *   - `grouping: "metadata"` gives every row its group id; `"row_identity"` omits it, so the evaluator treats
 *       every row as independent.
 *
 *   Repeated selection (`selection.candidates = k`) draws k candidates with the same truth against one set of
 *   published outcomes, keeps the one whose measured Q improvement is largest, and evaluates it either on the
 *   same rows (`confirmation: "same"`) or on freshly drawn rows (`"fresh"`).
 */

import { mulberry32 } from "@mailwoman/core/random"

import { evaluateReleaseSpec, type PairedRow, ReleaseOutcome } from "#tools/eval-harness/release/evaluate"
import {
	MultipleComparisonMethod,
	type ReleaseRequirementSpec,
	validateReleaseSpec,
} from "#tools/eval-harness/release/requirements"

export interface SimulatedCountry {
	country: string
	rows: number
	/**
	 * True published exact parse rate.
	 */
	published: number
	/**
	 * True candidate exact parse rate.
	 */
	candidate: number
	/**
	 * P(published != candidate) per row.
	 *
	 * Defaults to the smallest feasible value, `|candidate - published|`.
	 */
	discordance?: number
	/**
	 * Rows per group.
	 *
	 * The last group may be smaller.
	 * Defaults to 1.
	 */
	groupSize?: number
	/**
	 * Probability that a group shares one outcome pair.
	 * Defaults to 0.
	 */
	correlation?: number
	/**
	 * Simulation parameter: the minimum candidate rate this country is required to meet.
	 * Absent means not required.
	 */
	minimum?: number
}

export interface SimulationScenario {
	id: string
	description: string
	countries: SimulatedCountry[]
	/**
	 * Countries in the objective set C. Defaults to every country.
	 */
	objectiveCountries?: string[]
	/**
	 * Simulation parameter: the required Q improvement.
	 */
	minimumImprovement: number
	confidenceLevel: number
	multipleComparison?: MultipleComparisonMethod
	/**
	 * `row_identity` omits the group field.
	 *
	 * The synthetic specification never declares rows independent, so those scenarios
	 * measure the refusal of ungrouped rows.
	 */
	grouping: "metadata" | "row_identity"
	selection?: { candidates: number; confirmation: "same" | "fresh" }
}

export interface Rate {
	count: number
	total: number
	rate: number
	low: number
	high: number
}

export interface CheckCoverage {
	id: string
	check: "minimum" | "max_loss" | "objective"
	truth: number
	coverage: Rate
}

export interface ScenarioReport {
	id: string
	description: string
	repetitions: number
	rows: number
	/**
	 * Whether the truth meets every simulation requirement, inclusive.
	 */
	truthMeetsAll: boolean
	truthImprovement: number
	pass: Rate
	fail: Rate
	insufficient: Rate
	/**
	 * Pass while the truth misses a requirement; `null` when the truth meets them all.
	 */
	erroneousApproval: Rate | null
	/**
	 * Fail while the truth meets every requirement; `null` when it does not.
	 */
	erroneousFail: Rate | null
	/**
	 * Fraction of evaluations in which every check's bounds include its truth.
	 */
	jointCoverage: Rate
	checks: CheckCoverage[]
	/**
	 * Evaluations in which some check had no bounds, such as ungrouped rows the
	 * specification does not declare independent.
	 * Such a check counts as not covering its truth.
	 */
	unbounded: number
}

/**
 * Wilson score interval for a binomial proportion.
 */
export function wilsonRate(count: number, total: number, z = 1.96): Rate {
	if (total === 0)
		return {
			count,
			total,
			rate: Number.NaN,
			low: Number.NaN,
			high: Number.NaN,
		}

	const p = count / total
	const z2 = z * z
	const denom = 1 + z2 / total
	const center = p + z2 / (2 * total)
	const spread = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))

	return {
		count,
		total,
		rate: p,
		low: Math.max(0, (center - spread) / denom),
		high: Math.min(1, (center + spread) / denom),
	}
}

const probability = (value: unknown): value is number => typeof value === "number" && value >= 0 && value <= 1

/**
 * Refuses a scenario whose truth is infeasible or whose fields are malformed, naming the field.
 */
export function validateSimulationScenario(scenario: SimulationScenario): void {
	const fail = (problem: string): never => {
		throw new Error(`scenario ${String(scenario?.id)}: ${problem}`)
	}

	if (typeof scenario?.id !== "string" || !scenario.id) {
		fail("id must be a non-empty string")
	}

	if (!Array.isArray(scenario.countries) || !scenario.countries.length) {
		fail("countries must be a non-empty array")
	}

	const names = new Set<string>()

	for (const c of scenario.countries) {
		if (typeof c.country !== "string" || !c.country) {
			fail("a country lacks its code")
		}

		if (names.has(c.country)) {
			fail(`country ${c.country} appears twice`)
		}

		names.add(c.country)

		if (!Number.isInteger(c.rows) || c.rows < 1) {
			fail(`${c.country}.rows must be a positive integer`)
		}

		if (!probability(c.published) || !probability(c.candidate)) {
			fail(`${c.country} rates must lie in [0, 1]`)
		}

		const groupSize = c.groupSize ?? 1

		if (!Number.isInteger(groupSize) || groupSize < 1) {
			fail(`${c.country}.groupSize must be a positive integer`)
		}

		if (!probability(c.correlation ?? 0)) {
			fail(`${c.country}.correlation must lie in [0, 1]`)
		}

		if (c.minimum != null && !probability(c.minimum)) {
			fail(`${c.country}.minimum must lie in [0, 1]`)
		}

		jointCells(c, fail)
	}

	for (const country of scenario.objectiveCountries ?? []) {
		if (!names.has(country)) {
			fail(`objective country ${country} is not simulated`)
		}
	}

	if (typeof scenario.minimumImprovement !== "number" || Math.abs(scenario.minimumImprovement) > 1) {
		fail("minimumImprovement must be a number in [-1, 1]")
	}

	if (!(scenario.confidenceLevel > 0 && scenario.confidenceLevel < 1)) {
		fail("confidenceLevel must lie in (0, 1)")
	}

	if (scenario.grouping !== "metadata" && scenario.grouping !== "row_identity") {
		fail("grouping must be metadata or row_identity")
	}

	if (scenario.selection) {
		const { candidates, confirmation } = scenario.selection

		if (!Number.isInteger(candidates) || candidates < 1) {
			fail("selection.candidates must be a positive integer")
		}

		if (confirmation !== "same" && confirmation !== "fresh") {
			fail("selection.confirmation must be same or fresh")
		}
	}
}

/**
 * P(published=1, candidate=0) and P(published=0, candidate=1) for a country,
 * refusing an infeasible discordance.
 */
function jointCells(c: SimulatedCountry, fail: (problem: string) => never): { a: number; b: number } {
	const delta = c.candidate - c.published
	const d = c.discordance ?? Math.abs(delta)

	if (!probability(d)) {
		fail(`${c.country}.discordance must lie in [0, 1]`)
	}

	const a = (d - delta) / 2
	const b = (d + delta) / 2
	const eps = 1e-12

	if (a < -eps || b < -eps || c.published - a < -eps || 1 - c.published - b < -eps) {
		fail(`${c.country}: discordance ${d} is infeasible for rates ${c.published} and ${c.candidate}`)
	}

	return { a: Math.max(0, a), b: Math.max(0, b) }
}

/**
 * One drawn evaluation set: the published outcome of every row, its structure,
 * and a way to draw a candidate.
 */
interface DrawnSet {
	rows: Array<Omit<PairedRow, "candidate">>
	/**
	 * For each row, the index of the outcome unit it shares (a shared group or the row itself).
	 */
	unit: Int32Array
	unitPublished: Uint8Array
	unitCountry: SimulatedCountry[]
}

function drawSet(scenario: SimulationScenario, random: () => number): DrawnSet {
	const rows: DrawnSet["rows"] = []
	const unitList: number[] = []
	const unitPublished: number[] = []
	const unitCountry: SimulatedCountry[] = []

	for (const c of scenario.countries) {
		const groupSize = c.groupSize ?? 1
		const correlation = c.correlation ?? 0

		for (let start = 0, g = 0; start < c.rows; start += groupSize, g++) {
			const shared = random() < correlation
			let unit = -1

			for (let i = start; i < Math.min(c.rows, start + groupSize); i++) {
				if (!shared || unit < 0) {
					unit = unitPublished.length
					unitPublished.push(random() < c.published ? 1 : 0)
					unitCountry.push(c)
				}

				unitList.push(unit)

				rows.push({
					rowID: `${c.country}:${i}`,
					country: c.country,
					source: `sim-${c.country.toLowerCase()}`,
					kind: "address",
					provenance: "verified_unseen",
					group: scenario.grouping === "metadata" ? `${c.country}:g${g}` : null,
					weightsLocale: "simulation",
					published: unitPublished[unit] === 1,
				})
			}
		}
	}

	return {
		rows,
		unit: Int32Array.from(unitList),
		unitPublished: Uint8Array.from(unitPublished),
		unitCountry,
	}
}

const refuse = (problem: string): never => {
	throw new Error(problem)
}

/**
 * Draws one candidate's outcomes conditional on the set's published outcomes.
 */
function drawCandidate(set: DrawnSet, random: () => number): PairedRow[] {
	const unitCandidate = new Uint8Array(set.unitPublished.length)

	for (let u = 0; u < unitCandidate.length; u++) {
		const c = set.unitCountry[u]!
		const { a, b } = jointCells(c, refuse)
		const p = set.unitPublished[u] === 1

		const given = p
			? c.published > 0
				? (c.published - a) / c.published
				: 0
			: c.published < 1
				? b / (1 - c.published)
				: 0

		unitCandidate[u] = random() < given ? 1 : 0
	}

	return set.rows.map((row, i) => ({
		...row,
		candidate: unitCandidate[set.unit[i]!] === 1,
	}))
}

const PUBLISHED_SHA = "0".repeat(64)
const CANDIDATE_SHA = "1".repeat(64)

/**
 * The synthetic specification a scenario is evaluated against.
 * Its thresholds are simulation parameters.
 */
export function scenarioSpec(scenario: SimulationScenario): ReleaseRequirementSpec {
	return validateReleaseSpec(
		{
			schemaVersion: 3,
			specVersion: `simulation:${scenario.id}`,
			rationale: "Simulation parameters for statistical validation; not a registered requirement.",
			requirements: scenario.countries
				.filter((c) => c.minimum != null)
				.map((c) => ({
					id: c.country,
					kind: "country",
					country: c.country,
					reason: "simulation parameter",
					minimum: c.minimum,
				})),
			objective: {
				countries: objectiveCountries(scenario),
				minimumImprovement: scenario.minimumImprovement,
			},
			identities: {
				dataset: { id: null, sha256: null },
				scorer: { id: "exact-parse", revision: "simulation" },
				inference: { description: "simulation", options: {} },
				published: {
					description: "simulated published",
					sha256: PUBLISHED_SHA,
				},
				candidate: {
					description: "simulated candidate",
					sha256: CANDIDATE_SHA,
				},
			},
			statistics: {
				confidenceLevel: scenario.confidenceLevel,
				multipleComparison: scenario.multipleComparison ?? MultipleComparisonMethod.Bonferroni,
				samplingUnit: "group",
				rowsIndependent: false,
				groupingAssumption: `simulation: ${scenario.grouping}`,
				requiredPrecision: null,
			},
			provenance: { admitted: { minimum: ["verified_unseen"], comparative: ["verified_unseen"] } },
			evaluations: {
				development: { id: null, description: "simulation" },
				confirmation: { id: null, description: "simulation" },
			},
		},
		`simulation scenario ${scenario.id}`
	)
}

function objectiveCountries(scenario: SimulationScenario): string[] {
	return scenario.objectiveCountries ?? scenario.countries.map((c) => c.country)
}

function measuredImprovement(rows: readonly PairedRow[], countries: readonly string[]): number {
	let sum = 0

	for (const country of countries) {
		let n = 0
		let diff = 0

		for (const row of rows) {
			if (row.country !== country) continue

			n++
			diff += Number(row.candidate) - Number(row.published)
		}

		sum += diff / n
	}

	return sum / countries.length
}

/**
 * Runs `repetitions` evaluations of a scenario.
 *
 * Repetition r draws data from seed `seed + r`, so every repetition is distinct and the run is reproducible.
 * The evaluator's bounds are analytic and draw no random numbers of their own.
 */
export function simulateScenario(scenario: SimulationScenario, repetitions: number, seed: number): ScenarioReport {
	validateSimulationScenario(scenario)

	if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("repetitions must be a positive integer")

	const objective = objectiveCountries(scenario)

	let improvementSum = 0

	for (const country of objective) {
		const c = scenario.countries.find((x) => x.country === country)!

		improvementSum += c.candidate - c.published
	}

	const truthImprovement = improvementSum / objective.length

	const truthByCheck = new Map<string, number>()

	for (const c of scenario.countries) {
		if (c.minimum != null) {
			truthByCheck.set(c.country, c.candidate)
		}
	}

	truthByCheck.set("objective", truthImprovement)

	const eps = 1e-12

	const truthMeetsAll =
		scenario.countries.every((c) => c.minimum == null || c.candidate >= c.minimum - eps) &&
		truthImprovement >= scenario.minimumImprovement - eps

	let pass = 0
	let fail = 0
	let insufficient = 0
	let joint = 0
	let unbounded = 0
	const covered = new Map<string, number>()
	let checkKinds = new Map<string, CheckCoverage["check"]>()
	let rowsPerSet = 0

	for (let r = 0; r < repetitions; r++) {
		const random = mulberry32((seed + r) >>> 0)
		const set = drawSet(scenario, random)
		let paired = drawCandidate(set, random)

		if (scenario.selection && scenario.selection.candidates > 1) {
			let best = measuredImprovement(paired, objective)

			for (let k = 1; k < scenario.selection.candidates; k++) {
				const next = drawCandidate(set, random)
				const value = measuredImprovement(next, objective)

				if (value > best) {
					best = value
					paired = next
				}
			}
		}

		if (scenario.selection?.confirmation === "fresh") {
			paired = drawCandidate(drawSet(scenario, random), random)
		}

		rowsPerSet = paired.length

		const verdict = evaluateReleaseSpec(
			scenarioSpec(scenario),
			paired,
			{ published: PUBLISHED_SHA, candidate: CANDIDATE_SHA },
			{ rule: "simulation" }
		)

		if (verdict.outcome === ReleaseOutcome.Pass) {
			pass++
		} else if (verdict.outcome === ReleaseOutcome.Fail) {
			fail++
		} else {
			insufficient++
		}

		let all = true
		let bounded = true

		checkKinds = new Map(verdict.checks.map((c) => [c.id, c.check]))

		for (const check of verdict.checks) {
			const truth = truthByCheck.get(check.id)

			if (truth == null) throw new Error(`the verdict holds a check ${check.id} with no simulated truth`)

			if (check.lower == null || check.upper == null) {
				bounded = false
				all = false

				continue
			}

			const inside = check.lower <= truth + eps && truth - eps <= check.upper

			if (inside) {
				covered.set(check.id, (covered.get(check.id) ?? 0) + 1)
			} else {
				all = false
			}
		}

		if (!bounded) {
			unbounded++
		}

		if (all) {
			joint++
		}
	}

	return {
		id: scenario.id,
		description: scenario.description,
		repetitions,
		rows: rowsPerSet,
		truthMeetsAll,
		truthImprovement,
		pass: wilsonRate(pass, repetitions),
		fail: wilsonRate(fail, repetitions),
		insufficient: wilsonRate(insufficient, repetitions),
		erroneousApproval: truthMeetsAll ? null : wilsonRate(pass, repetitions),
		erroneousFail: truthMeetsAll ? wilsonRate(fail, repetitions) : null,
		jointCoverage: wilsonRate(joint, repetitions),
		checks: [...truthByCheck.entries()].map(([id, truth]) => ({
			id,
			check: checkKinds.get(id) ?? "minimum",
			truth,
			coverage: wilsonRate(covered.get(id) ?? 0, repetitions),
		})),
		unbounded,
	}
}
