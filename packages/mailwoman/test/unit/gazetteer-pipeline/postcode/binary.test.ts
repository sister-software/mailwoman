/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1509 — the two defects `mailwoman gazetteer postcode-binary` shipped, pinned as tests.
 *
 *   1. The GB outward derivation split `name` on a SPACE, so the licence-clean Code-Point Open database
 *      (`postalcode-gb-codepoint.db`, names stored space-stripped as `AB101AB`) yielded null on every
 *      one of its 1,746,976 rows.
 *   2. The command wrote the resulting ZERO-key binary and exited 0 — a valid, empty, silently-fed
 *      channel, which is the #1467 defect class again.
 */

import {
	buildPostcodeBinaryEntries,
	gbOutwardFromKey,
	keyFloorFor,
	keyFloorViolation,
	POSTCODE_BINARY_KEY_FLOORS,
	postcodeBinaryKey,
} from "mailwoman/gazetteer-pipeline/postcode/binary"
import { describe, expect, it } from "vitest"

describe("gbOutwardFromKey — shape, not space-split (#1509)", () => {
	it("derives the outward from the SPACE-STRIPPED form both databases can produce", () => {
		// Code-Point Open's storage form (the database the defect was found against) …
		expect(gbOutwardFromKey("AB101AB")).toBe("AB10")
		expect(gbOutwardFromKey("SW1A2AA")).toBe("SW1A")
		// … and the retired GeoNames-lineage database's spaced display form, keyed identically.
		expect(gbOutwardFromKey("SW1A 2AA")).toBe("SW1A")
		expect(gbOutwardFromKey("so4 3rx")).toBe("SO4")
	})

	it("rejects anything that is not a GB unit shape", () => {
		expect(gbOutwardFromKey("75008")).toBeNull() // FR five-digit
		expect(gbOutwardFromKey("1012LG")).toBeNull() // NL PC6
		expect(gbOutwardFromKey("SW1A")).toBeNull() // already an outward
		expect(gbOutwardFromKey("")).toBeNull()
	})
})

describe("postcodeBinaryKey", () => {
	it("uppercases and strips spaces for GB — the train painter's key form", () => {
		expect(postcodeBinaryKey("GB", " sw1a 2aa ")).toBe("SW1A2AA")
	})

	it("leaves every other country's database name verbatim but uppercased", () => {
		expect(postcodeBinaryKey("NL", "1012lm")).toBe("1012LM")
		expect(postcodeBinaryKey("US", "94105")).toBe("94105")
	})
})

describe("buildPostcodeBinaryEntries", () => {
	const GB_ROWS = [
		{ name: "AB101AB", lat: 57.1, lon: -2.1 },
		{ name: "AB101AF", lat: 57.2, lon: -2.3 },
		{ name: "SW1A2AA", lat: 51.5, lon: -0.13 },
		{ name: "NOTAPOSTCODE", lat: 1, lon: 1 },
	]

	it("GB `unit` granularity emits every unit PLUS one outward district per prefix", () => {
		const { entries, skipped } = buildPostcodeBinaryEntries("GB", GB_ROWS, { gbGranularity: "unit" })

		expect(skipped).toBe(1) // NOTAPOSTCODE
		expect(entries.map((e) => e.postcode).toSorted()).toEqual(["AB10", "AB101AB", "AB101AF", "SW1A", "SW1A2AA"])

		// The outward centroid is the MEAN of its PLACED units, matching `anchor-lookup.ts::addGBOutwardKeys`.
		const ab10 = entries.find((e) => e.postcode === "AB10")!
		expect(ab10.lat).toBeCloseTo((57.1 + 57.2) / 2, 10)
		expect(ab10.lon).toBeCloseTo((-2.1 + -2.3) / 2, 10)
	})

	it("GB `outward` granularity emits districts only — the browser-budget artifact", () => {
		const { entries } = buildPostcodeBinaryEntries("GB", GB_ROWS, { gbGranularity: "outward" })

		expect(entries.map((e) => e.postcode).toSorted()).toEqual(["AB10", "SW1A"])
	})

	it("an UNPLACED unit still keys, but is excluded from its district's mean", () => {
		const { entries } = buildPostcodeBinaryEntries(
			"GB",
			[
				{ name: "AB101AB", lat: 57.1, lon: -2.1 },
				{ name: "AB101AF", lat: 0, lon: 0 },
			],
			{ gbGranularity: "unit" }
		)

		expect(entries.find((e) => e.postcode === "AB101AF")).toBeDefined()
		expect(entries.find((e) => e.postcode === "AB10")!.lat).toBeCloseTo(57.1, 10)
	})

	it("serializes a non-GB country verbatim", () => {
		const { entries, skipped } = buildPostcodeBinaryEntries("NL", [{ name: "1012LM", lat: 52.3, lon: 4.9 }], {})

		expect(skipped).toBe(0)
		expect(entries).toEqual([{ postcode: "1012LM", country: "NL", lat: 52.3, lon: 4.9 }])
	})
})

describe("keyFloorViolation — a below-floor bin is a build failure, not a product (#1509)", () => {
	it("names ZERO as a refusal for a country with no floor entry at all", () => {
		const reason = keyFloorViolation("ZZ", 0, "unit")

		expect(reason).toContain("0 keys")
		expect(reason).toMatch(/refus/i)
	})

	it("accepts zero for nothing — the meaning-of-zero rule", () => {
		for (const country of Object.keys(POSTCODE_BINARY_KEY_FLOORS)) {
			expect(keyFloorViolation(country.split(":")[0]!, 0, "unit")).not.toBeNull()
		}
	})

	it("refuses the #1509 reproduction: GB at zero keys names the floor and the count", () => {
		const reason = keyFloorViolation("GB", 0, "unit")

		expect(reason).toContain("GB")
		expect(reason).toContain(keyFloorFor("GB", "unit").toLocaleString())
	})

	it("passes a build at or above the floor", () => {
		expect(keyFloorViolation("GB", 1_749_839, "unit")).toBeNull()
		expect(keyFloorViolation("GB", 2863, "outward")).toBeNull()
		expect(keyFloorViolation("US", 42_318, "unit")).toBeNull()
	})

	it("refuses a GB unit build that came back at outward-only scale", () => {
		expect(keyFloorViolation("GB", 2863, "unit")).not.toBeNull()
	})

	it("floors an unknown country at 1 — a named artifact with no measurement still cannot be empty", () => {
		expect(keyFloorFor("ZZ", "unit")).toBe(1)
		expect(keyFloorViolation("ZZ", 1, "unit")).toBeNull()
	})
})
