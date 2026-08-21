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
 *   These tests build synthetic package layouts under a `cacheRoot` (the same seam
 *   `weights.test.ts`'s pair-index gate uses) so they need no model binaries: `resolveWeights` only
 *   `existsSync`-probes `model.onnx` / `tokenizer.model`, so empty stubs are enough to reach the
 *   sibling-resolution code this file is about.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LexiconVersionMismatchError, resolveWeights, weightsCachePackageDir } from "@mailwoman/neural/weights"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

let cacheRoot: string
let packageDir: string

/**
 * A package-shaped directory the `cache:` resolution rung finds:
 * `<cacheRoot>/node_modules/@mailwoman/neural-weights-en-us`.
 */
function stagePackage(card: Record<string, unknown>, lexicons: readonly string[]): void {
	writeFileSync(join(packageDir, "model.onnx"), "")
	writeFileSync(join(packageDir, "tokenizer.model"), "")
	writeFileSync(join(packageDir, "model-card.json"), JSON.stringify(card))

	for (const name of lexicons) {
		writeFileSync(join(packageDir, name), JSON.stringify({ entries: {} }))
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

beforeEach(() => {
	cacheRoot = mkdtempSync(join(tmpdir(), "mailwoman-lexicon-card-"))
	packageDir = weightsCachePackageDir(cacheRoot, "en-us")
	mkdirSync(packageDir, { recursive: true })
})

afterEach(() => {
	rmSync(cacheRoot, { recursive: true, force: true })
})

describe("resolveWeights — evidence lexicons resolve from the card (#1510)", () => {
	test("a card naming v7 resolves v7, not the legacy v6 filename", () => {
		stagePackage(cardDeclaring("locality-surface-lexicon-v7.json"), [
			"locality-surface-lexicon-v6.json",
			"locality-surface-lexicon-v7.json",
		])

		const resolved = resolveWeights({ locale: "en-us", cacheRoot })

		expect(resolved.localitySurfaceLexiconPath).toMatch(/locality-surface-lexicon-v7\.json$/)
	})

	test("a card naming v7 against a package shipping ONLY v6 REFUSES, naming both versions", () => {
		stagePackage(cardDeclaring("locality-surface-lexicon-v7.json"), ["locality-surface-lexicon-v6.json"])

		let thrown: unknown

		try {
			resolveWeights({ locale: "en-us", cacheRoot })
		} catch (error) {
			thrown = error
		}

		expect(thrown).toBeInstanceOf(LexiconVersionMismatchError)
		const message = (thrown as Error).message
		expect(message).toContain("locality-surface-lexicon-v7.json")
		expect(message).toContain("locality-surface-lexicon-v6.json")
		expect(message).toContain("locality_surface")
	})

	test("a card naming a lexicon against a package shipping NONE of the family is plain absence, not a mismatch", () => {
		// `neural-weights-base-latn` is the live example: it symlinks en-us's card and ships no lexicons.
		// createScorer's declared-required fail-closed is what covers this case, not a resolution throw.
		stagePackage(cardDeclaring("locality-surface-lexicon-v7.json"), [])

		expect(resolveWeights({ locale: "en-us", cacheRoot }).localitySurfaceLexiconPath).toBeUndefined()
	})

	test("a card with NO lexicon field resolves the legacy filename WITH a warning", () => {
		stagePackage(cardDeclaring(undefined), ["locality-surface-lexicon-v6.json"])
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		try {
			const resolved = resolveWeights({ locale: "en-us", cacheRoot })

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

	test("the pocket tier still skips the channel entirely — a mismatch there cannot even be reached", () => {
		stagePackage(cardDeclaring("locality-surface-lexicon-v7.json"), ["locality-surface-lexicon-v6.json"])

		expect(resolveWeights({ locale: "en-us", cacheRoot, tier: "pocket" }).localitySurfaceLexiconPath).toBeUndefined()
	})

	test("a non-string `lexicon` is a loud artifact bug, not a silent fallback", () => {
		stagePackage({ requires: { locality_surface: { required: true, lexicon: 7 } } }, [
			"locality-surface-lexicon-v6.json",
		])

		expect(() => resolveWeights({ locale: "en-us", cacheRoot })).toThrow(
			/malformed `requires.locality_surface.lexicon`/
		)
	})
})
