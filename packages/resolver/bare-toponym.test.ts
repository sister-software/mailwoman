/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #17 bare city-name disambiguation, at the tier that actually answers a bare toponym.
 *
 *   The model reads a bare famous name as a `street` ("Zürich", "Berlin", "Moscow", "Fulda"), so it
 *   never reaches the admin walk and span-rescore is the only tier that resolves it. That tier takes
 *   the caller's `country` as a HARD gazetteer filter — and for this query shape the caller's country
 *   is a LOCALE DEFAULT, not knowledge (span-rescore.ts already says so, at the #961 block). Measured
 *   through the compiled CLI on 2026-08-10: `geocode --locale en-US 'Zürich'` returns Zurich, Kansas
 *   (population 81), 8,043 km from the gold; `--locale en-GB 'Zürich'` returns nothing at all.
 *
 *   The fix is the #912 lever, applied where the bare-toponym class is actually decided: when the span
 *   covers the WHOLE unqualified input, probe the gazetteer unscoped and let the locale country be an
 *   additive bonus instead of a filter. Everything else — a postcode, a region qualifier, a partial
 *   span — keeps the hard filter byte-for-byte.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import type { ResolvedPlace, ResolverBackend } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { createWOFResolver } from "./resolve.ts"
import { findRescoreCandidate } from "./span-rescore.ts"

/**
 * The backend's name key: fold diacritics AWAY (`Zürich` → `zurich`), the way `normalizeLocalityForKey` does. Dropping
 * combining marks rather than replacing them with a space is the whole point — replace, and `Zürich` keys as `zu rich`
 * and matches nothing it should.
 */
const norm = (s: string): string =>
	s
		.toLowerCase()
		.normalize("NFD")
		.replaceAll(/\p{M}/gu, "")
		.replaceAll(/[^a-z0-9 ]/g, " ")
		.replaceAll(/\s+/g, " ")
		.trim()

/**
 * Live rows off the shipped `candidate.db`, 2026-08-10 (`prominence` = log10(population + 1)).
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
	// Manchester: the in-country answer the soft prior must KEEP (NH 5.06 + 2 > GB 5.74).
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
	// Weimar / Thüringen: the longest-wins trap. "Thüringen" is a REAL exact match (an AT locality),
	// so a 2-token span that happens to contain it must not outrank the 1-token gold.
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
	// A postcode → point for the not-bare guard; sits on Berlin, Wisconsin (id 5) so the gate ADMITS it.
	{ id: 900, name: "54923", placetype: "postalcode", country: "US", lat: 43.97, lon: -88.95, score: 1 },
]

function makeBackend(calls?: Array<{ text: string; country?: string; limit?: number }>): ResolverBackend {
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
		const hit = await findRescoreCandidate(raw, roots, makeBackend(), { country: "US" })

		expect(hit?.place.country).toBe("CH")
		expect(hit?.place.id).toBe(1)
	})

	it("resolves a bare 'Zürich' under an en-GB locale instead of returning nothing", async () => {
		// GB holds no Zurich at all, so the hard filter made this an EMPTY result — the worst answer.
		const raw = "Zürich"
		const roots = [node({ tag: "street", value: raw, start: 0, end: raw.length })]
		const hit = await findRescoreCandidate(raw, roots, makeBackend(), { country: "GB" })

		expect(hit?.place.country).toBe("CH")
	})

	it("KEEPS the in-country answer when the locale bonus carries it (Manchester under en-US)", async () => {
		const raw = "Manchester"
		const roots = [node({ tag: "street", value: raw, start: 0, end: raw.length })]
		const hit = await findRescoreCandidate(raw, roots, makeBackend(), { country: "US" })

		expect(hit?.place.country).toBe("US")
		expect(hit?.place.id).toBe(7)
	})

	it("carries the losing namesakes as alternatives so the ambiguity margin stays computable", async () => {
		const raw = "Zürich"
		const roots = [node({ tag: "street", value: raw, start: 0, end: raw.length })]
		const hit = await findRescoreCandidate(raw, roots, makeBackend(), { country: "US" })

		expect(hit?.alternatives.map((a) => a.country)).toContain("US")
	})

	it("does NOT fire when a postcode qualifies the query (the hard filter stands)", async () => {
		// A postcode is knowledge, not a locale guess — it has already picked the country.
		const raw = "Berlin 54923"

		const roots = [
			node({ tag: "street", value: "Berlin", start: 0, end: 6 }),
			node({ tag: "postcode", value: "54923", start: 7, end: 12, confidence: 0.95 }),
		]

		const hit = await findRescoreCandidate(raw, roots, makeBackend(), { country: "US", postcode: "54923" })
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

		const hit = await findRescoreCandidate(raw, roots, makeBackend(), { country: "US" })
		expect(hit?.place.country).toBe("US")
	})

	it("does NOT fire when the span is only PART of the raw input", async () => {
		// "Weimar Thüringen": the whole-input span finds nothing, so the 1-token fallbacks stay scoped —
		// and the DE-scoped 'Weimar' probe is exactly the gold. A partial span is not a bare toponym.
		const raw = "Weimar Thüringen"
		const roots = [node({ tag: "street", value: raw, start: 0, end: raw.length })]
		const calls: Array<{ text: string; country?: string }> = []
		const hit = await findRescoreCandidate(raw, roots, makeBackend(calls), { country: "DE" })

		expect(hit?.place.id).toBe(8) // Weimar DE, not Thüringen AT
		expect(calls.filter((c) => c.text === "Thüringen").every((c) => c.country === "DE")).toBe(true)
	})

	it("is byte-stable when the caller supplied no country at all", async () => {
		const raw = "Berlin"
		const roots = [node({ tag: "street", value: raw, start: 0, end: raw.length })]
		const calls: Array<{ text: string; country?: string; limit?: number }> = []
		const hit = await findRescoreCandidate(raw, roots, makeBackend(calls), {})

		expect(hit?.place.country).toBe("DE")
		// One probe per span, exactly as before — no widened re-probe when there is no filter to soften.
		expect(calls).toHaveLength(1)
	})

	it("accepts an explicit weight so the prior can be tuned or disabled", async () => {
		const raw = "Zürich"
		const roots = [node({ tag: "street", value: raw, start: 0, end: raw.length })]

		const hit = await findRescoreCandidate(raw, roots, makeBackend(), {
			country: "US",
			bareToponymCountryWeight: 99,
		})

		expect(hit?.place.country).toBe("US")
	})

	it("opts out entirely with bareToponymSoftCountry: false", async () => {
		const raw = "Zürich"
		const roots = [node({ tag: "street", value: raw, start: 0, end: raw.length })]

		const hit = await findRescoreCandidate(raw, roots, makeBackend(), {
			country: "US",
			bareToponymSoftCountry: false,
		})

		expect(hit?.place.country).toBe("US")
		expect(hit?.place.id).toBe(2)
	})
})

/**
 * The other half of the bare-toponym class: the queries the model DOES tag `locality`, which reach the admin walk
 * instead of span-rescore. `Whitby` / `Warwick` / `Epping` / `Windsor` all land here, and no country reaches the
 * resolver for them at all (the #912 guard upstream drops the locale default for a bare-locality tree), so the pick is
 * population and nothing else. Importance is the only key that separates them — see `toponym-prior.ts` for the measured
 * table.
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
		// Fame is the prior of LAST resort — it answers "which one did you probably mean" only when
		// nothing in the query answered it. A #369 anchor posterior is derived from the address's own
		// postcode, which is evidence, and evidence outranks a prior every time.
		const withScores = WHITBY.map((c, i) => ({ ...c, importance: i === 0 ? 0.5089 : 0.5496 }))
		const out = await walk(withScores, { anchorPosterior: { CA: 1 } })
		expect(out.roots[0]?.metadata?.["resolver_country"]).toBe("CA")
	})

	/**
	 * #27 — the OTHER half of the #912 lever. A bare toponym the model tags `locality` never reaches span-rescore (the
	 * tree resolves, so the #685 brake holds), so the soft country prior that fixed `Zürich` cannot see it. The CLI's
	 * answer today is to drop the locale country entirely, which is why `--locale en-GB Whitby` and `--default-country GB
	 * Whitby` disagree.
	 *
	 * OPT-IN, and the calibration is in `ResolveOpts.localeCountryPrior`: the weight that flips these four is disjoint
	 * from the weight that holds the en-US board. The lever is here, tested, and off.
	 */
	it("promotes the in-locale-country namesake when the locale prior is supplied (#27)", async () => {
		const out = await walk(WHITBY, { localeCountryPrior: "GB" })
		expect(out.roots[0]?.metadata?.["resolver_country"]).toBe("GB")
	})

	it("is byte-stable when no locale prior is supplied (the shipped default)", async () => {
		const out = await walk(WHITBY, {})
		expect(out.roots[0]?.metadata?.["resolver_country"]).toBe("CA")
	})

	it("is additive, never a filter — a dominant foreign bearer still wins", async () => {
		// Paris FR (6.34) over Paris TX (4.40 + 2 = 6.40)? No: the bonus DOES flip this one, which is
		// exactly why the lever ships off. What must hold is that the prior cannot make a place the
		// gazetteer never returned appear — `weight: 0` is the identity, and the foreign bearer survives.
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
 * The bare-COUNTRY class: "Japan" / "China" / "Germany" as the whole query. Two independent defects, measured through
 * the compiled CLI on 2026-08-13 against the shipped candidate.db (which carries every country at `placetype: country`
 * with real centroids and `is_primary = 1`):
 *
 * - The parser tags bare country names `locality` about half the time (Japan, China, Nigeria, Australia — vs France,
 *   Germany, United States tagged `country`), and the locality placetype filter made the country row unreachable at any
 *   rank: bare `Japan` answered Japan, Pennsylvania. Fix: the lone bare locality-tagged span ALSO races the `country`
 *   placetype, prominence arbitrates.
 * - Even a CORRECT `country` tag failed under the locale-inferred default scope: the hard filter can only admit the scope
 *   country itself, so bare `Germany` under en-US filtered out the DE row and fell to Camp Dennison, Ohio (an FTS alias
 *   — its historical name is "Germany"). Fix: an INFERRED scope is withheld from `country`-placetype lookups; an
 *   explicit scope stays supreme.
 */
describe("bare-country class", () => {
	const WORLD: ResolvedPlace[] = [
		// prominence = log10(population + 1), the #938 unit — Japan 126,264,931 / Germany 83,237,124.
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

	it("never fires without a country namesake — bare 'Paris' is byte-stable", async () => {
		const out = await createWOFResolver(backend()).resolveTree(bareTree("locality", "Paris"))
		const root = out.roots[0]!

		expect(root.metadata?.["resolver_country"]).toBe("FR")
		expect(root.metadata?.["bare_country_repick"]).toBeUndefined()
	})

	it("never fires on an address-shaped tree — a second value-bearing node keeps the race off", async () => {
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
		// Under the inferred posture the caller (the #912 guard) has already withheld the scope for the
		// bare-locality shape, so the race runs worldwide; nothing here asserts an inferred locality
		// filter, because that combination does not reach the resolver in production.
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
		// State 19.57M vs city 8.84M: log-margin 0.345, under the 0.5 cut — the famous city holds.
		const out = await createWOFResolver(backend()).resolveTree(bare("New York"))
		const root = out.roots[0]!

		expect(root.metadata?.["bare_region_repick"]).toBeUndefined()
		expect(root.lat).toBeCloseTo(40.7127, 3)
	})
})
