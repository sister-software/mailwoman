// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The scope a runtime pipeline reads its bundled defaults from.
 *
 *   The defaults were module-level caches, shared by every pipeline in a process and closed by none.
 *   A pipeline now builds them on its own scope, or reads them from a parent scope.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { ResolveOpts, Resolver } from "@mailwoman/core/resolver"
import { ServiceRegistry } from "async-init"
import { describe, expect, it, vi } from "vitest"

import { type PlaceCountryFn, PlaceCountryService } from "#default/placer"
import { createRuntimePipeline, registerRuntimePipelineServices } from "#runtime-pipeline"

const ADDRESS = "12 rue de la Paix, 75002 Paris"

/**
 * A classifier that returns one street node, so the pipeline takes its full path and reaches the resolver.
 */
const classifier = {
	parse: async (text: string): Promise<AddressTree> => ({
		raw: text,
		roots: [{ tag: "street", value: "rue de la Paix", start: 3, end: 17, confidence: 0.9, children: [] }],
	}),
}

function capturingResolver(): { resolver: Resolver; seen: ResolveOpts[] } {
	const seen: ResolveOpts[] = []

	return {
		seen,
		resolver: {
			resolveTree: async (tree, opts) => {
				seen.push(opts ?? {})

				return tree
			},
			artifactCoverage: null,
		},
	}
}

describe("createRuntimePipeline: the scope of its bundled defaults", () => {
	it("reads the place-country function its parent scope provides, built once for two pipelines", async () => {
		await using scope = new ServiceRegistry()
		const placeCountry: PlaceCountryFn = () => ({ country: "FR", confidence: 0.99, posterior: { FR: 0.99, BE: 0.01 } })
		const build = vi.fn(async () => placeCountry)

		scope.define(PlaceCountryService, { build })

		const first = capturingResolver()
		const second = capturingResolver()

		await using one = createRuntimePipeline({ classifier, resolver: first.resolver }, { parent: scope })
		await using two = createRuntimePipeline({ classifier, resolver: second.resolver }, { parent: scope })

		await one(ADDRESS)
		await two(ADDRESS)

		expect(build).toHaveBeenCalledTimes(1)
		expect(first.seen[0]?.anchorPosterior).toEqual({ FR: 0.99, BE: 0.01 })
		expect(second.seen[0]?.anchorPosterior).toEqual({ FR: 0.99, BE: 0.01 })
	})

	it("leaves a parent's service loaded when the pipeline is disposed", async () => {
		await using scope = new ServiceRegistry()
		const release = vi.fn()

		scope.define(PlaceCountryService, { build: async () => null, release })

		{
			await using pipeline = createRuntimePipeline({ classifier }, { parent: scope })

			await pipeline(ADDRESS)
		}

		expect(release).not.toHaveBeenCalled()
	})

	it("registers each default once on a shared scope, and skips the ones the scope already has", async () => {
		await using scope = new ServiceRegistry()

		registerRuntimePipelineServices(scope)

		const registered = scope.graph().map((service) => service.token.description)

		expect(registered).toEqual(
			expect.arrayContaining(["place-country", "street-evidence", "reverse-geocoder", "resolver-module"])
		)

		registerRuntimePipelineServices(scope)

		expect(scope.graph()).toHaveLength(registered.length)
	})
})
