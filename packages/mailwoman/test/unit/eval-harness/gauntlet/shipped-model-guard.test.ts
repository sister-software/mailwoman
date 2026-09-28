/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Because the guard runs only when the model path exists, it must obtain the graded artifact from
 *   `resolveWeights()`, never from a package path literal, or a missing path silently disables it.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

const HARNESS = repoRootPath("packages", "mailwoman", "lib", "eval-harness", "gauntlet", "harness.ts")

describe("the #1024 shipped-model guard", () => {
	it("derives the graded model from the resolver, never from a package path literal", async () => {
		const source = await readLocalTextFile(HARNESS)

		// The card path is deliberately not matched: a model-card is committed to its package,
		// so reading it there is a fact about the repo rather than an assumption about
		// where binaries were materialized.
		const literals = [...source.matchAll(/["'`][^"'`]*neural-weights-[a-z-]+\/(?:model\.onnx|tokenizer\.model)/g)]

		expect(
			literals.map((m) => m[0]),
			"the graded artifact must come from resolveWeights(), so the guard follows the loader"
		).toEqual([])
	})

	it("still asks the resolver for the default run", async () => {
		const source = await readLocalTextFile(HARNESS)

		expect(source).toContain('resolveWeights({ locale: "en-us" })')
	})

	it("keeps the assertion reachable — it runs only for the SHIPPED default, and that branch still exists", async () => {
		const source = await readLocalTextFile(HARNESS)

		// A `--candidate` run is exempt on purpose; if that exemption widened to the default,
		// the guard would be off for every run and no other check in the suite would notice.
		expect(source).toContain("if (!opts.modelPath && !opts.tokenizerPath && !opts.weightsCacheRoot)")
		expect(source).toContain("assertShippedModelMatchesCard(md5)")
	})
})
