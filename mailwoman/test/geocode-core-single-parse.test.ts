/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The single-parse dedupe surface: `geocodeAddress` accepts a pre-parsed `parsedTree` and skips its
 *   internal `classifier.parse` when given one, and `parseForGeocode` exposes that exact parse so a
 *   caller can run it once and feed both the geocode and a PostalAddress. Fakes the classifier/resolver
 *   — no weights/WOF needed.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { ResolveOpts, Resolver } from "@mailwoman/resolver"
import { describe, expect, test, vi } from "vitest"

import { geocodeAddress, type GeocodeClassifier, parseForGeocode } from "../geocode-core.js"

function fakeClassifier(tree: AddressTree): GeocodeClassifier {
	return { parse: vi.fn(async () => tree) }
}

function captureResolver(): { resolver: Resolver; seen: AddressTree[] } {
	const seen: AddressTree[] = []
	const resolver: Resolver = {
		resolveTree: vi.fn(async (tree: AddressTree, _opts?: ResolveOpts) => {
			seen.push(tree)

			return tree
		}),
	}

	return { resolver, seen }
}

const emptyTree: AddressTree = { raw: "x", roots: [] }

describe("geocodeAddress — parsedTree dedupe", () => {
	test("a supplied parsedTree skips classifier.parse and is what the resolver resolves", async () => {
		const classifier = fakeClassifier(emptyTree)
		const { resolver, seen } = captureResolver()
		const provided: AddressTree = { raw: "pre-parsed", roots: [] }

		await geocodeAddress("500 N Hiatus Rd, Pembroke Pines, FL", {
			classifier,
			resolver,
			placeCountry: false,
			parsedTree: provided,
		})

		expect(classifier.parse).not.toHaveBeenCalled()
		expect(seen[0]).toBe(provided)
	})

	test("without parsedTree, classifier.parse runs exactly once (the default path)", async () => {
		const classifier = fakeClassifier(emptyTree)
		const { resolver } = captureResolver()

		await geocodeAddress("500 N Hiatus Rd, Pembroke Pines, FL", { classifier, resolver, placeCountry: false })

		expect(classifier.parse).toHaveBeenCalledTimes(1)
	})
})

describe("parseForGeocode", () => {
	test("parses once with the geocode options (postcodeRepair + normalizeCase) and returns a tree", async () => {
		const classifier = fakeClassifier(emptyTree)

		const tree = await parseForGeocode("500 N HIATUS RD, PEMBROKE PINES, FL", {
			classifier,
			resolver: captureResolver().resolver,
		})

		expect(classifier.parse).toHaveBeenCalledTimes(1)
		expect(classifier.parse).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ postcodeRepair: true, normalizeCase: true })
		)
		expect(tree).toBeDefined()
	})

	test("a tree from parseForGeocode, fed back as parsedTree, reaches the resolver unchanged", async () => {
		const classifier = fakeClassifier(emptyTree)
		const { resolver, seen } = captureResolver()

		const tree = await parseForGeocode("x", { classifier, resolver })
		await geocodeAddress("x", { classifier, resolver, placeCountry: false, parsedTree: tree })

		// parseForGeocode parsed once; geocodeAddress did not parse again.
		expect(classifier.parse).toHaveBeenCalledTimes(1)
		expect(seen.at(-1)).toBe(tree)
	})
})
