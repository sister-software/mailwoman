import { describe, expect, it } from "vitest"

import { rowsHaveTag, scorePerTagF1, type PerTagEvalRow } from "./per-tag-f1.ts"

const rows: PerTagEvalRow[] = [
	{ raw: "one", components: { street: "Main St", region: "CA" } },
	{ raw: "two", components: { street: "Oak Ave" } },
]

describe("scorePerTagF1", () => {
	it("scores exact matches, false positives, and false negatives by tag", async () => {
		const predictions: Record<string, Record<string, string>> = {
			one: { street: " main st ", region: "NV" },
			two: { street: "wrong", region: "OR" },
		}

		await expect(scorePerTagF1(rows, ["street", "region"], async (raw) => predictions[raw]!)).resolves.toEqual({
			street: 50,
			region: 0,
		})
	})

	it("distinguishes an absent tag from a present tag with no correct predictions", () => {
		expect(rowsHaveTag(rows, "region")).toBe(true)
		expect(rowsHaveTag(rows, "postcode")).toBe(false)
	})
})
