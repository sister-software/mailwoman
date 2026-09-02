/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The #1024 guard must not FAIL OPEN.
 *
 *   `assertShippedModelMatchesCard` blocks the release when the model about to be graded disagrees with
 *   `model-card.json`'s `files_md5`. It only runs inside `if (existsSync(effModel))`, so whatever names
 *   `effModel` decides whether the guard runs at all — and it named
 *   `packages/neural-weights-en-us/model.onnx` outright.
 *
 *   That literal held only while the dev linker materialized binaries into that package. The moment they
 *   live anywhere else — a data-root overlay, the user weights cache, a consumer's node_modules — the path
 *   misses, `existsSync` is false, the whole block is skipped, and the check grades a model it never
 *   verified. The classifier below it resolves properly and loads the model regardless, so nothing errors
 *   and nothing is reported: a silent ungating, which is #1024's own failure mode reproduced by the fix's
 *   own path literal.
 *
 *   This is a SOURCE check rather than a behavioural one because the property is about how the path is
 *   obtained, and the failure is an absence — there is no wrong answer to assert against, only a check that
 *   quietly stopped happening.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

const HARNESS = String(repoRootPath("packages", "mailwoman", "lib", "eval-harness", "gauntlet", "harness.ts"))

describe("the #1024 shipped-model guard", () => {
	it("derives the graded model from the resolver, never from a package path literal", async () => {
		const source = await readLocalTextFile(HARNESS)

		// Any `neural-weights-<locale>/model.onnx` or `/tokenizer.model` spelled out in a path position. The card
		// path is deliberately NOT matched: a model-card IS committed to its package, so reading it there is a fact
		// about the repo rather than an assumption about where binaries were materialized.
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

		// A `--candidate` run grades a different artifact on purpose and is exempt. If that exemption ever widens to
		// cover the default, the guard is off for every run and nothing else in the suite would notice.
		expect(source).toContain("if (!opts.modelPath && !opts.tokenizerPath && !opts.weightsCacheRoot)")
		expect(source).toContain("assertShippedModelMatchesCard(md5)")
	})
})
