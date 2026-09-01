/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the postcode-prefix prior (#31, Mechanism 3, `ResolveOpts.postcodePrefixPrior` +
 *   `postcodePrefixIndex`) — the partial-code prior for postcodes the full-code gazetteer does not
 *   carry (the #1480 NI BT abstention). The pre-registered bars:
 *
 *   - **B3-2** — ≥60% of held-out units within 10 km, zero worse than the abstention arm. The
 *     within-10-km population is a DATA property of a real PFX1 artifact (a GB one is being built
 *     build-side); what the resolver-level legs below pin is the CONTRACT the artifact rides on —
 *     a hit resolves to the index node's coordinate, the node's `radiusP95Km` rides along (never
 *     read a coordinate without its radius), and an abstention arm (no index) resolves NOTHING, so
 *     a hit is never worse than abstention by construction.
 *   - **B3-3** — NI ≥95% country scope GB + NIR ancestry + correct district named, 0% coordinate.
 *     The ancestry-only tier resolves with NO lat/lon — absence, never 0,0 (meaning-of-zero) — and
 *     the metadata contract carries `postcode_prefix` + `postcode_prefix_ancestors`.
 *   - **B3-5** — structural: the index is `PostcodePrefixIndexLike` (`probe` + optional `country`),
 *     injected, never imported from `@mailwoman/neural`. The fake indexes below are plain objects
 *     satisfying the structure — the resolver consumes any implementation.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { PostcodePrefixIndexLike, ResolverBackend } from "@mailwoman/core/resolver"
import { derivePostcodePrefix, probePostcodePrefix } from "@mailwoman/resolver/postcode"
import { createWOFResolver } from "@mailwoman/resolver/resolve"
import { describe, expect, it } from "vitest"

//#region Fixtures

const node = (over: Partial<AddressNode> & Pick<AddressNode, "tag" | "value">): AddressNode => ({
	start: 0,
	end: over.value.length,
	confidence: 0.95,
	children: [],
	...over,
})

const tree = (...roots: AddressNode[]): AddressTree => ({ raw: roots.map((r) => r.value).join(" "), roots })

/**
 * Every backend query misses — the postalcode lookup must fail for the prior to fire.
 */
const silentBackend: ResolverBackend = {
	findPlace: async () => [],
}

/**
 * A coordinate-bearing GB outward index — the B3-2 tier (prefix centroid + measured radius).
 */
const gbCoordinateIndex: PostcodePrefixIndexLike = {
	country: "GB",
	probe: (prefix) =>
		prefix === "BT9"
			? {
					prefix,
					ancestors: [
						{ placetype: "country", wofID: 85_633_127, name: "United Kingdom" },
						{ placetype: "region", wofID: 200_783_847, name: "Northern Ireland" },
						{ placetype: "locality", wofID: 200_875_281, name: "Belfast" },
					],
					lat: 54.577232,
					lon: -5.94725,
					radiusP95Km: 8.2,
					unitCount: 411,
				}
			: null,
}

/**
 * The ancestry-only tier — NI's 80 BT districts with NO coordinate (B3-3's 0% half).
 */
const gbAncestryOnlyIndex: PostcodePrefixIndexLike = {
	country: "GB",
	probe: (prefix) =>
		prefix === "BT9"
			? {
					prefix,
					ancestors: [
						{ placetype: "country", wofID: 85_633_127, name: "United Kingdom" },
						{ placetype: "region", wofID: 200_783_847, name: "Northern Ireland" },
						{ placetype: "locality", wofID: 200_875_281, name: "Belfast" },
					],
					unitCount: 411,
				}
			: null,
}

//#endregion

describe("derivePostcodePrefix — the derivation laws", () => {
	it("derives the GB outward code: compact minus the trailing 3 unit characters", () => {
		expect(derivePostcodePrefix("SW1A 2AA", "GB")).toBe("SW1A")
		expect(derivePostcodePrefix("SW1A2AA", "GB")).toBe("SW1A") // already-compact input
		expect(derivePostcodePrefix("BT9 5GS", "GB")).toBe("BT9")
		expect(derivePostcodePrefix("BT93GS", "GB")).toBe("BT9")
		expect(derivePostcodePrefix("EC1A 1BB", "GB")).toBe("EC1A")
	})

	it("derives the US 3-digit section", () => {
		expect(derivePostcodePrefix("94043", "US")).toBe("940")
		expect(derivePostcodePrefix("80503", "US")).toBe("805")
	})

	it("abstains on codes too short to carry a prefix", () => {
		// "B3" is a GB area, not a unit-bearing code — no 3-character unit to strip.
		expect(derivePostcodePrefix("B3", "GB")).toBeNull()
		expect(derivePostcodePrefix("12", "US")).toBeNull()
		expect(derivePostcodePrefix("", "GB")).toBeNull()
	})

	it("abstains on a country with no derivation law", () => {
		expect(derivePostcodePrefix("75001", "FR")).toBeNull()
		expect(derivePostcodePrefix("75001", undefined)).toBeNull()
	})
})

describe("probePostcodePrefix — the country gate", () => {
	it("refuses to let a GB index speak under a US scope (B3-5 posture)", () => {
		expect(probePostcodePrefix("BT9 5GS", gbCoordinateIndex, "US")).toBeNull()
	})

	it("probes when the scope matches, or when no scope is set", () => {
		expect(probePostcodePrefix("BT9 5GS", gbCoordinateIndex, "GB")?.prefix).toBe("BT9")
		expect(probePostcodePrefix("BT9 5GS", gbCoordinateIndex)?.prefix).toBe("BT9")
	})

	it("returns null on a prefix the index does not carry", () => {
		expect(probePostcodePrefix("SW1A 2AA", gbCoordinateIndex, "GB")).toBeNull()
	})
})

describe("postcodePrefixResolvedPlace — the synthetic place (B3-2/B3-3)", () => {
	it("carries the coordinate + radius only when the index node does", async () => {
		const resolver = createWOFResolver(silentBackend)

		const resolved = await resolver.resolveTree(tree(node({ tag: "postcode", value: "BT9 5GS" })), {
			postcodePrefixPrior: true,
			postcodePrefixIndex: gbCoordinateIndex,
		})

		const postcode = resolved.roots[0]!
		expect(postcode.tag).toBe("postcode")
		expect(postcode.source).toBe("resolver")
		expect(postcode.placeID).toBe("wof:0") // synthetic — not a gazetteer row
		// The B3-2 tier: the node resolves to the index node's coordinate…
		expect(postcode.lat).toBe(54.577232)
		expect(postcode.lon).toBe(-5.94725)
		// …and the metadata contract rides along: prefix, ancestry, radius — never read a coordinate
		// without its radius (M-3's 200× receipt).
		expect(postcode.metadata?.["postcode_prefix"]).toBe("BT9")

		expect(postcode.metadata?.["postcode_prefix_ancestors"]).toEqual([
			{ placetype: "country", wofID: 85_633_127, name: "United Kingdom" },
			{ placetype: "region", wofID: 200_783_847, name: "Northern Ireland" },
			{ placetype: "locality", wofID: 200_875_281, name: "Belfast" },
		])

		expect(postcode.metadata?.["postcode_prefix_radius_p95_km"]).toBe(8.2)
		expect(postcode.metadata?.["coordinate_source"]).toBe("postcode_prefix")
	})

	it("abstention arm: without the index, the same tree resolves NOTHING (a hit is never worse)", async () => {
		const resolver = createWOFResolver(silentBackend)

		const abstained = await resolver.resolveTree(tree(node({ tag: "postcode", value: "BT9 5GS" })), {
			postcodePrefixPrior: true, // flag on, no index — the prior cannot fire
		})

		const postcode = abstained.roots[0]!
		expect(postcode.placeID).toBeUndefined()
		expect(postcode.lat).toBeUndefined()
		expect(postcode.source).toBeUndefined()
	})

	it("is a no-op when the prior is off, even with an index injected", async () => {
		const resolver = createWOFResolver(silentBackend)

		const off = await resolver.resolveTree(tree(node({ tag: "postcode", value: "BT9 5GS" })), {
			postcodePrefixIndex: gbCoordinateIndex, // index present, flag off
		})

		expect(off.roots[0]!.placeID).toBeUndefined()
	})
})

describe("B3-3 — the ancestry-only tier is coordinate-free (0% get a coordinate)", () => {
	it("resolves the district but assigns NO lat/lon and no coordinate_source", async () => {
		const resolver = createWOFResolver(silentBackend)

		const resolved = await resolver.resolveTree(tree(node({ tag: "postcode", value: "BT9 5GS" })), {
			postcodePrefixPrior: true,
			postcodePrefixIndex: gbAncestryOnlyIndex,
		})

		const postcode = resolved.roots[0]!
		expect(postcode.source).toBe("resolver")
		expect(postcode.placeID).toBe("wof:0")
		// 0% coordinate — absence, never 0,0 (inventing a BT centroid would reproduce the
		// `BT3 9QQ` → Sheffield defect #1480 just fixed).
		expect(postcode.lat).toBeUndefined()
		expect(postcode.lon).toBeUndefined()
		expect(postcode.metadata?.["coordinate_source"]).toBeUndefined()
		// The district is still NAMED — country → constituent country → district, coarsest-first.
		expect(postcode.metadata?.["postcode_prefix"]).toBe("BT9")
		const ancestors = postcode.metadata?.["postcode_prefix_ancestors"] as Array<{ name: string }>
		expect(ancestors.map((a) => a.name)).toEqual(["United Kingdom", "Northern Ireland", "Belfast"])
	})
})

describe("B3-5 — structural consumption, no model imports", () => {
	it("accepts any structurally-conforming index, from any implementation", async () => {
		// A plain object with `probe` + `country` — nothing about `@mailwoman/neural` enters this
		// graph. The resolver's only dependency is the structure (compile-enforced).
		const structuralIndex: PostcodePrefixIndexLike = {
			country: "GB",
			probe: (prefix) =>
				prefix === "SW1A"
					? { prefix, ancestors: [{ placetype: "country", wofID: 1, name: "United Kingdom" }], unitCount: 88 }
					: null,
		}

		const resolver = createWOFResolver(silentBackend)

		const resolved = await resolver.resolveTree(tree(node({ tag: "postcode", value: "SW1A 2AA" })), {
			postcodePrefixPrior: true,
			postcodePrefixIndex: structuralIndex,
		})

		expect(resolved.roots[0]!.metadata?.["postcode_prefix"]).toBe("SW1A")
		expect(resolved.roots[0]!.lat).toBeUndefined()
	})

	it("defers to a real gazetteer hit when one exists — the prior is a MISS-fallback only", async () => {
		const realBackend: ResolverBackend = {
			findPlace: async (query) =>
				query.placetype === "postalcode"
					? [
							{
								id: 555,
								name: "BT9 5GS",
								placetype: "postalcode",
								country: "GB",
								lat: 54.6,
								lon: -5.93,
								score: 9,
								exactMatch: true,
							},
						]
					: [],
		}

		const resolver = createWOFResolver(realBackend)

		const resolved = await resolver.resolveTree(tree(node({ tag: "postcode", value: "BT9 5GS" })), {
			postcodePrefixPrior: true,
			postcodePrefixIndex: gbCoordinateIndex,
		})

		const postcode = resolved.roots[0]!
		// The gazetteer row wins — no synthetic place, no prefix metadata.
		expect(postcode.placeID).toBe("wof:555")
		expect(postcode.metadata?.["postcode_prefix"]).toBeUndefined()
	})
})
