/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Cache-fallback resolution for the CLI weights guard (plan 3): when no
 *   `@mailwoman/neural-weights-<locale>` package resolves, `resolveWeights` probes the user-level
 *   npm-prefix cache (`~/.cache/mailwoman/weights` — `cacheRoot` injects a test root). Uses the
 *   `de-DE` locale throughout because no workspace package exists for it, so the package branch
 *   falls through to the cache on every host, lab or CI.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveWeights, weightsCacheDir, weightsPackageName } from "@mailwoman/neural/weights"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

const LOCALE = "de-DE"
const PACKAGE_NAME = "@mailwoman/neural-weights-de-de"

let cacheRoot: string

function layoutCachedPackage(files: string[]): string {
	const packageDir = join(cacheRoot, "node_modules", PACKAGE_NAME)

	mkdirSync(packageDir, { recursive: true })

	for (const file of files) {
		writeFileSync(join(packageDir, file), file === "model-card.json" ? JSON.stringify({ version: "0.0.0" }) : "stub")
	}

	return packageDir
}

beforeEach(() => {
	cacheRoot = mkdtempSync(join(tmpdir(), "mailwoman-weights-cache-"))
})

afterEach(() => {
	rmSync(cacheRoot, { recursive: true, force: true })
})

describe("resolveWeights cache fallback", () => {
	test("resolves a cache-installed package, sibling artifacts included", () => {
		const packageDir = layoutCachedPackage([
			"model.onnx",
			"tokenizer.model",
			"model-card.json",
			"postcode-de.bin",
			"crf-transitions.json",
		])

		const resolved = resolveWeights({ locale: LOCALE, cacheRoot })

		expect(resolved.source).toBe(`cache:${PACKAGE_NAME}`)
		expect(resolved.modelPath).toBe(join(packageDir, "model.onnx"))
		expect(resolved.tokenizerPath).toBe(join(packageDir, "tokenizer.model"))
		expect(resolved.modelCardPath).toBe(join(packageDir, "model-card.json"))
		// The PCB1 anchor binary resolves exactly as it would from an installed package (#718 soft-feed).
		expect(resolved.anchorLookupPath).toEqual({ path: join(packageDir, "postcode-de.bin"), binary: true })
	})

	test("a binary-less cache install (metadata-only tarball) does not resolve", () => {
		layoutCachedPackage(["model-card.json"])

		expect(() => resolveWeights({ locale: LOCALE, cacheRoot })).toThrow(/Could not resolve/)
	})

	test("the not-found error names the probed cache path", () => {
		expect(() => resolveWeights({ locale: LOCALE, cacheRoot })).toThrow(
			new RegExp(join(cacheRoot, "node_modules", PACKAGE_NAME).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		)
	})

	test("an EXPLICIT cacheRoot outranks an installed package (candidate grading, en-US resolves in-repo)", () => {
		const packageDir = join(cacheRoot, "node_modules", "@mailwoman/neural-weights-en-us")

		mkdirSync(packageDir, { recursive: true })

		for (const file of ["model.onnx", "tokenizer.model"]) {
			writeFileSync(join(packageDir, file), "stub")
		}

		// The workspace package exists and resolves, but the explicit cacheRoot names the candidate.
		const resolved = resolveWeights({ locale: "en-US", cacheRoot })

		expect(resolved.source).toBe("cache:@mailwoman/neural-weights-en-us")
		expect(resolved.modelPath).toBe(join(packageDir, "model.onnx"))
	})

	test("helpers: cache dir + package-name builder", () => {
		expect(weightsCacheDir()).toMatch(/\.cache[/\\]mailwoman[/\\]weights$/)
		expect(weightsPackageName("en-US")).toBe("@mailwoman/neural-weights-en-us")
		expect(weightsPackageName()).toBe("@mailwoman/neural-weights-en-us")
	})
})
