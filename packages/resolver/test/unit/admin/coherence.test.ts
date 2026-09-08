/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for #263 admin descendant-consistency (`opts.adminCoherence`). When a region resolves to a
 *   foreign namesake (greedy by population — "ME" → Messina, IT) and its child locality then finds
 *   nothing beneath it, re-pick the (region, locality) pair so the locality descends from a same-named
 *   region candidate ("Portland" → Maine, not Messina). Joint over the containment graph; no country
 *   prior, no list. Byte-stable when the flag is unset and when no consistent pair exists.
 */

import { walkNodes, type AddressNode, type AddressTree } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { createWOFResolver } from "@mailwoman/resolver/resolve"
import { describe, expect, it } from "vitest"

// "ME" → Messina (IT, greedy top by population) and Maine (US) — both exact abbrev matches.
const MESSINA = {
	id: 10,
	name: "Messina",
	placetype: "region",
	country: "IT",
	lat: 38,
	lon: 14.9,
	score: 9,
	exactMatch: true,
}

const MAINE = {
	id: 20,
	name: "Maine",
	placetype: "region",
	country: "US",
	lat: 45.3,
	lon: -69,
	score: 7,
	exactMatch: true,
}

// A loose fuzzy runner-up ("ME" surfaces M-states) — must be ignored (not an exact match).
const MISSOURI = {
	id: 30,
	name: "Missouri",
	placetype: "region",
	country: "US",
	lat: 38.4,
	lon: -92.5,
	score: 6,
	exactMatch: false,
}

// Portland lives under Maine (parent_id 20), not under Messina.
const PORTLAND_ME: ResolvedPlace = {
	id: 21,
	name: "Portland",
	placetype: "locality",
	country: "US",
	parent_id: 20,
	lat: 43.66,
	lon: -70.25,
	score: 8,
	exactMatch: true,
}

/**
 * Backend filtered by name-substring + placetype + country + `parentID` (descendant scope via parent_id).
 */
async function makeBackend(places: ResolvedPlace[]): Promise<ResolverBackend> {
	return {
		async findPlace(query) {
			const text = query.text.toLowerCase()
			const types = Array.isArray(query.placetype) ? query.placetype : query.placetype ? [query.placetype] : null

			return places
				.filter((p) => p.name.toLowerCase() === text || (p.placetype === "region" && text.length === 2)) // 2-letter abbrev matches its region candidates
				.filter((p) => !types || types.includes(p.placetype))
				.filter((p) => !query.country || p.country === query.country)
				.filter((p) => query.parentID === undefined || p.parent_id === query.parentID)
				.slice(0, query.limit ?? 5)
		},
	}
}

const node = (over: Partial<AddressNode> & Pick<AddressNode, "tag" | "value" | "start" | "end">): AddressNode => ({
	confidence: 0.95,
	children: [],
	...over,
})

// region(ME) → locality(Portland), the shape recognizeUSRegions produces for "Portland, ME".
const portlandMeTree = (): AddressTree => ({
	raw: "Portland, ME",
	roots: [
		node({
			tag: "region",
			value: "ME",
			start: 9,
			end: 11,
			children: [node({ tag: "locality", value: "Portland", start: 0, end: 8 })],
		}),
	],
})

function localityOf(tree: AddressTree): AddressNode | undefined {
	for (const n of walkNodes(tree.roots)) {
		if (n.tag === "locality") return n
	}

	return undefined
}

function regionOf(tree: AddressTree): AddressNode | undefined {
	for (const n of walkNodes(tree.roots)) {
		if (n.tag === "region") return n
	}

	return undefined
}

describe("resolveTree + adminCoherence (#263)", () => {
	it("re-picks (region, locality) so the locality descends from the region", async () => {
		const resolver = createWOFResolver(await makeBackend([MESSINA, MAINE, MISSOURI, PORTLAND_ME]))
		const out = await resolver.resolveTree(portlandMeTree(), { adminCoherence: true })
		const loc = localityOf(out)

		expect(loc?.lat).toBeCloseTo(43.66, 2)
		expect(loc?.lon).toBeCloseTo(-70.25, 2)
		expect(loc?.metadata?.["admin_coherence_repicked"]).toBe(true)
	})

	it("runs by default when adminCoherence is unset (#895 settled drift D1 — default-ON)", async () => {
		const resolver = createWOFResolver(await makeBackend([MESSINA, MAINE, MISSOURI, PORTLAND_ME]))
		const out = await resolver.resolveTree(portlandMeTree(), {})
		const loc = localityOf(out)

		expect(loc?.lat).toBeCloseTo(43.66, 2)
		expect(loc?.metadata?.["admin_coherence_repicked"]).toBe(true)
	})

	it("restores the greedy result when adminCoherence is explicitly false (the opt-out)", async () => {
		const resolver = createWOFResolver(await makeBackend([MESSINA, MAINE, MISSOURI, PORTLAND_ME]))
		const out = await resolver.resolveTree(portlandMeTree(), { adminCoherence: false })
		const loc = localityOf(out)

		// Greedy walk scoped Portland to Messina (parent 10) → nothing → unresolved; no re-pick.
		expect(loc?.lat == null || (loc.lat === 0 && loc.lon === 0)).toBe(true)
		expect(loc?.metadata?.["admin_coherence_repicked"]).toBeUndefined()
	})

	it("does not re-pick when no same-named locality descends from any region candidate", async () => {
		// No Portland anywhere → the pass finds no consistent pair and leaves the tree alone.
		const resolver = createWOFResolver(await makeBackend([MESSINA, MAINE, MISSOURI]))
		const out = await resolver.resolveTree(portlandMeTree(), { adminCoherence: true })
		const loc = localityOf(out)

		expect(loc?.metadata?.["admin_coherence_repicked"]).toBeUndefined()
	})

	it("ignores fuzzy (non-exact) region candidates — a Portland under Missouri must NOT match the token 'ME'", async () => {
		// Place a Portland under Missouri (the fuzzy runner-up). Since MISSOURI.exactMatch is false, the
		// pass must not consider it, so no re-pick to Missouri.
		const PORTLAND_MO: ResolvedPlace = { ...PORTLAND_ME, id: 31, parent_id: 30, lat: 37, lon: -93 }
		const resolver = createWOFResolver(await makeBackend([MESSINA, MISSOURI, PORTLAND_MO]))
		const out = await resolver.resolveTree(portlandMeTree(), { adminCoherence: true })
		const loc = localityOf(out)

		expect(loc?.metadata?.["admin_coherence_repicked"]).toBeUndefined()
	})

	it("falls through to a same-named COUNTRY when no region holds the locality (#267 — Tbilisi, Georgia)", async () => {
		// "Georgia" the US state vs Georgia the country. Tbilisi descends from the COUNTRY, Atlanta from the state.
		const usGeorgia = {
			id: 40,
			name: "Georgia",
			placetype: "region",
			country: "US",
			lat: 32.6,
			lon: -83.4,
			score: 9,
			exactMatch: true,
		}

		const georgiaCountry = {
			id: 50,
			name: "Georgia",
			placetype: "country",
			country: "GE",
			lat: 42,
			lon: 43.5,
			score: 8,
			exactMatch: true,
		}

		const tbilisi: ResolvedPlace = {
			id: 51,
			name: "Tbilisi",
			placetype: "locality",
			country: "GE",
			parent_id: 50,
			lat: 41.69,
			lon: 44.83,
			score: 7,
			exactMatch: true,
		}

		const atlanta: ResolvedPlace = {
			id: 41,
			name: "Atlanta",
			placetype: "locality",
			country: "US",
			parent_id: 40,
			lat: 33.76,
			lon: -84.42,
			score: 9,
			exactMatch: true,
		}

		const tree = (city: string): AddressTree => ({
			raw: `${city}, Georgia`,
			roots: [
				node({
					tag: "region",
					value: "Georgia",
					start: city.length + 2,
					end: city.length + 9,
					children: [node({ tag: "locality", value: city, start: 0, end: city.length })],
				}),
			],
		})

		const resolver = createWOFResolver(await makeBackend([usGeorgia, georgiaCountry, tbilisi, atlanta]))

		// Tbilisi has no descendant under the US state → fall through to Georgia the country.
		const tb = localityOf(await resolver.resolveTree(tree("Tbilisi"), { adminCoherence: true }))
		expect(tb?.lat).toBeCloseTo(41.69, 2)
		expect(tb?.metadata?.["admin_coherence_repicked"]).toBe(true)

		// Atlanta IS under the US state → it resolves in the walk; no country fall-through.
		const at = localityOf(await resolver.resolveTree(tree("Atlanta"), { adminCoherence: true }))
		expect(at?.lat).toBeCloseTo(33.76, 2)
	})

	it("re-picks via matchCountry when the gazetteer has NO country node + the locality is orphaned (#1023 — flattened GE hierarchy)", async () => {
		// The 2026-07-07 admin rebuild (#1015) flattened Georgia to localities-only: no `country`-placetype
		// node, and Tbilisi orphaned (parent_id -1). So both the country-node lookup AND the `parentID`
		// descendant test miss it — the exact shape that regressed "Tbilisi, Georgia" → US Georgia (10,200 km).
		// matchCountry("Georgia") → GE lets the fall-through scope by the `country` COLUMN, which is still set.
		const usGeorgia = {
			id: 40,
			name: "Georgia",
			placetype: "region",
			country: "US",
			lat: 32.6,
			lon: -83.4,
			score: 9,
			exactMatch: true,
		}

		const tbilisiOrphan: ResolvedPlace = {
			id: 51,
			name: "Tbilisi",
			placetype: "locality",
			country: "GE",
			parent_id: -1, // orphaned by the rebuild — no ancestry chain to a country node
			lat: 41.69,
			lon: 44.83,
			score: 7,
			exactMatch: true,
		}

		const tree = (): AddressTree => ({
			raw: "Tbilisi, Georgia",
			roots: [
				node({
					tag: "region",
					value: "Georgia",
					start: 9,
					end: 16,
					children: [node({ tag: "locality", value: "Tbilisi", start: 0, end: 7 })],
				}),
			],
		})

		const resolver = createWOFResolver(await makeBackend([usGeorgia, tbilisiOrphan]))
		const out = await resolver.resolveTree(tree(), { adminCoherence: true })

		const loc = localityOf(out)
		expect(loc?.lat).toBeCloseTo(41.69, 2)
		expect(loc?.lon).toBeCloseTo(44.83, 2)
		expect(loc?.metadata?.["admin_coherence_repicked"]).toBe(true)

		// The greedy walk had bound the region node to the US-state namesake; the fall-through reverts that
		// stale decoration so no wrong-country coordinate / `resolver_country` leaks into the result.
		const region = regionOf(out)
		expect(region?.lat).toBeUndefined()
		expect(region?.placeID).toBeUndefined()
		expect(region?.metadata?.["resolver_country"]).toBeUndefined()
		expect(region?.value).toBe("Georgia") // the parsed token is preserved
	})

	it("stays inert for a domestic (region, locality) pair — matchCountry returns null for a US state name", async () => {
		// "Georgia" names both a country and a US state, but the fall-through must never fire when the pair
		// is genuinely domestic. Atlanta resolves under the US state in the walk, so reconcileAdminPair's
		// unresolved-locality branch never runs — and even if it did, a Springfield-style US token
		// ("Illinois"/"ME") returns null from matchCountry. Guards byte-stability on the domestic path.
		const usGeorgia = {
			id: 40,
			name: "Georgia",
			placetype: "region",
			country: "US",
			lat: 32.6,
			lon: -83.4,
			score: 9,
			exactMatch: true,
		}

		const atlanta: ResolvedPlace = {
			id: 41,
			name: "Atlanta",
			placetype: "locality",
			country: "US",
			parent_id: 40,
			lat: 33.76,
			lon: -84.42,
			score: 9,
			exactMatch: true,
		}

		const tree: AddressTree = {
			raw: "Atlanta, Georgia",
			roots: [
				node({
					tag: "region",
					value: "Georgia",
					start: 9,
					end: 16,
					children: [node({ tag: "locality", value: "Atlanta", start: 0, end: 7 })],
				}),
			],
		}

		const resolver = createWOFResolver(await makeBackend([usGeorgia, atlanta]))
		const out = await resolver.resolveTree(tree, { adminCoherence: true })

		const loc = localityOf(out)
		expect(loc?.lat).toBeCloseTo(33.76, 2)
		// Resolved in the walk, not by the coherence pass — no re-pick marker.
		expect(loc?.metadata?.["admin_coherence_repicked"]).toBeUndefined()
		// The US-Georgia region decoration stands (not reverted).
		const region = regionOf(out)
		expect(region?.metadata?.["resolver_country"]).toBe("US")
	})
})

describe("resolveTree + applyParentFallbackContradiction", () => {
	// 臺南市 (Tainan City) and 新竹市 (Hsinchu City) are regions; only Hsinchu's 北區 carries a key. The walk scopes 北區 to
	// Tainan, misses, and the parent-fallback retry answers Hsinchu's — a namesake 214 km away on the real gazetteer.
	const TAINAN: ResolvedPlace = {
		id: 100,
		name: "Tainan City",
		placetype: "region",
		country: "TW",
		lat: 23.15,
		lon: 120.33,
		score: 9,
		exactMatch: true,
	}

	const HSINCHU: ResolvedPlace = {
		id: 200,
		name: "Hsinchu City",
		placetype: "region",
		country: "TW",
		lat: 24.8,
		lon: 120.97,
		score: 8,
		exactMatch: true,
	}

	const HSINCHU_BEI_QU: ResolvedPlace = {
		id: 201,
		name: "Bei Qu",
		placetype: "locality",
		country: "TW",
		parent_id: 200,
		lat: 24.816,
		lon: 120.949,
		score: 7,
		exactMatch: true,
	}

	function beiQuTree(): AddressTree {
		return {
			raw: "臺南市北區",
			roots: [
				node({
					tag: "region",
					value: "Tainan City",
					start: 0,
					end: 3,
					children: [node({ tag: "subregion", value: "Bei Qu", start: 3, end: 5 })],
				}),
			],
		}
	}

	async function backendWithLineage(
		ancestorsOf: Record<number, Array<{ id: number; placetype: string; name: string }>>
	) {
		const base = await makeBackend([TAINAN, HSINCHU, HSINCHU_BEI_QU])

		return { ...base, ancestors: (id: number | string) => ancestorsOf[Number(id)] ?? [] } as ResolverBackend
	}

	const opts = { includeAncestors: true, placetypeMap: { region: "region", subregion: "locality" } }

	function subregionOf(tree: AddressTree): AddressNode | undefined {
		for (const n of walkNodes(tree.roots)) {
			if (n.tag === "subregion") return n
		}

		return undefined
	}

	it("un-resolves a parent-fallback pick whose lineage names another region, so the ladder answers the parent", async () => {
		const backend = await backendWithLineage({ 201: [{ id: 200, placetype: "region", name: "Hsinchu City" }] })
		const out = await createWOFResolver(backend).resolveTree(beiQuTree(), opts)
		const sub = subregionOf(out)

		expect(regionOf(out)?.placeID).toBe("wof:100")
		expect(sub?.placeID).toBeUndefined()
		expect(sub?.lat).toBeUndefined()
		expect(sub?.metadata?.["parent_fallback_refused"]).toBe(true)
		expect(sub?.metadata?.["resolver_name"]).toBeUndefined()
	})

	it("keeps a parent-fallback pick whose lineage names no region at all — the incomplete chain the retry exists for", async () => {
		const backend = await backendWithLineage({ 201: [{ id: 1, placetype: "country", name: "Taiwan" }] })
		const out = await createWOFResolver(backend).resolveTree(beiQuTree(), opts)
		const sub = subregionOf(out)

		expect(sub?.placeID).toBe("wof:201")
		expect(sub?.metadata?.["parent_fallback"]).toBe(true)
		expect(sub?.metadata?.["parent_fallback_refused"]).toBeUndefined()
	})

	it("keeps a parent-fallback pick whose lineage names the resolved parent", async () => {
		const backend = await backendWithLineage({ 201: [{ id: 100, placetype: "region", name: "Tainan City" }] })
		const out = await createWOFResolver(backend).resolveTree(beiQuTree(), opts)

		expect(subregionOf(out)?.placeID).toBe("wof:201")
	})

	it("refuses the same pick when the BACKEND widened the scope and stamped regionScopeMiss (#1731)", async () => {
		// A backend that keeps the parent scope on the query and re-admits rows from outside it, the way the candidate
		// table's interior region-scope fallback does — the resolver's own retry never runs.
		const widened: ResolverBackend = {
			async findPlace(query) {
				const text = query.text.toLowerCase()

				const under = [TAINAN, HSINCHU, HSINCHU_BEI_QU].filter(
					(p) => p.name.toLowerCase() === text && (query.parentID === undefined || p.parent_id === query.parentID)
				)

				if (under.length || query.parentID === undefined) return under

				return [TAINAN, HSINCHU, HSINCHU_BEI_QU]
					.filter((p) => p.name.toLowerCase() === text)
					.map((p) => ({ ...p, regionScopeMiss: true }))
			},
			ancestors: () => [{ id: 200, placetype: "region", name: "Hsinchu City" }],
		}

		const out = await createWOFResolver(widened).resolveTree(beiQuTree(), opts)
		const sub = subregionOf(out)

		expect(sub?.placeID).toBeUndefined()
		expect(sub?.metadata?.["parent_fallback_refused"]).toBe(true)
	})

	it("is inert without the ancestor sidecar, since an unreadable chain is not a contradiction", async () => {
		const out = await createWOFResolver(await makeBackend([TAINAN, HSINCHU, HSINCHU_BEI_QU])).resolveTree(
			beiQuTree(),
			opts
		)

		expect(subregionOf(out)?.placeID).toBe("wof:201")
	})
})
