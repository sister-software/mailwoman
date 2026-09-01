/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1717 stage 2 — the admin-containment re-rank at the WALK's deciding site.
 *
 *   The partition itself is pure and tested directly (tier-safety, stability, the no-stamp
 *   identity). The walk tests then pin the reach contract the #1729 lesson demands: the qualifier is
 *   threaded onto exactly the lookups the lever covers, the partition runs AFTER `rankByImportance`
 *   (fame must not win back the top slot from a qualifier-vouched candidate), and the
 *   `admin_containment` trace stamp reports the tri-state truthfully — `unavailable` on a backend
 *   that cannot answer is the census surface for an opted-in lever that cannot fire.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolveOpts, ResolverBackend } from "@mailwoman/core/resolver"
import { adminContainmentVerdict, partitionByContainment } from "@mailwoman/resolver/admin"
import { createWOFResolver } from "@mailwoman/resolver/resolve"
import { describe, expect, it } from "vitest"

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
 * A backend whose locality candidates carry containment stamps ONLY when the query asked (`regionQualifier` present) —
 * the capable-backend contract. Region lookups miss (the fixture region resolves nothing, like Thüringen under a US
 * scope).
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
				id: spec.id,
				name: "Marwei",
				placetype: "locality",
				country: spec.country,
				lat: spec.id,
				lon: spec.id,
				score: 100 - spec.id,
				prominence: 8 - spec.id,
				exactMatch: spec.exactMatch ?? true,
				...(spec.importance === undefined ? {} : { importance: spec.importance }),
				...(query.regionQualifier === undefined || spec.contained === undefined
					? {}
					: { containedByQualifier: spec.contained }),
			}))
		},
	}
}

describe("partitionByContainment — the shared ordering function", () => {
	const row = (id: number, contained: boolean | undefined, exact: boolean) => ({ id, contained, exact })
	const isContained = (r: { contained: boolean | undefined }) => r.contained === true
	const isExact = (r: { exact: boolean }) => r.exact

	it("moves contained rows ahead within a tier, preserving each group's order", () => {
		const rows = [row(1, false, true), row(2, true, true), row(3, false, true), row(4, true, true)]

		expect(partitionByContainment(rows, isContained, isExact).map((r) => r.id)).toEqual([2, 4, 1, 3])
	})

	it("is TIER-SAFE: a contained partial match never crosses an exact uncontained one", () => {
		// Interleaved tiers — the walk's no-importance path never regroups them, so the partition must
		// permute each tier only among its own slots.
		const rows = [row(1, false, true), row(2, true, false), row(3, false, true), row(4, false, false)]

		expect(partitionByContainment(rows, isContained, isExact).map((r) => r.id)).toEqual([1, 2, 3, 4])
	})

	it("is the identity when nothing is stamped — positive evidence only", () => {
		const rows = [row(1, undefined, true), row(2, undefined, true), row(3, undefined, false)]

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

describe("the walk's deciding site (#1729 reach contract)", () => {
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

	it("threads the qualifier onto the locality lookup when the lever is ON", async () => {
		const seen: Array<{ placetype?: string | string[]; regionQualifier?: string }> = []

		await resolveWith([{ id: 1, country: "US" }], { adminContainmentRerank: true }, seen)

		const locality = seen.find((q) => q.placetype === "locality")

		expect(locality?.regionQualifier).toBe("Thuria")
	})

	it("does NOT thread the qualifier when the lever is off — the default is byte-stable", async () => {
		const seen: Array<{ placetype?: string | string[]; regionQualifier?: string }> = []
		const { locality } = await resolveWith([{ id: 1, country: "US" }], {}, seen)

		expect(seen.every((q) => q.regionQualifier === undefined)).toBe(true)
		expect(locality.metadata?.["admin_containment"]).toBeUndefined()
	})

	it("stands down under an EXPLICIT caller country scope (the #912 posture)", async () => {
		const seen: Array<{ placetype?: string | string[]; regionQualifier?: string }> = []

		await resolveWith([{ id: 1, country: "US" }], { adminContainmentRerank: true, defaultCountry: "US" }, seen)

		expect(seen.every((q) => q.regionQualifier === undefined)).toBe(true)
	})

	it("threads under a locale-INFERRED scope — the scope the lever exists to see past", async () => {
		const seen: Array<{ placetype?: string | string[]; regionQualifier?: string }> = []

		await resolveWith(
			[{ id: 1, country: "US" }],
			{ adminContainmentRerank: true, defaultCountry: "US", defaultCountryIsInferred: true },
			seen
		)

		expect(seen.find((q) => q.placetype === "locality")?.regionQualifier).toBe("Thuria")
	})

	it("the contained candidate wins even when fame disagrees — the partition outranks rankByImportance", async () => {
		// The uncontained namesake is MORE important (Richmond VA vs Richmond, North Yorkshire): fame
		// alone re-orders it to the front, so a lever that only trusted the backend's incoming order
		// would lose here. This is the reach proof: the walk's own partition must run after the fame key.
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
		// The #1729 fixture discipline: the test must fail under an inverted containment term. Inverting
		// the stamps here is the walk-level image of inverting `intervalContains` in the backend — the
		// candidate-lookup suite carries the artifact-level twin.
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

		// Fame decides as today — the lever changed nothing, and says so.
		expect(locality.placeID).toBe("wof:1")
		expect(locality.metadata?.["admin_containment"]).toBe("no_contained_candidate")
	})

	it("reports 'unavailable' on a backend that cannot answer — the opted-in lever is visibly inert", async () => {
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
