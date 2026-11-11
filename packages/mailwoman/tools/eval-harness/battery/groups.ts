/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compares two groups of trained runs on a battery report: a control recipe's seeds against a candidate's.
 *
 *   A single run of a recipe is one draw from its training noise. Two runs of one config and one seed on the A100
 *   disagreed on 5.1% of battery rows, and two seeds on 6.5% to 7.6% (#2869). A difference between arms is therefore
 *   read against the spread between runs of the same arm. The comparison reports, per suite and per country:
 *
 *   - each group's mean rate and the difference between them;
 *   - the spread between runs inside each group, as the pooled standard deviation of the run rates and the mean share
 *     of rows on which two runs of one group disagree;
 *   - the rows that move under the agreement rule of {@linkcode agreementQuorum};
 *   - a t statistic whose standard error adds the between-run variance of the two group means to the row-sampling
 *     variance of their difference, with `k_a + k_b - 2` degrees of freedom, and its two-sided p value;
 *   - for countries, Holm-adjusted p values over every country with enough rows.
 *
 *   It also reports the smallest difference a comparison with `k` runs per arm could detect, and the difference of
 *   every regrouping of the pooled runs into groups of the same sizes. Those regroupings give the spread that the
 *   choice of split produces by itself.
 */

import { formatPercent, mean } from "@mailwoman/core/stats"

import type { BatteryReport, BatteryRowResult } from "#tools/eval-harness/battery/battery"
import { regularizedBeta, studentTUpperQuantile } from "#tools/eval-harness/release/bounds"

/**
 * A group of runs of one recipe under one label, each run an arm of the battery report.
 */
export interface RunGroup {
	name: string
	runs: readonly string[]
}

/**
 * The comparison of two run groups over one set of decision rows.
 */
export interface CellComparison {
	label: string
	rows: number
	/**
	 * Each run's share of the rows right, in the order of the group's runs.
	 */
	ratesA: number[]
	ratesB: number[]
	meanA: number
	meanB: number
	/**
	 * `meanB - meanA`, a share of the rows.
	 */
	difference: number
	/**
	 * The pooled standard deviation of the run rates within the two groups.
	 */
	runSD: number
	/**
	 * The mean share of rows on which two runs of the group disagree, or null for a group of one run.
	 */
	disagreementA: number | null
	disagreementB: number | null
	/**
	 * Rows group A holds right and group B wrong under the agreement rule, and the reverse.
	 */
	regressed: number
	improved: number
	standardError: number
	degreesOfFreedom: number
	t: number
	p: number
}

/**
 * A country's comparison with its Holm-adjusted p value.
 */
export interface CountryComparison extends CellComparison {
	holmP: number
}

/**
 * The smallest detectable difference with `runsPerArm` runs in each group.
 */
export interface DetectableDifference {
	runsPerArm: number
	difference: number
}

/**
 * The difference one regrouping of the pooled runs gives on every decision row.
 */
export interface Regrouping {
	a: string[]
	b: string[]
	difference: number
	net: number
	observed: boolean
}

/**
 * The full comparison of two run groups.
 */
export interface GroupComparison {
	a: RunGroup
	b: RunGroup
	total: CellComparison
	suites: CellComparison[]
	countries: CountryComparison[]
	minimumCountryRows: number
	detectable: { label: string; byRuns: DetectableDifference[] }[]
	regroupings: Regrouping[]
}

/**
 * The smallest group in which one run may disagree with the others on a moved row.
 *
 * A group of two that let one run disagree would count a row as moved on one run's say.
 */
const SMALLEST_GROUP_ALLOWING_ONE_DISSENT = 3

/**
 * The number of a group's runs that must agree on a row before the row counts as moved:
 * every run for a group of one or two, and all but one for three or more.
 */
export function agreementQuorum(runs: number): number {
	return runs >= SMALLEST_GROUP_ALLOWING_ONE_DISSENT ? runs - 1 : runs
}

/**
 * The two-sided p value of Student's t at `t` with `df` degrees of freedom.
 */
export function twoSidedTP(t: number, df: number): number {
	if (!Number.isFinite(t)) return 0

	return regularizedBeta(df / (df + t * t), df / 2, 0.5)
}

/**
 * Holm's step-down adjustment of `ps`, returned in the input order.
 */
export function holmAdjust(ps: readonly number[]): number[] {
	const order = ps.map((p, i) => [p, i] as const).toSorted((x, y) => x[0] - y[0])
	const adjusted = new Array<number>(ps.length)
	let running = 0

	order.forEach(([p, i], rank) => {
		running = Math.max(running, Math.min(1, (ps.length - rank) * p))
		adjusted[i] = running
	})

	return adjusted
}

function variance(xs: readonly number[]): number {
	if (xs.length < 2) return 0

	const m = mean(xs)!

	return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)
}

function meanPairwiseDisagreement(rows: readonly BatteryRowResult[], runs: readonly string[]): number | null {
	if (runs.length < 2 || !rows.length) return null

	const shares: number[] = []

	for (let i = 0; i < runs.length; i++) {
		for (let j = i + 1; j < runs.length; j++) {
			shares.push(rows.filter((row) => row.right[runs[i]!] !== row.right[runs[j]!]).length / rows.length)
		}
	}

	return mean(shares)
}

/**
 * Compares group `b` against group `a` on `rows`.
 */
export function compareCell(
	label: string,
	rows: readonly BatteryRowResult[],
	a: RunGroup,
	b: RunGroup
): CellComparison {
	const n = rows.length
	const rate = (run: string) => (n === 0 ? 0 : rows.filter((row) => row.right[run]).length / n)
	const ratesA = a.runs.map(rate)
	const ratesB = b.runs.map(rate)
	const meanA = mean(ratesA) ?? 0
	const meanB = mean(ratesB) ?? 0
	const degreesOfFreedom = Math.max(1, a.runs.length + b.runs.length - 2)

	const pooled =
		((a.runs.length - 1) * variance(ratesA) + (b.runs.length - 1) * variance(ratesB)) /
		Math.max(1, a.runs.length + b.runs.length - 2)

	// The per-row difference of the group means: its variance over rows is the row-sampling term.
	const share = (row: BatteryRowResult, runs: readonly string[]) =>
		runs.filter((run) => row.right[run]).length / runs.length

	const rowDifferences = rows.map((row) => share(row, b.runs) - share(row, a.runs))
	const rowTerm = n > 1 ? variance(rowDifferences) / n : 0
	const standardError = Math.sqrt(pooled * (1 / a.runs.length + 1 / b.runs.length) + rowTerm)
	const difference = meanB - meanA
	const t = standardError > 0 ? difference / standardError : difference === 0 ? 0 : Infinity

	const quorumA = agreementQuorum(a.runs.length)
	const quorumB = agreementQuorum(b.runs.length)
	const rightCount = (row: BatteryRowResult, runs: readonly string[]) => runs.filter((run) => row.right[run]).length
	let regressed = 0
	let improved = 0

	for (const row of rows) {
		const rightA = rightCount(row, a.runs)
		const rightB = rightCount(row, b.runs)

		if (rightA >= quorumA && b.runs.length - rightB >= quorumB) {
			regressed++
		} else if (a.runs.length - rightA >= quorumA && rightB >= quorumB) {
			improved++
		}
	}

	return {
		label,
		rows: n,
		ratesA,
		ratesB,
		meanA,
		meanB,
		difference,
		runSD: Math.sqrt(pooled),
		disagreementA: meanPairwiseDisagreement(rows, a.runs),
		disagreementB: meanPairwiseDisagreement(rows, b.runs),
		regressed,
		improved,
		standardError,
		degreesOfFreedom,
		t,
		p: twoSidedTP(Math.abs(t), degreesOfFreedom),
	}
}

/**
 * The smallest difference a two-sided test at `alpha` detects with power `power`, given a cell's
 * between-run standard deviation and its row-sampling standard error, with `runs` runs in each arm.
 */
export function detectableDifference(cell: CellComparison, runs: number, alpha = 0.05, power = 0.8): number {
	const df = 2 * runs - 2

	const rowTerm = Math.max(
		0,
		cell.standardError ** 2 - cell.runSD ** 2 * (1 / cell.ratesA.length + 1 / cell.ratesB.length)
	)

	const se = Math.sqrt((cell.runSD ** 2 * 2) / runs + rowTerm)

	return (studentTUpperQuantile(alpha / 2, df) + studentTUpperQuantile(1 - power, df)) * se
}

function combinations<T>(items: readonly T[], size: number): T[][] {
	if (size === 0) return [[]]

	if (items.length < size) return []

	const [head, ...rest] = items as [T, ...T[]]

	return [...combinations(rest, size - 1).map((c) => [head, ...c]), ...combinations(rest, size)]
}

/**
 * Compares two run groups across a battery report's decision rows.
 *
 * @throws When a run isn't an arm of the report, or a run appears in both groups.
 */
export function compareRunGroups(
	report: BatteryReport,
	a: RunGroup,
	b: RunGroup,
	options: { minimumCountryRows?: number } = {}
): GroupComparison {
	const arms = new Set(report.arms.map((arm) => arm.name))

	for (const run of [...a.runs, ...b.runs]) {
		if (!arms.has(run)) throw new Error(`${run} is not an arm of the report (arms: ${[...arms].join(", ")})`)
	}

	if (a.runs.some((run) => b.runs.includes(run))) throw new Error(`a run appears in both ${a.name} and ${b.name}`)

	const minimumCountryRows = options.minimumCountryRows ?? 200
	const decision = (rows: readonly BatteryRowResult[]) => rows.filter((row) => !row.labelConvention)
	const all = Object.values(report.suites).flatMap(({ rows }) => decision(rows))

	const suites = Object.entries(report.suites)
		.map(([id, { rows }]) => compareCell(id, decision(rows), a, b))
		.filter((cell) => cell.rows > 0)

	const byCountry = new Map<string, BatteryRowResult[]>()

	for (const row of all) {
		byCountry.set(row.country, [...(byCountry.get(row.country) ?? []), row])
	}

	const tested = [...byCountry.entries()]
		.filter(([, rows]) => rows.length >= minimumCountryRows)
		.map(([country, rows]) => compareCell(country, rows, a, b))

	const holm = holmAdjust(tested.map((cell) => cell.p))
	const countries = tested.map((cell, i) => ({ ...cell, holmP: holm[i]! })).toSorted((x, y) => x.p - y.p)

	const total = compareCell("all suites", all, a, b)

	const detectable = [total, ...suites].map((cell) => ({
		label: cell.label,
		byRuns: [2, 3, 4, 5].map((runsPerArm) => ({ runsPerArm, difference: detectableDifference(cell, runsPerArm) })),
	}))

	const pooled = [...a.runs, ...b.runs]
	const observedA = a.runs.toSorted().join(",")

	const regroupings = combinations(pooled, a.runs.length).map((groupA) => {
		const groupB = pooled.filter((run) => !groupA.includes(run))
		const cell = compareCell("regrouping", all, { name: "a", runs: groupA }, { name: "b", runs: groupB })

		return {
			a: groupA,
			b: groupB,
			difference: cell.difference,
			net: cell.improved - cell.regressed,
			observed: groupA.toSorted().join(",") === observedA,
		}
	})

	return { a, b, total, suites, countries, minimumCountryRows, detectable, regroupings }
}

const pp = (share: number) => `${share >= 0 ? "+" : "−"}${Math.abs(share * 100).toFixed(2)}`
const pct = (share: number | null) => (share == null ? "—" : formatPercent(share, 1))
/**
 * The smallest p value the report prints as a number: four decimals, the precision it prints at.
 */
const SMALLEST_PRINTED_P = 0.0001
const pValue = (p: number) => (p < SMALLEST_PRINTED_P ? `<${SMALLEST_PRINTED_P}` : p.toFixed(4))

function cellLine(cell: CellComparison): string {
	return [
		cell.label,
		cell.rows.toLocaleString("en-US"),
		pct(cell.meanA),
		pct(cell.meanB),
		pp(cell.difference),
		(cell.runSD * 100).toFixed(2),
		pct(cell.disagreementA),
		pct(cell.disagreementB),
		`${cell.regressed} / ${cell.improved}`,
		cell.t.toFixed(2),
		pValue(cell.p),
	].join(" | ")
}

/**
 * Renders a run-group comparison as markdown.
 */
export function formatGroupComparison(comparison: GroupComparison): string {
	const { a, b, total, suites, countries, detectable, regroupings } = comparison
	const header = `| Cell | Rows | ${a.name} | ${b.name} | Difference (pp) | Run SD (pp) | ${a.name} disagree | ${b.name} disagree | Regressed / improved | t | p |`
	const rule = "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"

	const lines = [
		`# ${b.name} against ${a.name}`,
		"",
		`${a.name}: ${a.runs.join(", ")}. ${b.name}: ${b.runs.join(", ")}. Decision rows only.`,
		"",
		`A row regresses when at least ${agreementQuorum(a.runs.length)} of ${a.runs.length} ${a.name} runs are right and at least ${agreementQuorum(b.runs.length)} of ${b.runs.length} ${b.name} runs are wrong; it improves the other way round. The standard error adds the between-run variance of the two means to the row-sampling variance of their difference, with ${total.degreesOfFreedom} degrees of freedom.`,
		"",
		"## By suite",
		"",
		header,
		rule,
		...[total, ...suites].map((cell) => `| ${cellLine(cell)} |`),
		"",
		`## By country (${countries.length} countries with at least ${comparison.minimumCountryRows} decision rows, Holm-adjusted)`,
		"",
		`${header} Holm p |`,
		`${rule} ---: |`,
		...countries.map((cell) => `| ${cellLine(cell)} | ${pValue(cell.holmP)} |`),
		"",
		"## Smallest detectable difference (two-sided, alpha 0.05, power 0.8), in points",
		"",
		"| Cell | 2 runs per arm | 3 | 4 | 5 |",
		"| --- | ---: | ---: | ---: | ---: |",
		...detectable.map(
			(cell) => `| ${cell.label} | ${cell.byRuns.map((d) => (d.difference * 100).toFixed(2)).join(" | ")} |`
		),
		"",
		`## Every regrouping of the ${a.runs.length + b.runs.length} runs into groups of ${a.runs.length} and ${b.runs.length}`,
		"",
		"| Group a | Group b | Difference (pp) | Improved − regressed rows |",
		"| --- | --- | ---: | ---: |",
		...regroupings
			.toSorted((x, y) => x.difference - y.difference)
			.map(
				(r) =>
					`| ${r.a.join(", ")}${r.observed ? " (observed)" : ""} | ${r.b.join(", ")} | ${pp(r.difference)} | ${r.net} |`
			),
		"",
	]

	return lines.join("\n")
}
