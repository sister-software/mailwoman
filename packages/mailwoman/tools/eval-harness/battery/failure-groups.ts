/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Groups the battery's decision rows by how the arms fail together, and prints each group with full addresses.
 *
 *   Three row sets are read. A row is all-wrong when every arm is wrong. A row is a seeds fix when the baseline is
 *   wrong and every seed is right, and a seeds break when the baseline is right and every seed is wrong. All-wrong
 *   rows are counted per suite, per suite and country cell, and per suite and cause, where the cause is the one every
 *   arm shares or `mixed`. Fixes are filed under the baseline's cause and breaks under the first seed's cause.
 *
 *   Two readers classify a wrong parse further. The venue shape reports how an arm handled the expected venue: right,
 *   read as another field (`venue→street`), missing with its text merged into another field, or with its text wrong.
 *   The number shape reports what became of the expected house number: read as the postcode, joined to the street, moved
 *   to another number, or lost. Field values here are the battery's joined fields, so two street spans count as one
 *   street. The address-list reader of 2026-10-28 kept spans apart and counted the same row as `venue→street`.
 */

import { formatPercent } from "@mailwoman/core/stats"

import { parseBatteryFieldKey } from "#tools/eval-harness/battery/classify"

/**
 * One scored row of a battery report, as `battery.run.ts` writes it.
 */
export interface BatteryReportRow {
	raw: string
	country: string
	labelConvention: string | null
	expected: string
	got: Record<string, string>
	right: Record<string, boolean>
	cause: Record<string, string | null>
}

/**
 * A battery report's rows by suite, with the arm roles needed to group them.
 */
export interface BatteryReportView {
	arms: ReadonlyArray<{ name: string }>
	baseline: string
	seeds: readonly string[]
	suites: Readonly<Record<string, { rows: readonly BatteryReportRow[] }>>
}

/**
 * How an arm handled the expected venue of a row.
 */
export type VenueShape =
	| "no-expected-venue"
	| "venue-right"
	| `venue→${string}`
	| "venue-missing-text-merged"
	| "venue-text-wrong"

/**
 * Classifies how an arm's fields hold the expected venue.
 */
export function venueShape(expected: ReadonlyMap<string, string>, got: ReadonlyMap<string, string>): VenueShape {
	const venue = expected.get("venue")

	if (venue == null) return "no-expected-venue"

	if (got.get("venue") === venue) return "venue-right"

	for (const [tag, value] of got) {
		if (tag !== "venue" && value === venue) return `venue→${tag}`
	}

	return got.has("venue") ? "venue-text-wrong" : "venue-missing-text-merged"
}

/**
 * What became of the expected house number, or of the postcode when the house number is right.
 */
export type NumberShape =
	| "house_number→postcode"
	| "house_number→street"
	| "house_number-boundary-moved"
	| "house_number-lost"
	| "postcode-wrong"
	| "numbers-right"

/**
 * Classifies an arm's reading of the expected house number and postcode.
 */
export function numberShape(expected: ReadonlyMap<string, string>, got: ReadonlyMap<string, string>): NumberShape {
	const houseNumber = expected.get("house_number")
	const postcode = expected.get("postcode")

	if (houseNumber != null && got.get("house_number") !== houseNumber) {
		if (got.get("postcode") === houseNumber) return "house_number→postcode"

		if ((got.get("street") ?? "").split(" ").includes(houseNumber)) return "house_number→street"

		return got.has("house_number") ? "house_number-boundary-moved" : "house_number-lost"
	}

	if (postcode != null && got.get("postcode") !== postcode) return "postcode-wrong"

	return "numbers-right"
}

/**
 * A row with its suite, kept as an example of a group.
 */
export interface FailureExample extends BatteryReportRow {
	suite: string
}

/**
 * A counted group with up to {@linkcode FailureGroupOptions.examples} of its rows.
 */
export interface CountedGroup {
	key: string
	rows: number
	examples: FailureExample[]
}

/**
 * Tallies of one reader's shapes for one arm.
 */
export interface ShapeTally {
	arm: string
	rows: number
	shapes: Array<[shape: string, rows: number]>
}

/**
 * The failure groups of one battery report.
 */
export interface FailureGroups {
	baseline: string
	seeds: string[]
	decisionRows: number
	allWrong: number
	seedsFix: number
	seedsBreak: number
	allWrongBySuite: Array<{ suite: string; decision: number; allWrong: number }>
	allWrongByCell: CountedGroup[]
	allWrongByCause: CountedGroup[]
	seedsFixByCause: CountedGroup[]
	seedsBreakByCause: CountedGroup[]
	/**
	 * Venue shape per arm on the all-wrong rows of the venue suites.
	 */
	venueAllWrong: ShapeTally[]
	/**
	 * Venue shape per seed on the seeds-break rows of the venue suites.
	 */
	venueSeedsBreak: ShapeTally[]
	/**
	 * Number shape per arm over every row that arm gets wrong.
	 */
	numberWrong: ShapeTally[]
}

export interface FailureGroupOptions {
	/**
	 * Full addresses kept per group.
	 */
	examples?: number
}

const isVenueSuite = (suite: string) => suite.endsWith("venue-with-address")

/**
 * Counts keys and keeps the first rows of each.
 */
class GroupCounter {
	readonly #groups = new Map<string, CountedGroup>()
	readonly #examples: number

	constructor(examples: number) {
		this.#examples = examples
	}

	add(key: string, example: FailureExample): void {
		const group = this.#groups.get(key) ?? { key, rows: 0, examples: [] }

		group.rows++

		if (group.examples.length < this.#examples) {
			group.examples.push(example)
		}

		this.#groups.set(key, group)
	}

	sorted(): CountedGroup[] {
		return [...this.#groups.values()].toSorted((a, b) => b.rows - a.rows || a.key.localeCompare(b.key))
	}
}

/**
 * Counts one reader's shapes per arm.
 */
class ShapeCounter {
	readonly #arms = new Map<string, { rows: number; shapes: Map<string, number> }>()

	add(arm: string, shape: string): void {
		const tally = this.#arms.get(arm) ?? { rows: 0, shapes: new Map() }

		tally.rows++
		tally.shapes.set(shape, (tally.shapes.get(shape) ?? 0) + 1)
		this.#arms.set(arm, tally)
	}

	tallies(arms: readonly string[]): ShapeTally[] {
		return arms.map((arm) => {
			const tally = this.#arms.get(arm)

			return {
				arm,
				rows: tally?.rows ?? 0,
				shapes: [...(tally?.shapes ?? new Map<string, number>())].toSorted((a, b) => b[1] - a[1]),
			}
		})
	}
}

/**
 * Groups a battery report's decision rows.
 *
 * @throws When the report names fewer than two seeds and fewer than one candidate,
 * or a row lacks an arm's outcome.
 */
export function groupBatteryFailures(report: BatteryReportView, options: FailureGroupOptions = {}): FailureGroups {
	const examples = options.examples ?? 3
	const arms = report.arms.map((arm) => arm.name)
	const baseline = report.baseline
	const seeds = report.seeds.length ? [...report.seeds] : arms.filter((arm) => arm !== baseline)

	if (!seeds.length) throw new Error("a battery report needs a candidate arm to group failures by")

	const cells = new GroupCounter(examples)
	const causes = new GroupCounter(examples)
	const fixes = new GroupCounter(examples)
	const breaks = new GroupCounter(examples)
	const venueAllWrong = new ShapeCounter()
	const venueSeedsBreak = new ShapeCounter()
	const numberWrong = new ShapeCounter()
	const bySuite: FailureGroups["allWrongBySuite"] = []
	const totals = { decisionRows: 0, allWrong: 0, seedsFix: 0, seedsBreak: 0 }

	for (const [suite, { rows }] of Object.entries(report.suites)) {
		const suiteTotals = { suite, decision: 0, allWrong: 0 }

		for (const row of rows) {
			if (row.labelConvention) continue

			for (const arm of arms) {
				if (typeof row.right[arm] !== "boolean") throw new Error(`${suite}: row ${row.raw} has no outcome for ${arm}`)
			}

			suiteTotals.decision++

			totals.decisionRows++

			const example: FailureExample = { suite, ...row }
			const expected = parseBatteryFieldKey(row.expected)

			for (const arm of arms) {
				if (!row.right[arm]) {
					numberWrong.add(arm, numberShape(expected, parseBatteryFieldKey(row.got[arm] ?? "")))
				}
			}

			if (arms.every((arm) => !row.right[arm])) {
				suiteTotals.allWrong++

				totals.allWrong++
				cells.add(`${suite} / ${row.country}`, example)

				const armCauses = new Set(arms.map((arm) => row.cause[arm]))
				const cause = armCauses.size === 1 ? String([...armCauses][0]) : "mixed"

				causes.add(`${suite} / ${cause}`, example)

				if (isVenueSuite(suite)) {
					for (const arm of arms) {
						venueAllWrong.add(arm, venueShape(expected, parseBatteryFieldKey(row.got[arm] ?? "")))
					}
				}
			}

			const baselineRight = row.right[baseline]!

			if (!baselineRight && seeds.every((seed) => row.right[seed])) {
				totals.seedsFix++
				fixes.add(`${suite} / ${row.cause[baseline]}`, example)
			}

			if (baselineRight && seeds.every((seed) => !row.right[seed])) {
				totals.seedsBreak++
				breaks.add(`${suite} / ${row.cause[seeds[0]!]}`, example)

				if (isVenueSuite(suite)) {
					for (const seed of seeds) {
						venueSeedsBreak.add(seed, venueShape(expected, parseBatteryFieldKey(row.got[seed] ?? "")))
					}
				}
			}
		}

		bySuite.push(suiteTotals)
	}

	return {
		baseline,
		seeds,
		...totals,
		allWrongBySuite: bySuite,
		allWrongByCell: cells.sorted(),
		allWrongByCause: causes.sorted(),
		seedsFixByCause: fixes.sorted(),
		seedsBreakByCause: breaks.sorted(),
		venueAllWrong: venueAllWrong.tallies(arms),
		venueSeedsBreak: venueSeedsBreak.tallies(seeds),
		numberWrong: numberWrong.tallies(arms),
	}
}

const share = (n: number, d: number) => formatPercent(n, d)

function formatExamples(group: CountedGroup, arms: readonly string[]): string[] {
	const lines = [`#### ${group.key} (${group.rows.toLocaleString("en")} rows)`, ""]

	for (const row of group.examples) {
		lines.push(`- \`${row.raw}\` (${row.country})`, `  - expected: ${row.expected}`)

		for (const arm of arms) {
			lines.push(`  - ${arm}: ${row.right[arm] ? "right" : `${row.got[arm]} (${row.cause[arm]})`}`)
		}
	}

	lines.push("")

	return lines
}

function formatTally(title: string, tallies: readonly ShapeTally[]): string[] {
	const shapes = [...new Set(tallies.flatMap((tally) => tally.shapes.map(([shape]) => shape)))]

	const lines = [
		`### ${title}`,
		"",
		`| Shape | ${tallies.map((t) => `${t.arm} (of ${t.rows.toLocaleString("en")})`).join(" | ")} |`,
		`| --- | ${tallies.map(() => "---:").join(" | ")} |`,
	]

	for (const shape of shapes) {
		const counts = tallies.map((tally) => tally.shapes.find(([s]) => s === shape)?.[1] ?? 0)

		lines.push(`| ${shape} | ${counts.map((n) => n.toLocaleString("en")).join(" | ")} |`)
	}

	lines.push("")

	return lines
}

function formatCounted(
	title: string,
	groups: readonly CountedGroup[],
	arms: readonly string[],
	limits: { table: number; examples: number }
): string[] {
	const lines = [`### ${title}`, "", "| Group | Rows |", "| --- | ---: |"]

	for (const group of groups.slice(0, limits.table)) {
		lines.push(`| ${group.key} | ${group.rows.toLocaleString("en")} |`)
	}

	if (groups.length > limits.table) {
		lines.push(`| ${groups.length - limits.table} more groups | |`)
	}

	lines.push("")

	for (const group of groups.slice(0, limits.examples)) {
		lines.push(...formatExamples(group, arms))
	}

	return lines
}

/**
 * Renders the failure groups as a markdown section, with full addresses under each of the largest groups.
 */
export function formatFailureGroups(groups: FailureGroups, arms: readonly string[]): string {
	const lines = [
		"## Failure groups, decision rows only",
		"",
		`Baseline \`${groups.baseline}\`; seeds ${groups.seeds.map((s) => `\`${s}\``).join(", ")}. ` +
			`${groups.decisionRows.toLocaleString("en")} decision rows: all arms wrong on ${groups.allWrong.toLocaleString("en")} ` +
			`(${share(groups.allWrong, groups.decisionRows)}), every seed fixes ${groups.seedsFix.toLocaleString("en")}, ` +
			`every seed breaks ${groups.seedsBreak.toLocaleString("en")}.`,
		"",
		"### All arms wrong, per suite",
		"",
		"| Suite | All wrong | Of | Share |",
		"| --- | ---: | ---: | ---: |",
		...groups.allWrongBySuite.map(
			(s) =>
				`| ${s.suite} | ${s.allWrong.toLocaleString("en")} | ${s.decision.toLocaleString("en")} | ${share(s.allWrong, s.decision)} |`
		),
		"",
		...formatCounted("All arms wrong, per suite and country cell", groups.allWrongByCell, arms, {
			table: 40,
			examples: 12,
		}),
		...formatCounted("All arms wrong, per suite and shared cause", groups.allWrongByCause, arms, {
			table: 40,
			examples: 14,
		}),
		...formatCounted("Every seed fixes, per suite and the baseline's cause", groups.seedsFixByCause, arms, {
			table: 30,
			examples: 8,
		}),
		...formatCounted("Every seed breaks, per suite and the first seed's cause", groups.seedsBreakByCause, arms, {
			table: 30,
			examples: 10,
		}),
		...formatTally("Venue shape, all arms wrong, venue suites", groups.venueAllWrong),
		...formatTally("Venue shape, every seed breaks, venue suites", groups.venueSeedsBreak),
		...formatTally("Number shape, every wrong row of each arm", groups.numberWrong),
	]

	return `${lines.join("\n")}\n`
}
