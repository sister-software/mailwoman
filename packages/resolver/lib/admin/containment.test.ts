/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The admin-containment re-rank at the walk's deciding site: the qualifier is threaded onto exactly
 *   the lookups the setting covers, the partition runs after `rankByImportance`, and the
 *   `admin_containment` trace stamp reports the tri-state truthfully.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { EMPTY_PLACE_FIELDS } from "@mailwoman/core/resolver"
import type { ResolvedPlace, ResolveOpts, ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { adminContainmentVerdict, partitionByContainment } from "#admin"
import { createWOFResolver } from "#resolve"

const node = (over: Partial<AddressNode> & Pick<AddressNode, "tag" | "value" | "start" | "end">): AddressNode => ({
	confidence: 0.4,
	children: [],
	...over,
})

/**
 * The Weimar shape: region("Thuria") wrapping locality("Marwei") — the qualifier and the homonym.
 */
const qualifiedTree = (): AddressTree => ({
	raw: "Marwei, Thuria",
	roots: [
		node({
			tag: "region",
			value: "Thuria",
			start: 8,
			end: 14,
			children: [node({ tag: "locality", value: "Marwei", start: 0, end: 6 })],
		}),
	],
})

interface StampSpec {
	id: number
	country: string
	importance?: number
	contained?: boolean
	exactMatch?: boolean
}

/**
 * A backend whose locality candidates include containment stamps only when the query
 * asked (`regionQualifier` present), while region lookups miss.
 */
async function makeBackend(
	specs: StampSpec[],
	seen: Array<{ placetype?: string | string[]; regionQualifier?: string; country?: string }> = []
): Promise<ResolverBackend> {
	return {
		async findPlace(query) {
			seen.push({ placetype: query.placetype, regionQualifier: query.regionQualifier, country: query.country })

			if (query.placetype !== "locality") return []

			return specs.map((spec): ResolvedPlace => ({
				...EMPTY_PLACE_FIELDS,
				id: spec.id,
				name: "Marwei",
				placetype: "locality",
				country: spec.country,
				lat: spec.id,
				lon: spec.id,
				score: 100 - spec.id,
				prominence: 8 - spec.id,
				exactMatch: spec.exactMatch ?? true,
				importance: spec.importance ?? null,
				containedByQualifier: !query.regionQualifier || spec.contained === undefined ? null : spec.contained,
			}))
		},
	}
}

describe("partitionByContainment — the shared ordering function", () => {
	const row = (id: number, contained: boolean | null, exact: boolean) => ({ id, contained, exact })
	const isContained = (r: { contained: boolean | null }) => r.contained === true
	const isExact = (r: { exact: boolean }) => r.exact

	it("moves contained rows ahead within a tier, preserving each group's order", () => {
		const rows = [row(1, false, true), row(2, true, true), row(3, false, true), row(4, true, true)]

		expect(partitionByContainment(rows, isContained, isExact).map((r) => r.id)).toEqual([2, 4, 1, 3])
	})

	it("is TIER-SAFE: a contained partial match never crosses an exact uncontained one", () => {
		// Interleaved tiers: the walk's no-importance path never regroups them,
		// so the partition permutes each tier only among its own slots.
		const rows = [row(1, false, true), row(2, true, false), row(3, false, true), row(4, false, false)]

		expect(partitionByContainment(rows, isContained, isExact).map((r) => r.id)).toEqual([1, 2, 3, 4])
	})

	it("is the identity when nothing is stamped — positive evidence only", () => {
		const rows = [row(1, null, true), row(2, null, true), row(3, null, false)]

		expect(partitionByContainment(rows, isContained, isExact).map((r) => r.id)).toEqual([1, 2, 3])
	})

	it("is the identity when everything is contained", () => {
		const rows = [row(1, true, true), row(2, true, true)]

		expect(partitionByContainment(rows, isContained, isExact).map((r) => r.id)).toEqual([1, 2])
	})
})

describe("adminContainmentVerdict — the tri-state trace stamp", () => {
	it("reads 'contained' when any candidate was vouched for", () => {
		expect(adminContainmentVerdict([{ containedByQualifier: false }, { containedByQualifier: true }])).toBe("contained")
	})

	it("reads 'no_contained_candidate' when evaluated and none vouched", () => {
		expect(adminContainmentVerdict([{ containedByQualifier: false }, { containedByQualifier: false }])).toBe(
			"no_contained_candidate"
		)
	})

	it("reads 'unavailable' when the question was never asked — absence is not a negative answer", () => {
		expect(adminContainmentVerdict([{}, {}])).toBe("unavailable")
		expect(adminContainmentVerdict([])).toBe("unavailable")
	})
})

describe("the walk's deciding site (#1729 reach interface)", () => {
	const resolveWith = async (
		specs: StampSpec[],
		opts: ResolveOpts,
		seen: Array<{ placetype?: string | string[]; regionQualifier?: string; country?: string }> = []
	) => {
		const out = await createWOFResolver(await makeBackend(specs, seen)).resolveTree(qualifiedTree(), opts)
		const region = out.roots[0]!
		const locality = region.children[0]!

		return { region, locality, seen }
	}

	it("threads the qualifier onto the locality lookup when the setting is ON", async () => {
		const seen: Array<{ placetype?: string | string[]; regionQualifier?: string }> = []

		await resolveWith([{ id: 1, country: "US" }], { adminContainmentRerank: true }, seen)

		const locality = seen.find((q) => q.placetype === "locality")

		expect(locality?.regionQualifier).toBe("Thuria")
	})

	it("threads the qualifier by default, because the setting defaults on", async () => {
		const seen: Array<{ placetype?: string | string[]; regionQualifier?: string }> = []

		await resolveWith([{ id: 1, country: "US" }], {}, seen)

		expect(seen.find((q) => q.placetype === "locality")?.regionQualifier).toBe("Thuria")
	})

	it("does NOT thread the qualifier when the setting is off — the off arm is byte-stable", async () => {
		const seen: Array<{ placetype?: string | string[]; regionQualifier?: string }> = []
		const { locality } = await resolveWith([{ id: 1, country: "US" }], { adminContainmentRerank: false }, seen)

		expect(seen.every((q) => q.regionQualifier === undefined)).toBe(true)
		expect(locality.metadata?.["admin_containment"]).toBeUndefined()
	})

	it("stands down under an EXPLICIT caller country scope (the #912 posture)", async () => {
		const seen: Array<{ placetype?: string | string[]; regionQualifier?: string }> = []

		await resolveWith(
			[{ id: 1, country: "US" }],
			{ adminContainmentRerank: true, defaultCountry: { country: "US", source: "caller" } },
			seen
		)

		expect(seen.every((q) => q.regionQualifier === undefined)).toBe(true)
	})

	it("threads under a locale-INFERRED scope — the scope the setting exists to see past", async () => {
		const seen: Array<{ placetype?: string | string[]; regionQualifier?: string }> = []

		await resolveWith(
			[{ id: 1, country: "US" }],
			{ adminContainmentRerank: true, defaultCountry: { country: "US", source: "inferred" } },
			seen
		)

		expect(seen.find((q) => q.placetype === "locality")?.regionQualifier).toBe("Thuria")
	})

	it("the contained candidate wins even when fame disagrees — the partition outranks rankByImportance", async () => {
		// The uncontained namesake is more important, so the walk's own partition must run after the fame key.
		const { locality } = await resolveWith(
			[
				{ id: 1, country: "US", importance: 0.9, contained: false },
				{ id: 2, country: "DE", importance: 0.4, contained: true },
			],
			{ adminContainmentRerank: true }
		)

		expect(locality.placeID).toBe("wof:2")
		expect(locality.metadata?.["admin_containment"]).toBe("contained")
		// The displaced namesake survives as the first alternative — soft reorder, never a filter.
		expect((locality.alternatives as ResolvedPlace[])[0]!.id).toBe(1)
	})

	it("MUTATION CHECK: with the containment stamps inverted, the same input flips to the namesake", async () => {
		// The test must fail under an inverted containment term.
		// The test inverts the stamps to mirror an inverted `intervalContains` term in the backend.
		const { locality } = await resolveWith(
			[
				{ id: 1, country: "US", importance: 0.9, contained: true },
				{ id: 2, country: "DE", importance: 0.4, contained: false },
			],
			{ adminContainmentRerank: true }
		)

		expect(locality.placeID).toBe("wof:1")
	})

	it("reports 'no_contained_candidate' when the backend evaluated and vouched for nothing", async () => {
		const { locality } = await resolveWith(
			[
				{ id: 1, country: "US", importance: 0.9, contained: false },
				{ id: 2, country: "DE", importance: 0.4, contained: false },
			],
			{ adminContainmentRerank: true }
		)

		// Fame decides as today — the setting changed no pick.
		// The assertion checks that result.
		expect(locality.placeID).toBe("wof:1")
		expect(locality.metadata?.["admin_containment"]).toBe("no_contained_candidate")
	})

	it("reports 'unavailable' on a backend that cannot answer — the opted-in setting is visibly inert", async () => {
		const { locality } = await resolveWith(
			[
				{ id: 1, country: "US", importance: 0.9 },
				{ id: 2, country: "DE", importance: 0.4 },
			],
			{ adminContainmentRerank: true }
		)

		expect(locality.placeID).toBe("wof:1")
		expect(locality.metadata?.["admin_containment"]).toBe("unavailable")
	})

	it("never promotes a contained PARTIAL match over an exact one — tier-safe end to end", async () => {
		const { locality } = await resolveWith(
			[
				{ id: 1, country: "US", contained: false, exactMatch: true },
				{ id: 2, country: "DE", contained: true, exactMatch: false },
			],
			{ adminContainmentRerank: true }
		)

		expect(locality.placeID).toBe("wof:1")
	})
})
