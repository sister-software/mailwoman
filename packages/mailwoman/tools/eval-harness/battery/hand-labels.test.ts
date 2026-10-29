import { describe, expect, it } from "vitest"

import {
	type FieldMap,
	type HandLabeledRow,
	readHandLabels,
	scoreHandLabels,
} from "#tools/eval-harness/battery/hand-labels"

describe("readHandLabels", () => {
	it("reads the committed fixture, one row per id, each corrected row keeping different source labels", async () => {
		const rows = await readHandLabels()

		expect(rows.length).toBeGreaterThan(0)
		expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)

		for (const row of rows.filter((r) => r.decision === "corrected")) {
			expect(row.labels).not.toEqual(row.source)
		}
	})
})

describe("scoreHandLabels", () => {
	const row: HandLabeledRow = {
		id: "r",
		group: "spaced-po-box",
		country: "US",
		raw: "P O BOX 190, WINDTHORST, TX",
		labels: { po_box: "p o box 190", locality: "windthorst", region: "tx" },
		decision: "corrected",
		rule: "spaced-po-box",
		source: { street: "p o box 190", locality: "windthorst", region: "tx" },
	}

	const parses = new Map<string, Map<string, FieldMap>>([
		["a", new Map([["r", { po_box: "p o box 190", locality: "windthorst", region: "tx" }]])],
		["b", new Map([["r", { street: "p o box 190", locality: "windthorst", region: "tx" }]])],
	])

	it("counts each arm right by the hand labels and by the source labels", () => {
		expect(scoreHandLabels([row], parses)).toEqual([
			{ arm: "a", rows: 1, rightByHand: 1, rightBySource: 0 },
			{ arm: "b", rows: 1, rightByHand: 0, rightBySource: 1 },
		])
	})

	it("refuses a row with no parse for an arm", () => {
		expect(() => scoreHandLabels([row], new Map([["c", new Map()]]))).toThrow(/no parse for c/)
	})
})
