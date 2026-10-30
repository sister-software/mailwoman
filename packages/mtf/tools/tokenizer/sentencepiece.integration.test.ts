/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Native `spm_train` writes the Python wheel's model, byte for byte.
 *
 *   `test/fixtures/spm-recipes/recipes.json` records five training calls the sentencepiece 0.2.2 wheel made, each in
 *   a directory holding the recipe's input as `input.txt`, and the SHA-256 of the model and vocabulary the wheel
 *   wrote. The recipes cover a comma symbol, the default symbol list, the identity normalizer with eight threads, an
 *   empty symbol list, and explicit trainer defaults. The test makes the same calls through `trainSentencePiece`.
 *
 *   The test needs a built `spm_train`. It runs when the cache root holds one (`spmTrainBinary` builds it on first
 *   use) and is skipped otherwise, so a host without CMake does not fail the suite.
 */

import { cacheRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { isFile } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { copyFileTo } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { workspacePath } from "@mailwoman/core/paths"
import { beforeAll, describe, expect, it } from "vitest"

import { mtfTokenizerBinary, SENTENCEPIECE } from "./binary.ts"
import { measureByteFallback } from "./byte-fallback.ts"
import { loadEncoder } from "./model.ts"
import { type TrainerFlags, trainSentencePiece } from "./sentencepiece.ts"

interface Recipe {
	name: string
	input: string
	flags: TrainerFlags
	model_sha256: string
	vocab_sha256: string
}

const fixtures = workspacePath("mtf", "test", "fixtures", "spm-recipes")
const spmTrain = cacheRootPath(`sentencepiece-${SENTENCEPIECE.tag}`, "build", "src", "spm_train")
const available = await isFile(spmTrain)
const { recipes } = await readLocalJSONFile<{ recipes: Recipe[] }>(`${fixtures}/recipes.json`)

async function train(recipe: Recipe, directory: string) {
	await copyFileTo(`${fixtures}/${recipe.input}`, `${directory}/input.txt`)

	return trainSentencePiece(recipe.flags, { spmTrain, workDirectory: directory, cwd: directory })
}

if (!available) {
	console.warn(`skipped: the recipe test needs a built spm_train at ${spmTrain}, and this host has none`)
}

describe.skipIf(!available)("native spm_train in the wheel's form (requires a built spm_train)", () => {
	// The first call compiles `mtf-tokenizer` when the checkout has no current build.
	beforeAll(async () => {
		await mtfTokenizerBinary()
	}, 600_000)

	it.each(recipes.map((recipe) => [recipe.name, recipe] as const))("%s trains the wheel's bytes", async (_, recipe) => {
		await using scratch = await temporaryDirectory("spm-recipe-")
		const trained = await train(recipe, scratch.path.toString())

		await expect(sha256File(trained.model)).resolves.toBe(recipe.model_sha256)
		await expect(sha256File(trained.vocab)).resolves.toBe(recipe.vocab_sha256)
	})

	it("keeps a user-defined symbol whole, including a comma", async () => {
		await using scratch = await temporaryDirectory("spm-recipe-")
		const recipe = recipes.find((r) => r.name === "comma-symbol")!
		const trained = await train(recipe, scratch.path.toString())

		using encoder = await loadEncoder(trained.model)

		expect(encoder.encode("PO Box 12, Paris").pieces).toEqual(expect.arrayContaining(["PO▁Box", ","]))
	})

	it("buckets byte fallback per script", async () => {
		await using scratch = await temporaryDirectory("spm-recipe-")

		const trained = await train(
			recipes.find((r) => r.name === "comma-symbol")!,
			scratch.path.toString()
		)

		const report = await measureByteFallback(trained.model, ["Paris 75008", "  ", "東京都新宿区", "Москва Тверская"])

		expect(report.overall.lines).toBe(3)
		expect(report.per_script["latin"]!.byte_fallback_pieces).toBe(0)
		expect(report.per_script["cjk"]!.byte_fallback_pieces).toBeGreaterThan(0)
		expect(report.per_script["cyrillic"]!.byte_fallback_pieces).toBeGreaterThan(0)

		const empty = await measureByteFallback(trained.model, [])

		expect(empty.overall).toEqual({ lines: 0, pieces: 0, byte_fallback_pieces: 0, rate: 0 })
	})
})
