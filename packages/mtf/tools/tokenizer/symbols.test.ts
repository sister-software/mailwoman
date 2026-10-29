/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import {
	dedupeKeepOrder,
	DEFAULT_USER_DEFINED_SYMBOLS,
	pythonSplitLines,
	pythonStrip,
	readUserDefinedSymbolsFile,
	sentencePieceSymbol,
} from "./symbols.ts"

const LINE_SEPARATOR = String.fromCodePoint(0x20_28)
const FILE_SEPARATOR = String.fromCodePoint(0x1c)
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x30_00)
const NO_BREAK_SPACE = String.fromCodePoint(0xa0)

describe("user-defined symbols", () => {
	it("keeps the postal anchors whole by default", () => {
		for (const symbol of ["NY", "CA", "USA", "France", "Cedex", "PO Box"]) {
			expect(DEFAULT_USER_DEFINED_SYMBOLS).toContain(symbol)
		}
	})

	it("reads one literal per line, skipping blanks and comments and keeping inner spaces", async () => {
		await using scratch = await temporaryDirectory("symbols-")
		const path = scratch.path("uds.txt").toString()

		await writeLocalTextFile(["# comment", "75008", "10001", "", "SW1A 1AA", "  ", "100-0005"], path)

		expect(await readUserDefinedSymbolsFile(path)).toEqual(["75008", "10001", "SW1A 1AA", "100-0005"])
	})

	it("passes a space as the whitespace placeholder", () => {
		expect(sentencePieceSymbol("SW1A 1AA")).toBe("SW1A▁1AA")
	})

	it("drops empty entries and later duplicates", () => {
		expect(dedupeKeepOrder(["CA", "", "DE", "CA", "US"])).toEqual(["CA", "DE", "US"])
	})

	it("splits and strips lines the way Python's str methods do", () => {
		expect(pythonSplitLines(`a\r\nb${LINE_SEPARATOR}c\n`)).toEqual(["a", "b", "c"])
		expect(pythonStrip(`${FILE_SEPARATOR}${IDEOGRAPHIC_SPACE} x ${NO_BREAK_SPACE}`)).toBe("x")
	})
})
