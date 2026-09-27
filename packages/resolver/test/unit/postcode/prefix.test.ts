import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { PostcodePrefixIndexLike, ResolverBackend } from "@mailwoman/core/resolver"
import { derivePostcodePrefix, probePostcodePrefix } from "@mailwoman/resolver/postcode"
import { createWOFResolver } from "@mailwoman/resolver/resolve"
import { describe, expect, it } from "vitest"

const node = (over: Partial<AddressNode> & Pick<AddressNode, "tag" | "value">): AddressNode => ({
	start: 0,
	end: over.value.length,
	confidence: 0.95,
	children: [],
	...over,
})

const tree = (...roots: AddressNode[]): AddressTree => ({ raw: roots.map((r) => r.value).join(" "), roots })

const silentBackend: ResolverBackend = {
	findPlace: async () => [],
}

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

describe("derivePostcodePrefix — the derivation laws", () => {
	it("derives the GB outward code: compact minus the trailing 3 unit characters", () => {
		expect(derivePostcodePrefix("SW1A 2AA", "GB")).toBe("SW1A")
		expect(derivePostcodePrefix("SW1A2AA", "GB")).toBe("SW1A")
		expect(derivePostcodePrefix("BT9 5GS", "GB")).toBe("BT9")
		expect(derivePostcodePrefix("BT93GS", "GB")).toBe("BT9")
		expect(derivePostcodePrefix("EC1A 1BB", "GB")).toBe("EC1A")
	})

	it("derives the US 3-digit section", () => {
		expect(derivePostcodePrefix("94043", "US")).toBe("940")
		expect(derivePostcodePrefix("80503", "US")).toBe("805")
	})

	it("abstains on codes too short to carry a prefix", () => {
		expect(derivePostcodePrefix("B3", "GB")).toBeNull()
		expect(derivePostcodePrefix("12", "US")).toBeNull()
		expect(derivePostcodePrefix("", "GB")).toBeNull()
	})

	it("abstains on a country with no derivation law", () => {
		expect(derivePostcodePrefix("75001", "FR")).toBeNull()
		expect(derivePostcodePrefix("75001", undefined)).toBeNull()
	})
})

describe("probePostcodePrefix — the country check", () => {
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
		expect(postcode.placeID).toBe("wof:0")

		expect(postcode.lat).toBe(54.577232)
		expect(postcode.lon).toBe(-5.94725)

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
			postcodePrefixPrior: true,
		})

		const postcode = abstained.roots[0]!
		expect(postcode.placeID).toBeUndefined()
		expect(postcode.lat).toBeUndefined()
		expect(postcode.source).toBeUndefined()
	})

	it("is a no-op when the prior is off, even with an index injected", async () => {
		const resolver = createWOFResolver(silentBackend)

		const off = await resolver.resolveTree(tree(node({ tag: "postcode", value: "BT9 5GS" })), {
			postcodePrefixIndex: gbCoordinateIndex,
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

		expect(postcode.lat).toBeUndefined()
		expect(postcode.lon).toBeUndefined()
		expect(postcode.metadata?.["coordinate_source"]).toBeUndefined()

		expect(postcode.metadata?.["postcode_prefix"]).toBe("BT9")
		const ancestors = postcode.metadata?.["postcode_prefix_ancestors"] as Array<{ name: string }>
		expect(ancestors.map((a) => a.name)).toEqual(["United Kingdom", "Northern Ireland", "Belfast"])
	})
})

describe("B3-5 — structural consumption without model imports", () => {
	it("accepts any structurally-conforming index, from any implementation", async () => {
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

		expect(postcode.placeID).toBe("wof:555")
		expect(postcode.metadata?.["postcode_prefix"]).toBeUndefined()
	})
})
