/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { buildWeightsInstallArgs, probeWeights } from "mailwoman/cli-kit/weights-guard"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

// Must be a locale no weights package can resolve.
// This breaks if one is published.
const LOCALE = "pt-BR"

let cacheRoot: TemporaryDirectory

beforeEach(async () => {
	cacheRoot = await temporaryDirectory("mailwoman-guard-")
})

afterEach(() => cacheRoot[Symbol.asyncDispose]())

describe("buildWeightsInstallArgs", () => {
	test("targets the cache prefix with the locale package at latest", () => {
		expect(buildWeightsInstallArgs("en-US", "/cache/root")).toEqual([
			"install",
			"--prefix",
			"/cache/root",
			"--no-audit",
			"--no-fund",
			"--loglevel",
			"error",
			"@mailwoman/neural-weights-en-us@latest",
		])
	})

	test("honors an explicit spec", () => {
		expect(buildWeightsInstallArgs("fr-FR", "/c", "6.0.0")).toContain("@mailwoman/neural-weights-fr-fr@6.0.0")
	})
})

describe("probeWeights", () => {
	test("ok=false with an actionable detail when nothing resolves", async () => {
		const probe = await probeWeights(LOCALE, cacheRoot.path.toString())

		expect(probe.ok).toBe(false)
		expect(probe.detail).toMatch(/Could not resolve/)
		expect(probe.detail).toContain(weightsCachePackageDir(cacheRoot.path, LOCALE).toString())
	})

	test("ok=true against a binary-carrying cache install", async () => {
		const packageDir = weightsCachePackageDir(cacheRoot.path, LOCALE)

		await makeDirectories(packageDir)
		await writeLocalTextFile("stub", packageDir("model.onnx"))
		await writeLocalTextFile("stub", packageDir("tokenizer.model"))

		expect(await probeWeights(LOCALE, cacheRoot.path.toString())).toEqual({ ok: true })
	})

	test("ok=false against a metadata-only cache install (the code-only-release tarball)", async () => {
		const packageDir = weightsCachePackageDir(cacheRoot.path, LOCALE)

		await makeDirectories(packageDir)
		await writeLocalTextFile("{}", packageDir("model-card.json"))

		expect((await probeWeights(LOCALE, cacheRoot.path.toString())).ok).toBe(false)
	})
})
