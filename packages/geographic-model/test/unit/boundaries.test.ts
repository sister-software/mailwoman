/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two constraints the boundary record
 *   (`docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md`) hands this package that are
 *   checkable before any ontology record exists.
 *
 *   Both are written to keep failing usefully as the package grows, rather than to describe today's
 *   empty state: the first reads `@mailwoman/core`'s manifest, so it answers the same question after
 *   the schema and the compiler land; the second reads whatever the public entry point exports, so a
 *   later ordering API trips it on the commit that adds it.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import * as geographicModel from "@mailwoman/geographic-model"
import { createRequire } from "@mailwoman/platform/module"
import { describe, expect, it } from "vitest"

interface Manifest {
	name: string
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
}

/**
 * Resolve a sibling manifest through its own `exports` map rather than by composing a path into `node_modules`, so a
 * hoist, a rename, or a package move reports as an unresolvable specifier instead of as an absent dependency.
 */
async function readManifest(specifier: string): Promise<Manifest> {
	return await readLocalJSONFile<Manifest>(createRequire(import.meta.url).resolve(specifier))
}

/**
 * Name fragments that would announce ranking policy on the public surface. Matched case-insensitively against every
 * exported binding, so `rankBy`, `categoryWeight`, and `POI_BOOSTS` all read as violations of the same rule.
 */
const RANKING_POLICY_FRAGMENTS = ["boost", "penalt", "weight", "rank", "score", "prioriti", "ordering"]

describe("the geographic model's recorded dependency direction", () => {
	it("keeps @mailwoman/core free of a dependency on @mailwoman/geographic-model", async () => {
		const core = await readManifest("@mailwoman/core/package.json")

		// Name the manifest that was actually read. Without this, a specifier that resolved somewhere else
		// would report zero declarations — the absence this test exists to distinguish from a real one.
		expect(core.name).toBe("@mailwoman/core")

		const declaring = (
			[
				["dependencies", core.dependencies],
				["devDependencies", core.devDependencies],
				["optionalDependencies", core.optionalDependencies],
				["peerDependencies", core.peerDependencies],
			] as const
		)
			.filter(([, field]) => field && "@mailwoman/geographic-model" in field)
			.map(([name]) => name)

		// Core ships the pipeline contract and its reference data to every consumer, so a world-semantics
		// dependency there is one every drop-in API inherits. Reversing the direction amends the boundary
		// record; it is not a convenience during implementation.
		expect(declaring).toEqual([])
	})
})

describe("the geographic model's public surface", () => {
	it("exposes no ranking, boost, penalty, or candidate-ordering binding", () => {
		const offenders = Object.keys(geographicModel).filter((name) =>
			RANKING_POLICY_FRAGMENTS.some((fragment) => name.toLowerCase().includes(fragment))
		)

		expect(offenders).toEqual([])
	})
})
