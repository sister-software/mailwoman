import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { describe, expect, it } from "vitest"

import {
	assertPairedArms,
	countHeldoutCells,
	type HeldoutRow,
	heldoutRowID,
	scoreHeldoutArm,
} from "#tools/eval-harness/heldout/per/country"

const node = (raw: string, tag: AddressNode["tag"], start: number, end: number): AddressNode => ({
	tag,
	value: raw.slice(start, end),
	start,
	end,
	confidence: 1,
	children: [],
})

const rows: HeldoutRow[] = [
	{
		raw: "12 Main St",
		span_starts: [0, 3],
		span_ends: [2, 10],
		span_tags: ["house_number", "street"],
		country: "US",
		source: "oa-us",
		source_id: "a1",
	},
	{
		raw: "Wollin, Mecklenburg-Vorpommern",
		span_starts: [0, 8],
		span_ends: [6, 30],
		span_tags: ["locality", "region"],
		country: "DE",
		source: "wof-de",
		source_id: null,
	},
]

const exactTree = (row: HeldoutRow): AddressTree => ({
	raw: row.raw,
	roots: row.span_tags.map((tag, i) =>
		node(row.raw, tag as AddressNode["tag"], row.span_starts[i]!, row.span_ends[i]!)
	),
})

const extraTree = (row: HeldoutRow): AddressTree => {
	const tree = exactTree(row)

	return { ...tree, roots: [...tree.roots, node(row.raw, "postcode", 0, 2)] }
}

describe("scoreHeldoutArm", () => {
	it("writes aligned per-row outcomes for two arms on identical rows", async () => {
		const shipped = await scoreHeldoutArm(rows, async (row) => exactTree(row))
		const candidate = await scoreHeldoutArm(rows, async (row) => extraTree(row))

		expect(() => assertPairedArms([shipped, candidate])).not.toThrow()
		expect(shipped.rows.map((r) => r.rowID)).toEqual(["oa-us:a1", heldoutRowID(rows[1]!)])
		expect(heldoutRowID(rows[1]!)).toMatch(/^wof-de:raw-sha256:[0-9a-f]{64}$/u)

		expect(shipped.rows.map((r) => [r.country, r.kind, r.exact, r.provenance])).toEqual([
			["US", "address", true, "unknown"],
			["DE", "gazetteer", true, "unknown"],
		])

		// The additional span fails exact parsing but leaves every gold span recovered.
		expect(candidate.rows[0]).toMatchObject({
			exact: false,
			additionalSpans: 1,
			goldRecovered: true,
		})

		expect(candidate.cells.get("US/address")).toEqual({
			rows: 1,
			rowsExactParse: 0,
			rowsGoldRecovered: 1,
			spans: 2,
			spansRecovered: 2,
		})
	})

	it("assigns a provenance class only from a recorded history", async () => {
		const history = new Map([["oa-us:a1", { provenance: "verified_unseen" as const, evidence: "audit.json#sha" }]])
		const arm = await scoreHeldoutArm(rows, async (row) => exactTree(row), history)

		expect(arm.rows.map((r) => r.provenance)).toEqual(["verified_unseen", "unknown"])
	})

	it("refuses misaligned arms and duplicate identities", async () => {
		const full = await scoreHeldoutArm(rows, async (row) => exactTree(row))
		const reversed = await scoreHeldoutArm(rows.toReversed(), async (row) => exactTree(row))

		expect(() => assertPairedArms([full, reversed])).toThrow(/row 0/u)
		await expect(scoreHeldoutArm([rows[0]!, rows[0]!], async (row) => exactTree(row))).rejects.toThrow(/share/u)
	})

	it("refuses a malformed annotation rather than scoring it", async () => {
		const bad = { ...rows[0]!, span_ends: [2] }

		await expect(scoreHeldoutArm([bad], async () => exactTree(rows[0]!))).rejects.toThrow(/row oa-us:a1/u)
	})
})

describe("countHeldoutCells", () => {
	it("reports available and sampled rows per country and kind", () => {
		expect(
			countHeldoutCells(
				[
					{ country: "US", kind: "address", available: 900 },
					{ country: "DE", kind: "gazetteer", available: 40 },
					{ country: "DE", kind: "address", available: 3 },
				],
				rows
			)
		).toEqual([
			{ country: "DE", kind: "address", available: 3, sampled: 0 },
			{ country: "DE", kind: "gazetteer", available: 40, sampled: 1 },
			{ country: "US", kind: "address", available: 900, sampled: 1 },
		])
	})

	it("refuses a sampled row outside the availability count", () => {
		expect(() => countHeldoutCells([], rows)).toThrow(/lacks/u)
	})
})
