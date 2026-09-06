/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The scoped pair probe for a compound JP municipality: the ward answers under its city, never a namesake
 *   elsewhere; a town answers under the prefecture when its county has no key; a plain miss stays a miss.
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { expandPlacetypeFilter } from "@mailwoman/core/resolver"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { createWOFResolver } from "@mailwoman/resolver"
import { describe, expect, it } from "vitest"

const JAPAN = 1
const HYOGO = 2
const KOBE = 3
const KOBE_NISHI = 4
const FUKUOKA = 5
const FUKUOKA_NISHI = 6
const IBARAKI = 7
const GOKA = 8

const PLACES: ResolvedPlace[] = [
	{ id: JAPAN, name: "日本", placetype: "country", country: "JP", lat: 36, lon: 138, score: 10 },
	{ id: 9, name: "栃木県", placetype: "region", country: "JP", parent_id: JAPAN, lat: 36.56, lon: 139.88, score: 9 },
	{
		id: HYOGO,
		name: "兵庫県",
		placetype: "region",
		country: "JP",
		parent_id: JAPAN,
		lat: 34.69,
		lon: 135.18,
		score: 9,
	},
	{
		id: KOBE,
		name: "神戸市",
		placetype: "locality",
		country: "JP",
		parent_id: HYOGO,
		lat: 34.69,
		lon: 135.2,
		score: 8,
	},
	{
		id: KOBE_NISHI,
		name: "西区",
		placetype: "borough",
		country: "JP",
		parent_id: KOBE,
		lat: 34.67,
		lon: 135.02,
		score: 3,
	},
	{
		id: FUKUOKA,
		name: "福岡市",
		placetype: "locality",
		country: "JP",
		parent_id: 99,
		lat: 33.59,
		lon: 130.4,
		score: 8,
	},
	// The namesake ward, better scored: the unscoped probe would take it.
	{
		id: FUKUOKA_NISHI,
		name: "西区",
		placetype: "borough",
		country: "JP",
		parent_id: FUKUOKA,
		lat: 33.58,
		lon: 130.32,
		score: 7,
	},
	{
		id: IBARAKI,
		name: "茨城県",
		placetype: "region",
		country: "JP",
		parent_id: JAPAN,
		lat: 36.34,
		lon: 140.45,
		score: 9,
	},
	// The town under its prefecture; the county 猿島郡 has no record at all.
	{
		id: GOKA,
		name: "五霞町",
		placetype: "locality",
		country: "JP",
		parent_id: IBARAKI,
		lat: 36.11,
		lon: 139.74,
		score: 4,
	},
]

class ScopedFakeBackend implements ResolverBackend {
	readonly calls: Array<Parameters<ResolverBackend["findPlace"]>[0]> = []

	async findPlace(query: Parameters<ResolverBackend["findPlace"]>[0]): Promise<ResolvedPlace[]> {
		this.calls.push(query)
		const requested = Array.isArray(query.placetype) ? query.placetype : query.placetype ? [query.placetype] : null
		const types = expandPlacetypeFilter(requested)

		return PLACES.filter((p) => p.name === query.text)
			.filter((p) => !types || types.includes(p.placetype))
			.filter((p) => query.parentID === undefined || p.parent_id === query.parentID)
			.toSorted((a, b) => b.score - a.score)
			.slice(0, query.limit ?? 5)
	}
}

function node(tag: string, value: string, children: AddressNode[] = []): AddressNode {
	return { tag: tag as AddressNode["tag"], value, start: 0, end: value.length, confidence: 1, children }
}

function municipalityOf(tree: AddressTree): AddressNode {
	const found = tree.roots.flatMap((root) => [root, ...root.children]).find((n) => n.tag === "municipality")

	if (!found) throw new Error("no municipality node")

	return found
}

describe("compound JP municipality — the scoped pair", () => {
	it("answers the ward under its city, not the better-scored namesake in another city", async () => {
		const backend = new ScopedFakeBackend()
		const resolver = createWOFResolver(backend)

		const tree: AddressTree = {
			raw: "兵庫県神戸市西区",
			roots: [node("prefecture", "兵庫県", [node("municipality", "神戸市西区")])],
		}

		const resolved = await resolver.resolveTree(tree, { defaultCountry: "JP" })
		const municipality = municipalityOf(resolved)

		expect(municipality.lat).toBe(34.67)

		expect(municipality.metadata?.["municipality_split"]).toEqual({
			head: "神戸市",
			tail: "西区",
			shape: "city_ward",
			answered: "tail",
		})

		// The tail probe carried the city as its parent; no unscoped probe of the bare ward was made.
		const wardProbes = backend.calls.filter((call) => call.text === "西区")

		expect(wardProbes).toHaveLength(1)
		expect(wardProbes[0]!.parentID).toBe(KOBE)
	})

	it("answers the town under the prefecture when the county has no key", async () => {
		const backend = new ScopedFakeBackend()
		const resolver = createWOFResolver(backend)

		const tree: AddressTree = {
			raw: "茨城県猿島郡五霞町",
			roots: [node("prefecture", "茨城県", [node("municipality", "猿島郡五霞町")])],
		}

		const resolved = await resolver.resolveTree(tree, { defaultCountry: "JP" })
		const municipality = municipalityOf(resolved)

		expect(municipality.lat).toBe(36.11)
		expect(municipality.metadata?.["municipality_split"]).toMatchObject({ shape: "county_town", answered: "tail" })
	})

	it("refuses a tail the backend re-admitted from outside the scope (regionScopeMiss)", async () => {
		const backend = new ScopedFakeBackend()
		const scoped = backend.findPlace.bind(backend)

		// A backend whose scoped probe of the town misses and answers a namesake from another prefecture instead.
		backend.findPlace = async (query) => {
			const hits = await scoped(query)

			if (query.text === "五霞町" && !hits.length) {
				return [{ ...PLACES.find((p) => p.id === GOKA)!, id: 999, parent_id: 98, lat: 35.5, regionScopeMiss: true }]
			}

			return hits
		}

		const resolver = createWOFResolver(backend)

		const tree: AddressTree = {
			raw: "栃木県猿島郡五霞町",
			roots: [node("prefecture", "栃木県", [node("municipality", "猿島郡五霞町")])],
		}

		const resolved = await resolver.resolveTree(tree, { defaultCountry: "JP" })
		const municipality = municipalityOf(resolved)

		expect(municipality.lat).toBeUndefined()
		expect(municipality.metadata?.["municipality_split"]).toBeUndefined()
	})

	it("leaves a plain miss alone", async () => {
		const backend = new ScopedFakeBackend()
		const resolver = createWOFResolver(backend)

		const tree: AddressTree = {
			raw: "兵庫県尼崎市",
			roots: [node("prefecture", "兵庫県", [node("municipality", "尼崎市")])],
		}

		const resolved = await resolver.resolveTree(tree, { defaultCountry: "JP" })
		const municipality = municipalityOf(resolved)

		expect(municipality.lat).toBeUndefined()
		expect(municipality.metadata?.["municipality_split"]).toBeUndefined()
	})
})
