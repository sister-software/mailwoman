/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { createWOFResolver } from "@mailwoman/resolver/resolve"
import { describe, expect, test } from "vitest"

const VENEZUELA = 8_040_579_053_981
const ZULIA_LOCALITY_CO = 8_084_693_553_936

const PLACES: ResolvedPlace[] = [
	{ id: VENEZUELA, name: "Venezuela", placetype: "country", country: "VE", lat: 8, lon: -66, score: 7.4 },
	{ id: 8_040_579_053_000, name: "Colombia", placetype: "country", country: "CO", lat: 4.6, lon: -74.1, score: 7.3 },
	{ id: 8_596_679_816_180, name: "Zulia", placetype: "region", country: "VE", lat: 10.4, lon: -71.9, score: 6.5 },
	{ id: ZULIA_LOCALITY_CO, name: "Zulia", placetype: "locality", country: "CO", lat: 7.9, lon: -72.6, score: 3.1 },
	{
		id: 8_933_755_722_164,
		name: "Maracaibo",
		placetype: "locality",
		country: "VE",
		lat: 10.65,
		lon: -71.64,
		score: 6.3,
	},
]

class RecordingBackend implements ResolverBackend {
	readonly calls: Array<Parameters<ResolverBackend["findPlace"]>[0]> = []

	async findPlace(query: Parameters<ResolverBackend["findPlace"]>[0]): Promise<ResolvedPlace[]> {
		this.calls.push(query)

		const text = query.text.toLowerCase()
		const requested = Array.isArray(query.placetype) ? query.placetype : query.placetype ? [query.placetype] : null

		return PLACES.filter((place) => place.name.toLowerCase() === text)
			.filter((place) => !requested || requested.includes(place.placetype))
			.filter((place) => !query.country || place.country === query.country)
			.map((place) => ({ ...place, exactMatch: true }))
	}
}

const node = (
	tag: AddressNode["tag"],
	value: string,
	start: number,
	end: number,
	children: AddressNode[] = []
): AddressNode => ({ tag, value, start, end, confidence: 0.9, children })

const MALFORMED_PARSE: AddressTree = {
	raw: "Maracaibo 4001, Zulia, Venezuela",
	roots: [
		node("country", "Venezuela", 23, 32, [
			node("locality", "Zulia", 16, 21),
			node("locality", "Maracaibo", 0, 9, [node("postcode", "4001", 10, 14)]),
		]),
	],
}

describe("#2248 — an inferred country must never overrule one the input named", () => {
	test("the country named in the input resolves, against a claim satisfiable only elsewhere", async () => {
		const backend = new RecordingBackend()
		const result = await createWOFResolver(backend).resolveTree(MALFORMED_PARSE)

		expect(result.roots[0]?.placeID).toBe(`wof:${VENEZUELA}`)
	})

	test("no lookup is scoped to the inferred country", async () => {
		const backend = new RecordingBackend()

		await createWOFResolver(backend).resolveTree(MALFORMED_PARSE)

		expect(backend.calls.filter((call) => call.country === "CO")).toEqual([])
	})

	test("the mis-tagged locality does not carry the answer to Colombia", async () => {
		const backend = new RecordingBackend()
		const result = await createWOFResolver(backend).resolveTree(MALFORMED_PARSE)

		const zulia = result.roots[0]?.children.find((child) => child.value === "Zulia")

		expect(zulia?.placeID).not.toBe(`wof:${ZULIA_LOCALITY_CO}`)
	})
})
