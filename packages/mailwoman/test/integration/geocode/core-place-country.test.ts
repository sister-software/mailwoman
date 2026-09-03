/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the coarse-placer soft-prior wiring in `geocodeAddress` (#244, M1 step C). Fakes
 *   the classifier + resolver so the test captures the `ResolveOpts` the cascade hands the resolver
 *   — no WOF / weights / databases needed. Pins the contract: a confident in-map guess injects an
 *   `anchorPosterior`; abstain / off-map / no-stage are byte-stable no-ops; an explicit
 *   `defaultCountry` still flows alongside.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { ResolveOpts, Resolver } from "@mailwoman/resolver"
import { geocodeAddress, type GeocodeClassifier } from "mailwoman/geocode"
import { describe, expect, test, vi } from "vitest"

/**
 * A classifier that returns a fixed tree (no region → admin-only path, no databases needed).
 */
function fakeClassifier(tree: AddressTree): GeocodeClassifier {
	return { parse: vi.fn(async () => tree) }
}

/**
 * A resolver that records the ResolveOpts it was handed and echoes the tree back.
 */
function captureResolver(): { resolver: Resolver; seen: ResolveOpts[] } {
	const seen: ResolveOpts[] = []

	const resolver: Resolver = {
		resolveTree: vi.fn(async (tree, opts) => {
			seen.push(opts ?? {})

			return tree
		}),
	}

	return { resolver, seen }
}

const emptyTree: AddressTree = { raw: "x", roots: [] }

describe("geocodeAddress — coarse-placer soft prior (#244)", () => {
	test("placeCountry: false ⇒ no anchorPosterior (the disable / byte-stable path)", async () => {
		const { resolver, seen } = captureResolver()

		await geocodeAddress("12 rue de la Paix, Paris", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			placeCountry: false,
		})

		expect(seen[0]?.anchorPosterior).toBeUndefined()
		expect(seen[0]?.anchorWeight).toBeUndefined()
	})

	test("default-on (no placeCountry) ⇒ the bundled placer injects the in-map distribution for a clear address", async () => {
		const { resolver, seen } = captureResolver()
		// No `placeCountry` → geocodeAddress lazy-loads the bundled coarse-placer (#244 default-on).
		await geocodeAddress("350 5th Ave, New York, NY 10118", { classifier: fakeClassifier(emptyTree), resolver })
		const post = seen[0]?.anchorPosterior
		expect(post, "default-on should inject a country posterior for a clear in-map address").toBeDefined()
		const entries = Object.entries(post ?? {})
		// Residual upgrade: a full per-in-map-country DISTRIBUTION, not the one-hot argmax.
		expect(entries.length).toBeGreaterThan(1)

		for (const [c, p] of entries) {
			expect(c).toMatch(/^[A-Z]{2}$/) // 2-letter in-map country (never OTHER)
			expect(p).toBeGreaterThanOrEqual(0)
		}

		// US is the unambiguous winner for this address.
		const top = entries.toSorted((a, b) => b[1] - a[1])[0]!
		expect(top[0]).toBe("US")
		expect(seen[0]?.anchorWeight).toBe(1)
	})

	test("a confident in-map guess injects an anchorPosterior + weight", async () => {
		const { resolver, seen } = captureResolver()
		const placeCountry = vi.fn(() => ({ country: "FR", confidence: 0.94 }))

		await geocodeAddress("12 rue de la Paix, Paris", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			placeCountry,
		})

		expect(placeCountry).toHaveBeenCalledWith("12 rue de la Paix, Paris")
		expect(seen[0]).toMatchObject({ anchorPosterior: { FR: 0.94 }, anchorWeight: 1 })
	})

	test("an explicit defaultCountry flows alongside the injected posterior", async () => {
		const { resolver, seen } = captureResolver()
		const placeCountry = vi.fn(() => ({ country: "DE", confidence: 0.97 }))

		await geocodeAddress("Hauptstraße 5, Berlin", {
			classifier: fakeClassifier(emptyTree),
			resolver,
			defaultCountry: "DE",
			placeCountry,
		})

		expect(seen[0]).toMatchObject({ defaultCountry: "DE", anchorPosterior: { DE: 0.97 } })
	})

	test("abstain (country: null) ⇒ no posterior injected", async () => {
		const { resolver, seen } = captureResolver()
		const placeCountry = vi.fn(() => ({ country: null, confidence: 0.3 }))
		await geocodeAddress("ambiguous", { classifier: fakeClassifier(emptyTree), resolver, placeCountry })
		expect(seen[0]?.anchorPosterior).toBeUndefined()
	})

	test("off-map (OTHER) ⇒ no posterior injected", async () => {
		const { resolver, seen } = captureResolver()
		const placeCountry = vi.fn(() => ({ country: "OTHER", confidence: 0.99 }))
		await geocodeAddress("улица Пушкина", { classifier: fakeClassifier(emptyTree), resolver, placeCountry })
		expect(seen[0]?.anchorPosterior).toBeUndefined()
	})
})

describe("geocodeAddress — the dominant-bearer guard on hardCountry (#1738)", () => {
	const node = (tag: "street" | "locality", value: string) => ({
		tag,
		value,
		start: 0,
		end: value.length,
		confidence: 0.95,
		children: [],
	})

	/**
	 * A street + locality tree — NOT bare-locality, so the placer block runs (the #912 change skips bare trees).
	 */
	const treeWithLocality = (locality: string): AddressTree => ({
		raw: `1001 Rue X, ${locality}`,
		roots: [node("street", "Rue X"), node("locality", locality)],
	})

	const placerFR = () => ({ country: "FR", confidence: 0.97 })

	function guardResolver(dominant: { country: string; exactMatch?: boolean } | undefined): {
		resolver: Resolver
		seen: ResolveOpts[]
	} {
		const { resolver, seen } = captureResolver()

		resolver.findPlace = vi.fn(async () =>
			dominant
				? [
						{
							id: 1,
							name: "x",
							placetype: "locality",
							country: dominant.country,
							lat: 45,
							lon: -73,
							score: 9,
							...(dominant.exactMatch === undefined ? {} : { exactMatch: dominant.exactMatch }),
						},
					]
				: []
		)

		return { resolver, seen }
	}

	// CONTRACT CHANGE, #1751 narrowing #1738. This test asserted `anchorPosterior` SURVIVED a disagreeing
	// bearer — "the placer's posterior stays the SOFT anchor the worldwide race weighs". At
	// `COARSE_PLACER_ANCHOR_WEIGHT = 1` that anchor is not soft: the within-tier key is
	// `(prominence ?? score) + w · posterior[country]`, so on `Queen Street, Bristol` a 0.9261 posterior
	// gap overturned GB Bristol's 0.884776 prominence lead and the answer moved 5,274 km to Connecticut.
	// A prior that decides is not a prior.
	//
	// So a disagreeing bearer now withholds BOTH. The outcome #1738 protects is unchanged — measured
	// end to end, `1001 Boulevard Saint-Laurent, Montréal` still answers 45.5079245, -73.5593271, CA —
	// and the board is identical on both arms (gauntlet 382/383, 449/591 resolved, same tier tally).
	//
	// The alternative that would preserve #1738's wording is to keep the posterior at a REDUCED weight
	// it cannot decide with. That needs a measured weight rather than a chosen one (#1740's complaint
	// about `placeCountryThreshold`), and no population exists to measure it on yet.
	test("a DISAGREEING dominant bearer withholds the placer entirely — Montréal under French text", async () => {
		const { resolver, seen } = guardResolver({ country: "CA", exactMatch: true })

		await geocodeAddress("1001 Rue X, Montréal", {
			classifier: fakeClassifier(treeWithLocality("Montréal")),
			resolver,
			placeCountry: placerFR,
		})

		expect(seen[0]?.hardCountry).toBeUndefined()
		expect(seen[0]?.anchorPosterior).toBeUndefined()
	})

	// The other half of the contract, unchanged and worth pinning: an AGREEING bearer still gets the
	// soft posterior. Withholding on agreement would retire the placer, not narrow it.
	test("an AGREEING dominant bearer still gets the soft posterior", async () => {
		const { resolver, seen } = guardResolver({ country: "FR", exactMatch: true })

		await geocodeAddress("1001 Rue X, Paris", {
			classifier: fakeClassifier(treeWithLocality("Paris")),
			resolver,
			placeCountry: placerFR,
		})

		expect(seen[0]?.anchorPosterior).toMatchObject({ FR: 0.97 })
	})

	test("an AGREEING dominant bearer hardens exactly as before — Paris under French text", async () => {
		const { resolver, seen } = guardResolver({ country: "FR", exactMatch: true })

		await geocodeAddress("1001 Rue X, Paris", {
			classifier: fakeClassifier(treeWithLocality("Paris")),
			resolver,
			placeCountry: placerFR,
		})

		expect(seen[0]?.hardCountry).toBe("FR")
	})

	test("an unknown locality is not disagreement — hardens as before", async () => {
		const { resolver, seen } = guardResolver(undefined)

		await geocodeAddress("1001 Rue X, Zzyzzx", {
			classifier: fakeClassifier(treeWithLocality("Zzyzzx")),
			resolver,
			placeCountry: placerFR,
		})

		expect(seen[0]?.hardCountry).toBe("FR")
	})

	test("a FUZZY top bearer is not disagreement — only an exact bearer may soften", async () => {
		const { resolver, seen } = guardResolver({ country: "CA", exactMatch: false })

		await geocodeAddress("1001 Rue X, Montréa", {
			classifier: fakeClassifier(treeWithLocality("Montréa")),
			resolver,
			placeCountry: placerFR,
		})

		expect(seen[0]?.hardCountry).toBe("FR")
	})

	test("a resolver WITHOUT the findPlace passthrough hardens exactly as before — absence degrades honestly", async () => {
		const { resolver, seen } = captureResolver()

		await geocodeAddress("1001 Rue X, Montréal", {
			classifier: fakeClassifier(treeWithLocality("Montréal")),
			resolver,
			placeCountry: placerFR,
		})

		expect(seen[0]?.hardCountry).toBe("FR")
	})
})
