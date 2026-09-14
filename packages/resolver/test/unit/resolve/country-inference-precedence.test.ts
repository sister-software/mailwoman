/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #2248's resolver invariant, and it does NOT hold: **a country NAMED in the input must never be looked
 *   up inside a country INFERRED from another node.**
 *
 *   The reported failure was `Maracaibo 4001, Zulia, Venezuela` answering with no country at all. The
 *   parse mis-tagged `Zulia` — a Venezuelan REGION — as a locality. Venezuela has no locality Zulia and
 *   Colombia does, so the locality claim was satisfiable only in CO; the walk inferred CO and probed
 *   `Venezuela` inside it, finding nothing.
 *
 *   **That input no longer reproduces it, and that is not evidence the invariant holds.** The parse moved
 *   too — today the same string reads `street: Maracaibo` + `house_number: 4001`, which never reaches the
 *   vulnerable path. These cases freeze the malformed parse and a controlled two-country contest, so the
 *   guard is exercised whatever the parser does next. All three fail today, which is why they are
 *   `test.fails`: the assertion is inverted, so the suite turns RED the moment the invariant starts
 *   holding and the expectation has to be un-inverted with the fix.
 *
 *   Scope. This file owns the COUNTRY-PRECEDENCE half only. `Zulia` reaching the walk tagged `locality` is
 *   a parse defect owned by #1748, and the `«locality» «postcode»` to `«street» «house_number»` class is
 *   #1821 — the five Venezuelan regression-board rows belong to those two, and this invariant holding
 *   would not make them pass.
 */

import type { AddressNode, AddressTree, ComponentTag } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { createWOFResolver } from "@mailwoman/resolver/resolve"
import { describe, expect, test } from "vitest"

const VENEZUELA = 8_040_579_053_981
const ZULIA_LOCALITY_CO = 8_084_693_553_936

/**
 * The controlled contest, and the whole point of it: `Zulia` exists as a REGION in Venezuela and as a LOCALITY in
 * Colombia, so a walk that trusts the mis-tag can satisfy it only by moving country.
 */
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
	tag: ComponentTag,
	value: string,
	start: number,
	end: number,
	children: AddressNode[] = []
): AddressNode => ({ tag, value, start, end, confidence: 0.9, children })

/**
 * The malformed parse, nested the way the decoder nests — country at the root, admin depth downward, which is the shape
 * `Maracaibo, Zulia, Venezuela` produces today (`country > region > locality`). Here `Zulia` occupies the locality slot
 * and `Maracaibo` sits outside the winner's lineage, which is what the report's trace shows.
 */
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
	test.fails("XFAIL: the country named in the input resolves, against a claim satisfiable only elsewhere", async () => {
		const backend = new RecordingBackend()
		const result = await createWOFResolver(backend).resolveTree(MALFORMED_PARSE)

		expect(result.roots[0]?.placeID).toBe(`wof:${VENEZUELA}`)
	})

	test.fails("XFAIL: no lookup is scoped to the inferred country", async () => {
		const backend = new RecordingBackend()

		await createWOFResolver(backend).resolveTree(MALFORMED_PARSE)

		// The reported failure in one line: `tag=country value="Venezuela" scope={country: CO}`.
		expect(backend.calls.filter((call) => call.country === "CO")).toEqual([])
	})

	test.fails("XFAIL: the mis-tagged locality does not carry the answer to Colombia", async () => {
		const backend = new RecordingBackend()
		const result = await createWOFResolver(backend).resolveTree(MALFORMED_PARSE)

		// Leaving `Zulia` unresolved is the correct degradation here; its correct TAGGING belongs to #1748.
		const zulia = result.roots[0]?.children.find((child) => child.value === "Zulia")

		expect(zulia?.placeID).not.toBe(`wof:${ZULIA_LOCALITY_CO}`)
	})
})
