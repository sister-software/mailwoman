/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #928: `countryFromPostcodeFormat` — a parsed postcode's FORMAT as a country signal, used by the
 *   `postcodeCountryPrior` lever to override the language-based placer (which conflates GB/US). The
 *   essential guarantee: the GB pattern is UNFORGEABLE across the formats we resolve — it never matches
 *   a US ZIP, an NL `\d{4} [A-Z]{2}`, an FR 5-digit, or a Canadian `A#A #A#` code — so turning the lever
 *   on can never mis-route a non-GB address.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { describe, expect, it } from "vitest"

import { countryFromPostcodeFormat, extractGeocodeResult } from "./geocode-core.js"

describe("countryFromPostcodeFormat (#928)", () => {
	it("matches GB postcodes (spaced and unspaced)", () => {
		expect(countryFromPostcodeFormat("E4 9AZ")).toBe("GB")
		expect(countryFromPostcodeFormat("SW1A 1AA")).toBe("GB")
		expect(countryFromPostcodeFormat("IG5 0NA")).toBe("GB")
		expect(countryFromPostcodeFormat("E49AZ")).toBe("GB") // unspaced
		expect(countryFromPostcodeFormat("  CH43 0TR  ")).toBe("GB") // trimmed
	})

	it("matches CA postcodes (A#A #A#), distinct from GB", () => {
		expect(countryFromPostcodeFormat("K2P 1L4")).toBe("CA")
		expect(countryFromPostcodeFormat("M5J 2J2")).toBe("CA")
		expect(countryFromPostcodeFormat("V6C0C3")).toBe("CA") // unspaced
	})

	it("does NOT match a US ZIP, NL, or FR postcode (unforgeable → no mis-route)", () => {
		expect(countryFromPostcodeFormat("90210")).toBeNull() // US ZIP (all digits)
		expect(countryFromPostcodeFormat("1012 LG")).toBeNull() // NL (digits-first)
		expect(countryFromPostcodeFormat("75013")).toBeNull() // FR
	})

	it("matches IE Eircodes (routing key + 4-alnum unique part), incl. the D6W special", () => {
		expect(countryFromPostcodeFormat("D02 AF30")).toBe("IE")
		expect(countryFromPostcodeFormat("T12 X70A")).toBe("IE")
		expect(countryFromPostcodeFormat("V94T2XR")).toBe("IE") // unspaced
		expect(countryFromPostcodeFormat("D6W XY00")).toBe("IE")
	})

	it("GB / CA / IE formats never collide", () => {
		// GB inward is 3 chars (\d[A-Z]{2}); CA ends \d[A-Z]\d; IE unique part is 4 alnum. Mutually exclusive.
		expect(countryFromPostcodeFormat("E4 9AZ")).toBe("GB")
		expect(countryFromPostcodeFormat("K2P 1L4")).toBe("CA")
		expect(countryFromPostcodeFormat("D02 AF30")).toBe("IE")
		// Belfast (Northern Ireland) uses GB postcodes — BT must stay GB, never IE.
		expect(countryFromPostcodeFormat("BT1 5GS")).toBe("GB")
	})

	it("is null on empty / missing input", () => {
		expect(countryFromPostcodeFormat(undefined)).toBeNull()
		expect(countryFromPostcodeFormat("")).toBeNull()
		expect(countryFromPostcodeFormat("   ")).toBeNull()
	})
})

function node(partial: Partial<AddressNode> & Pick<AddressNode, "tag" | "value">): AddressNode {
	return { start: 0, end: 0, confidence: 1, children: [], ...partial }
}

describe("extractGeocodeResult — resolved-place surfacing (#1014)", () => {
	// The parse span was lowercase "paris"; the resolver's canonical name is "Paris", ISO2 "FR".
	const resolvedParis = (): AddressTree => ({
		raw: "55 rue du faubourg saint-honoré 75008 paris",
		roots: [
			node({
				tag: "locality",
				value: "paris",
				lat: 48.8566,
				lon: 2.3522,
				placeID: "wof:1159322569",
				metadata: { resolver_name: "Paris", resolver_country: "FR" },
			}),
		],
	})

	it("surfaces the resolved gazetteer name on each hierarchy entry (not the parsed span)", () => {
		const r = extractGeocodeResult("55 rue du faubourg saint-honoré 75008 paris", resolvedParis())
		expect(r.hierarchy[0]?.name).toBe("Paris") // resolver_name — proper casing
		expect(r.hierarchy[0]?.value).toBe("paris") // the raw parsed span stays available
	})

	it("surfaces the resolved ISO-3166 alpha-2 country code", () => {
		expect(extractGeocodeResult("…", resolvedParis()).countryCode).toBe("FR")
	})

	it("countryCode is null when no node carries a resolved country", () => {
		const tree: AddressTree = {
			raw: "berlin",
			roots: [node({ tag: "locality", value: "Berlin", lat: 52.5, lon: 13.4, placeID: "wof:101909779" })],
		}
		expect(extractGeocodeResult("berlin", tree).countryCode).toBeNull()
	})

	it("hierarchy entry name falls back to the parsed value when unresolved-named", () => {
		const tree: AddressTree = {
			raw: "berlin",
			roots: [node({ tag: "locality", value: "Berlin", lat: 52.5, lon: 13.4, placeID: "wof:101909779" })],
		}
		expect(extractGeocodeResult("berlin", tree).hierarchy[0]?.name).toBe("Berlin")
	})
})

describe("extractGeocodeResult — ranked candidates for limit>1 (#1016)", () => {
	it("surfaces the resolved primary plus its alternatives, self first", () => {
		const tree: AddressTree = {
			raw: "springfield",
			roots: [
				node({
					tag: "locality",
					value: "springfield",
					lat: 37.19,
					lon: -93.29,
					placeID: "wof:100",
					metadata: { resolver_name: "Springfield", resolver_country: "US" },
					// ranked runner-ups (Springfield MA, then IL) the resolver captured on the node
					alternatives: [
						{ id: 201, name: "Springfield", placetype: "locality", lat: 42.11, lon: -72.54, country: "US" },
						{ id: 202, name: "Springfield", placetype: "locality", lat: 39.77, lon: -89.65, country: "US" },
					],
				}),
			],
		}
		const r = extractGeocodeResult("springfield", tree)
		expect(r.candidates).toHaveLength(3) // self + 2 alternatives
		expect(r.candidates[0]).toMatchObject({
			name: "Springfield",
			tag: "locality",
			lat: 37.19,
			countryCode: "US",
			placeID: "wof:100",
		})
		expect(r.candidates[1]).toMatchObject({ name: "Springfield", lat: 42.11, countryCode: "US", placeID: "wof:201" })
		expect(r.candidates[2]).toMatchObject({ lat: 39.77, placeID: "wof:202" })
	})

	it("collapses same-coordinate duplicates (a city + its coincident township)", () => {
		const tree: AddressTree = {
			raw: "springfield",
			roots: [
				node({
					tag: "locality",
					value: "springfield",
					lat: 37.194291,
					lon: -93.291579,
					placeID: "wof:100",
					metadata: { resolver_name: "Springfield", resolver_country: "US" },
					alternatives: [
						// same point as the primary (~0.2 m) → dropped
						{
							id: 101,
							name: "Springfield Township",
							placetype: "localadmin",
							lat: 37.194301,
							lon: -93.291581,
							country: "US",
						},
						// a genuinely distinct namesake → kept
						{ id: 201, name: "Springfield", placetype: "locality", lat: 42.115503, lon: -72.53952, country: "US" },
					],
				}),
			],
		}
		const r = extractGeocodeResult("springfield", tree)
		expect(r.candidates).toHaveLength(2) // primary + the distinct MA one; the coincident township is dropped
		expect(r.candidates.map((c) => c.placeID)).toEqual(["wof:100", "wof:201"])
	})

	it("is a single entry for an unambiguous result (no alternatives)", () => {
		const tree: AddressTree = {
			raw: "berlin",
			roots: [
				node({
					tag: "locality",
					value: "Berlin",
					lat: 52.5,
					lon: 13.4,
					placeID: "wof:101909779",
					metadata: { resolver_name: "Berlin", resolver_country: "DE" },
				}),
			],
		}
		expect(extractGeocodeResult("berlin", tree).candidates).toHaveLength(1)
	})
})
