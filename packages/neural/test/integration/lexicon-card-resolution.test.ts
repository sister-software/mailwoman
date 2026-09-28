/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The evidence-bundle lexicons resolve from the model-card rather than a hard-coded filename: a
 *   card naming a generation the package does not ship must refuse rather than silently serve a
 *   different one.
 *
 *   These tests build synthetic package layouts under a `cacheRoot.path` so they need no model
 *   binaries — `resolveWeights` only `existsSync`-probes `model.onnx` / `tokenizer.model`, and empty
 *   stubs are enough to reach the sibling-resolution code.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { resolveWeights, weightsCachePackageDir } from "@mailwoman/neural/weights"
import { LexiconVersionMismatchError } from "@mailwoman/neural/weights-lexicon"
import type { PathBuilder } from "path-ts"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

let cacheRoot: TemporaryDirectory
let packageDir: PathBuilder

/**
 * A package-shaped directory the `cache:` resolution rung finds
 * under `<cacheRoot.path>/node_modules/@mailwoman/neural-weights-en-us`.
 */
async function stagePackage(card: Record<string, unknown>, lexicons: readonly string[]): Promise<void> {
	await writeLocalTextFile("", packageDir("model.onnx"))
	await writeLocalTextFile("", packageDir("tokenizer.model"))
	await writeLocalJSONFile(card, packageDir("model-card.json"))

	for (const name of lexicons) {
		await writeLocalJSONFile({ entries: {} }, packageDir, name)
	}
}

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
		// A package that ships no lexicons is covered by createScorer's declared-required
		// fail-closed rather than by a resolution throw.
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
