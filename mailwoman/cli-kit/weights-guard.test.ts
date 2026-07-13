/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pure-machinery tests for the CLI weights guard (plan 3). The interactive component is exercised
 *   live under a pty in the plan's Task-4 verification; here we pin the npm invocation, the probe
 *   semantics against a cache layout, and the probe's rejection of metadata-only installs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { buildWeightsInstallArgs, probeWeights } from "./weights-guard.tsx"

const LOCALE = "de-DE"
const PACKAGE_NAME = "@mailwoman/neural-weights-de-de"

let cacheRoot: string

beforeEach(() => {
	cacheRoot = mkdtempSync(join(tmpdir(), "mailwoman-guard-"))
})

afterEach(() => {
	rmSync(cacheRoot, { recursive: true, force: true })
})

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
	test("ok=false with an actionable detail when nothing resolves", () => {
		const probe = probeWeights(LOCALE, cacheRoot)

		expect(probe.ok).toBe(false)
		expect(probe.detail).toMatch(/Could not resolve/)
		expect(probe.detail).toContain(join(cacheRoot, "node_modules", PACKAGE_NAME))
	})

	test("ok=true against a binary-carrying cache install", () => {
		const packageDir = join(cacheRoot, "node_modules", PACKAGE_NAME)

		mkdirSync(packageDir, { recursive: true })
		writeFileSync(join(packageDir, "model.onnx"), "stub")
		writeFileSync(join(packageDir, "tokenizer.model"), "stub")

		expect(probeWeights(LOCALE, cacheRoot)).toEqual({ ok: true })
	})

	test("ok=false against a metadata-only cache install (the code-only-release tarball)", () => {
		const packageDir = join(cacheRoot, "node_modules", PACKAGE_NAME)

		mkdirSync(packageDir, { recursive: true })
		writeFileSync(join(packageDir, "model-card.json"), "{}")

		expect(probeWeights(LOCALE, cacheRoot).ok).toBe(false)
	})
})
