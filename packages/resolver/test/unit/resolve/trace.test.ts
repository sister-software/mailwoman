/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The #1721 resolver-interior trace pins. Three properties matter, in this order:
 *
 *   1. NO SINK, NO EFFECT — the default walk does zero trace bookkeeping and resolves byte-identically. The trace is
 *      a debug opt-in, never a production cost.
 *   2. The per-stage rank vector attributes loss: a candidate first by the backend and displaced by the fame key
 *      carries `ranks.initial = 1` and `ranks.importance > 1` — "lost to the fame term" as a recorded fact.
 *   3. Every exit path emits — a lookup that resolves NOTHING still records `picked: null` with its `gates`, because an
 *      absent record is indistinguishable from a lookup that never ran.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolveNodeTrace, ResolverBackend } from "@mailwoman/core/resolver"
import { createWOFResolver } from "@mailwoman/resolver/resolve"
import { describe, expect, it } from "vitest"

function node(tag: string, value: string, start: number, end: number): AddressNode {
	return { tag: tag as AddressNode["tag"], value, start, end, confidence: 0.9, children: [] }
}

function tree(raw: string, roots: AddressNode[]): AddressTree {
	return { raw, roots }
}

class StubBackend implements Pick<ResolverBackend, "findPlace"> {
	readonly calls: Array<Parameters<ResolverBackend["findPlace"]>[0]> = []
	readonly #places: ResolvedPlace[]

	constructor(places: ResolvedPlace[]) {
		this.#places = places
	}

	async findPlace(query: Parameters<ResolverBackend["findPlace"]>[0]): Promise<ResolvedPlace[]> {
		this.calls.push(query)

		return this.#places
			.filter((p) => p.name.toLowerCase().includes(query.text.toLowerCase()))
			.filter((p) => !query.country || p.country === query.country)
			.slice(0, query.limit ?? 5)
	}
}

/**
 * Two same-name localities: the backend ranks the POPULOUS one first, the fame key must flip them — the Whitby class,
 * and the rank vector must say so.
 */
const WHITBY_PLACES: ResolvedPlace[] = [
	{
		id: 1,
		name: "Whitby",
		placetype: "locality",
		country: "CA",
		lat: 43.88,
		lon: -78.94,
		score: 8,
		population: 128_377,
		importance: 0.2,
		exactMatch: true,
	},
	{
		id: 2,
		name: "Whitby",
		placetype: "locality",
		country: "GB",
		lat: 54.49,
		lon: -0.62,
		score: 7,
		population: 13_130,
		importance: 0.8,
		exactMatch: true,
	},
]

describe("resolver-interior trace (#1721)", () => {
	it("emits nothing and resolves identically when no sink is set", async () => {
		const backendA = new StubBackend(WHITBY_PLACES)
		const backendB = new StubBackend(WHITBY_PLACES)
		const bare = (): AddressTree => tree("Whitby", [node("locality", "Whitby", 0, 6)])

		const plain = await createWOFResolver(backendA as ResolverBackend).resolveTree(bare(), {})
		const records: ResolveNodeTrace[] = []

		const traced = await createWOFResolver(backendB as ResolverBackend).resolveTree(bare(), {
			traceSink: (record) => records.push(record),
		})

		// Identical resolution either way — the sink observes, never participates.
		expect(JSON.stringify(plain)).toBe(JSON.stringify(traced))
		expect(records.length).toBeGreaterThan(0)
	})

	it("attributes a rank flip to the stage that caused it", async () => {
		const backend = new StubBackend(WHITBY_PLACES)
		const records: ResolveNodeTrace[] = []

		await createWOFResolver(backend as ResolverBackend).resolveTree(
			tree("Whitby", [node("locality", "Whitby", 0, 6)]),
			{ traceSink: (record) => records.push(record) }
		)

		const localityRecord = records.find((r) => r.placetype === "locality")

		expect(localityRecord).toBeDefined()

		const canada = localityRecord!.candidates.find((c) => c.country === "CA")
		const yorkshire = localityRecord!.candidates.find((c) => c.country === "GB")

		// The backend's own order put the populous namesake first; the fame key flipped them. The rank
		// vector records both facts, which is the whole point.
		expect(canada?.ranks["initial"]).toBe(1)
		expect(yorkshire?.ranks["initial"]).toBe(2)
		expect(yorkshire?.ranks["importance"]).toBe(1)
		expect(canada?.ranks["importance"]).toBe(2)
		expect(localityRecord!.picked).toMatchObject({ id: 2, source: "ranked" })
		expect(localityRecord!.query.limit).toBeGreaterThan(0)
	})

	it("records the span-rescore rescue — the famous-name class no longer answers off the record", async () => {
		// A STREET-tagged famous name never enters the walk (street is not in the placetype map), so the
		// span-rescore tier is the only thing that resolves it — and before the #1721 follow-up it answered
		// with an EMPTY trace beside a real coordinate.
		const backend = new StubBackend(WHITBY_PLACES)
		const records: ResolveNodeTrace[] = []

		// Confidence UNDER the rescore threshold (0.7) — a confident street read is deliberately avoided
		// by the span enumeration, and the famous-name class arrives exactly this unconfident.
		const streetNode = { ...node("street", "Whitby", 0, 6), confidence: 0.4 }

		const resolved = await createWOFResolver(backend as ResolverBackend).resolveTree(tree("Whitby", [streetNode]), {
			traceSink: (record) => records.push(record),
		})

		// The rescue produced a resolved locality node…
		const rescued = resolved.roots.find((n) => n.tag === "locality" && n.placeID)

		expect(rescued?.metadata?.["span_rescore"]).toBe(true)

		// …and a record for it: no resolved coordinate without a lookup record.
		const record = records.find((r) => r.gates.includes("span_rescore"))

		expect(record).toBeDefined()
		expect(record!.picked).toMatchObject({ source: "span_rescore" })
		expect(record!.candidates.length).toBeGreaterThan(0)
	})

	it("records picked: null with its gates when a lookup resolves nothing", async () => {
		const backend = new StubBackend([])
		const records: ResolveNodeTrace[] = []

		await createWOFResolver(backend as ResolverBackend).resolveTree(
			tree("Nowheresville", [node("locality", "Nowheresville", 0, 13)]),
			{ traceSink: (record) => records.push(record) }
		)

		const record = records.find((r) => r.placetype === "locality")

		expect(record).toBeDefined()
		expect(record!.picked).toBeNull()
		expect(record!.candidates).toEqual([])
		// The bare-toponym race ran (single value-bearing locality node) and still found nothing — the
		// check says the mechanism participated, which is what separates "raced and lost" from "never ran".
		expect(record!.gates).toContain("bare_race")
	})
})
