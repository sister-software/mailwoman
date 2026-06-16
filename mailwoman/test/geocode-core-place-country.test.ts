/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the coarse-placer soft-prior wiring in `geocodeAddress` (#244, M1 step C). Fakes
 *   the classifier + resolver so the test captures the `ResolveOpts` the cascade hands the resolver
 *   — no WOF / weights / shards needed. Pins the contract: a confident in-map guess injects an
 *   `anchorPosterior`; abstain / off-map / no-stage are byte-stable no-ops; an explicit
 *   `defaultCountry` still flows alongside.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { ResolveOpts, Resolver } from "@mailwoman/core/resolver"
import { describe, expect, test, vi } from "vitest"

import { geocodeAddress, type GeocodeClassifier } from "../geocode-core.js"

/** A classifier that returns a fixed tree (no region → admin-only path, no shards needed). */
function fakeClassifier(tree: AddressTree): GeocodeClassifier {
	return { parse: vi.fn(async () => tree) }
}

/** A resolver that records the ResolveOpts it was handed and echoes the tree back. */
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
		const top = entries.sort((a, b) => b[1] - a[1])[0]!
		expect(top[0]).toBe("US")
		expect(seen[0]?.anchorWeight).toBe(1.0)
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
		expect(seen[0]).toMatchObject({ anchorPosterior: { FR: 0.94 }, anchorWeight: 1.0 })
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
