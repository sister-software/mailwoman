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

import { describe, expect, it } from "vitest"

import { probeForkEntity, type ForkEntityProbeOpts } from "./fork-entity.ts"
import type { POIExecutorLookup } from "./poi-executor.ts"

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
