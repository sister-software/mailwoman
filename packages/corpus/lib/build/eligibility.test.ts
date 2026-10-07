/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests the admission path a release-eligible build runs every row through.
 *
 *   Two failures here are silent and opposite.
 *   A key that never matches refuses every row and yields an empty corpus.
 *   A key that always matches admits a publication no review has read.
 *   Both pass a type check, so the behavior is pinned here.
 */

import { beforeAll, describe, expect, it } from "vitest"

import { createIneligibilityReader, readSourceEligibility, sourceEligibilityKey } from "#build/eligibility"
import { readAddressSourceRegister } from "#source-register"
import type { AddressSourceRegister } from "#source-register/types"
import type { CanonicalRow } from "#types"

/**
 * A row carrying only the fields the reader consults.
 */
function rowFrom(source: string, country: string): CanonicalRow {
	return { raw: "", components: {}, country, source, source_id: "x", corpus_version: "", license: "" }
}

describe("sourceEligibilityKey", () => {
	it("joins the adapter to the jurisdiction, because one adapter serves several sources", () => {
		expect(sourceEligibilityKey("ban", "GP")).toBe("ban:GP")
		expect(sourceEligibilityKey("ban", "FR")).toBe("ban:FR")
	})

	it("reads a lowercase jurisdiction as the same key, since the register stores ISO 3166-1 uppercase", () => {
		expect(sourceEligibilityKey("ban", "gp")).toBe(sourceEligibilityKey("ban", "GP"))
	})
})

describe("readSourceEligibility over the committed register", () => {
	let register: AddressSourceRegister
	let eligibility: ReadonlyMap<string, readonly string[]>

	beforeAll(async () => {
		register = await readAddressSourceRegister()
		eligibility = await readSourceEligibility()
	})

	it("keys a source only when it declares the adapter that emits its rows", () => {
		const declaring = register.sources.filter((source) => source.adapterID !== undefined)

		expect(eligibility.size).toBe(declaring.length)

		for (const source of declaring) {
			expect(eligibility.has(sourceEligibilityKey(source.adapterID!, source.iso2))).toBe(true)
		}
	})

	it("leaves a source that declares no adapter out of the map rather than keying it by sourceID", () => {
		const undeclared = register.sources.find((source) => source.adapterID === undefined)

		expect(undeclared).toBeDefined()
		expect([...eligibility.keys()]).not.toContain(undeclared!.sourceID)
	})

	it("admits every jurisdiction the BAN reader serves, each through its own decision", () => {
		const banKeys = [...eligibility].filter(([key]) => key.startsWith("ban:"))

		// France plus the ten overseas jurisdictions whose published files hold rows.
		expect(banKeys).toHaveLength(11)

		for (const [key, problems] of banKeys) {
			expect(problems, `${key} should carry no ingest problem`).toEqual([])
		}
	})
})

describe("createIneligibilityReader", () => {
	it("admits a row whose adapter and country reach a source with no problems", () => {
		const reader = createIneligibilityReader(new Map([["ban:GP", []]]))

		expect(reader.read(rowFrom("ban", "GP"))).toBeNull()
	})

	it("refuses a row no source claims, and names the field that would fix it", () => {
		const reader = createIneligibilityReader(new Map([["ban:GP", []]]))
		const problems = reader.read(rowFrom("openaddresses", "FR"))

		expect(problems).not.toBeNull()
		expect(problems![0]).toContain('no register source declares "openaddresses" as its adapter in "FR"')
		expect(problems![0]).toContain("source-resolutions.json")
	})

	it("separates one adapter's jurisdictions, so an unreviewed country stays refused", () => {
		const reader = createIneligibilityReader(new Map([["ban:FR", []]]))

		expect(reader.read(rowFrom("ban", "FR"))).toBeNull()
		expect(reader.read(rowFrom("ban", "NC"))).not.toBeNull()
	})

	it("returns the source's own problems where the register recorded them", () => {
		const reader = createIneligibilityReader(new Map([["ban:FR", ["license x is unchecked"]]]))

		expect(reader.read(rowFrom("ban", "FR"))).toEqual(["license x is unchecked"])
	})

	it("records one refusal per key rather than one per row", () => {
		const reader = createIneligibilityReader(new Map())

		reader.read(rowFrom("osm", "DE"))
		reader.read(rowFrom("osm", "DE"))
		reader.read(rowFrom("osm", "FR"))

		expect([...reader.refused.keys()].toSorted()).toEqual(["osm:DE", "osm:FR"])
	})

	it("admits every row under the exploratory profile, where no eligibility is read", () => {
		const reader = createIneligibilityReader(null)

		expect(reader.read(rowFrom("whatever", "ZZ"))).toBeNull()
		expect(reader.refused.size).toBe(0)
	})
})
