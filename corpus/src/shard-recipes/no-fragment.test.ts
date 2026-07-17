/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the `no-fragment` shard (Track B — the NO house-number-licence lever).
 *
 *   Two invariants, both load-bearing (the fr-fragment lesson, transplanted):
 *
 *   1. THE SPLIT with a DIACRITIC surface. The board keeps diacritics; a diacritic-stripping norm
 *      would leak `Tømmerlien` silently. Pinned in both directions.
 *   2. THE COUNTER-DISTRIBUTION. Teaching bare `{street} {number}` alone lets the model flip its
 *      default from "bare -> locality" to "bare -> street", and stop emitting postcode to win the
 *      digit. The bare-LOCALITY and bare-POSTCODE counter rows must both exist and carry no street.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { noFragmentRecipe } from "./no-fragment.ts"

const TUPLES = [
	{ street: "Tømmerlien", locality: "dokka", number: "3", postcode: "2870" },
	{ street: "Hallingrudveien", locality: "vikersund", number: "32", postcode: "3370" },
	{ street: "Blåklokkevegen", locality: "sandnes", number: "7", postcode: "4300" },
	{ street: "Motland", locality: "nærbø", number: "51", postcode: "4365" },
	{ street: "Øvrabø", locality: "hellvik", number: "124/1", postcode: "4375" },
]

function scratch(tuples: object[], surfaces: string[]): { input: string; exclude: string } {
	const dir = mkdtempSync(join(tmpdir(), "no-fragment-"))
	const input = join(dir, "tuples.jsonl")
	const exclude = join(dir, "surfaces.txt")

	writeFileSync(input, tuples.map((t) => JSON.stringify(t)).join("\n") + "\n")
	writeFileSync(exclude, "# reserved\n" + surfaces.join("\n") + "\n")

	return { input, exclude }
}

async function run(tuples: object[], surfaces: string[], opts: Record<string, unknown> = {}) {
	const { input, exclude } = scratch(tuples, surfaces)
	const lines: string[] = []
	const stats = await noFragmentRecipe.run(
		{ output: "", seed: 901, variants: 1, input, excludeSurfaces: exclude, ...opts },
		(line) => lines.push(line)
	)

	return { stats, rows: lines.map((line) => JSON.parse(line) as Record<string, never>) }
}

describe("no-fragment", () => {
	it("REFUSES to run without an exclusion list", async () => {
		const { input } = scratch(TUPLES, [])

		await expect(noFragmentRecipe.run({ output: "", seed: 901, variants: 1, input }, () => {})).rejects.toThrow(
			/--exclude-surfaces is REQUIRED/
		)
	})

	it("skips a reserved surface KEEPING diacritics", async () => {
		const { stats } = await run(TUPLES, ["tømmerlien"])

		expect(stats.contaminated).toBe(1)
	})

	it("does NOT skip a stripped-diacritic near-match", async () => {
		const { stats } = await run(TUPLES, ["tommerlien"])

		expect(stats.contaminated).toBe(0)
	})

	it("emits the SIGNAL — a street with NO postcode/locality partner", async () => {
		// counterProb 0 so every non-reserved row is a street fragment; bareStreetProb 0 so it carries
		// its number. The point of the shard: the street stands alone.
		const { rows } = await run(TUPLES, ["nonexistent-surface"], { counterProb: 0, bareProb: 0 })
		const signal = rows.filter((r) => (r as { components: { street?: string } }).components.street)

		expect(signal.length).toBeGreaterThan(0)

		for (const r of signal) {
			const c = (r as { components: Record<string, string> }).components

			// A signal row has a street and MAY have a house_number, but NEVER a postcode or locality —
			// that is the whole licence: read the street without its partners.
			expect(c.postcode).toBeUndefined()
			expect(c.locality).toBeUndefined()
			expect(c.street).toBeTruthy()
		}
	})

	it("emits BOTH counter-classes — bare locality and bare postcode", async () => {
		// counterProb 1 so every row is a counter draw.
		const { rows } = await run(TUPLES, ["nonexistent-surface"], { counterProb: 1 })
		const kinds = new Set(
			rows.map((r) => {
				const c = (r as { components: Record<string, string> }).components

				return c.locality ? "loc" : c.postcode ? "pc" : "?"
			})
		)

		expect(kinds.has("loc")).toBe(true)
		expect(kinds.has("pc")).toBe(true)

		// A counter row NEVER carries a street — else it is not a counter.
		for (const r of rows) {
			expect((r as { components: { street?: string } }).components.street).toBeUndefined()
		}
	})

	it("title-cases the ALL-CAPS Kartverket locality in a counter row", async () => {
		const { rows } = await run([{ street: "X", locality: "HELLVIK", number: "1", postcode: "4375" }], ["z"], {
			counterProb: 1,
		})
		const locRows = rows.filter((r) => (r as { components: { locality?: string } }).components.locality)

		for (const r of locRows) {
			expect((r as { components: { locality: string } }).components.locality).toBe("Hellvik")
		}
	})
})
