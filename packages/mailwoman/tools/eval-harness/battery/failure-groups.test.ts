import { describe, expect, it } from "vitest"

import { parseBatteryFieldKey } from "#tools/eval-harness/battery/classify"
import {
	type BatteryReportRow,
	type BatteryReportView,
	formatFailureGroups,
	groupBatteryFailures,
	numberShape,
	venueShape,
} from "#tools/eval-harness/battery/failure-groups"

const fields = parseBatteryFieldKey

describe("venueShape", () => {
	it("names the field that holds the expected venue", () => {
		const expected = fields("venue=jysk | street=rruga bylis | house_number=16")

		expect(venueShape(expected, fields("venue=jysk | street=rruga bylis"))).toBe("venue-right")
		expect(venueShape(expected, fields("locality=jysk | street=rruga bylis"))).toBe("venue→locality")
		expect(venueShape(expected, fields("street=jysk rruga bylis"))).toBe("venue-missing-text-merged")
		expect(venueShape(expected, fields("venue=jy | street=rruga bylis"))).toBe("venue-text-wrong")
		expect(venueShape(fields("street=main"), fields("street=main"))).toBe("no-expected-venue")
	})
})

describe("numberShape", () => {
	it("names what became of the expected house number", () => {
		const expected = fields("venue=zamin bank | house_number=1130 | street=babək prospekti")

		expect(numberShape(expected, fields("postcode=1130 | street=babək prospekti"))).toBe("house_number→postcode")
		expect(numberShape(expected, fields("street=1130 babək prospekti"))).toBe("house_number→street")

		expect(numberShape(expected, fields("house_number=113 | street=babək prospekti"))).toBe(
			"house_number-boundary-moved"
		)

		expect(numberShape(expected, fields("street=babək prospekti"))).toBe("house_number-lost")
		expect(numberShape(fields("postcode=0101"), fields("postcode=01"))).toBe("postcode-wrong")
		expect(numberShape(expected, expected)).toBe("numbers-right")
	})
})

function row(raw: string, country: string, right: Record<string, boolean>, overrides: Partial<BatteryReportRow> = {}) {
	return {
		raw,
		country,
		labelConvention: null,
		expected: "venue=jysk | house_number=16 | street=rruga bylis",
		got: { base: "street=jysk rruga bylis | house_number=16", s1: "locality=jysk", s2: "postcode=16" },
		right,
		cause: { base: "venue", s1: "venue", s2: "venue" },
		...overrides,
	} satisfies BatteryReportRow
}

const report: BatteryReportView = {
	arms: [{ name: "base" }, { name: "s1" }, { name: "s2" }],
	baseline: "base",
	seeds: ["s1", "s2"],
	suites: {
		"osm-venue-with-address": {
			rows: [
				row("JYSK, Rruga Bylis 16, Tirana", "AL", { base: false, s1: false, s2: false }),
				row("JYSK, Rruga Bylis 17, Tirana", "AL", { base: false, s1: false, s2: false }),
				row("Asia Lounge, Rua da Missão 29", "AO", { base: true, s1: false, s2: false }),
				row("Osaka, 760 Avenida", "PR", { base: false, s1: true, s2: true }),
				row("Hotel, 1 Main", "AR", { base: false, s1: true, s2: false }),
				row("Units, 9", "PH", { base: false, s1: false, s2: false }, { labelConvention: "bare-unit" }),
			],
		},
	},
}

describe("groupBatteryFailures", () => {
	const groups = groupBatteryFailures(report, { examples: 1 })

	it("counts all-wrong rows, fixes and breaks on decision rows only", () => {
		expect(groups.decisionRows).toBe(5)
		expect(groups.allWrong).toBe(2)
		expect(groups.seedsFix).toBe(1)
		expect(groups.seedsBreak).toBe(1)

		expect(groups.allWrongByCell).toEqual([
			{ key: "osm-venue-with-address / AL", rows: 2, examples: [expect.objectContaining({ country: "AL" })] },
		])

		expect(groups.allWrongByCause[0]!.key).toBe("osm-venue-with-address / venue")
	})

	it("tallies venue and number shapes per arm", () => {
		expect(groups.venueAllWrong.find((t) => t.arm === "s1")!.shapes).toEqual([["venue→locality", 2]])
		expect(groups.venueSeedsBreak.map((t) => t.arm)).toEqual(["s1", "s2"])
		// s2 is wrong on the two all-wrong rows, the break and the row only s1 fixes.
		expect(groups.numberWrong.find((t) => t.arm === "s2")!.shapes).toEqual([["house_number→postcode", 4]])
	})

	it("refuses a row with no outcome for an arm", () => {
		const broken: BatteryReportView = {
			...report,
			suites: { s: { rows: [row("x", "AL", { base: false, s1: false })] } },
		}

		expect(() => groupBatteryFailures(broken)).toThrow(/no outcome for s2/)
	})

	it("prints the full address of each group's examples", () => {
		const markdown = formatFailureGroups(groups, ["base", "s1", "s2"])

		expect(markdown).toContain("#### osm-venue-with-address / AL (2 rows)")
		expect(markdown).toContain("- `JYSK, Rruga Bylis 16, Tirana` (AL)")
		expect(markdown).toContain("| house_number→postcode |")
	})
})
