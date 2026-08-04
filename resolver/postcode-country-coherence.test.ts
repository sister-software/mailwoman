/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for postcode-country coherence (#42, `ResolveOpts.postcodeCountryCoherence`) — the only
 *   mechanism allowed to override `defaultCountry`, and the only one that runs BEFORE the walk.
 *
 *   The fixture pool is the real 4-way `75001` collision, coordinates taken from the 2026-08-04
 *   candidate gazetteer: FR 48.863,2.336 (Paris 1er), US 32.960,-96.838 (ZIP 75001, Addison TX),
 *   DE 48.844,9.367, PL 54.190,16.188. The fake backend models the two things that actually cause the
 *   bug — a HARD `country` filter on every query, and population-first ranking inside the exact tier
 *   — so `12 Rue de Rivoli, 75001 Paris` under `defaultCountry: "US"` genuinely lands in Paris, Texas
 *   before the pass and in Paris, France after it.
 *
 *   The safety properties under test, in the order they matter:
 *
 *   1. A COHERENT default country always wins (no override, no metadata, byte-stable walk).
 *   2. Zero coherent countries abstains; TWO OR MORE coherent countries abstains.
 *   3. The pass is inert without a postcode, without a locality, without a default country, and
 *      whenever the flag is off — which is the default.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { findPostcodeCountryScope, firstLocalityValue } from "./postcode-country-coherence.ts"
import { createWOFResolver } from "./resolve.ts"

//#region Fixtures — the real 75001 collision

const PC_75001_FR: ResolvedPlace = {
	id: 421_307_175,
	name: "75001",
	placetype: "postalcode",
	country: "FR",
	lat: 48.86263,
	lon: 2.336293,
	score: 9,
	exactMatch: true,
}

const PC_75001_US: ResolvedPlace = {
	id: 554_744_141,
	name: "75001",
	placetype: "postalcode",
	country: "US",
	lat: 32.960001,
	lon: -96.838499,
	score: 9,
	exactMatch: true,
}

const PC_75001_DE: ResolvedPlace = {
	id: 421_285_019,
	name: "75001",
	placetype: "postalcode",
	country: "DE",
	lat: 48.843796,
	lon: 9.367177,
	score: 9,
	exactMatch: true,
}

const PARIS_FR: ResolvedPlace = {
	id: 1_159_322_569,
	name: "Paris",
	placetype: "locality",
	country: "FR",
	lat: 48.856599,
	lon: 2.342841,
	score: 9,
	prominence: 2_138_551,
	exactMatch: true,
}

// The populous US namesake the hard US filter force-matches. 143.8 km from ZIP 75001 (Addison) — the
// distance that makes applyPostcodeConsistency fall the locality back onto the ZIP point.
const PARIS_TX: ResolvedPlace = {
	id: 101_725_293,
	name: "Paris",
	placetype: "locality",
	country: "US",
	lat: 33.669,
	lon: -95.544,
	score: 6,
	prominence: 24_969,
	exactMatch: true,
}

const PARIS_TN: ResolvedPlace = {
	id: 101_722_715,
	name: "Paris",
	placetype: "locality",
	country: "US",
	lat: 36.294,
	lon: -88.307,
	score: 6,
	prominence: 10_343,
	exactMatch: true,
}

// Addison TX sits 0.3 km from ZIP 75001 — the literal collision, and the case the pass must NOT flip.
const ADDISON_TX: ResolvedPlace = {
	id: 101_725_671,
	name: "Addison",
	placetype: "locality",
	country: "US",
	lat: 32.959,
	lon: -96.836,
	score: 8,
	prominence: 16_661,
	exactMatch: true,
}

const PC_10115_DE: ResolvedPlace = {
	id: 900_001,
	name: "10115",
	placetype: "postalcode",
	country: "DE",
	lat: 52.532,
	lon: 13.388,
	score: 9,
	exactMatch: true,
}

const PC_10115_US: ResolvedPlace = {
	id: 900_002,
	name: "10115",
	placetype: "postalcode",
	country: "US",
	lat: 40.811,
	lon: -73.963,
	score: 9,
	exactMatch: true,
}

const BERLIN_DE: ResolvedPlace = {
	id: 101_909_779,
	name: "Berlin",
	placetype: "locality",
	country: "DE",
	lat: 52.502,
	lon: 13.402,
	score: 9,
	prominence: 3_426_354,
	exactMatch: true,
}

const BERLIN_NH: ResolvedPlace = {
	id: 900_010,
	name: "Berlin",
	placetype: "locality",
	country: "US",
	lat: 44.468,
	lon: -71.185,
	score: 5,
	prominence: 9827,
	exactMatch: true,
}

// The domestic control: ZIP 62701 + Springfield IL, 3.3 km apart. The default country is coherent here.
const PC_62701_US: ResolvedPlace = {
	id: 900_020,
	name: "62701",
	placetype: "postalcode",
	country: "US",
	lat: 39.799,
	lon: -89.65,
	score: 9,
	exactMatch: true,
}

const SPRINGFIELD_IL: ResolvedPlace = {
	id: 85_940_429,
	name: "Springfield",
	placetype: "locality",
	country: "US",
	lat: 39.7817,
	lon: -89.6501,
	score: 9,
	prominence: 114_394,
	exactMatch: true,
}

// A GB postcode + locality, for the "shape names exactly one country" leg.
const PC_SW1A_GB: ResolvedPlace = {
	id: 900_030,
	name: "SW1A 1AA",
	placetype: "postalcode",
	country: "GB",
	lat: 51.501,
	lon: -0.1416,
	score: 9,
	exactMatch: true,
}

const LONDON_GB: ResolvedPlace = {
	id: 900_031,
	name: "London",
	placetype: "locality",
	country: "GB",
	lat: 51.5074,
	lon: -0.1278,
	score: 9,
	prominence: 8_799_800,
	exactMatch: true,
}

const LONDON_OH: ResolvedPlace = {
	id: 900_032,
	name: "London",
	placetype: "locality",
	country: "US",
	lat: 39.8865,
	lon: -83.4483,
	score: 5,
	prominence: 10_133,
	exactMatch: true,
}

//#endregion

/**
 * Models the two backend behaviours that cause the bug: `country` is a HARD filter (a US-scoped query never returns a
 * foreign row — `spr.country = ?`), and within the exact tier population is the primary key (#905), so Paris TX beats
 * Paris TN. Name match is exact + case-insensitive.
 */
function makeBackend(places: readonly ResolvedPlace[]): ResolverBackend & { calls: number } {
	const backend = {
		calls: 0,
		async findPlace(query: Parameters<ResolverBackend["findPlace"]>[0]) {
			backend.calls++
			const text = query.text.trim().toLowerCase()
			const types = Array.isArray(query.placetype) ? query.placetype : query.placetype ? [query.placetype] : null

			return places
				.filter((p) => p.name.toLowerCase() === text)
				.filter((p) => !types || types.includes(p.placetype))
				.filter((p) => !query.country || p.country === query.country)
				.toSorted((a, b) => (b.prominence ?? 0) - (a.prominence ?? 0) || b.score - a.score)
				.slice(0, query.limit ?? 5)
		},
	}

	return backend
}

const node = (over: Partial<AddressNode> & Pick<AddressNode, "tag" | "value">): AddressNode => ({
	start: 0,
	end: over.value.length,
	confidence: 0.95,
	children: [],
	...over,
})

/**
 * The shape the parser produces for "<street>, <postcode> <locality>": flat sibling roots.
 */
const addressTree = (postcode: string | null, locality: string | null, street = "Rue de Rivoli"): AddressTree => {
	const roots: AddressNode[] = [node({ tag: "street", value: street })]

	if (postcode) {
		roots.push(node({ tag: "postcode", value: postcode }))
	}

	if (locality) {
		roots.push(node({ tag: "locality", value: locality }))
	}

	return { raw: [street, postcode, locality].filter(Boolean).join(" "), roots }
}

function nodeByTag(tree: AddressTree, tag: string): AddressNode | undefined {
	const stack = [...tree.roots]

	while (stack.length) {
		const n = stack.pop()!

		if (n.tag === tag) return n

		stack.push(...n.children)
	}

	return undefined
}

const RIVOLI_POOL = [PC_75001_FR, PC_75001_US, PC_75001_DE, PARIS_FR, PARIS_TX, PARIS_TN, ADDISON_TX]

describe("findPostcodeCountryScope", () => {
	it("returns FR for (75001, Paris) under a US default — the case under investigation", async () => {
		const backend = makeBackend(RIVOLI_POOL)

		const scope = await findPostcodeCountryScope(addressTree("75001", "Paris").roots, backend, {
			postcode: "75001",
			defaultCountry: "US",
		})

		expect(scope?.country).toBe("FR")
		expect(scope?.localityPlace.id).toBe(PARIS_FR.id)
		expect(scope?.postcodePlace.id).toBe(PC_75001_FR.id)
		// Paris 1er's postcode point to the Paris locality point.
		expect(scope?.distanceKm).toBeLessThan(1)
	})

	it("returns null for (75001, Addison) — the literal collision, where the US default IS coherent", async () => {
		const backend = makeBackend(RIVOLI_POOL)

		const scope = await findPostcodeCountryScope(addressTree("75001", "Addison").roots, backend, {
			postcode: "75001",
			defaultCountry: "US",
		})

		expect(scope).toBeNull()
	})

	it("spends at most two lookups when the default country is coherent (the byte-stable path)", async () => {
		const backend = makeBackend([PC_62701_US, SPRINGFIELD_IL])

		const scope = await findPostcodeCountryScope(addressTree("62701", "Springfield").roots, backend, {
			postcode: "62701",
			defaultCountry: "US",
		})

		expect(scope).toBeNull()
		expect(backend.calls).toBe(2)
	})

	it("abstains when the postcode is wrong for the city in EVERY candidate country", async () => {
		const backend = makeBackend([...RIVOLI_POOL, SPRINGFIELD_IL])

		const scope = await findPostcodeCountryScope(addressTree("75001", "Springfield").roots, backend, {
			postcode: "75001",
			defaultCountry: "US",
		})

		expect(scope).toBeNull()
	})

	it("abstains when TWO candidate countries are both coherent (a genuine geographic tie)", async () => {
		// A synthetic tie: the same code resolves near a same-named locality in BOTH DE and FR.
		const twinFR: ResolvedPlace = { ...PC_75001_FR, name: "99999" }
		const twinDE: ResolvedPlace = { ...PC_75001_DE, name: "99999" }
		const cityFR: ResolvedPlace = { ...PARIS_FR, name: "Twinsville", id: 1 }

		const cityDE: ResolvedPlace = {
			...BERLIN_DE,
			name: "Twinsville",
			id: 2,
			lat: PC_75001_DE.lat,
			lon: PC_75001_DE.lon,
		}

		const backend = makeBackend([twinFR, twinDE, cityFR, cityDE])

		const scope = await findPostcodeCountryScope(addressTree("99999", "Twinsville").roots, backend, {
			postcode: "99999",
			defaultCountry: "US",
		})

		expect(scope).toBeNull()
	})

	it("respects the gate — a same-named locality outside gateKm is not evidence", async () => {
		const backend = makeBackend(RIVOLI_POOL)
		const roots = addressTree("75001", "Paris").roots

		expect(
			await findPostcodeCountryScope(roots, backend, { postcode: "75001", defaultCountry: "US", gateKm: 25 })
		).not.toBeNull()

		// Paris 1er's postcode point sits ~0.8 km from the locality point, so a sub-metre gate excludes it.
		const tight = await findPostcodeCountryScope(roots, backend, {
			postcode: "75001",
			defaultCountry: "US",
			gateKm: 0.0001,
		})

		expect(tight).toBeNull()
	})

	it("ignores non-exact locality matches (a generous FTS hit is not geographic evidence)", async () => {
		const fuzzy: ResolvedPlace = { ...PARIS_FR, exactMatch: false }
		const backend = makeBackend([PC_75001_FR, PC_75001_US, fuzzy, PARIS_TX])

		const scope = await findPostcodeCountryScope(addressTree("75001", "Paris").roots, backend, {
			postcode: "75001",
			defaultCountry: "US",
		})

		expect(scope).toBeNull()
	})

	it("abstains when the tree carries no locality (nothing to be coherent with)", async () => {
		const backend = makeBackend(RIVOLI_POOL)

		const scope = await findPostcodeCountryScope(addressTree("75001", null).roots, backend, {
			postcode: "75001",
			defaultCountry: "US",
		})

		expect(scope).toBeNull()
		expect(backend.calls).toBe(0)
	})

	it("abstains when the shape names no address system (a bare '27')", async () => {
		const backend = makeBackend(RIVOLI_POOL)

		const scope = await findPostcodeCountryScope(addressTree("27", "Paris").roots, backend, {
			postcode: "27",
			defaultCountry: "US",
		})

		expect(scope).toBeNull()
	})

	it("never proposes a country with no codex slice (the gazetteer's PL 75001 is unreachable)", async () => {
		const plPostcode: ResolvedPlace = {
			id: 8_000_048_250,
			name: "75001",
			placetype: "postalcode",
			country: "PL",
			lat: 54.1903,
			lon: 16.1879,
			score: 9,
			exactMatch: true,
		}

		const koszalin: ResolvedPlace = {
			id: 900_040,
			name: "Koszalin",
			placetype: "locality",
			country: "PL",
			lat: 54.194,
			lon: 16.172,
			score: 9,
			prominence: 106_000,
			exactMatch: true,
		}

		const backend = makeBackend([plPostcode, koszalin, PC_75001_US])

		const scope = await findPostcodeCountryScope(addressTree("75001", "Koszalin").roots, backend, {
			postcode: "75001",
			defaultCountry: "US",
		})

		// The pair IS coherent in PL, but `candidateSystemsForPostcode` has no `pl` slice, so PL is never a candidate.
		expect(scope).toBeNull()
	})

	it("recovers DE for (10115, Berlin) under a US default — generality beyond FR", async () => {
		const backend = makeBackend([PC_10115_DE, PC_10115_US, BERLIN_DE, BERLIN_NH])

		const scope = await findPostcodeCountryScope(addressTree("10115", "Berlin").roots, backend, {
			postcode: "10115",
			defaultCountry: "US",
		})

		expect(scope?.country).toBe("DE")
		expect(scope?.localityPlace.id).toBe(BERLIN_DE.id)
	})

	it("recovers GB for a letter-bearing shape the default country cannot place", async () => {
		const backend = makeBackend([PC_SW1A_GB, LONDON_GB, LONDON_OH])

		const scope = await findPostcodeCountryScope(addressTree("SW1A 1AA", "London").roots, backend, {
			postcode: "SW1A 1AA",
			defaultCountry: "US",
		})

		expect(scope?.country).toBe("GB")
		expect(scope?.localityPlace.id).toBe(LONDON_GB.id)
	})
})

describe("firstLocalityValue", () => {
	it("prefers a locality over a dependent_locality regardless of tree order", () => {
		const roots = [node({ tag: "dependent_locality", value: "Shoreditch" }), node({ tag: "locality", value: "London" })]

		expect(firstLocalityValue(roots)).toBe("London")
	})

	it("falls back to a dependent_locality when no locality exists", () => {
		expect(firstLocalityValue([node({ tag: "dependent_locality", value: "Shoreditch" })])).toBe("Shoreditch")
	})

	it("ignores blank values", () => {
		expect(firstLocalityValue([node({ tag: "locality", value: "   " })])).toBeUndefined()
	})
})

describe("resolveTree + postcode-country coherence", () => {
	it("resolves '12 Rue de Rivoli, 75001 Paris' to Paris TEXAS with the flag off (the reported bug)", async () => {
		const resolver = createWOFResolver(makeBackend(RIVOLI_POOL))
		const out = await resolver.resolveTree(addressTree("75001", "Paris"), { defaultCountry: "US" })
		const locality = nodeByTag(out, "locality")

		expect(locality?.metadata?.["resolver_country"]).toBe("US")
		// applyPostcodeConsistency (default-ON) then drags it onto ZIP 75001, Addison TX — the worse-than-wrong case.
		expect(locality?.lat).toBeCloseTo(PC_75001_US.lat, 3)
		expect(locality?.lon).toBeCloseTo(PC_75001_US.lon, 3)
		expect(locality?.metadata?.["postcode_city_mismatch"]).toBe(true)
		expect(locality?.metadata?.["postcode_country_scope"]).toBeUndefined()
	})

	it("resolves it to Paris, FRANCE with the flag on", async () => {
		const resolver = createWOFResolver(makeBackend(RIVOLI_POOL))

		const out = await resolver.resolveTree(addressTree("75001", "Paris"), {
			defaultCountry: "US",
			postcodeCountryCoherence: true,
		})

		const locality = nodeByTag(out, "locality")
		expect(locality?.metadata?.["resolver_country"]).toBe("FR")
		expect(locality?.lat).toBeCloseTo(PARIS_FR.lat, 3)
		expect(locality?.lon).toBeCloseTo(PARIS_FR.lon, 3)
		expect(locality?.metadata?.["postcode_city_mismatch"]).toBeUndefined()

		// The postcode node re-scopes too — this is what stops the Addison fallback.
		const postcode = nodeByTag(out, "postcode")
		expect(postcode?.metadata?.["resolver_country"]).toBe("FR")
		expect(postcode?.lat).toBeCloseTo(PC_75001_FR.lat, 3)
	})

	it("stamps the override receipt on the postcode and locality nodes", async () => {
		const resolver = createWOFResolver(makeBackend(RIVOLI_POOL))

		const out = await resolver.resolveTree(addressTree("75001", "Paris"), {
			defaultCountry: "US",
			postcodeCountryCoherence: true,
		})

		for (const tag of ["postcode", "locality"]) {
			expect(nodeByTag(out, tag)?.metadata?.["postcode_country_scope"]).toBe("FR")
			expect(typeof nodeByTag(out, tag)?.metadata?.["postcode_country_scope_km"]).toBe("number")
		}

		// The street node is not part of the evidence and carries no stamp.
		expect(nodeByTag(out, "street")?.metadata?.["postcode_country_scope"]).toBeUndefined()
	})

	it("leaves '75001 Addison' in the US — the coherent default is never overridden", async () => {
		const resolver = createWOFResolver(makeBackend(RIVOLI_POOL))

		const out = await resolver.resolveTree(addressTree("75001", "Addison"), {
			defaultCountry: "US",
			postcodeCountryCoherence: true,
		})

		const locality = nodeByTag(out, "locality")
		expect(locality?.metadata?.["resolver_country"]).toBe("US")
		expect(locality?.lat).toBeCloseTo(ADDISON_TX.lat, 3)
		expect(locality?.metadata?.["postcode_country_scope"]).toBeUndefined()
	})

	it("is byte-identical on the domestic control '62701 Springfield' (flag on vs off)", async () => {
		const pool = [PC_62701_US, SPRINGFIELD_IL]

		const off = await createWOFResolver(makeBackend(pool)).resolveTree(addressTree("62701", "Springfield"), {
			defaultCountry: "US",
		})

		const on = await createWOFResolver(makeBackend(pool)).resolveTree(addressTree("62701", "Springfield"), {
			defaultCountry: "US",
			postcodeCountryCoherence: true,
		})

		expect(JSON.stringify(on)).toBe(JSON.stringify(off))
	})

	it("does not fire without a default country (nothing was hard-filtered)", async () => {
		const backend = makeBackend(RIVOLI_POOL)

		const out = await createWOFResolver(backend).resolveTree(addressTree("75001", "Paris"), {
			postcodeCountryCoherence: true,
		})

		expect(nodeByTag(out, "locality")?.metadata?.["postcode_country_scope"]).toBeUndefined()
	})

	it("does not fire when the tree carries no postcode", async () => {
		const backend = makeBackend(RIVOLI_POOL)

		const out = await createWOFResolver(backend).resolveTree(addressTree(null, "Paris"), {
			defaultCountry: "US",
			postcodeCountryCoherence: true,
		})

		expect(nodeByTag(out, "locality")?.metadata?.["postcode_country_scope"]).toBeUndefined()
		expect(nodeByTag(out, "locality")?.metadata?.["resolver_country"]).toBe("US")
	})

	it("honours a custom gate radius", async () => {
		const resolver = createWOFResolver(makeBackend(RIVOLI_POOL))

		const out = await resolver.resolveTree(addressTree("75001", "Paris"), {
			defaultCountry: "US",
			postcodeCountryCoherence: true,
			postcodeCountryCoherenceGateKm: 0.0001,
		})

		expect(nodeByTag(out, "locality")?.metadata?.["postcode_country_scope"]).toBeUndefined()
	})

	it("degrades to no-override when the backend throws", async () => {
		const backend: ResolverBackend = {
			async findPlace(query) {
				if (query.placetype === "postalcode") throw new Error("backend down")

				return query.country === "US" ? [PARIS_TX] : []
			},
		}

		const out = await createWOFResolver(backend).resolveTree(addressTree("75001", "Paris"), {
			defaultCountry: "US",
			postcodeCountryCoherence: true,
		})

		expect(nodeByTag(out, "locality")?.metadata?.["postcode_country_scope"]).toBeUndefined()
		expect(nodeByTag(out, "locality")?.metadata?.["resolver_country"]).toBe("US")
	})
})
