/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The recipe editor, including the case it must REFUSE.
 *
 *   The property that matters is that prose survives. `defaults.ts` is reviewed like code and its entries
 *   carry measurements — `IN` is five lines recording 189,026 sub-locality nodes at 98.6% conversion and
 *   the instruction to remove IN from the Overture list in the same change. An editor that silently
 *   deleted an entry would take the reason with it, and the resulting diff would look clean.
 */

import { readFileSync } from "node:fs"

import { addCountry, removeCountry } from "mailwoman/gazetteer-pipeline/recipe-edit"
import { describe, expect, it } from "vitest"

const LIST = `/**
 * A docstring the editor must not touch.
 */
export const DEFAULT_OVERTURE_COUNTRIES = [
	"AE",
	"AT",
	"BE",
	// Added after the granularity probe: 189,026 sub-locality nodes, 98.6% conversion.
	// Moves OUT of the GeoNames list in the same change.
	"IN",
	"ZW",
] as const
`

describe("addCountry", () => {
	it("inserts in sorted position", () => {
		const result = addCountry(LIST, "DEFAULT_OVERTURE_COUNTRIES", "AU")

		expect(result.ok && result.changed).toBe(true)
		expect(result.ok && result.source).toContain('"AT",\n\t"AU",\n\t"BE",')
	})

	it("does not separate a comment block from the entry it belongs to", () => {
		// "IL" sorts before "IN", so a naive insertion lands between the prose and the entry it explains —
		// leaving a comment that now describes the wrong country.
		const result = addCountry(LIST, "DEFAULT_OVERTURE_COUNTRIES", "IL")

		expect(result.ok).toBe(true)
		expect(result.ok && result.source).toContain('"IL",\n\t// Added after the granularity probe')
		expect(result.ok && result.source).toContain('same change.\n\t"IN",')
	})

	it("is a no-op for a country already present, so re-running a plan is safe", () => {
		const result = addCountry(LIST, "DEFAULT_OVERTURE_COUNTRIES", "AE")

		expect(result.ok && result.changed).toBe(false)
		expect(result.ok && result.source).toBe(LIST)
	})

	it("leaves the list's docstring alone", () => {
		const result = addCountry(LIST, "DEFAULT_OVERTURE_COUNTRIES", "AU")

		expect(result.ok && result.source).toContain("A docstring the editor must not touch.")
	})

	it("refuses a list it cannot find rather than writing nothing quietly", () => {
		expect(addCountry(LIST, "NO_SUCH_LIST", "AU")).toEqual({
			ok: false,
			reason: "No list named NO_SUCH_LIST in defaults.ts",
		})
	})
})

describe("removeCountry", () => {
	it("removes a plain entry", () => {
		const result = removeCountry(LIST, "DEFAULT_OVERTURE_COUNTRIES", "BE")

		expect(result.ok && result.changed).toBe(true)
		expect(result.ok && result.source).not.toContain('"BE",')
		expect(result.ok && result.source).toContain('"AT",')
	})

	it("REFUSES to remove an entry whose prose would be orphaned, and quotes it", () => {
		const result = removeCountry(LIST, "DEFAULT_OVERTURE_COUNTRIES", "IN")

		expect(result.ok).toBe(false)

		if (result.ok) return

		expect(result.reason).toContain("would orphan")
		expect(result.comment).toHaveLength(2)
		expect(result.comment?.[0]).toContain("189,026")
	})

	it("is a no-op for a country that is not in the list", () => {
		const result = removeCountry(LIST, "DEFAULT_OVERTURE_COUNTRIES", "ZZ")

		expect(result.ok && result.changed).toBe(false)
	})
})

describe("against the real defaults.ts", () => {
	const source = readFileSync(new URL("../../../gazetteer-pipeline/defaults.ts", import.meta.url), "utf8")

	it("would refuse to remove IN from the WOF list — the entry that carries the measurement", () => {
		const result = removeCountry(source, "DEFAULT_WOF_PRIORITY_COUNTRIES", "IN")

		expect(result.ok).toBe(false)
		expect(result.ok || result.comment?.join(" ")).toContain("189,026")
	})

	it("adds TR to the WOF list in sorted position, between JP and KR's neighbours", () => {
		const result = addCountry(source, "DEFAULT_WOF_PRIORITY_COUNTRIES", "TR")

		expect(result.ok && result.changed).toBe(true)
		// TW follows TR alphabetically and is the entry it must land before.
		expect(result.ok && result.source).toContain('"TR",\n\t"TW",')
	})

	it("round-trips: adding then removing a country restores the file byte for byte", () => {
		const added = addCountry(source, "DEFAULT_OVERTURE_COUNTRIES", "ZZ")

		expect(added.ok).toBe(true)

		const removed = added.ok ? removeCountry(added.source, "DEFAULT_OVERTURE_COUNTRIES", "ZZ") : undefined

		expect(removed?.ok && removed.source).toBe(source)
	})
})
