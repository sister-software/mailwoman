import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { stringifyJSON } from "@mailwoman/core/json"
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

describe("Resolver-interior trace", () => {
	it("emits nothing and resolves identically when no sink is set", async () => {
		const backendA = new StubBackend(WHITBY_PLACES)
		const backendB = new StubBackend(WHITBY_PLACES)
		const bare = (): AddressTree => tree("Whitby", [node("locality", "Whitby", 0, 6)])

		const plain = await createWOFResolver(backendA as ResolverBackend).resolveTree(bare(), {})
		const records: ResolveNodeTrace[] = []

		const traced = await createWOFResolver(backendB as ResolverBackend).resolveTree(bare(), {
			traceSink: (record) => records.push(record),
		})

		expect(stringifyJSON(plain)).toBe(stringifyJSON(traced))
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

		expect(canada?.ranks["initial"]).toBe(1)
		expect(yorkshire?.ranks["initial"]).toBe(2)
		expect(yorkshire?.ranks["importance"]).toBe(1)
		expect(canada?.ranks["importance"]).toBe(2)
		expect(localityRecord!.picked).toMatchObject({ id: 2, source: "ranked" })
		expect(localityRecord!.query.limit).toBeGreaterThan(0)
	})

	it("records the span-rescore rescue — the famous-name class no longer answers off the record", async () => {
		const backend = new StubBackend(WHITBY_PLACES)
		const records: ResolveNodeTrace[] = []

		const streetNode = { ...node("street", "Whitby", 0, 6), confidence: 0.4 }

		const resolved = await createWOFResolver(backend as ResolverBackend).resolveTree(tree("Whitby", [streetNode]), {
			traceSink: (record) => records.push(record),
		})

		const rescued = resolved.roots.find((n) => n.tag === "locality" && n.placeID)

		expect(rescued?.metadata?.["span_rescore"]).toBe(true)

		const record = records.find((r) => r.checks.includes("span_rescore"))

		expect(record).toBeDefined()
		expect(record!.picked).toMatchObject({ source: "span_rescore" })
		expect(record!.candidates.length).toBeGreaterThan(0)
	})

	it("records picked: null with its checks when a lookup resolves nothing", async () => {
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

		expect(record!.checks).toContain("bare_race")
	})
})
