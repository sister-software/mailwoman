/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Cache-fallback resolution for the CLI weights guard (plan 3): when no
 *   `@mailwoman/neural-weights-<locale>` package resolves, `resolveWeights` probes the user-level
 *   npm-prefix cache (`~/.cache/mailwoman/weights` — `cacheRoot.path` injects a test root). Uses the
 *   `pt-BR` locale throughout because no workspace package exists for it, so the package branch
 *   (was `de-DE` until 2026-08-02, when campaign R9 shipped that package and made the locale resolvable — the
 *   negative control has to name a locale nobody has claimed yet)
 *   falls through to the cache on every host, lab or CI.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalFile, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { join } from "@mailwoman/platform/path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { resolveWeights, weightsCacheDir, weightsCachePackageDir, weightsPackageName } from "#weights"

const LOCALE = "pt-BR"
const PACKAGE_NAME = "@mailwoman/neural-weights-pt-br"

let cacheRoot: TemporaryDirectory

/**
 * THIS FILE SPELLS THE LAYOUT OUT BY HAND ON PURPOSE (2026-08-06 triage). Everywhere else in the tree that literal
 * moved to {@linkcode weightsCachePackageDir}, because a layout re-typed in eight places is a layout that can drift.
 * Here it is the ORACLE: this is the file that pins what `resolveWeights`' cache rung finds, and a fixture built with
 * the implementation's own helper cannot fail when the implementation is wrong. The helper is tied back to the
 * independent spelling by the last test in this file instead.
 */
async function layoutCachedPackage(files: string[]): Promise<string> {
	const packageDir = cacheRoot.resolve("node_modules", PACKAGE_NAME)

	await makeDirectories(packageDir)

	for (const file of files) {
		await writeLocalFile(
			file === "model-card.json" ? JSON.stringify({ version: "0.0.0" }) : "stub",
			join(packageDir, file)
		)
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

		const resolved = resolveWeights({ locale: LOCALE, cacheRoot: cacheRoot.path })

		expect(resolved.source).toBe(`cache:${PACKAGE_NAME}`)
		expect(resolved.modelPath).toBe(join(packageDir, "model.onnx"))
		expect(resolved.tokenizerPath).toBe(join(packageDir, "tokenizer.model"))
		expect(resolved.modelCardPath).toBe(join(packageDir, "model-card.json"))
		// The PCB1 anchor binary resolves exactly as it would from an installed package (#718 soft-feed).
		expect(resolved.anchorLookupPath).toEqual({ path: join(packageDir, "postcode-br.bin"), binary: true })
	})

	test("a binary-less cache install without a base declaration does not resolve", async () => {
		await layoutCachedPackage(["model-card.json"])

		expect(() => resolveWeights({ locale: LOCALE, cacheRoot: cacheRoot.path })).toThrow(/missing model files/)
	})

	test("the not-found error names the probed cache path", () => {
		expect(() => resolveWeights({ locale: LOCALE, cacheRoot: cacheRoot.path })).toThrow(
			new RegExp(cacheRoot.resolve("node_modules", PACKAGE_NAME).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		)
	})

	test("an EXPLICIT cacheRoot.path outranks an installed package (candidate grading, en-US resolves in-repo)", async () => {
		const packageDir = cacheRoot.resolve("node_modules", "@mailwoman/neural-weights-en-us")

		await makeDirectories(packageDir)

		for (const file of ["model.onnx", "tokenizer.model"]) {
			await writeLocalTextFile("stub", join(packageDir, file))
		}

		// The workspace package exists and resolves, but the explicit cacheRoot.path names the candidate.
		const resolved = resolveWeights({ locale: "en-US", cacheRoot: cacheRoot.path })

		expect(resolved.source).toBe("cache:@mailwoman/neural-weights-en-us")
		expect(resolved.modelPath).toBe(join(packageDir, "model.onnx"))
	})

	test("a cached data-only overlay resolves the candidate base beside it", async () => {
		const scopeDir = cacheRoot.resolve("node_modules", "@mailwoman")
		const baseDir = join(scopeDir, "neural-weights-en-us")
		const overlayDir = join(scopeDir, "neural-weights-en-gb")

		await makeDirectories(baseDir)
		await makeDirectories(overlayDir)
		await writeLocalJSONFile({ name: "@mailwoman/neural-weights-en-us" }, join(baseDir, "package.json"))
		await writeLocalTextFile("candidate-model", join(baseDir, "model.onnx"))
		await writeLocalTextFile("candidate-tokenizer", join(baseDir, "tokenizer.model"))
		await writeLocalJSONFile({ version: "candidate" }, join(baseDir, "model-card.json"))

		await writeLocalJSONFile(
			{
				name: "@mailwoman/neural-weights-en-gb",
				mailwoman: { baseWeights: "@mailwoman/neural-weights-en-us" },
			},
			join(overlayDir, "package.json")
		)

		await writeLocalTextFile("overlay-pairs", join(overlayDir, "pair-index-gb.bin"))

		const resolved = resolveWeights({ locale: "en-GB", cacheRoot: cacheRoot.path })

		expect(resolved.source).toBe("cache:@mailwoman/neural-weights-en-gb+base")
		expect(resolved.modelPath).toBe(join(baseDir, "model.onnx"))
		expect(resolved.tokenizerPath).toBe(join(baseDir, "tokenizer.model"))
		expect(resolved.modelCardPath).toBe(join(baseDir, "model-card.json"))
		expect(resolved.pairIndexPath).toBe(join(overlayDir, "pair-index-gb.bin"))
	})

	test("a cached data-only overlay refuses a missing cached base instead of falling through", async () => {
		const overlayDir = cacheRoot.resolve("node_modules", "@mailwoman", "neural-weights-en-gb")

		await makeDirectories(overlayDir)

		await writeLocalJSONFile(
			{
				name: "@mailwoman/neural-weights-en-gb",
				mailwoman: { baseWeights: "@mailwoman/neural-weights-en-us" },
			},
			join(overlayDir, "package.json")
		)

		let message = ""

		try {
			resolveWeights({ locale: "en-GB", cacheRoot: cacheRoot.path })
		} catch (error) {
			message = (error as Error).message
		}

		expect(message).toContain("missing model files")
		expect(message).toContain(join(overlayDir, "model.onnx"))
		expect(message).not.toContain("packages/neural-weights-en-us/model.onnx")
	})

	test("helpers: cache dir + package-name builder", () => {
		expect(weightsCacheDir()).toMatch(/\.cache[/\\]mailwoman[/\\]weights$/)
		expect(weightsPackageName("en-US")).toBe("@mailwoman/neural-weights-en-us")
		expect(weightsPackageName()).toBe("@mailwoman/neural-weights-en-us")
	})

	// The tie between the exported layout helper and the layout this file pins independently. Every other call site in
	// the tree now builds the directory with `weightsCachePackageDir`; if it and the hand-spelled path ever disagree,
	// they disagree HERE and not in a gate run that silently graded the wrong bundle.
	test("weightsCachePackageDir builds exactly the layout this file pins", () => {
		expect(weightsCachePackageDir(cacheRoot.path, LOCALE)).toBe(cacheRoot.resolve("node_modules", PACKAGE_NAME))

		// Locale casing is normalized the same way the package name is.
		expect(weightsCachePackageDir(cacheRoot.path)).toBe(
			cacheRoot.resolve("node_modules", "@mailwoman/neural-weights-en-us")
		)
	})
})
