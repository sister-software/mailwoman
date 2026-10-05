/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, test } from "vitest"

import { UnresolvedUnitTotalError } from "#eligibility"
import { renderScenarioReport, scenarioReport } from "#report"
import {
	CAPEX_RANGE,
	COMPARISON_CASES,
	DOSSIER_RECORDS,
	REPORT_OPTIONS,
	SHARED_ROUTE,
	syntheticDossier,
	UNIT_COUNTS,
} from "#test/fixtures/shared-route"

const markdown = renderScenarioReport(scenarioReport(syntheticDossier(), SHARED_ROUTE, REPORT_OPTIONS))
// oxlint-disable-next-line mailwoman/prefer-spliterator -- one rendered section of about 200 lines, read whole
const lines = markdown.split("\n")

/**
 * The trimmed cells of each table row whose first cell is `first`.
 */
function rowsStarting(first: string): string[][] {
	return lines
		.filter((line) => line.startsWith("| "))
		.map((line) =>
			line
				.slice(1, -1)
				.split(" | ")
				.map((cell) => cell.trim())
		)
		.filter((cells) => cells[0] === first)
}

describe("the report states what its figures are", () => {
	test("opens with the scenario statement and labels the inputs synthetic", () => {
		expect(lines.slice(0, 3)).toEqual([
			"## Shared-route scenario: Synthetic shared route to Example Route Parcel",
			"",
			"Every input in this section is synthetic. The figures are a scenario computed from the supplied assumptions below. " +
				"They are not a quote. The low and high cases are scenarios from named assumptions, and no probability is attached to them.",
		])
	})

	test("never labels a case with a percentile", () => {
		expect(markdown).not.toMatch(/\bP\d{1,2}\b/)
	})

	test("states the conventions: currency, tax, month zero, horizon, discounting and zero terminal value", () => {
		expect(lines).toContain("- Tax: pre-tax. The tax column holds zero by this convention.")
		expect(lines).toContain("- Month 0 is 2026-10. The table runs from month 0 through month 48 (2030-10).")
		expect(lines).toContain("- Terminal value: zero. The base case adds no sale proceeds after month 48 (2030-10).")
		expect(markdown).toContain("(1 + annual rate)^(1/12) - 1 = 0.797414%")
	})
})

describe("the shared-route example", () => {
	test("prints the handoff's four figures", () => {
		expect(lines).toContain("- Example Building A alone: USD 13,000.00.")
		expect(lines).toContain("- Example Building B alone: USD 14,000.00.")
		expect(lines).toContain("- Total project cost: USD 16,000.00.")
		expect(lines).toContain("- Adding Example Building B to Example Building A: USD 3,000.00.")
	})

	test("prints the shared segment once, used by both buildings", () => {
		expect(
			rowsStarting("shared-route-trench: Underground route from the existing splice point to Example Route Parcel")
		).toEqual([
			[
				"shared-route-trench: Underground route from the existing splice point to Example Route Parcel",
				"outside_plant",
				"400 m",
				"25.00 per m",
				"10,000.00",
				"1",
				"segment shared-route, used by Example Building A and Example Building B",
				"stated by synthetic example for #2288",
			],
		])
	})
})

describe("decision outputs with their assumptions", () => {
	test("capex range, affordable spend, first revenue, cash before it, and peak funding", () => {
		expect(lines).toContain(
			"- Capex range, as scenarios: low USD 14,400.00 (every construction line 10% under the rate card), " +
				"base USD 16,000.00 (rate card as stated), high USD 18,500.00 (outside plant 25% over the rate card)."
		)

		expect(lines).toContain(
			"- Affordable extra construction spend: USD 2,697.42 paid in month 1 (2026-11), at the factor 1.00797414, " +
				"keeps the NPV at or above USD 0.00."
		)

		expect(lines).toContain("- First revenue: month 4 (2027-02).")
		expect(lines).toContain("- Cash required before first revenue: USD 17,170.00.")
		expect(lines).toContain("- Peak funding: USD 20,285.00, reached in month 6 (2027-04), after first revenue.")
	})

	test("the break-even take rate names its month and its subscribers over occupied units", () => {
		expect(markdown).toMatch(
			/^- Break-even take rate: \d+\.\d{2}% of occupied units under the uptake assumption\. In month 24 \(2028-10\), \d+ of 40 occupied units subscribe \(\d+\.\d{2}%\), and the NPV is USD [\d,]+\.\d{2}\.$/m
		)
	})

	test("lists every downside case's NPV beside its assumption, and names the lowest", () => {
		expect(rowsStarting("Lower competitor-driven price")).toEqual([
			[
				"Lower competitor-driven price",
				"from month 12 (2027-10) the monthly price is USD 45.00 instead of USD 55.00",
				"16,000.00",
				"-3,056.83",
				"month 4",
				"17,170.00",
				"20,285.00 in month 6",
			],
		])

		for (const entry of COMPARISON_CASES) {
			expect(rowsStarting(entry.label)).toHaveLength(1)
		}

		expect(markdown).toMatch(/^Lowest NPV among the cases: USD -[\d,]+\.\d{2}, under "Slower uptake": /m)
	})
})

describe("the monthly table", () => {
	test("month 3: 3 × 55.00 receipts all credited, 3 × 10.00 + 40.00 service and maintenance, 3 × 300.00 activations, 200.00 working capital", () => {
		// −1,170.00 / 1.02411369 = −1,142.45
		expect(rowsStarting("3")).toEqual([
			[
				"3",
				"2027-01",
				"24",
				"3",
				"3",
				"0",
				"165.00",
				"165.00",
				"70.00",
				"900.00",
				"0.00",
				"200.00",
				"0.00",
				"-1,170.00",
				"-17,170.00",
				"1.02411369",
				"-1,142.45",
			],
		])
	})

	test("month 12: 20 × 55.00 − 20 × 10.00 − 40.00 = 860.00, discounted by exactly 1.1", () => {
		expect(rowsStarting("12")[0]!.slice(-4)).toEqual(["860.00", "-17,080.00", "1.10000000", "781.82"])
	})

	test("the totals row adds up: 48,125.00 − 1,980.00 − 10,590.00 − 10,800.00 − 16,600.00 − 200.00 − 0.00 = 7,955.00", () => {
		expect(rowsStarting("Total")).toEqual([
			[
				"Total",
				"",
				"",
				"",
				"36",
				"16",
				"48,125.00",
				"1,980.00",
				"10,590.00",
				"10,800.00",
				"16,600.00",
				"200.00",
				"0.00",
				"7,955.00",
				"",
				"",
				"2,676.08",
			],
		])

		expect(lines.filter((line) => /^\| \d+ +\| \d{4}-\d{2} +\|/.test(line))).toHaveLength(49)
	})

	test("pads every cell to its column, so each table's rows are one width", () => {
		const table = lines.filter((line) => line.startsWith("| Month ") || /^\| (\d+|Total) +\| /.test(line))

		expect(new Set(table.map((line) => line.length)).size).toBe(1)
	})
})

describe("optional views", () => {
	test("the financing view reconciles and the transaction cases state timing, obligations and proceeds", () => {
		expect(lines).toContain(
			"- In each of the 49 months, the net cash flow minus that month's financing flows equals the project cash flow."
		)

		expect(lines).toContain(
			"- Obligation: route-lease, Lease payment for the shared route: USD 150.00 per month in months 1 to 48 (stated by synthetic example for #2288)."
		)

		expect(lines.filter((line) => /\| yes +\|$/.test(line))).toHaveLength(4)
	})

	test("are absent unless requested", () => {
		const plain = renderScenarioReport(
			scenarioReport(syntheticDossier(), SHARED_ROUTE, { capexRange: CAPEX_RANGE, cases: [] })
		)

		expect(plain).not.toContain("### Financing view")
		expect(plain).not.toContain("### Transaction cases")
	})
})

describe("an unresolved unit total", () => {
	test("produces no report, so its units never print as zero or as subscribers", () => {
		const conflicting = {
			...DOSSIER_RECORDS,
			counts: [...UNIT_COUNTS, { ...UNIT_COUNTS[1]!, id: "b-completed-18", count: 18 }],
		}

		expect(() => scenarioReport(syntheticDossier(conflicting), SHARED_ROUTE, REPORT_OPTIONS)).toThrow(
			UnresolvedUnitTotalError
		)
	})
})

describe("the README", () => {
	test("shows the renderer's output for the synthetic fixture, unchanged", async () => {
		const readme = await readLocalTextFile(workspacePath("route-scenarios", "README.md"))
		const example = readme.split("```markdown\n")[1]?.split("\n```")[0]

		expect(example).toBe(markdown.trimEnd())
	})
})
