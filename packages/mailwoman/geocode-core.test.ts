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
import type { ResolvedPlace } from "@mailwoman/core/resolver"
import { computeQueryShape } from "@mailwoman/query-shape"
import { createWOFResolver, type Resolver } from "@mailwoman/resolver"
import { describe, expect, it } from "vitest"

import {
	geocodeAddress,
	countryFromPostcodeFormat,
	extractGeocodeResult,
	recognizeBarePostcode,
	type GeocodeClassifier,
	type GeocodeDeps,
	parseForGeocode,
} from "./geocode-core.ts"

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
		expect(r.candidates).toHaveLength(3)

		// self + 2 alternatives
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

	it("retains locale-specific parsed components that have no legacy named result field", () => {
		const tree: AddressTree = {
			raw: "りんりん, 〒506-0025 岐阜県高山市天満町3丁目 57",
			roots: [
				node({ tag: "venue", value: "りんりん" }),
				node({ tag: "postcode", value: "506-0025" }),
				node({ tag: "prefecture", value: "岐阜県" }),
				node({ tag: "municipality", value: "高山市" }),
				node({ tag: "district", value: "天満町" }),
				node({ tag: "block", value: "3丁目" }),
				node({ tag: "house_number", value: "57" }),
			],
		}

		expect(extractGeocodeResult(tree.raw, tree).components).toMatchObject({
			venue: "りんりん",
			postcode: "506-0025",
			prefecture: "岐阜県",
			municipality: "高山市",
			district: "天満町",
			block: "3丁目",
			house_number: "57",
		})
	})
})

describe("recognizeBarePostcode (#22)", () => {
	const tree = (roots: AddressNode[], raw = "N7 0BT"): AddressTree => ({ raw, roots })

	it("retags a whole-input GB postcode the model read as a street", () => {
		const out = recognizeBarePostcode(tree([node({ tag: "street", value: "N7 0BT", end: 6 })]))
		expect(out.roots[0]?.tag).toBe("postcode")
		expect(out.roots[0]?.metadata?.["bare_postcode_retag"]).toBe(true)
	})

	it("retags a CA postcode the same way", () => {
		const out = recognizeBarePostcode(tree([node({ tag: "venue", value: "K2P 1L4" })], "K2P 1L4"))
		expect(out.roots[0]?.tag).toBe("postcode")
	})

	it("leaves a tree that already found a postcode alone", () => {
		const out = recognizeBarePostcode(tree([node({ tag: "postcode", value: "N7 0BT" })], "N7 0BT"))
		expect(out.roots[0]?.tag).toBe("postcode")
		expect(out.roots[0]?.metadata?.["bare_postcode_retag"]).toBeUndefined()
	})

	it("never touches a postcode-shaped span inside a longer address", () => {
		const out = recognizeBarePostcode(
			tree([node({ tag: "locality", value: "London" }), node({ tag: "street", value: "N7 0BT" })], "London N7 0BT")
		)

		expect(out.roots[1]?.tag).toBe("street")
	})

	it("never touches a street name that is not an unforgeable postcode shape", () => {
		for (const value of ["Main Street", "90210", "1012 LG", "75013", "Broadway"]) {
			const out = recognizeBarePostcode(tree([node({ tag: "street", value })], value))
			expect(out.roots[0]?.tag).toBe("street")
		}
	})
})

describe("extractGeocodeResult — unit-grade postcodes lead the admin ladder (#977 NL, #22 GB)", () => {
	/**
	 * The GB shape of the defect: `29 Brecknock Road, London, N7 0BT` resolves BOTH the locality (the London centroid,
	 * 51.5005/-0.1094) and the unit postcode (`N70BT`, 51.5500/-0.1307 — 38 m from the rooftop truth), and the admin
	 * ladder returned London, 5.6 km out. Coordinates are the live `candidate.db` rows, read 2026-08-10.
	 */
	const gbTree = (postcodeName = "N70BT"): AddressTree => ({
		raw: "29 Brecknock Road, London, N7 0BT",
		roots: [
			node({
				tag: "locality",
				value: "London",
				lat: 51.500525578898,
				lon: -0.109400835283853,
				placeID: "wof:101750367",
				metadata: { resolver_name: "London", resolver_country: "GB" },
			}),
			node({
				tag: "postcode",
				value: "N7 0BT",
				lat: 51.54997980304472,
				lon: -0.1306932211473067,
				placeID: "wof:1",
				metadata: { resolver_name: postcodeName, resolver_country: "GB" },
			}),
		],
	})

	it("returns the GB unit-postcode centroid, not the locality centroid", () => {
		const r = extractGeocodeResult("29 Brecknock Road, London, N7 0BT", gbTree())
		expect(r.lat).toBeCloseTo(51.54998, 4)
		expect(r.lon).toBeCloseTo(-0.130693, 4)
	})

	it("keeps the locality centroid when the resolver only reached the OUTWARD stem", () => {
		// A stem hit (`N7`) is district-class — coarser than the locality, so it must NOT lead.
		const r = extractGeocodeResult("29 Brecknock Road, London, N7 0BT", gbTree("N7"))
		expect(r.lat).toBeCloseTo(51.500526, 4)
	})

	it("keeps the locality centroid for a US ZIP (area-class, the locality-first epoch convention)", () => {
		const tree: AddressTree = {
			raw: "350 5th Ave, New York, NY 10118",
			roots: [
				node({
					tag: "locality",
					value: "New York",
					lat: 40.7128,
					lon: -74.006,
					metadata: { resolver_name: "New York", resolver_country: "US" },
				}),
				node({
					tag: "postcode",
					value: "10118",
					lat: 40.7484,
					lon: -73.9857,
					metadata: { resolver_name: "10118", resolver_country: "US" },
				}),
			],
		}

		expect(extractGeocodeResult(tree.raw, tree).lat).toBeCloseTo(40.7128, 4)
	})

	it("still leads with an NL PC6 exact hit (#977 unchanged)", () => {
		const tree: AddressTree = {
			raw: "Damrak 1, 1012 LG Amsterdam",
			roots: [
				node({ tag: "locality", value: "Amsterdam", lat: 52.3676, lon: 4.9041 }),
				node({
					tag: "postcode",
					value: "1012 LG",
					lat: 52.3759,
					lon: 4.8975,
					metadata: { resolver_name: "1012LG" },
				}),
			],
		}

		expect(extractGeocodeResult(tree.raw, tree).lat).toBeCloseTo(52.3759, 4)
	})
})

describe("extractGeocodeResult — street-tier locality from the register commune (#1058)", () => {
	// "Rue Sainte-Catherine, Bordeaux": the street-centroid tier matched the register's (street,
	// commune) pair and stamped `street_locality: "Bordeaux"` on the street node; span-rescore's
	// speculative locality ("Rue", the street's first token — a real commune in the Somme) was
	// dropped by the resolver for contradicting the register.
	const streetTierTree = (): AddressTree => ({
		raw: "Rue Sainte-Catherine, Bordeaux",
		roots: [
			node({ tag: "region", value: "Bordeaux", start: 22, end: 30 }),
			node({
				tag: "street",
				value: "Sainte-Catherine",
				start: 4,
				end: 20,
				metadata: {
					resolution_tier: "street",
					street_centroid: { lat: 44.8364, lon: -0.5736 },
					street_locality: "Bordeaux",
					uncertainty_m: 586,
				},
				children: [node({ tag: "street_prefix", value: "Rue", start: 0, end: 3 })],
			}),
		],
	})

	it("decorates `locality` from the register commune, never the street's first token", () => {
		const r = extractGeocodeResult("Rue Sainte-Catherine, Bordeaux", streetTierTree())
		expect(r.resolution_tier).toBe("street")
		expect(r.locality).toBe("Bordeaux") // not "Rue"
	})

	it("inserts the commune into the hierarchy when no locality entry exists", () => {
		const r = extractGeocodeResult("Rue Sainte-Catherine, Bordeaux", streetTierTree())
		const localityEntry = r.hierarchy.find((h) => h.tag === "locality")
		expect(localityEntry?.name).toBe("Bordeaux")
	})

	it("does not override a locality hierarchy entry the walk already resolved", () => {
		const tree = streetTierTree()

		tree.roots.push(
			node({
				tag: "locality",
				value: "bordeaux",
				lat: 44.84,
				lon: -0.58,
				placeID: "wof:117496",
				metadata: { resolver_name: "Bordeaux" },
			})
		)

		const r = extractGeocodeResult("Rue Sainte-Catherine, Bordeaux", tree)
		expect(r.hierarchy.filter((h) => h.tag === "locality")).toHaveLength(1) // no duplicate
		expect(r.hierarchy[0]?.placeID).toBe("wof:117496") // the resolved entry wins
	})

	it("is inert for non-street tiers and postcode-scoped street hits (no street_locality stamped)", () => {
		const tree: AddressTree = {
			raw: "berlin",
			roots: [node({ tag: "locality", value: "Berlin", lat: 52.5, lon: 13.4 })],
		}

		const r = extractGeocodeResult("berlin", tree)
		expect(r.locality).toBe("Berlin")
		expect(r.hierarchy).toHaveLength(1)
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

describe("the Decision-A retry rider (retryAlternateRegister)", () => {
	function riderDeps(
		parses: Array<{ inputMode?: string }>,
		resolveHits: boolean[]
	): Pick<GeocodeDeps, "classifier" | "resolver"> {
		let call = 0

		const classifier: GeocodeClassifier = {
			parse: async (text, opts) => {
				parses.push({ inputMode: opts?.inputMode })

				return { raw: text, roots: [] }
			},
		}

		const resolver: Resolver = {
			resolveTree: async (tree) => {
				const hit = resolveHits[call++] ?? false

				// A hit carries its coordinate ON the node — that's what extractGeocodeResult reads.
				return hit
					? {
							raw: tree.raw,
							roots: [node({ tag: "locality", value: "Testville", lat: 1, lon: 2, placeID: "wof:1" })],
						}
					: { raw: tree.raw, roots: [] }
			},
		}

		return { classifier, resolver }
	}

	it("zero-hit in a derived register retries ONCE in the alternative register", async () => {
		const parses: Array<{ inputMode?: string }> = []
		const result = await geocodeAddress("Fragmentville", riderDeps(parses, [false, false]))

		expect(parses).toHaveLength(2)
		// "Fragmentville" derives fragmented (locality_only); the retry flips to formatted, explicitly.
		expect(parses[1]!.inputMode).toBe("formatted")
		expect(result.lat).toBeNull()
	})

	it("an explicit register is never second-guessed", async () => {
		const parses: Array<{ inputMode?: string }> = []
		await geocodeAddress("Fragmentville", { ...riderDeps(parses, [false, false]), inputMode: "fragmented" })

		expect(parses).toHaveLength(1)
	})

	/**
	 * Builds a rider whose FIRST parse reads the input as the given components and resolves nothing.
	 */
	function streetReadingDeps(
		parses: Array<{ inputMode?: string }>,
		roots: AddressNode[]
	): Pick<GeocodeDeps, "classifier" | "resolver"> {
		const classifier: GeocodeClassifier = {
			parse: async (text, opts) => {
				parses.push({ inputMode: opts?.inputMode })

				return { raw: text, roots }
			},
		}

		const resolver: Resolver = {
			resolveTree: async (tree) => ({ raw: tree.raw, roots: tree.roots }),
		}

		return { classifier, resolver }
	}

	it("a parse that read the whole input as a street name earns no retry", async () => {
		// "Sultan Qaboos Street" parses correctly and resolves nothing (no OM street coverage). The flip used to
		// hand the result to a homonym INSIDE the name — Sultan, Washington — and clip `street` to "Qaboos".
		const parses: Array<{ inputMode?: string }> = []

		const result = await geocodeAddress(
			"Sultan Qaboos Street",
			streetReadingDeps(parses, [
				node({ tag: "street", value: "Sultan Qaboos" }),
				node({ tag: "street_suffix", value: "Street" }),
			])
		)

		expect(parses).toHaveLength(1)
		expect(result.components.street).toBe("Sultan Qaboos")
	})

	it("still retries when the parse carries more than a street name", async () => {
		// The guard is about a WHOLE-input street reading. A street beside a locality is an ordinary address that
		// simply failed to resolve, which is exactly what the rider exists for.
		const parses: Array<{ inputMode?: string }> = []

		await geocodeAddress(
			"Main Street, Fragmentville",
			streetReadingDeps(parses, [
				node({ tag: "street", value: "Main Street" }),
				node({ tag: "locality", value: "Fragmentville" }),
			])
		)

		expect(parses).toHaveLength(2)
	})

	it("retryAlternateRegister: false pins single-pass", async () => {
		const parses: Array<{ inputMode?: string }> = []

		await geocodeAddress("Fragmentville", {
			...riderDeps(parses, [false, false]),
			retryAlternateRegister: false,
		})

		expect(parses).toHaveLength(1)
	})
})

describe("#1537: a famous namesake the model reads as a `street` keeps its candidate list", () => {
	/**
	 * The live shape the issue reports, reduced to a fixture. The model tags a bare `Springfield` / `Berlin` / `Moscow`
	 * as a `street` (they read as street names), so the admin walk resolves nothing and the #370 span-rescore tier is the
	 * ONLY thing that recovers the place. It used to decorate the injected node with an EMPTY alternatives list, so
	 * `candidates` came back holding one entry and `declared_ambiguity` — whose whole trigger is a top-1-vs-top-2 margin
	 * — could not fire for the very class it exists for.
	 */
	const SPRINGFIELDS: ResolvedPlace[] = [
		{
			id: 10,
			name: "Springfield",
			placetype: "locality",
			country: "US",
			lat: 37.194291,
			lon: -93.291579,
			score: 8,
			prominence: 5.1,
			exactMatch: true,
		},
		{
			id: 11,
			name: "Springfield",
			placetype: "locality",
			country: "US",
			lat: 42.1015,
			lon: -72.5898,
			score: 7,
			prominence: 5.05,
			exactMatch: true,
		},
		{
			id: 12,
			name: "Springfield",
			placetype: "locality",
			country: "US",
			lat: 39.7817,
			lon: -89.6501,
			score: 6,
			prominence: 5.02,
			exactMatch: true,
		},
	]

	const deps = (): Pick<GeocodeDeps, "classifier" | "resolver" | "placeCountry"> => ({
		// A `street` node below the span-blocking confidence threshold — exactly what the model emits here.
		classifier: {
			parse: async (text) => ({
				raw: text,
				roots: [node({ tag: "street", value: text, end: text.length, confidence: 0.4 })],
			}),
		},
		resolver: createWOFResolver({
			findPlace: async (query) =>
				query.text.trim().toLowerCase() === "springfield" ? SPRINGFIELDS.map((p) => ({ ...p })) : [],
		}),
		// No placer: this test is about the resolver's candidate list, not the country prior — and loading the
		// bundled placer model in a unit test would be a several-hundred-millisecond side quest.
		placeCountry: false,
	})

	it("returns every namesake, not just the winner", async () => {
		const result = await geocodeAddress("Springfield", deps())

		// The winner is untouched — the same coordinate this query answered with before the fix.
		expect(result.lat).toBe(37.194291)
		expect(result.lon).toBe(-93.291579)
		expect(result.candidates.map((c) => c.placeID)).toEqual(["wof:10", "wof:11", "wof:12"])
	})

	it("and the recovered margin lets `declared_ambiguity` fire", async () => {
		const result = await geocodeAddress("Springfield", deps())
		const marker = result.intent_markers.find((m) => m.code === "declared_ambiguity")

		expect(marker).toBeDefined()
		// 5.10 − 5.05, an order of magnitude under the 0.5 decisive cut.
		expect(marker!.evidence?.["margin"]).toBeCloseTo(0.05, 4)
	})
})
