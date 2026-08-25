/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The #1895 pin machinery: the committed constants read back exactly, a surgical rewrite touches only the three
 *   constant lines (the pin test's dated history comments survive byte-identically), a same-values rewrite is a no-op,
 *   and a reshaped test file refuses instead of being partially rewritten.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { repoRootPath } from "@mailwoman/core/utils"
import {
	checkBoardPins,
	PIN_TEST_PATH,
	readCommittedPins,
	writeCommittedPins,
} from "mailwoman/eval-harness/gauntlet/cases/pins"
import { describe, expect, it } from "vitest"

const realTestText = readFileSync(resolve(String(repoRootPath()), PIN_TEST_PATH), "utf8")

describe("the committed-pin read/write contract", () => {
	it("reads the three constants out of the real pin test", () => {
		const pins = readCommittedPins(realTestText)

		expect(pins.CORPUS_SIZE).toBeGreaterThan(0)
		expect(pins.CORPUS_HASH).toMatch(/^[0-9a-f]{64}$/)
		expect(pins.BOARD_ID).toMatch(/^gauntlet-regression@\d+:[0-9a-f]+$/)
	})

	it("rewriting with the same values is byte-identical — update is idempotent", () => {
		expect(writeCommittedPins(realTestText, readCommittedPins(realTestText))).toBe(realTestText)
	})

	it("rewriting new values changes exactly the three constant lines; every history comment survives", () => {
		const rewritten = writeCommittedPins(realTestText, {
			CORPUS_SIZE: 999,
			CORPUS_HASH: "f".repeat(64),
			BOARD_ID: "gauntlet-regression@999:abcdefabcdef",
		})

		// oxlint-disable-next-line mailwoman/prefer-spliterator -- One committed test file, compared line-by-line once.
		const originalLines = realTestText.split("\n")
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- The rewritten twin of the same bounded file.
		const rewrittenLines = rewritten.split("\n")
		const changed = rewrittenLines.filter((line, index) => line !== originalLines[index])

		expect(changed).toEqual([
			"const CORPUS_SIZE = 999",
			`const CORPUS_HASH = "${"f".repeat(64)}"`,
			'const BOARD_ID = "gauntlet-regression@999:abcdefabcdef"',
		])
	})

	it("refuses a reshaped file rather than guessing", () => {
		const reshaped = realTestText.replace("const CORPUS_HASH", "const CORPUS_DIGEST")

		expect(() => readCommittedPins(reshaped)).toThrow(/CORPUS_HASH/)
		expect(() => writeCommittedPins(reshaped, readCommittedPins(realTestText))).toThrow(/CORPUS_HASH/)
	})

	it("the pins hold on the current tree — the check the merge wrapper and CI run", async () => {
		const check = await checkBoardPins()

		expect(check.stale).toEqual([])
	})
})
