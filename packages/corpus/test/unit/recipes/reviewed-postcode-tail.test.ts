/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { parseJSONStrict } from "@mailwoman/core/json"
import {
	readReviewedPostcodeTuples,
	REVIEWED_POSTCODE_TAIL_SOURCE,
	reviewedPostcodeTailRecipe,
	reviewedPostcodeTailVariants,
} from "@mailwoman/corpus/recipes/reviewed-postcode-tail"
import { describe, expect, it } from "vitest"

interface EmittedRow {
	raw: string
	components: Record<string, string>
	country: string
	locale: string
	source: string
	source_id: string
	license: string
	labels: string[]
}

function collapsedComponents(labels: readonly string[]): string[] {
	const out: string[] = []
	let active = ""

	for (const label of labels) {
		if (label === "O") {
			active = ""

			continue
		}

		const [prefix, component] = label.split("-", 2)

		if (prefix === "B" || component !== active) {
			out.push(component!)
		}

		active = component!
	}

	return out
}

describe("reviewed Venezuela postcode tuples", () => {
	it("loads four provenance-bearing, unique after-locality facts", async () => {
		const tuples = await readReviewedPostcodeTuples()

		expect(tuples).toHaveLength(4)
		expect(new Set(tuples.map((tuple) => tuple.id))).toHaveLength(4)
		expect(tuples.every((tuple) => tuple.cc === "VE" && tuple.postcodePlacement === "after_locality")).toBe(true)
		expect(tuples.every((tuple) => tuple.provenance.reviewStatus === "reviewed")).toBe(true)
		expect(tuples.every((tuple) => URL.canParse(tuple.provenance.url))).toBe(true)
	})

	it("generates five bounded variants per tuple and two additional accent folds", async () => {
		const variants = (await readReviewedPostcodeTuples()).map(reviewedPostcodeTailVariants)

		expect(variants.map((rows) => rows.length)).toEqual([6, 5, 5, 6])
		expect(variants.flat()).toHaveLength(22)
		expect(variants.flat().filter((variant) => variant.id === "accent-folded")).toHaveLength(2)
		expect(variants.flat().filter((variant) => variant.id === "left-context")).toHaveLength(4)
	})

	it("emits 22 aligned VE rows whose labels contain locality, postcode, then region", async () => {
		const lines: string[] = []

		const stats = await reviewedPostcodeTailRecipe.run({ output: "", seed: 42, variants: 1 }, (line) =>
			lines.push(line)
		)

		const rows = lines.map((line) => parseJSONStrict<EmittedRow>(line))

		expect(stats).toEqual({ read: 4, emitted: 22, skipped: 0 })
		expect(rows).toHaveLength(22)
		expect(new Set(rows.map((row) => row.source_id))).toHaveLength(22)
		expect(rows.every((row) => row.source === REVIEWED_POSTCODE_TAIL_SOURCE)).toBe(true)
		expect(rows.every((row) => row.country === "VE" && row.locale === "es-VE")).toBe(true)
		expect(rows.every((row) => row.license.includes("reviewed-ve-postcode-tuples.json"))).toBe(true)

		expect(rows.every((row) => collapsedComponents(row.labels).join(" ").includes("locality postcode region"))).toBe(
			true
		)
	})

	it("pins the canonical, punctuation, case, accent, and named-context surfaces", async () => {
		const [barcelona] = await readReviewedPostcodeTuples()
		const rows = reviewedPostcodeTailVariants(barcelona!)

		expect(rows.map((row) => row.raw)).toEqual([
			"Barcelona 6001, Anzoátegui, Venezuela",
			"Barcelona 6001, Anzoátegui",
			"Barcelona 6001 Anzoátegui Venezuela",
			"BARCELONA 6001, ANZOÁTEGUI, VENEZUELA",
			"Comercio Ejemplo, Calle Principal, Barcelona 6001, Anzoátegui, Venezuela",
			"Barcelona 6001, Anzoategui, Venezuela",
		])
	})
})
