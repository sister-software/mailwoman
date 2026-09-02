/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1510 — the evidence-bundle lexicons resolve from the model-card, not a hard-coded filename.
 *
 *   The defect: `resolveWeights` probed the literal `locality-surface-lexicon-v6.json` while both the
 *   shipped v4.0.1 recipe and the v4.2.0 candidate TRAIN against v7. Serving fed the channel a
 *   different lexicon generation than training painted, and nothing said so — the v6 file exists, the
 *   channel loads, the parse works. The Run B gate had to stage v7's CONTENT under the v6 FILENAME to
 *   score faithfully.
 *
 *   These tests build synthetic package layouts under a `cacheRoot.path` (the same injection point
 *   `weights.test.ts`'s pair-index gate uses) so they need no model binaries: `resolveWeights` only
 *   `existsSync`-probes `model.onnx` / `tokenizer.model`, so empty stubs are enough to reach the
 *   sibling-resolution code this file is about.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { LexiconVersionMismatchError, resolveWeights, weightsCachePackageDir } from "@mailwoman/neural/weights"
import { join, type PathBuilder } from "path-ts"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

let cacheRoot: TemporaryDirectory
let packageDir: PathBuilder

/**
 * A package-shaped directory the `cache:` resolution rung finds:
 * `<cacheRoot.path>/node_modules/@mailwoman/neural-weights-en-us`.
 */
async function stagePackage(card: Record<string, unknown>, lexicons: readonly string[]): Promise<void> {
	await writeLocalTextFile("", join(packageDir, "model.onnx"))
	await writeLocalTextFile("", join(packageDir, "tokenizer.model"))
	await writeLocalJSONFile(card, join(packageDir, "model-card.json"))

	for (const name of lexicons) {
		await writeLocalJSONFile({ entries: {} }, packageDir, name)
	}
}

/**
 * A minimal card `requires` block for one evidence channel.
 */
function cardDeclaring(lexicon: string | undefined): Record<string, unknown> {
	return {
		requires: {
			locality_surface: { required: true, ...(lexicon ? { lexicon } : {}) },
		},
	}
}

beforeEach(async () => {
	cacheRoot = await temporaryDirectory("mailwoman-lexicon-card-")
	packageDir = weightsCachePackageDir(cacheRoot.path, "en-us")
	await makeDirectories(packageDir)
})

afterEach(() => cacheRoot[Symbol.asyncDispose]())

describe("resolveWeights — evidence lexicons resolve from the card (#1510)", () => {
	test("a card naming v7 resolves v7, not the legacy v6 filename", async () => {
		await stagePackage(cardDeclaring("locality-surface-lexicon-v7.json"), [
			"locality-surface-lexicon-v6.json",
			"locality-surface-lexicon-v7.json",
		])

		const resolved = await resolveWeights({ locale: "en-us", cacheRoot: cacheRoot.path })

		expect(resolved.localitySurfaceLexiconPath).toMatch(/locality-surface-lexicon-v7\.json$/)
	})

	test("a card naming v7 against a package shipping ONLY v6 REFUSES, naming both versions", async () => {
		await stagePackage(cardDeclaring("locality-surface-lexicon-v7.json"), ["locality-surface-lexicon-v6.json"])

		let thrown: unknown

		try {
			await resolveWeights({ locale: "en-us", cacheRoot: cacheRoot.path })
		} catch (error) {
			thrown = error
		}

		expect(thrown).toBeInstanceOf(LexiconVersionMismatchError)
		const message = (thrown as Error).message
		expect(message).toContain("locality-surface-lexicon-v7.json")
		expect(message).toContain("locality-surface-lexicon-v6.json")
		expect(message).toContain("locality_surface")
	})

	test("a card naming a lexicon against a package shipping NONE of the family is plain absence, not a mismatch", async () => {
		// `neural-weights-base-latn` is the live example: it symlinks en-us's card and ships no lexicons.
		// createScorer's declared-required fail-closed is what covers this case, not a resolution throw.
		await stagePackage(cardDeclaring("locality-surface-lexicon-v7.json"), [])

		expect(
			(await resolveWeights({ locale: "en-us", cacheRoot: cacheRoot.path })).localitySurfaceLexiconPath
		).toBeUndefined()
	})

	test("a card with NO lexicon field resolves the legacy filename WITH a warning", async () => {
		await stagePackage(cardDeclaring(undefined), ["locality-surface-lexicon-v6.json"])
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		try {
			const resolved = await resolveWeights({ locale: "en-us", cacheRoot: cacheRoot.path })

			expect(resolved.localitySurfaceLexiconPath).toMatch(/locality-surface-lexicon-v6\.json$/)

			expect(
				errorSpy.mock.calls.some(
					(call) =>
						typeof call[0] === "string" &&
						call[0].includes("does not name its `requires.locality_surface.lexicon`") &&
						call[0].includes("locality-surface-lexicon-v6.json")
				)
			).toBe(true)
		} finally {
			errorSpy.mockRestore()
		}
	})

	test("the pocket tier still skips the channel entirely — a mismatch there cannot even be reached", async () => {
		await stagePackage(cardDeclaring("locality-surface-lexicon-v7.json"), ["locality-surface-lexicon-v6.json"])

		expect(
			(await resolveWeights({ locale: "en-us", cacheRoot: cacheRoot.path, tier: "pocket" })).localitySurfaceLexiconPath
		).toBeUndefined()
	})

	test("a non-string `lexicon` is a loud artifact bug, not a silent fallback", async () => {
		await stagePackage({ requires: { locality_surface: { required: true, lexicon: 7 } } }, [
			"locality-surface-lexicon-v6.json",
		])

		await expect(resolveWeights({ locale: "en-us", cacheRoot: cacheRoot.path })).rejects.toThrow(
			/malformed `requires.locality_surface.lexicon`/
		)
	})
})
