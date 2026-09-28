/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The bare-city-name class where the model reads a bare famous name as a `street`, so span-rescore
 *   is the only tier that resolves it: when the span covers the whole unqualified input the gazetteer
 *   is probed unscoped and the locale country becomes an additive bonus instead of a filter, while
 *   every other shape keeps the hard filter byte-for-byte.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { createWOFResolver } from "@mailwoman/resolver/resolve"
import { findRescoreCandidate } from "@mailwoman/resolver/span-rescore"
import { describe, expect, it } from "vitest"

import { backendNameKey } from "../helpers/backend-name-key.ts"

const norm = backendNameKey

/**
 * Live rows off the shipped `candidate.db` (`prominence` = log10(population + 1)).
 */
const PLACES: ResolvedPlace[] = [
	{
		id: 1,
		name: "Zürich",
		placetype: "locality",
		country: "CH",
		lat: 47.3744,
		lon: 8.541,
		score: 5.6464,
		prominence: 5.6464,
		exactMatch: true,
	},
	{
		id: 2,
		name: "Zurich",
		placetype: "locality",
		country: "US",
		lat: 39.2323,
		lon: -99.4347,
		score: 1.9138,
		prominence: 1.9138,
		exactMatch: true,
	},
	{
		id: 3,
		name: "Berlin",
		placetype: "locality",
		country: "DE",
		lat: 52.5015,
		lon: 13.4019,
		score: 6.5646,
		prominence: 6.5646,
		exactMatch: true,
	},
	{
		id: 4,
		name: "Berlin",
		placetype: "locality",
		country: "US",
		lat: 41.6114,
		lon: -72.7758,
		score: 4.2981,
		prominence: 4.2981,
		exactMatch: true,
	},
	{
		id: 5,
		name: "Berlin",
		placetype: "locality",
		country: "US",
		lat: 43.9704,
		lon: -88.9504,
		score: 3.7451,
		prominence: 3.7451,
		exactMatch: true,
	},
	// Manchester: the in-country answer the soft prior must keep.
	{
		id: 6,
		name: "Manchester",
		placetype: "locality",
		country: "GB",
		lat: 53.4794,
		lon: -2.2453,
		score: 5.74,
		prominence: 5.74,
		exactMatch: true,
	},
	{
		id: 7,
		name: "Manchester",
		placetype: "locality",
		country: "US",
		lat: 42.9848,
		lon: -71.4447,
		score: 5.06,
		prominence: 5.06,
		exactMatch: true,
	},
	// Weimar / Thüringen: a 2-token span containing a real exact match must not outrank the 1-token gold.
	{
		id: 8,
		name: "Weimar",
		placetype: "locality",
		country: "DE",
		lat: 50.9783,
		lon: 11.3179,
		score: 4.8144,
		prominence: 4.8144,
		exactMatch: true,
	},
	{
		id: 9,
		name: "Thüringen",
		placetype: "locality",
		country: "AT",
		lat: 47.2,
		lon: 9.79,
		score: 3.3606,
		prominence: 3.3606,
		exactMatch: true,
	},
	// A postcode → point for the not-bare guard, sitting on Berlin, Wisconsin (id 5) so the check admits it.
	{ id: 900, name: "54923", placetype: "postalcode", country: "US", lat: 43.97, lon: -88.95, score: 1 },
]

async function makeBackend(
	calls?: Array<{ text: string; country?: string; limit?: number }>
): Promise<ResolverBackend> {
	return {
		async findPlace(query) {
			calls?.push({ text: query.text, country: query.country, limit: query.limit })
			const key = norm(query.text)

			return PLACES.filter(
				(p) =>
					norm(p.name) === key &&
					(!query.country || p.country === query.country) &&
					(query.placetype === "postalcode" ? p.placetype === "postalcode" : p.placetype !== "postalcode")
			).map((p) => ({ ...p }))
		},
	}
}

const node = (over: Partial<AddressNode> & Pick<AddressNode, "tag" | "value" | "start" | "end">): AddressNode => ({
	confidence: 0.4,
	children: [],
	...over,
})

describe("bare-toponym soft country prior (#17)", () => {
	it("resolves a bare 'Zürich' under an en-US locale to Switzerland, not Kansas", async () => {
		const raw = "Zürich"
		const roots = [node({ tag: "street", value: raw, start: 0, end: raw.length })]
		const hit = await findRescoreCandidate(raw, roots, await makeBackend(), { country: "US" })

		expect(hit?.place.country).toBe("CH")
		expect(hit?.place.id).toBe(1)
	})

	it("resolves a bare 'Zürich' under an en-GB locale instead of returning nothing", async () => {
		// GB holds no Zurich, so the hard filter would return no result.
		const raw = "Zürich"
		const roots = [node({ tag: "street", value: raw, start: 0, end: raw.length })]
		const hit = await findRescoreCandidate(raw, roots, await makeBackend(), { country: "GB" })

		expect(hit?.place.country).toBe("CH")
	})

	it("KEEPS the in-country answer when the locale bonus carries it (Manchester under en-US)", async () => {
		const raw = "Manchester"
		const roots = [node({ tag: "street", value: raw, start: 0, end: raw.length })]
		const hit = await findRescoreCandidate(raw, roots, await makeBackend(), { country: "US" })

		expect(hit?.place.country).toBe("US")
		expect(hit?.place.id).toBe(7)
	})

	it("carries the losing namesakes as alternatives so the ambiguity margin stays computable", async () => {
		const raw = "Zürich"
		const roots = [node({ tag: "street", value: raw, start: 0, end: raw.length })]
		const hit = await findRescoreCandidate(raw, roots, await makeBackend(), { country: "US" })

		expect(hit?.alternatives.map((a) => a.country)).toContain("US")
	})

	it("does NOT fire when a postcode qualifies the query (the hard filter stands)", async () => {
		// A postcode is knowledge rather than a locale guess and has already picked the country.
		const raw = "Berlin 54923"

		const roots = [
			node({ tag: "street", value: "Berlin", start: 0, end: 6 }),
			node({ tag: "postcode", value: "54923", start: 7, end: 12, confidence: 0.95 }),
		]

		const hit = await findRescoreCandidate(raw, roots, await makeBackend(), { country: "US", postcode: "54923" })
		expect(hit?.place.country).toBe("US")
		expect(hit?.place.id).toBe(5)
	})

	it("does NOT fire when a region qualifies the query (a qualifier beats population, always)", async () => {
		// The D-rule guard: 'Berlin Wisconsin' must keep resolving to Berlin, Wisconsin.
		const raw = "Berlin Wisconsin"

		const roots = [
			node({ tag: "street", value: "Berlin", start: 0, end: 6 }),
			node({ tag: "region", value: "Wisconsin", start: 7, end: 16, confidence: 0.9 }),
		]

		const hit = await findRescoreCandidate(raw, roots, await makeBackend(), { country: "US" })
		expect(hit?.place.country).toBe("US")
	})

	it("does NOT fire when the span is only PART of the raw input", async () => {
		// A partial span is not a bare toponym: 'Weimar Thüringen' keeps the DE-scoped 'Weimar' probe.
		const raw = "Weimar Thüringen"
		const roots = [node({ tag: "street", value: raw, start: 0, end: raw.length })]
		const calls: Array<{ text: string; country?: string }> = []
		const hit = await findRescoreCandidate(raw, roots, await makeBackend(calls), { country: "DE" })

		expect(hit?.place.id).toBe(8) // Weimar DE rather than Thüringen AT
		expect(calls.filter((c) => c.text === "Thüringen").every((c) => c.country === "DE")).toBe(true)
	})

	it("is byte-stable when the caller supplied no country at all", async () => {
		const raw = "Berlin"
		const roots = [node({ tag: "street", value: raw, start: 0, end: raw.length })]
		const calls: Array<{ text: string; country?: string; limit?: number }> = []
		const hit = await findRescoreCandidate(raw, roots, await makeBackend(calls), {})

		expect(hit?.place.country).toBe("DE")
		// One probe per span: no widened re-probe when there is no filter to soften.
		expect(calls).toHaveLength(1)
	})

	it("accepts an explicit weight so the prior can be tuned or disabled", async () => {
		const raw = "Zürich"
		const roots = [node({ tag: "street", value: raw, start: 0, end: raw.length })]

		const hit = await findRescoreCandidate(raw, roots, await makeBackend(), {
			country: "US",
			bareToponymCountryWeight: 99,
		})

		expect(hit?.place.country).toBe("US")
	})

	it("opts out entirely with bareToponymSoftCountry: false", async () => {
		const raw = "Zürich"
		const roots = [node({ tag: "street", value: raw, start: 0, end: raw.length })]

		const hit = await findRescoreCandidate(raw, roots, await makeBackend(), {
			country: "US",
			bareToponymSoftCountry: false,
		})

		expect(hit?.place.country).toBe("US")
		expect(hit?.place.id).toBe(2)
	})
})

/**
 * The other half of the bare-toponym class: queries the model tags `locality`, which reach
 * the admin walk instead of span-rescore, so importance is the only key that separates them.
 */
describe("importance key in the admin walk (#17)", () => {
	const WHITBY: ResolvedPlace[] = [
		{
			id: 1,
			name: "Whitby",
			placetype: "locality",
			country: "CA",
			lat: 43.8798,
			lon: -78.9422,
			score: 5.1085,
			prominence: 5.1085,
			exactMatch: true,
		},
		{
			id: 2,
			name: "Whitby",
			placetype: "locality",
			country: "GB",
			lat: 54.4796,
			lon: -0.6251,
			score: 4.1183,
			prominence: 4.1183,
			exactMatch: true,
		},
	]

	const walk = async (candidates: ResolvedPlace[], opts = {}) => {
		const backend: ResolverBackend = {
			async findPlace() {
				return candidates.map((c) => ({ ...c }))
			},
		}

		const tree = {
			raw: "Whitby",
			roots: [node({ tag: "locality", value: "Whitby", start: 0, end: 6, confidence: 0.9 })],
		}

		return createWOFResolver(backend).resolveTree(tree, opts)
	}

	it("prefers the encyclopedically prominent namesake when the gazetteer measures both", async () => {
		const withScores = WHITBY.map((c, i) => ({ ...c, importance: i === 0 ? 0.5089 : 0.5496 }))
		const out = await walk(withScores)
		expect(out.roots[0]?.metadata?.["resolver_country"]).toBe("GB")
	})

	it("stays on population when the gazetteer measures neither (today's shipped artifact)", async () => {
		const out = await walk(WHITBY)
		expect(out.roots[0]?.metadata?.["resolver_country"]).toBe("CA")
	})

	it("stands down when a postcode anchor already pinned the country", async () => {
		// Fame is the prior of last resort; an anchor posterior is derived from the
		// address's own postcode, and evidence outranks a prior.
		const withScores = WHITBY.map((c, i) => ({ ...c, importance: i === 0 ? 0.5089 : 0.5496 }))
		const out = await walk(withScores, { anchorPosterior: { CA: 1 } })
		expect(out.roots[0]?.metadata?.["resolver_country"]).toBe("CA")
	})

	it("promotes the in-locale-country namesake when the locale prior is supplied (#27)", async () => {
		const out = await walk(WHITBY, { localeCountryPrior: "GB" })
		expect(out.roots[0]?.metadata?.["resolver_country"]).toBe("GB")
	})

	it("is byte-stable when no locale prior is supplied (the shipped default)", async () => {
		const out = await walk(WHITBY, {})
		expect(out.roots[0]?.metadata?.["resolver_country"]).toBe("CA")
	})

	it("is additive, never a filter — a dominant foreign bearer still wins", async () => {
		// The prior is additive, never a filter: `weight: 0` is the identity,
		// so the prior cannot make a place the gazetteer never returned appear.
		const out = await walk(WHITBY, { localeCountryPrior: "GB", localeCountryPriorWeight: 0 })
		expect(out.roots[0]?.metadata?.["resolver_country"]).toBe("CA")
	})

	it("stands down under a hard country scope (a scope makes the prior a no-op by construction)", async () => {
		const out = await walk(WHITBY, { localeCountryPrior: "GB", defaultCountry: "CA" })
		expect(out.roots[0]?.metadata?.["resolver_country"]).toBe("CA")
	})

	it("stands down under a postcode anchor — evidence outranks a locale guess", async () => {
		const out = await walk(WHITBY, { localeCountryPrior: "GB", anchorPosterior: { CA: 1 } })
		expect(out.roots[0]?.metadata?.["resolver_country"]).toBe("CA")
	})
})

/**
 * The bare-country class: a lone bare locality-tagged country name also races the
 * `country` placetype, and an inferred scope is withheld from `country`-placetype lookups
 * while an explicit scope stays supreme.
 */
describe("bare-country class", () => {
	const WORLD: ResolvedPlace[] = [
		// prominence = log10(population + 1).
		{
			id: 10,
			name: "Japan",
			placetype: "country",
			country: "JP",
			lat: 37.5293,
			lon: 137.9448,
			score: 8.1013,
			prominence: 8.1013,
			exactMatch: true,
		},
		{
			id: 11,
			name: "Japan",
			placetype: "locality",
			country: "US",
			lat: 40.9926,
			lon: -75.9102,
			score: 0,
			prominence: 0,
			exactMatch: true,
		},
		{
			id: 12,
			name: "Germany",
			placetype: "country",
			country: "DE",
			lat: 51.1102,
			lon: 10.3923,
			score: 8.9204,
			prominence: 8.9204,
			exactMatch: true,
		},
		{
			id: 13,
			name: "Nigeria",
			placetype: "country",
			country: "NG",
			lat: 9,
			lon: 7.9,
			score: 8.3424,
			prominence: 8.3424,
			exactMatch: true,
		},
		{
			id: 14,
			name: "Paris",
			placetype: "locality",
			country: "FR",
			lat: 48.8566,
			lon: 2.3522,
			score: 6.3405,
			prominence: 6.3405,
			exactMatch: true,
		},
	]

	const backend = (calls?: Array<{ text: string; placetype?: unknown; country?: string }>): ResolverBackend => ({
		async findPlace(query) {
			calls?.push({ text: query.text, placetype: query.placetype, country: query.country })
			const key = norm(query.text)
			const want = Array.isArray(query.placetype) ? query.placetype : query.placetype ? [query.placetype] : null

			return WORLD.filter(
				(p) =>
					norm(p.name) === key &&
					(!want || want.includes(p.placetype)) &&
					(!query.country || p.country === query.country.toUpperCase())
			).map((p) => ({ ...p }))
		},
	})

	const bareTree = (tag: "locality" | "country", value: string) => ({
		raw: value,
		roots: [node({ tag, value, start: 0, end: value.length, confidence: 0.9 })],
	})

	it("repicks a bare locality-tagged country name to the country row (Japan over Japan, Pennsylvania)", async () => {
		const out = await createWOFResolver(backend()).resolveTree(bareTree("locality", "Japan"))
		const root = out.roots[0]!

		expect(root.metadata?.["resolver_country"]).toBe("JP")
		expect(root.metadata?.["bare_country_repick"]).toBe(true)
		expect(root.lat).toBeCloseTo(37.5293, 3)
	})

	it("keeps the displaced locality first among the alternatives", async () => {
		const out = await createWOFResolver(backend()).resolveTree(bareTree("locality", "Japan"))
		const alternatives = (out.roots[0]?.alternatives ?? []) as readonly ResolvedPlace[]

		expect(alternatives[0]?.country).toBe("US")
	})

	it("resolves a bare name with NO locality namesake through the empty-candidates hook (Nigeria)", async () => {
		const out = await createWOFResolver(backend()).resolveTree(bareTree("locality", "Nigeria"))

		expect(out.roots[0]?.metadata?.["resolver_country"]).toBe("NG")
		expect(out.roots[0]?.metadata?.["bare_country_repick"]).toBe(true)
	})

	// The race finds the right place, so the repick also retags the node to `country`.
	it("retags a country repick to `country`", async () => {
		const out = await createWOFResolver(backend()).resolveTree(bareTree("locality", "Japan"))

		expect(out.roots[0]?.tag).toBe("country")
	})

	it("retags the no-locality-namesake path too (Nigeria, via the empty-candidates hook)", async () => {
		const out = await createWOFResolver(backend()).resolveTree(bareTree("locality", "Nigeria"))

		expect(out.roots[0]?.tag).toBe("country")
	})

	it("leaves an ordinary locality alone — only the race's own picks are retagged", async () => {
		const out = await createWOFResolver(backend()).resolveTree(bareTree("locality", "Paris"))

		expect(out.roots[0]?.tag).toBe("locality")
	})

	it("never fires without a country namesake — bare 'Paris' is byte-stable", async () => {
		const out = await createWOFResolver(backend()).resolveTree(bareTree("locality", "Paris"))
		const root = out.roots[0]!

		expect(root.metadata?.["resolver_country"]).toBe("FR")
		expect(root.metadata?.["bare_country_repick"]).toBeUndefined()
	})

	it("never fires on an address-shaped tree — a second value-containing node keeps the race off", async () => {
		const tree = {
			raw: "Japan, Pennsylvania",
			roots: [
				node({ tag: "locality", value: "Japan", start: 0, end: 5, confidence: 0.9 }),
				node({ tag: "region", value: "Pennsylvania", start: 7, end: 19, confidence: 0.9 }),
			],
		}

		const out = await createWOFResolver(backend()).resolveTree(tree)

		expect(out.roots[0]?.metadata?.["resolver_country"]).toBe("US")
		expect(out.roots[0]?.metadata?.["bare_country_repick"]).toBeUndefined()
	})

	it("stays inside an EXPLICIT country scope — the race cannot promote a foreign country row", async () => {
		const out = await createWOFResolver(backend()).resolveTree(bareTree("locality", "Japan"), {
			defaultCountry: "US",
		})

		expect(out.roots[0]?.metadata?.["resolver_country"]).toBe("US")
		expect(out.roots[0]?.metadata?.["bare_country_repick"]).toBeUndefined()
	})

	it("resolves a country-TAGGED node under an inferred scope (bare 'Germany' under the en-US default)", async () => {
		const out = await createWOFResolver(backend()).resolveTree(bareTree("country", "Germany"), {
			defaultCountry: "us",
			defaultCountryIsInferred: true,
		})

		expect(out.roots[0]?.metadata?.["resolver_country"]).toBe("DE")
	})

	it("keeps an EXPLICIT scope supreme on country-tagged nodes (byte-stable legacy behavior)", async () => {
		const out = await createWOFResolver(backend()).resolveTree(bareTree("country", "Germany"), {
			defaultCountry: "us",
		})

		expect(out.roots[0]?.metadata?.["resolver_country"]).toBeUndefined()
	})

	it("scopes the country race by the inferred filter's own query country only when explicit", async () => {
		// Under the inferred posture the caller has already withheld the scope for the
		// bare-locality shape, so the race runs worldwide.
		const calls: Array<{ text: string; placetype?: unknown; country?: string }> = []

		await createWOFResolver(backend(calls)).resolveTree(bareTree("locality", "Japan"))
		const race = calls.find((c) => c.placetype === "country")

		expect(race).toBeDefined()
		expect(race?.country).toBeUndefined()
	})
})

describe("bare-region dominance (#1650)", () => {
	const US_STATES: ResolvedPlace[] = [
		{
			id: 20,
			name: "Georgia",
			placetype: "region",
			country: "US",
			lat: 32.6781,
			lon: -83.2229,
			score: 7.0425,
			prominence: 4,
			population: 11_029_227,
			exactMatch: true,
		},
		{
			id: 21,
			name: "Georgia",
			placetype: "locality",
			country: "US",
			lat: 44.7282,
			lon: -73.1276,
			score: 3.672,
			prominence: 3.672,
			population: 4697,
			exactMatch: true,
		},
		{
			id: 22,
			name: "New York",
			placetype: "region",
			country: "US",
			lat: 42.9,
			lon: -75.6,
			score: 7.2917,
			prominence: 4,
			population: 19_571_216,
			exactMatch: true,
		},
		{
			id: 23,
			name: "New York",
			placetype: "locality",
			country: "US",
			lat: 40.7127,
			lon: -74.006,
			score: 6.9465,
			prominence: 4,
			population: 8_840_134,
			exactMatch: true,
		},
	]

	const backend = (): ResolverBackend => ({
		async findPlace(query) {
			const key = norm(query.text)
			const want = Array.isArray(query.placetype) ? query.placetype : query.placetype ? [query.placetype] : null

			return US_STATES.filter(
				(p) =>
					norm(p.name) === key &&
					(!want || want.includes(p.placetype) || (want.includes("locality") && p.placetype === "locality"))
			).map((p) => ({ ...p }))
		},
	})

	const bare = (value: string) => ({
		raw: value,
		roots: [node({ tag: "locality", value, start: 0, end: value.length, confidence: 0.9 })],
	})

	it("promotes a DOMINANT region namesake over a hamlet (bare Georgia → the 11M state)", async () => {
		const out = await createWOFResolver(backend()).resolveTree(bare("Georgia"))
		const root = out.roots[0]!

		expect(root.metadata?.["bare_region_repick"]).toBe(true)
		expect(root.lat).toBeCloseTo(32.6781, 3)
	})

	it("does NOT promote under the dominance margin (bare New York stays the city)", async () => {
		// State 19.57M vs city 8.84M: log-margin 0.345, under the 0.5 threshold — the famous city holds.
		const out = await createWOFResolver(backend()).resolveTree(bare("New York"))
		const root = out.roots[0]!

		expect(root.metadata?.["bare_region_repick"]).toBeUndefined()
		expect(root.lat).toBeCloseTo(40.7127, 3)
	})
})
