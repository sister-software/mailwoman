/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests the cache fallback that `resolveWeights` uses when no weights package resolves. The tests
 *   use `pt-BR` because no workspace package exists for that locale, so resolution reaches the cache
 *   on every host.
 */

import { cacheRootPath } from "@mailwoman/core/data-root"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalFile, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolveWeights, weightsCacheDir, weightsCachePackageDir, weightsPackageName } from "@mailwoman/neural/weights"
import type { PathBuilder } from "path-ts"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

const LOCALE = "pt-BR"
const PACKAGE_NAME = "@mailwoman/neural-weights-pt-br"

let cacheRoot: TemporaryDirectory

/**
 * Writes a cached weights package with the given files.
 *
 * The path is spelled out by hand instead of using {@linkcode weightsCachePackageDir}.
 * A fixture built with the implementation's helper cannot catch a wrong layout.
 *
 * The last test in this file checks the helper against this spelling.
 */
async function layoutCachedPackage(files: string[]): Promise<PathBuilder> {
	const packageDir = cacheRoot.path("node_modules", PACKAGE_NAME)

	await makeDirectories(packageDir)

	for (const file of files) {
		await writeLocalFile(file === "model-card.json" ? stringifyJSON({ version: "0.0.0" }) : "stub", packageDir(file))
	}

	return packageDir
}

beforeEach(async () => {
	cacheRoot = await temporaryDirectory("mailwoman-weights-cache-")
})

afterEach(() => cacheRoot[Symbol.asyncDispose]())

describe("resolveWeights cache fallback", () => {
	test("resolves a cache-installed package, sibling artifacts included", async () => {
		const packageDir = await layoutCachedPackage([
			"model.onnx",
			"tokenizer.model",
			"model-card.json",
			"postcode-br.bin",
			"crf-transitions.json",
		])

		const resolved = await resolveWeights({ locale: LOCALE, cacheRoot: cacheRoot.path })

		expect(resolved.source).toBe(`cache:${PACKAGE_NAME}`)
		expect(resolved.modelPath).toBe(packageDir("model.onnx").toString())
		expect(resolved.tokenizerPath).toBe(packageDir("tokenizer.model").toString())
		expect(resolved.modelCardPath).toBe(packageDir("model-card.json").toString())
		// The PCB1 anchor binary resolves as it would from an installed package.
		expect(resolved.anchorLookupPath).toEqual({ path: packageDir("postcode-br.bin").toString(), binary: true })
	})

	test("a binary-less cache install without a base declaration does not resolve", async () => {
		await layoutCachedPackage(["model-card.json"])

		await expect(resolveWeights({ locale: LOCALE, cacheRoot: cacheRoot.path })).rejects.toThrow(/missing model files/)
	})

	test("the not-found error names the probed cache path", async () => {
		await expect(resolveWeights({ locale: LOCALE, cacheRoot: cacheRoot.path })).rejects.toThrow(
			new RegExp(cacheRoot.path("node_modules", PACKAGE_NAME).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		)
	})

	test("an EXPLICIT cacheRoot.path outranks an installed package (candidate grading, en-US resolves in-repo)", async () => {
		const packageDir = cacheRoot.path("node_modules", "@mailwoman/neural-weights-en-us")

		await makeDirectories(packageDir)

		for (const file of ["model.onnx", "tokenizer.model"]) {
			await writeLocalTextFile("stub", packageDir(file))
		}

		// The en-US workspace package resolves too, but an explicit cache root takes precedence.
		const resolved = await resolveWeights({ locale: "en-US", cacheRoot: cacheRoot.path })

		expect(resolved.source).toBe("cache:@mailwoman/neural-weights-en-us")
		expect(resolved.modelPath).toBe(packageDir("model.onnx").toString())
	})

	test("a cached data-only overlay resolves the candidate base beside it", async () => {
		const scopeDir = cacheRoot.path("node_modules", "@mailwoman")
		const baseDir = scopeDir("neural-weights-en-us")
		const overlayDir = scopeDir("neural-weights-en-gb")

		await makeDirectories(baseDir)
		await makeDirectories(overlayDir)
		await writeLocalJSONFile({ name: "@mailwoman/neural-weights-en-us" }, baseDir("package.json"))
		await writeLocalTextFile("candidate-model", baseDir("model.onnx"))
		await writeLocalTextFile("candidate-tokenizer", baseDir("tokenizer.model"))
		await writeLocalJSONFile({ version: "candidate" }, baseDir("model-card.json"))

		await writeLocalJSONFile(
			{
				name: "@mailwoman/neural-weights-en-gb",
				mailwoman: { baseWeights: "@mailwoman/neural-weights-en-us" },
			},
			overlayDir("package.json")
		)

		await writeLocalTextFile("overlay-pairs", overlayDir("pair-index-gb.bin"))

		const resolved = await resolveWeights({ locale: "en-GB", cacheRoot: cacheRoot.path })

		expect(resolved.source).toBe("cache:@mailwoman/neural-weights-en-gb+base")
		expect(resolved.modelPath).toBe(baseDir("model.onnx").toString())
		expect(resolved.tokenizerPath).toBe(baseDir("tokenizer.model").toString())
		expect(resolved.modelCardPath).toBe(baseDir("model-card.json").toString())
		expect(resolved.pairIndexPath).toBe(overlayDir("pair-index-gb.bin").toString())
	})

	test("a cached data-only overlay refuses a missing cached base instead of falling through", async () => {
		const overlayDir = cacheRoot.path("node_modules", "@mailwoman", "neural-weights-en-gb")

		await makeDirectories(overlayDir)

		await writeLocalJSONFile(
			{
				name: "@mailwoman/neural-weights-en-gb",
				mailwoman: { baseWeights: "@mailwoman/neural-weights-en-us" },
			},
			overlayDir("package.json")
		)

		let message = ""

		try {
			await resolveWeights({ locale: "en-GB", cacheRoot: cacheRoot.path })
		} catch (error) {
			message = (error as Error).message
		}

		expect(message).toContain("missing model files")
		expect(message).toContain(overlayDir("model.onnx").toString())
		expect(message).not.toContain("packages/neural-weights-en-us/model.onnx")
	})

	test("helpers: cache dir + package-name builder", () => {
		expect(weightsCacheDir().toString()).toBe(cacheRootPath("weights"))
		expect(weightsPackageName("en-US")).toBe("@mailwoman/neural-weights-en-us")
		expect(weightsPackageName()).toBe("@mailwoman/neural-weights-en-us")
	})

	// This test checks the exported layout helper against the hand-spelled path above.
	test("weightsCachePackageDir builds exactly the layout this file pins", () => {
		expect(weightsCachePackageDir(cacheRoot.path, LOCALE).toString()).toBe(
			cacheRoot.path("node_modules", PACKAGE_NAME).toString()
		)

		// Locale casing is normalized the same way the package name is.
		expect(weightsCachePackageDir(cacheRoot.path).toString()).toBe(
			cacheRoot.path("node_modules", "@mailwoman/neural-weights-en-us").toString()
		)
	})
})
