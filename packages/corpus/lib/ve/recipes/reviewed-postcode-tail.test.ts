/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
	readReviewedPostcodeTuples,
	REVIEWED_POSTCODE_TAIL_SOURCE,
	type ReviewedPostcodeTuple,
	reviewedPostcodeTailRecipe,
	reviewedPostcodeTailVariants,
} from "#ve/recipes/reviewed-postcode-tail"

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

/**
 * Invented facts in the committed file's shape.
 *
 * Two strings contain accents.
 * The accent-folded variant renders each string twice.
 */
function fixtureTuple(id: string, locality: string, postcode: string, region: string): ReviewedPostcodeTuple {
	return {
		id,
		locality,
		postcode,
		region,
		country: "Venezuela",
		cc: "VE",
		locale: "es-VE",
		postcodePlacement: "after_locality",
		provenance: {
			publisher: "Fixture Publisher",
			url: "https://example.org/fixture",
			retrievedAt: "2026-10-17",
			reviewStatus: "reviewed",
			sourceLicenseNote: "Invented test fixture.",
		},
	}
}

const FIXTURE_TUPLES = [
	fixtureTuple("ve-fixture-1", "San Tomé", "6001", "Región Uno"),
	fixtureTuple("ve-fixture-2", "Puerto Ejemplo", "1010", "Distrito Dos"),
	fixtureTuple("ve-fixture-3", "Villa Prueba", "3028", "Estado Tres"),
	fixtureTuple("ve-fixture-4", "Santa Muestra de Guairén", "8011", "Bolívar Cuatro"),
]

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-reviewed-postcode-tail-")
})

afterEach(async () => {
	await scratch[Symbol.asyncDispose]()
})

async function writeFixture(tuples: ReviewedPostcodeTuple[], tupleCount = tuples.length): Promise<PathBuilderLike> {
	const path = scratch.path("tuples.json")

	await writeLocalJSONFile({ version: "1.0.0", reviewedAt: "2026-10-17", tupleCount, tuples }, path)

	return path
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
	it("holds no tuple in the committed file, because no citation reaches a row permitting training", async () => {
		await expect(readReviewedPostcodeTuples()).resolves.toEqual([])
	})

	it("refuses to run over the committed file rather than write an empty output", async () => {
		await expect(reviewedPostcodeTailRecipe.run({ output: "", seed: 42, variants: 1 }, () => {})).rejects.toThrow(
			"no tuple to render"
		)
	})

	it("reads the expected count from the file and refuses a file whose tuples disagree with it", async () => {
		await expect(readReviewedPostcodeTuples(await writeFixture(FIXTURE_TUPLES))).resolves.toHaveLength(4)
		await expect(readReviewedPostcodeTuples(await writeFixture(FIXTURE_TUPLES, 5))).rejects.toThrow("tupleCount")
	})

	it("generates five bounded variants per tuple and two additional accent folds", async () => {
		const variants = (await readReviewedPostcodeTuples(await writeFixture(FIXTURE_TUPLES))).map(
			reviewedPostcodeTailVariants
		)

		expect(variants.map((rows) => rows.length)).toEqual([6, 5, 5, 6])
		expect(variants.flat()).toHaveLength(22)
		expect(variants.flat().filter((variant) => variant.id === "accent-folded")).toHaveLength(2)
		expect(variants.flat().filter((variant) => variant.id === "left-context")).toHaveLength(4)
	})

	it("emits 22 aligned VE rows whose labels contain locality, postcode, then region", async () => {
		const lines: string[] = []
		const input = await writeFixture(FIXTURE_TUPLES)

		const stats = await reviewedPostcodeTailRecipe.run({ output: "", input, seed: 42, variants: 1 }, (line) =>
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

	it("pins the canonical, punctuation, case, accent, and named-context surfaces", () => {
		expect(reviewedPostcodeTailVariants(FIXTURE_TUPLES[0]!).map((row) => row.raw)).toEqual([
			"San Tomé 6001, Región Uno, Venezuela",
			"San Tomé 6001, Región Uno",
			"San Tomé 6001 Región Uno Venezuela",
			"SAN TOMÉ 6001, REGIÓN UNO, VENEZUELA",
			"Comercio Ejemplo, Calle Principal, San Tomé 6001, Región Uno, Venezuela",
			"San Tome 6001, Region Uno, Venezuela",
		])
	})
})
