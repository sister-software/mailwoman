/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fork→entity probe's gates (`fork-entity.ts`), each against a stub lookup. The SAVILE ROW
 *   HIJACK GUARD is the load-bearing one: poi.db really does hold exactly one poi named
 *   `savile row`, and without gate 2 the famous London street would resolve to it — the board row
 *   `gb-fork-entity-savile-row-guard` tracks the live behavior; THIS test is the blocking half.
 */

import {
	probeForkEntity,
	probeVenueNearAnchor,
	probeVenueNearAnchorFolded,
	type ForkEntityProbeOpts,
} from "mailwoman/fork-entity"
import type { POIExecutorLookup } from "mailwoman/poi-executor"
import { describe, expect, it } from "vitest"

/**
 * A stub over fixed rows: FTS-ish name matching (case-folded substring), same hit shape as POILookup.
 */
function stubLookup(
	rows: Array<{ name: string; categoryID?: string; lat: number; lon: number; country?: string; confidence?: number }>
): POIExecutorLookup {
	return {
		search: (query) => {
			const needle = (query.name ?? "").toLowerCase()

			return rows
				.filter((r) => r.name.toLowerCase().includes(needle.split(" ")[0] ?? needle))
				.slice(0, query.limit ?? 10)
				.map((r) => ({
					name: r.name,
					categoryID: r.categoryID ?? null,
					brandWikidata: null,
					latitude: r.lat,
					longitude: r.lon,
					country: r.country ?? "FR",
					confidence: r.confidence ?? 0.9,
					gersID: null,
				}))
		},
	}
}

const NO_GENERICS: ForkEntityProbeOpts["isStreetGeneric"] = () => false

/**
 * The morphology stub the hijack guard uses — the real FST answers exactly this for these tokens.
 */
const REAL_GENERICS: ForkEntityProbeOpts["isStreetGeneric"] = (token) =>
	["row", "straße", "via", "vía", "rue", "street", "parade"].includes(token)

describe("probeForkEntity", () => {
	it("resolves the worldwide-unique exact-name entity (the COMER case)", () => {
		const lookup = stubLookup([
			{ name: "COMER parís.méxico", categoryID: "mexican_restaurant", lat: 48.87735, lon: 2.3516, confidence: 0.9888 },
			{ name: "Comer Park", categoryID: "park", lat: 33.9, lon: -83.1, country: "US" },
		])

		const hit = probeForkEntity("COMER parís.méxico", { lookup, isStreetGeneric: NO_GENERICS })

		expect(hit).not.toBeNull()
		expect(hit!.categoryID).toBe("mexican_restaurant")
		expect(hit!.latitude).toBeCloseTo(48.87735, 4)
	})

	it("THE HIJACK GUARD: a street-generic token stands the probe down even with a unique entity", () => {
		// poi.db's real state: exactly one poi named 'savile row'. Without gate 2 this would resolve.
		const lookup = stubLookup([{ name: "Savile Row", categoryID: "clothing_store", lat: 51, lon: -2, country: "GB" }])

		expect(probeForkEntity("Savile Row", { lookup, isStreetGeneric: REAL_GENERICS })).toBeNull()
	})

	it("abstains when no entity bears the exact name (FTS partials are not the entity)", () => {
		const lookup = stubLookup([{ name: "Comer Park", categoryID: "park", lat: 33.9, lon: -83.1, country: "US" }])

		expect(probeForkEntity("COMER parís.méxico", { lookup, isStreetGeneric: NO_GENERICS })).toBeNull()
	})

	it("abstains when two distinct entities share the name (no anchor to break the tie)", () => {
		const lookup = stubLookup([
			{ name: "La Terraza", lat: 48.87, lon: 2.35 },
			{ name: "La Terraza", lat: 40.42, lon: -3.7, country: "ES" },
		])

		expect(probeForkEntity("La Terraza", { lookup, isStreetGeneric: NO_GENERICS })).toBeNull()
	})

	it("collapses duplicate rows of ONE physical venue and keeps the more confident row", () => {
		// Two ingest rows ~60 m apart — one venue, not two entities.
		const lookup = stubLookup([
			{ name: "La Terraza", lat: 48.8773, lon: 2.3516, confidence: 0.7 },
			{ name: "La Terraza", lat: 48.8778, lon: 2.3519, confidence: 0.95 },
		])

		const hit = probeForkEntity("La Terraza", { lookup, isStreetGeneric: NO_GENERICS })

		expect(hit).not.toBeNull()
		expect(hit!.confidence).toBe(0.95)
	})
})

describe("probeVenueNearAnchor (#1684's venue tier)", () => {
	const LONDON = { lat: 51.5074, lon: -0.1278 }

	it("answers the single exact-name entity near the anchor — local uniqueness, not worldwide", () => {
		const lookup = stubLookup([
			// The local bearer plus a same-named entity in another city: the fork probe would abstain
			// on this pair; the anchored probe must not, because the anchor separates them.
			{ name: "Nine Elms Tavern", categoryID: "pub", lat: 51.48223, lon: -0.13718, country: "GB" },
			{ name: "Nine Elms Tavern", categoryID: "pub", lat: 40.7, lon: -74, country: "US" },
		])

		const hit = probeVenueNearAnchor("Nine Elms Tavern", LONDON, { lookup })

		expect(hit?.latitude).toBeCloseTo(51.48223)
		expect(hit?.country).toBe("GB")
	})

	it("abstains when TWO same-named entities sit inside the gate — a metro-local ambiguity", () => {
		const lookup = stubLookup([
			{ name: "The Red Lion", lat: 51.51, lon: -0.12, country: "GB" },
			{ name: "The Red Lion", lat: 51.52, lon: -0.2, country: "GB" },
		])

		expect(probeVenueNearAnchor("The Red Lion", LONDON, { lookup })).toBeNull()
	})

	it("abstains when the only exact bearer is beyond the gate — another city's venue never contests", () => {
		const lookup = stubLookup([{ name: "Nine Elms Tavern", lat: 40.7, lon: -74, country: "US" }])

		expect(probeVenueNearAnchor("Nine Elms Tavern", LONDON, { lookup })).toBeNull()
	})

	it("requires exact name-key equality — an FTS partial is not the venue", () => {
		const lookup = stubLookup([{ name: "Nine Elms Tavern and Grill", lat: 51.48, lon: -0.13, country: "GB" }])

		expect(probeVenueNearAnchor("Nine Elms Tavern", LONDON, { lookup })).toBeNull()
	})

	it("collapses duplicate rows of one physical venue before judging uniqueness", () => {
		const lookup = stubLookup([
			{ name: "Africa House", lat: 51.51691, lon: -0.11956, confidence: 0.95, country: "GB" },
			{ name: "Africa House", lat: 51.51692, lon: -0.11957, confidence: 0.9, country: "GB" },
		])

		const hit = probeVenueNearAnchor("Africa House", LONDON, { lookup })

		expect(hit?.confidence).toBe(0.95)
	})
})

describe("probeVenueNearAnchorFolded (the qualifier-folding second leg)", () => {
	const LONDON = { lat: 51.5074, lon: -0.1278 }
	const ROCHESTER = { lat: 51.36, lon: 0.44 }

	it("matches the query's decorated form against the row's differently-decorated one — the Mischicks class", () => {
		const lookup = stubLookup([
			{ name: "Mischicks Day Spa - St Andrews Lakes", lat: 51.35984, lon: 0.43781, country: "GB" },
		])

		const hit = probeVenueNearAnchorFolded("Mischicks Day Spa - St Andrews Lakes - Rochester, Kent", ROCHESTER, {
			lookup,
		})

		expect(hit?.latitude).toBeCloseTo(51.35984)
	})

	it("never second-guesses an exact hit — the exact leg runs first", () => {
		const lookup = stubLookup([
			{ name: "Nine Elms Tavern", lat: 51.48223, lon: -0.13718, country: "GB", confidence: 0.99 },
			// A folded-comparable decoy the second leg would also accept.
			{ name: "Nine Elms Tavern - Riverside", lat: 51.49, lon: -0.14, country: "GB", confidence: 0.5 },
		])

		const hit = probeVenueNearAnchorFolded("Nine Elms Tavern", LONDON, { lookup })

		expect(hit?.confidence).toBe(0.99)
	})

	it("abstains when the folded head matches TWO local entities — the chain-branch class", () => {
		// The query's decoration exists on NO row (the exact leg abstains), and the folded head matches
		// both metro branches — a genuine ambiguity. A query naming an existing branch verbatim is the
		// exact leg's win, not this leg's problem.
		const lookup = stubLookup([
			{ name: "The North Face - Covent Garden", lat: 51.512, lon: -0.123, country: "GB" },
			{ name: "The North Face - Oxford Street", lat: 51.515, lon: -0.141, country: "GB" },
		])

		expect(probeVenueNearAnchorFolded("The North Face - Long Acre", LONDON, { lookup })).toBeNull()
	})

	it("refuses a one-token head — a bare article matches everything and means nothing", () => {
		const lookup = stubLookup([{ name: "The - Bar", lat: 51.51, lon: -0.12, country: "GB" }])

		expect(probeVenueNearAnchorFolded("The - Unrelated Qualifier", LONDON, { lookup })).toBeNull()
	})

	it("handles long decorations without regex backtracking", () => {
		const lookup = stubLookup([])
		const decoration = "x".repeat(100_000)

		expect(probeVenueNearAnchorFolded(`Mischicks Day Spa - ${decoration}`, LONDON, { lookup })).toBeNull()
	})
})
