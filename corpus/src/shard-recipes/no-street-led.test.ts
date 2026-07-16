/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the `no-street-led` shard's board split (#901 family / Track B, 2026-07-16).
 *
 *   This recipe existed for a year before it could train on anything — the YAML Norway problem
 *   (`NO:` -> boolean false) dropped every Norwegian row (#1145). Now that it CAN train, it must not
 *   train on its own eval set. The one invariant that is not "nice to have":
 *
 *   THE DIACRITIC SPLIT. The NO digit board keeps diacritics in its surface key (`tømmerlien`).
 *   fr-fragment's normalizer strips them. If this recipe had reused fr-fragment's `norm`, the shard
 *   would fold `Tømmerlien` -> `tommerlien`, never match the board's reserved `tømmerlien`, and leak
 *   the surface into training while every check reported success. That failure is invisible
 *   downstream — the board just reads high. So it gets a test with a diacritic surface specifically.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { noStreetLedRecipe } from "./no-street-led.ts"

const TUPLES = [
	{ street: "Tømmerlien", locality: "dokka", number: "3", postcode: "2870" },
	{ street: "Hallingrudveien", locality: "vikersund", number: "32", postcode: "3370" },
	{ street: "Øvrabø", locality: "hellvik", number: "124/1", postcode: "4375" },
]

function scratch(tuples: object[], surfaces: string[]): { input: string; exclude: string } {
	const dir = mkdtempSync(join(tmpdir(), "no-street-led-"))
	const input = join(dir, "tuples.jsonl")
	const exclude = join(dir, "surfaces.txt")

	writeFileSync(input, tuples.map((t) => JSON.stringify(t)).join("\n") + "\n")
	writeFileSync(exclude, "# reserved\n" + surfaces.join("\n") + "\n")

	return { input, exclude }
}

async function run(tuples: object[], surfaces: string[]) {
	const { input, exclude } = scratch(tuples, surfaces)
	const lines: string[] = []
	const stats = await noStreetLedRecipe.run(
		{ output: "", seed: 901, variants: 1, input, excludeSurfaces: exclude },
		(line) => lines.push(line)
	)

	return { stats, rows: lines.map((line) => JSON.parse(line) as Record<string, never>) }
}

describe("no-street-led board split", () => {
	it("REFUSES to run without an exclusion list", async () => {
		const { input } = scratch(TUPLES, [])

		await expect(noStreetLedRecipe.run({ output: "", seed: 901, variants: 1, input }, () => {})).rejects.toThrow(
			/--exclude-surfaces is REQUIRED/
		)
	})

	it("REFUSES an exclusion list that resolves to zero surfaces", async () => {
		const { input, exclude } = scratch(TUPLES, [])
		writeFileSync(exclude, "# only a comment\n")

		await expect(
			noStreetLedRecipe.run({ output: "", seed: 901, variants: 1, input, excludeSurfaces: exclude }, () => {})
		).rejects.toThrow(/listed no surfaces/)
	})

	it("emits every surface when none are reserved", async () => {
		const { stats } = await run(TUPLES, ["some-other-street"])

		expect(stats.contaminated).toBe(0)
		expect(stats.emitted).toBeGreaterThan(0)
	})

	it("skips a reserved surface — KEEPING diacritics (the whole hazard)", async () => {
		// The board writes lowercased-NFC surfaces. `tømmerlien` with the ø INTACT.
		const { stats, rows } = await run(TUPLES, ["tømmerlien"])

		expect(stats.contaminated).toBe(1)
		for (const row of rows) {
			expect((row as { raw: string }).raw.toLowerCase()).not.toContain("tømmerlien")
		}
	})

	it("does NOT skip when the reserved surface differs only by a stripped diacritic", async () => {
		// If this recipe ever regresses to fr-fragment's diacritic-stripping norm, `tommerlien`
		// (no ø) would match `Tømmerlien` and this row would be wrongly excluded. It must NOT be.
		const { stats } = await run(TUPLES, ["tommerlien"])

		expect(stats.contaminated).toBe(0)
	})
})
