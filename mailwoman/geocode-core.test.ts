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
import { computeQueryShape } from "@mailwoman/query-shape"
import { describe, expect, it } from "vitest"

import {
	countryFromPostcodeFormat,
	extractGeocodeResult,
	type GeocodeClassifier,
	parseForGeocode,
} from "./geocode-core.js"

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

describe("extractGeocodeResult — parsed house-grade fields (#1041)", () => {
	// A rooftop parse of "123 East Sheldon Rd 75001 Paris": the street node is stamped `address_point`, and its
	// name-bearing subtree (prefix + base + suffix) plus the house_number nest under it (per the containment schema).
	const rooftopTree = (tier: "address_point" | "interpolated" | "admin"): AddressTree => ({
		raw: "123 east sheldon rd 75001 paris",
		roots: [
			node({
				tag: "street",
				value: "Sheldon",
				start: 9,
				end: 16,
				metadata:
					tier === "address_point"
						? { resolution_tier: "address_point", address_point: { lat: 48.8548, lon: 2.3451 } }
						: tier === "interpolated"
							? {
									resolution_tier: "interpolated",
									interpolated_point: { lat: 48.8548, lon: 2.3451 },
									uncertainty_m: 40,
								}
							: undefined,
				children: [
					node({ tag: "house_number", value: "123", start: 0, end: 3 }),
					node({ tag: "street_prefix", value: "East", start: 4, end: 8 }),
					node({ tag: "street_suffix", value: "Rd", start: 17, end: 19 }),
				],
			}),
			node({
				tag: "locality",
				value: "paris",
				lat: 48.8566,
				lon: 2.3522,
				metadata: { resolver_name: "Paris", resolver_country: "FR" },
			}),
			node({ tag: "postcode", value: "75001" }),
		],
	})

	it("surfaces the parsed house number + FULL reassembled street on a rooftop (address_point) result", () => {
		const r = extractGeocodeResult("123 East Sheldon Rd 75001 Paris", rooftopTree("address_point"))
		expect(r.resolution_tier).toBe("address_point")
		expect(r.house_number).toBe("123")
		expect(r.street).toBe("East Sheldon Rd") // prefix + base + suffix, span-ordered — not the bare "Sheldon"
		expect(r.lat).toBe(48.8548) // the rooftop coordinate won
		expect(r.postcode).toBe("75001")
	})

	it("surfaces the same house-grade fields on an interpolated result", () => {
		const r = extractGeocodeResult("123 East Sheldon Rd 75001 Paris", rooftopTree("interpolated"))
		expect(r.resolution_tier).toBe("interpolated")
		expect(r.house_number).toBe("123")
		expect(r.street).toBe("East Sheldon Rd")
	})

	it("still carries the parsed spans on an admin-tier fallback (the consumer gates on the tier, not their presence)", () => {
		const r = extractGeocodeResult("123 East Sheldon Rd 75001 Paris", rooftopTree("admin"))
		expect(r.resolution_tier).toBe("admin") // no address_point/interpolated metadata → admin centroid
		expect(r.house_number).toBe("123") // populated regardless of tier — informational
		expect(r.street).toBe("East Sheldon Rd")
	})

	it("is null for both when the parse found no street / house number (a bare locality query)", () => {
		const tree: AddressTree = {
			raw: "berlin",
			roots: [node({ tag: "locality", value: "Berlin", lat: 52.5, lon: 13.4 })],
		}
		const r = extractGeocodeResult("berlin", tree)
		expect(r.house_number).toBeNull()
		expect(r.street).toBeNull()
	})
})

describe("parseForGeocode — query-shape emission prior (#981)", () => {
	type ParseOpts = Parameters<GeocodeClassifier["parse"]>[1]

	/**
	 * A recording classifier: captures the opts geocode-core hands the model. Lets us assert the query-shape prior the
	 * runtime pipeline applies (`core/pipeline/runtime-pipeline.ts` → `safeClassify`) now reaches the geocode path too —
	 * without loading a real model.
	 */
	function recordingClassifier(): { classifier: GeocodeClassifier; calls: Array<{ text: string; opts?: ParseOpts }> } {
		const calls: Array<{ text: string; opts?: ParseOpts }> = []
		const classifier: GeocodeClassifier = {
			parse(text, opts) {
				calls.push({ text, opts })

				return Promise.resolve({ raw: text, roots: [] })
			},
		}

		return { classifier, calls }
	}

	it("passes a queryShape computed on the exact model input (converges with the runtime pipeline)", async () => {
		const { classifier, calls } = recordingClassifier()
		await parseForGeocode("Damrak 1, 1012 LG Amsterdam", { classifier })

		expect(calls).toHaveLength(1)
		const { text, opts } = calls[0]!
		expect(opts?.queryShape).toBeDefined()
		// The shape must be the one computeQueryShape derives from the SAME text handed to the model.
		expect(opts!.queryShape).toEqual(computeQueryShape(text))
	})

	it("carries the known-format hit that biases B-postcode (the belt reaches the geocode path)", async () => {
		const { classifier, calls } = recordingClassifier()
		await parseForGeocode("Damrak 1, 1012 LG Amsterdam", { classifier })

		const formats = calls[0]!.opts!.queryShape!.knownFormats.map((f) => f.format)
		expect(formats).toContain("nl_postcode")
	})

	it("is an empty-format shape for the bare street+city class — nothing for the prior to bias (#981 falsified)", async () => {
		const { classifier, calls } = recordingClassifier()
		await parseForGeocode("Wetstraat, Brussel", { classifier })

		const qs = calls[0]!.opts!.queryShape!
		// The Wetstraat/Rue-de-la-Loi cross-border class: no known postcode format, no region abbreviation, so
		// buildEmissionPriors returns an all-zeros matrix — the emission prior CANNOT move it. That class needs a
		// lexical country prior, not this belt.
		expect(qs.knownFormats).toHaveLength(0)
		expect(qs.regionAbbreviations ?? []).toHaveLength(0)
	})

	it("computes the shape over the raw input when normalizeInput is false", async () => {
		const { classifier, calls } = recordingClassifier()
		await parseForGeocode("Damrak 1, 1012 LG Amsterdam", { classifier, normalizeInput: false })

		expect(calls[0]!.text).toBe("Damrak 1, 1012 LG Amsterdam")
		expect(calls[0]!.opts!.queryShape).toEqual(computeQueryShape("Damrak 1, 1012 LG Amsterdam"))
	})
})
