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
 *      whenever the flag is explicitly `false`.
 *
 *   The flag is DEFAULT-ON as of the 2026-08-05 promotion, so every "off" leg below sets `false`
 *   explicitly. Omitting the option no longer means off, and a leg that relied on omission would
 *   quietly stop testing what its name says.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import {
	findPostcodeCountryScope,
	firstLocalityValue,
	localityValuesInDocumentOrder,
	POSTCODE_COUNTRY_COHERENCE_GATE_KM,
} from "@mailwoman/resolver/postcode-country-coherence"
import { createWOFResolver } from "@mailwoman/resolver/resolve"
import { describe, expect, it } from "vitest"

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

//#region Fixtures — the 2026-08-09 eu-mixed panel block (#24)

// `Valy 117, 37901 Třeboň` — the pair case the codex shape list could not reach (no `cz` slice).
const PC_37901_CZ: ResolvedPlace = {
	id: 900_100,
	name: "37901",
	placetype: "postalcode",
	country: "CZ",
	lat: 49.0038,
	lon: 14.7714,
	score: 9,
	exactMatch: true,
}

const PC_37901_US: ResolvedPlace = {
	id: 900_101,
	name: "37901",
	placetype: "postalcode",
	country: "US",
	lat: 35.9606,
	lon: -83.9207,
	score: 9,
	exactMatch: true,
}

const TREBON_CZ: ResolvedPlace = {
	id: 900_102,
	name: "Třeboň",
	placetype: "locality",
	country: "CZ",
	lat: 49.0033,
	lon: 14.7702,
	score: 9,
	prominence: 8400,
	exactMatch: true,
}

// `Biskupcova 1843/3, 13000 Praha 3` — the POSTCODE-ONLY case. `13000` is held in exactly one country
// and `Praha 3` (a municipal district) is not a gazetteer name anywhere, so the pair test can never fire.
const PC_13000_CZ: ResolvedPlace = {
	id: 900_110,
	name: "13000",
	placetype: "postalcode",
	country: "CZ",
	lat: 50.08662,
	lon: 14.47988,
	score: 9,
	exactMatch: true,
}

// `Bahnhofplatz 1, 6060 Sarnen` — the LOCALITY-ONLY case. The gazetteer holds no CH postcodes at all, so
// `6060` resolves in NL/AT and never in CH; `Sarnen` exists in exactly one country.
const PC_6060_NL: ResolvedPlace = {
	id: 900_120,
	name: "6060",
	placetype: "postalcode",
	country: "NL",
	lat: 51.2712,
	lon: 5.8306,
	score: 9,
	exactMatch: true,
}

const PC_6060_AT: ResolvedPlace = {
	id: 900_121,
	name: "6060",
	placetype: "postalcode",
	country: "AT",
	lat: 47.2833,
	lon: 11.5,
	score: 9,
	exactMatch: true,
}

const SARNEN_CH: ResolvedPlace = {
	id: 900_122,
	name: "Sarnen",
	placetype: "locality",
	country: "CH",
	lat: 46.8959,
	lon: 8.2456,
	score: 9,
	prominence: 10_200,
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
		expect(scope?.localityPlace?.id).toBe(PARIS_FR.id)
		expect(scope?.postcodePlace?.id).toBe(PC_75001_FR.id)
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

	// Until #24 this asserted the opposite — that PL was UNREACHABLE, because the candidate set came from
	// `candidateSystemsForPostcode` and there is no `pl` codex slice. That was a corollary of the source,
	// never a safety property: the pair is coherent in exactly one country and the pass exists to say so.
	// The gazetteer's own postcode membership is now the candidate source, so the 8 codex slices stop
	// bounding the mechanism. (The abstention rules are unchanged and tested below.)
	it("proposes a country with no codex slice when the GAZETTEER holds the postcode there", async () => {
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

		expect(scope?.country).toBe("PL")
		expect(scope?.evidence).toBe("pair")
	})

	// The CZ block of the 2026-08-09 panel: `Valy 117, 37901 Třeboň` under the en-US locale. `37901` shapes
	// as [US, DE, FR] and the gazetteer holds it in US and CZ; only CZ has a Třeboň next to it.
	it("recovers CZ for a 5-digit code the shape list calls US/DE/FR", async () => {
		const backend = makeBackend([PC_37901_CZ, PC_37901_US, TREBON_CZ])

		const scope = await findPostcodeCountryScope(addressTree("37901", "Třeboň").roots, backend, {
			postcode: "37901",
			defaultCountry: "US",
		})

		expect(scope?.country).toBe("CZ")
		expect(scope?.evidence).toBe("pair")
	})

	it("recovers DE for (10115, Berlin) under a US default — generality beyond FR", async () => {
		const backend = makeBackend([PC_10115_DE, PC_10115_US, BERLIN_DE, BERLIN_NH])

		const scope = await findPostcodeCountryScope(addressTree("10115", "Berlin").roots, backend, {
			postcode: "10115",
			defaultCountry: "US",
		})

		expect(scope?.country).toBe("DE")
		expect(scope?.localityPlace?.id).toBe(BERLIN_DE.id)
	})

	it("recovers GB for a letter-bearing shape the default country cannot place", async () => {
		const backend = makeBackend([PC_SW1A_GB, LONDON_GB, LONDON_OH])

		const scope = await findPostcodeCountryScope(addressTree("SW1A 1AA", "London").roots, backend, {
			postcode: "SW1A 1AA",
			defaultCountry: "US",
		})

		expect(scope?.country).toBe("GB")
		expect(scope?.localityPlace?.id).toBe(LONDON_GB.id)
	})
})

/**
 * The single-sided rungs (#24). The pair test can only speak when BOTH halves are in the gazetteer, and on the
 * 2026-08-09 eu-mixed panel that condition failed 10 times for two opposite reasons — a municipal district the
 * gazetteer does not name (`Praha 3`), and a country whose postcodes the gazetteer does not carry at all (CH, BE). Each
 * rung fires only when the DEFAULT country corroborates NEITHER half, and only when its own half names exactly one
 * country.
 */
describe("findPostcodeCountryScope — single-sided rungs (#24)", () => {
	it("scopes on the LOCALITY alone when it names exactly one country (Sarnen → CH)", async () => {
		const backend = makeBackend([PC_6060_NL, PC_6060_AT, SARNEN_CH])

		const scope = await findPostcodeCountryScope(addressTree("6060", "Sarnen").roots, backend, {
			postcode: "6060",
			defaultCountry: "US",
		})

		expect(scope?.country).toBe("CH")
		expect(scope?.evidence).toBe("locality")
		expect(scope?.localityPlace?.id).toBe(SARNEN_CH.id)
		expect(scope?.postcodePlace).toBeUndefined()
		expect(scope?.distanceKm).toBeUndefined()
	})

	it("scopes on the POSTCODE alone when the locality is in no gazetteer (13000 / Praha 3 → CZ)", async () => {
		const backend = makeBackend([PC_13000_CZ])

		const scope = await findPostcodeCountryScope(addressTree("13000", "Praha 3").roots, backend, {
			postcode: "13000",
			defaultCountry: "US",
		})

		expect(scope?.country).toBe("CZ")
		expect(scope?.evidence).toBe("postcode")
		expect(scope?.postcodePlace?.id).toBe(PC_13000_CZ.id)
	})

	it("abstains when the locality names more than one country (Charleroi BE/US)", async () => {
		const charleroiBE: ResolvedPlace = {
			id: 900_130,
			name: "Charleroi",
			placetype: "locality",
			country: "BE",
			lat: 50.4108,
			lon: 4.4446,
			score: 9,
			prominence: 201_816,
			exactMatch: true,
		}

		const charleroiUS: ResolvedPlace = {
			id: 900_131,
			name: "Charleroi",
			placetype: "locality",
			country: "US",
			lat: 40.1387,
			lon: -79.8992,
			score: 5,
			prominence: 4120,
			exactMatch: true,
		}

		const backend = makeBackend([charleroiBE, charleroiUS])

		const scope = await findPostcodeCountryScope(addressTree("6000", "Charleroi").roots, backend, {
			postcode: "6000",
			defaultCountry: "US",
		})

		expect(scope).toBeNull()
	})

	it("abstains when the DEFAULT country holds the locality (a domestic address whose ZIP is missing)", async () => {
		// `123 Main St, Vienna, VA 22180` with `22180` absent from the gazetteer. `Vienna` exists in the
		// default country, so the address is domestic-plausible and no foreign scope may be proposed —
		// even though AT's Wien/Vienna is the only OTHER bearer.
		const viennaUS: ResolvedPlace = {
			id: 900_140,
			name: "Vienna",
			placetype: "locality",
			country: "US",
			lat: 38.9012,
			lon: -77.2653,
			score: 6,
			prominence: 16_473,
			exactMatch: true,
		}

		const viennaAT: ResolvedPlace = {
			id: 900_141,
			name: "Vienna",
			placetype: "locality",
			country: "AT",
			lat: 48.2083,
			lon: 16.3725,
			score: 9,
			prominence: 1_897_491,
			exactMatch: true,
		}

		const backend = makeBackend([viennaUS, viennaAT])

		const scope = await findPostcodeCountryScope(addressTree("22180", "Vienna").roots, backend, {
			postcode: "22180",
			defaultCountry: "US",
		})

		expect(scope).toBeNull()
	})

	it("abstains when the DEFAULT country holds the postcode (a domestic address whose city is unlisted)", async () => {
		const zipUS: ResolvedPlace = {
			id: 900_150,
			name: "62701",
			placetype: "postalcode",
			country: "US",
			lat: 39.799,
			lon: -89.65,
			score: 9,
			exactMatch: true,
		}

		const backend = makeBackend([zipUS, SARNEN_CH])

		const scope = await findPostcodeCountryScope(addressTree("62701", "Sarnen").roots, backend, {
			postcode: "62701",
			defaultCountry: "US",
		})

		expect(scope).toBeNull()
	})

	it("never scopes to a country whose own postcode row CONTRADICTS the locality", async () => {
		// The locality is unique to CH, but this gazetteer also holds `6060` in CH, 900 km away — the two
		// halves disagree inside the same country, which is the one thing the pair test exists to catch.
		const pc6060CH: ResolvedPlace = {
			id: 900_160,
			name: "6060",
			placetype: "postalcode",
			country: "CH",
			lat: 40,
			lon: 2,
			score: 9,
			exactMatch: true,
		}

		const backend = makeBackend([pc6060CH, SARNEN_CH])

		const scope = await findPostcodeCountryScope(addressTree("6060", "Sarnen").roots, backend, {
			postcode: "6060",
			defaultCountry: "US",
		})

		expect(scope).toBeNull()
	})

	it("prefers the PAIR rung over either single-sided one", async () => {
		const backend = makeBackend([PC_37901_CZ, PC_37901_US, TREBON_CZ])

		const scope = await findPostcodeCountryScope(addressTree("37901", "Třeboň").roots, backend, {
			postcode: "37901",
			defaultCountry: "US",
		})

		expect(scope?.evidence).toBe("pair")
		expect(scope?.distanceKm).toBeLessThan(1)
	})
})

describe("findPostcodeCountryScope — multi-value locality fallthrough", () => {
	// `Calle Mayor 12, Aravaca, 28023 Madrid`: the model tags BOTH `Aravaca` and `Madrid` as localities.
	// `Aravaca` is a neighbourhood the locality band cannot see; `Madrid` carries the ES pair. Coordinates
	// are the live candidate rows: the ES 28023 row is Aravaca's own CP, 9.6 km from the Madrid locality.
	const PC_28023_ES: ResolvedPlace = {
		id: 900_200,
		name: "28023",
		placetype: "postalcode",
		country: "ES",
		lat: 40.46005,
		lon: -3.786808,
		score: 9,
		exactMatch: true,
	}

	// ZIP 28023, China Grove NC — the centroid the first-value-only pass answered with.
	const PC_28023_US: ResolvedPlace = {
		id: 900_201,
		name: "28023",
		placetype: "postalcode",
		country: "US",
		lat: 35.56952,
		lon: -80.60223,
		score: 9,
		exactMatch: true,
	}

	const MADRID_ES: ResolvedPlace = {
		id: 900_202,
		name: "Madrid",
		placetype: "locality",
		country: "ES",
		lat: 40.43489,
		lon: -3.678245,
		score: 9,
		prominence: 3_255_944,
		exactMatch: true,
	}

	// Madrid, Iowa — 1,600+ km from ZIP 28023, so the US default is NOT coherent on the second value either.
	const MADRID_IA: ResolvedPlace = {
		id: 900_203,
		name: "Madrid",
		placetype: "locality",
		country: "US",
		lat: 41.874538,
		lon: -93.819866,
		score: 5,
		prominence: 2799,
		exactMatch: true,
	}

	const aravacaTree = (): AddressTree => ({
		raw: "Calle Mayor 12, Aravaca, 28023 Madrid",
		roots: [
			node({ tag: "street", value: "Calle Mayor" }),
			node({ tag: "locality", value: "Aravaca" }),
			node({ tag: "postcode", value: "28023" }),
			node({ tag: "locality", value: "Madrid" }),
		],
	})

	it("falls through to the SECOND locality value when the first is invisible to the band (Aravaca → Madrid → ES)", async () => {
		const backend = makeBackend([PC_28023_ES, PC_28023_US, MADRID_ES, MADRID_IA])

		const scope = await findPostcodeCountryScope(aravacaTree().roots, backend, {
			postcode: "28023",
			defaultCountry: "US",
		})

		expect(scope?.country).toBe("ES")
		expect(scope?.evidence).toBe("pair")
		expect(scope?.locality).toBe("Madrid")
		expect(scope?.postcodePlace?.id).toBe(PC_28023_ES.id)
		expect(scope?.distanceKm).toBeLessThan(POSTCODE_COUNTRY_COHERENCE_GATE_KM)
	})

	it("a DOMESTIC value neutralizes itself, not its siblings — Green Point/Cape Town → ZA (rung 4a)", async () => {
		// `14 Long St, Green Point, Cape Town, 8001` under the inferred US default. "Green Point" has pop-0
		// US namesakes (domestic corroboration for that VALUE only); "Cape Town" names exactly one country
		// in the whole gazetteer. Any-value-kills abstained the pass and the hard US filter answered Green
		// Point, Pennsylvania — 12,748 km off. The live 8001 rows are NO/AU/SI: no US row, no ZA row.
		const greenPointPA: ResolvedPlace = {
			id: 900_220,
			name: "Green Point",
			placetype: "locality",
			country: "US",
			lat: 40.48092,
			lon: -76.55163,
			score: 5,
			exactMatch: true,
		}

		const greenPointAU: ResolvedPlace = {
			id: 900_221,
			name: "Green Point",
			placetype: "locality",
			country: "AU",
			lat: -32.2492053,
			lon: 152.5175294,
			score: 5,
			prominence: 522,
			exactMatch: true,
		}

		const capeTownZA: ResolvedPlace = {
			id: 900_222,
			name: "Cape Town",
			placetype: "locality",
			country: "ZA",
			lat: -33.9288301,
			lon: 18.4172197,
			score: 9,
			prominence: 3_740_026,
			exactMatch: true,
		}

		const pc8001AU: ResolvedPlace = {
			id: 900_223,
			name: "8001",
			placetype: "postalcode",
			country: "AU",
			lat: -37.814,
			lon: 144.9633,
			score: 9,
			exactMatch: true,
		}

		const backend = makeBackend([greenPointPA, greenPointAU, capeTownZA, pc8001AU])

		const tree: AddressTree = {
			raw: "14 Long St, Green Point, Cape Town, 8001",
			roots: [
				node({ tag: "street", value: "Long St" }),
				node({ tag: "locality", value: "Green Point" }),
				node({ tag: "locality", value: "Cape Town" }),
				node({ tag: "postcode", value: "8001" }),
			],
		}

		const scope = await findPostcodeCountryScope(tree.roots, backend, {
			postcode: "8001",
			defaultCountry: "US",
		})

		expect(scope?.country).toBe("ZA")
		expect(scope?.evidence).toBe("locality")
		expect(scope?.locality).toBe("Cape Town")
	})

	it("a TIE on a later value is a hard abstention, never a fall-through to the single-sided rungs", async () => {
		// First value `Zzv` names exactly one country in the locality band, so a buggy fall-through past the
		// tie would let rung 4a scope to NO. Second value `Mirakol` is pair-coherent in BOTH HR and RS.
		const zzvNO: ResolvedPlace = {
			id: 900_210,
			name: "Zzv",
			placetype: "locality",
			country: "NO",
			lat: 60.39,
			lon: 5.32,
			score: 9,
			prominence: 1000,
			exactMatch: true,
		}

		const pc20000HR: ResolvedPlace = {
			id: 900_211,
			name: "20000",
			placetype: "postalcode",
			country: "HR",
			lat: 42.65,
			lon: 18.09,
			score: 9,
			exactMatch: true,
		}

		const pc20000RS: ResolvedPlace = {
			id: 900_212,
			name: "20000",
			placetype: "postalcode",
			country: "RS",
			lat: 44.01,
			lon: 20.91,
			score: 9,
			exactMatch: true,
		}

		const mirakolHR: ResolvedPlace = {
			id: 900_213,
			name: "Mirakol",
			placetype: "locality",
			country: "HR",
			lat: 42.66,
			lon: 18.1,
			score: 9,
			prominence: 5000,
			exactMatch: true,
		}

		const mirakolRS: ResolvedPlace = {
			id: 900_214,
			name: "Mirakol",
			placetype: "locality",
			country: "RS",
			lat: 44,
			lon: 20.9,
			score: 9,
			prominence: 4000,
			exactMatch: true,
		}

		const backend = makeBackend([zzvNO, pc20000HR, pc20000RS, mirakolHR, mirakolRS])

		const tree: AddressTree = {
			raw: "Zzv, 20000 Mirakol",
			roots: [
				node({ tag: "locality", value: "Zzv" }),
				node({ tag: "postcode", value: "20000" }),
				node({ tag: "locality", value: "Mirakol" }),
			],
		}

		const scope = await findPostcodeCountryScope(tree.roots, backend, {
			postcode: "20000",
			defaultCountry: "US",
		})

		expect(scope).toBeNull()
	})
})

describe("localityValuesInDocumentOrder", () => {
	it("collects every locality in document order, then dependent localities", () => {
		const roots = [
			node({ tag: "locality", value: "Aravaca" }),
			node({ tag: "dependent_locality", value: "Shoreditch" }),
			node({ tag: "locality", value: "Madrid" }),
		]

		expect(localityValuesInDocumentOrder(roots)).toEqual(["Aravaca", "Madrid", "Shoreditch"])
	})

	it("deduplicates case-insensitively", () => {
		const roots = [node({ tag: "locality", value: "Madrid" }), node({ tag: "locality", value: "MADRID" })]

		expect(localityValuesInDocumentOrder(roots)).toEqual(["Madrid"])
	})

	it("caps the value list", () => {
		const roots = ["A", "B", "C", "D"].map((value) => node({ tag: "locality", value }))

		expect(localityValuesInDocumentOrder(roots)).toEqual(["A", "B", "C"])
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
	it("resolves '12 Rue de Rivoli, 75001 Paris' to Paris TEXAS with the flag OFF (the reported bug)", async () => {
		const resolver = createWOFResolver(makeBackend(RIVOLI_POOL))

		// The explicit `false` is the whole point of this row now: since the 2026-08-05 promotion an UNSET flag
		// means ON, so an options object that just omits it no longer reproduces the bug.
		const out = await resolver.resolveTree(addressTree("75001", "Paris"), {
			defaultCountry: "US",
			postcodeCountryCoherence: false,
		})

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

	it("runs by default when the flag is UNSET (operator-promoted to default-ON 2026-08-05)", async () => {
		const resolver = createWOFResolver(makeBackend(RIVOLI_POOL))
		const out = await resolver.resolveTree(addressTree("75001", "Paris"), { defaultCountry: "US" })
		const locality = nodeByTag(out, "locality")

		expect(locality?.metadata?.["postcode_country_scope"]).toBe("FR")
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
			postcodeCountryCoherence: false,
		})

		const on = await createWOFResolver(makeBackend(pool)).resolveTree(addressTree("62701", "Springfield"), {
			defaultCountry: "US",
			postcodeCountryCoherence: true,
		})

		expect(JSON.stringify(on)).toBe(JSON.stringify(off))
	})

	it("fires WITHOUT a default country when exactly one country makes the pair coherent (the browser-cascade arm)", async () => {
		// The 2026-08-11 contract flip (the staged-repoint e2e): with no default in force there is
		// nothing to override, but the pair rung still CONSTRAINS — (75001, Paris) is coherent in FR
		// alone (Paris TX sits ~150 km from the Addison ZIP), so the walk scopes to FR instead of
		// resolving population-first. Only the pair rung runs on this arm; the single-sided rungs
		// keep needing the default as their domestic-plausibility guard.
		const backend = makeBackend(RIVOLI_POOL)

		const out = await createWOFResolver(backend).resolveTree(addressTree("75001", "Paris"), {
			postcodeCountryCoherence: true,
		})

		expect(nodeByTag(out, "locality")?.metadata?.["postcode_country_scope"]).toBe("FR")
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
