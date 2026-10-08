/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { ResolveOpts } from "@mailwoman/core/resolver"
import { describe, expect, it } from "vitest"

import { extractGeocodeResult } from "#geocode/result"
import { applyStreetMissFallback } from "#street/miss-fallback"

const STREET_TREE: AddressTree = {
	raw: "Vaduz",
	roots: [{ tag: "street", value: "Vaduz", start: 0, end: 5, confidence: 0.6, children: [] }],
}

const MISS = extractGeocodeResult("Vaduz", STREET_TREE)

async function retryOptsFor(opts: ResolveOpts): Promise<ResolveOpts | undefined> {
	let seen: ResolveOpts | undefined

	await applyStreetMissFallback(MISS, {
		tree: STREET_TREE,
		opts,
		deps: {
			resolver: {
				resolveTree: async (tree, retryOpts) => {
					seen = retryOpts

					return tree
				},
			},
		},
		input: "Vaduz",
		forkDeclared: false,
		extract: () => MISS,
	})

	return seen
}

describe("applyStreetMissFallback", () => {
	it("drops an inferred country scope and the placer's evidence from the retry", async () => {
		const seen = await retryOptsFor({
			defaultCountry: { country: "US", source: "inferred" },
			hardCountry: "US",
			anchorPosterior: { US: 1 },
			maxLookups: 3,
		})

		expect(seen).toEqual({ maxLookups: 3 })
	})

	it("keeps a caller's country scope", async () => {
		const seen = await retryOptsFor({ defaultCountry: { country: "LI", source: "caller" }, hardCountry: "LI" })

		expect(seen).toEqual({ defaultCountry: { country: "LI", source: "caller" } })
	})
})
