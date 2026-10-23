/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	type CandidateBandProbe,
	describePlacetypeCounts,
	expectedBandFor,
	readExpectationReachability,
} from "#dev-mcp/diagnose/reachability"

// The GB rows `candidate.db` holds for each key, as the 2026-10-23 probe read them.
const GB_ROWS: Record<string, Record<string, number>> = {
	uxbridge: { neighbourhood: 1 },
	ruislip: { neighbourhood: 1 },
	slough: { locality: 1, region: 1, county: 1 },
	hillingdon: { borough: 1, county: 1 },
	norfolk: { region: 1 },
}

const probe: CandidateBandProbe = (value, country) => (country === "GB" ? (GB_ROWS[value.toLowerCase()] ?? {}) : {})

describe("expectedBandFor", () => {
	it("maps the admin tags through the codex placetype map onto the resolver's filter groups", () => {
		expect(expectedBandFor("locality", "GB")).toEqual(["locality", "borough", "localadmin"])
		expect(expectedBandFor("dependent_locality", "GB")).toEqual(["locality", "borough", "localadmin"])
		expect(expectedBandFor("region", "GB")).toEqual(["region", "macroregion"])
		expect(expectedBandFor("subregion", "GB")).toEqual(["county", "macrocounty"])
		expect(expectedBandFor("country", "GB")).toEqual(["country"])
	})

	it("has no band for a tag the resolver does not look up in the candidate table", () => {
		expect(expectedBandFor("street", "GB")).toBeNull()
		expect(expectedBandFor("venue", "GB")).toBeNull()
		expect(expectedBandFor("postcode", "GB")).toBeNull()
	})
})

describe("readExpectationReachability", () => {
	it("calls a value unreachable when its band holds no row while another placetype does", () => {
		const [uxbridge] = readExpectationReachability({ venue: "Little Britain Lake", locality: "Uxbridge" }, "GB", probe)

		expect(uxbridge).toEqual({
			tag: "locality",
			value: "Uxbridge",
			band: ["locality", "borough", "localadmin"],
			state: "unreachable",
			in_band: 0,
			outside_band: { neighbourhood: 1 },
		})
	})

	it("calls a value reachable when any band member holds a row, and reports the rows outside the band", () => {
		const [slough, hillingdon] = readExpectationReachability(
			{ locality: "Slough", subregion: "Hillingdon" },
			"GB",
			probe
		)

		expect(slough?.state).toBe("reachable")
		expect(slough?.in_band).toBe(1)
		expect(slough?.outside_band).toEqual({ region: 1, county: 1 })
		// Hillingdon is a `county` row, inside the subregion band.
		expect(hillingdon?.state).toBe("reachable")
	})

	it("tells an absent value apart from an unreachable one", () => {
		const [reading] = readExpectationReachability({ locality: "Nowhere" }, "GB", probe)

		expect(reading?.state).toBe("absent")
		expect(reading?.outside_band).toEqual({})
	})

	it("reads a row without a country and a tag without a band as unprobed rather than reachable", () => {
		expect(readExpectationReachability({ locality: "Uxbridge" }, null, probe)[0]?.state).toBe("unprobed")
		expect(readExpectationReachability({ street: "Lake Road", venue: "The O2" }, "GB", probe)).toEqual([])
	})

	it("skips an empty expected value", () => {
		expect(readExpectationReachability({ locality: "" }, "GB", probe)).toEqual([])
	})
})

describe("describePlacetypeCounts", () => {
	it("lists placetypes by count, largest first", () => {
		expect(describePlacetypeCounts({ county: 1, localadmin: 2, locality: 5 })).toBe(
			"locality ×5, localadmin ×2, county ×1"
		)
	})
})
