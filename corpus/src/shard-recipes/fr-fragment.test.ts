/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the `fr-fragment` shard recipe (#727 T2).
 *
 *   Two invariants here are not "nice to have":
 *
 *   1. **The split.** A shard that trains on its own eval set measures memorization, and NOTHING
 *      downstream can detect it — the board just reads high and everyone celebrates. The recipe must
 *      refuse to run without the exclusion list and must skip every reserved surface.
 *   2. **The counter-distribution.** Teaching bare streets alone lets the model satisfy every row by
 *      flipping its default from "bare ⇒ locality" to "bare ⇒ street" — trading a broken prior for a
 *      broken prior. The bare-locality rows must exist and must carry no street-side label.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { frFragmentRecipe, frTitleCase } from "./fr-fragment.ts"

const TUPLES = [
	{ street: "Rue Montmartre", locality: "paris", postcode: "75002" },
	{ street: "Rue de la Paix", locality: "paris", postcode: "75002" },
	{ street: "Allee du 11 Novembre 1918", locality: "lyon", postcode: "69001" },
	{ street: "Avenue des Champs", locality: "saint-jean-de-luz", postcode: "64500" },
	{ street: "Boulevard Voltaire", locality: "mery-sur-oise", postcode: "95540" },
]

function scratch(tuples: object[], surfaces: string[]): { input: string; exclude: string } {
	const dir = mkdtempSync(join(tmpdir(), "fr-fragment-"))
	const input = join(dir, "tuples.jsonl")
	const exclude = join(dir, "surfaces.txt")
	writeFileSync(input, tuples.map((t) => JSON.stringify(t)).join("\n") + "\n")
	writeFileSync(exclude, "# reserved\n" + surfaces.join("\n") + "\n")

	return { input, exclude }
}

async function run(tuples: object[], surfaces: string[], opts: Record<string, unknown> = {}) {
	const { input, exclude } = scratch(tuples, surfaces)
	const lines: string[] = []
	const stats = await frFragmentRecipe.run(
		{ output: "", seed: 727, variants: 1, input, excludeSurfaces: exclude, ...opts },
		(line) => lines.push(line)
	)

	return { stats, rows: lines.map((line) => JSON.parse(line) as Record<string, never>) }
}

describe("frTitleCase", () => {
	it("capitalizes elements and leaves French particles lowercase", () => {
		expect(frTitleCase("saint-jean-de-luz")).toBe("Saint-Jean-de-Luz")
		expect(frTitleCase("mery-sur-oise")).toBe("Mery-sur-Oise")
		expect(frTitleCase("paris")).toBe("Paris")
	})

	it("capitalizes a leading particle — it is not a joiner there", () => {
		expect(frTitleCase("le mans")).toBe("Le Mans")
		expect(frTitleCase("la rochelle")).toBe("La Rochelle")
	})
})

describe("fr-fragment: the split", () => {
	it("REFUSES to run without an exclusion list rather than mint a contaminated shard", async () => {
		const { input } = scratch(TUPLES, [])

		await expect(frFragmentRecipe.run({ output: "", seed: 1, variants: 1, input }, () => {})).rejects.toThrow(
			/--exclude-surfaces is REQUIRED/
		)
	})

	it("refuses an exclusion list that is present but empty", async () => {
		const { input, exclude } = scratch(TUPLES, [])
		writeFileSync(exclude, "# only a comment\n")

		await expect(
			frFragmentRecipe.run({ output: "", seed: 1, variants: 1, input, excludeSurfaces: exclude }, () => {})
		).rejects.toThrow(/listed no surfaces/)
	})

	it("skips every reserved surface, accent- and case-insensitively", async () => {
		// The list is normalized; the tuple is not. They must still match.
		const { rows } = await run(TUPLES, ["rue montmartre", "allee du 11 novembre 1918"])
		const streets = rows.map((r) => String(r.raw))

		expect(streets.some((s) => s.includes("Montmartre"))).toBe(false)
		expect(streets.some((s) => s.includes("11 Novembre"))).toBe(false)
		// …while the unreserved ones survive.
		expect(streets.some((s) => s.includes("de la Paix"))).toBe(true)
	})
})

describe("fr-fragment: the forms", () => {
	it("mints streets with NO house number — the class the existing recipe cannot reach", async () => {
		const { rows } = await run(TUPLES, ["nothing"], { hnProb: 0 })
		const streetRows = rows.filter((r) => String(r.synth_method).startsWith("fr-fragment:") && r.components.street)

		expect(streetRows.length).toBeGreaterThan(0)

		for (const row of streetRows) {
			expect(row.components.house_number, `${row.raw} carries a house number at hnProb=0`).toBeUndefined()
			// The whole point: the street stands alone, no locality to lean on either.
			expect(row.components.locality).toBeUndefined()
		}
	})

	it("labels the designator as street_prefix, not as part of a locality", async () => {
		const { rows } = await run(TUPLES, ["nothing"], { hnProb: 0 })
		const montmartre = rows.find((r) => String(r.raw) === "Rue de la Paix")!

		expect(montmartre.labels[0]).toBe("B-street_prefix")
		expect(String(montmartre.labels.join(" "))).not.toContain("locality")
	})

	it("still mints numbered rows so the licence is not UNLEARNED", async () => {
		const { rows } = await run(TUPLES, ["nothing"], { hnProb: 1 })
		const numbered = rows.filter((r) => r.components.house_number)

		expect(numbered.length).toBeGreaterThan(0)

		for (const row of numbered) {
			expect(row.labels[0]).toBe("B-house_number")
		}
	})
})

describe("fr-fragment: the counter-distribution", () => {
	it("mints bare localities carrying NO street-side label", async () => {
		const { rows } = await run(TUPLES, ["nothing"])
		const negative = rows.filter((r) => String(r.synth_method) === "fr-fragment:bare-locality")

		expect(negative.length).toBeGreaterThan(0)

		for (const row of negative) {
			expect(String(row.labels.join(" ")), `${row.raw} leaked a street label`).not.toContain("street")
			expect(row.components.locality).toBeDefined()
		}
	})

	it("title-cases the locality — BAN stores it normalized, the model must not learn that shape", async () => {
		const { rows } = await run(TUPLES, ["nothing"])
		const negative = rows.filter((r) => String(r.synth_method) === "fr-fragment:bare-locality")

		for (const row of negative) {
			expect(String(row.raw)).not.toBe(String(row.raw).toLowerCase())
		}

		expect(negative.some((r) => String(r.raw) === "Saint-Jean-de-Luz" || String(r.raw) === "Mery-sur-Oise")).toBe(true)
	})

	it("scales the counter with bareProb", async () => {
		const none = await run(TUPLES, ["nothing"], { bareProb: 0 })
		const lots = await run(TUPLES, ["nothing"], { bareProb: 0.5 })
		const count = (r: { rows: Array<Record<string, never>> }) =>
			r.rows.filter((x) => String(x.synth_method) === "fr-fragment:bare-locality").length

		expect(count(none)).toBe(0)
		expect(count(lots)).toBeGreaterThan(count(none))
	})
})

describe("fr-fragment: reproducibility", () => {
	it("is byte-identical for a fixed seed", async () => {
		const a = await run(TUPLES, ["nothing"])
		const b = await run(TUPLES, ["nothing"])

		expect(a.rows.map((r) => r.raw)).toEqual(b.rows.map((r) => r.raw))
	})
})
