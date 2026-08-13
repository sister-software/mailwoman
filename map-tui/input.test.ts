/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { decodeInputChunk } from "./input.ts"

const ESC = "\u001B"

describe("decodeInputChunk", () => {
	it("maps the cursor keys to unit pan directions", () => {
		expect(decodeInputChunk(`${ESC}[A`)).toEqual([{ kind: "pan", dx: 0, dy: -1 }])
		expect(decodeInputChunk(`${ESC}[B`)).toEqual([{ kind: "pan", dx: 0, dy: 1 }])
		expect(decodeInputChunk(`${ESC}[C`)).toEqual([{ kind: "pan", dx: 1, dy: 0 }])
		expect(decodeInputChunk(`${ESC}[D`)).toEqual([{ kind: "pan", dx: -1, dy: 0 }])
	})

	// A terminal left in application-cursor mode sends ESC O A for the same key.
	it("accepts application-mode cursor keys", () => {
		expect(decodeInputChunk(`${ESC}OA`)).toEqual([{ kind: "pan", dx: 0, dy: -1 }])
	})

	it("maps both zoom vocabularies", () => {
		expect(decodeInputChunk("+")).toEqual([{ kind: "zoom", delta: 1 }])
		expect(decodeInputChunk("=")).toEqual([{ kind: "zoom", delta: 1 }])
		expect(decodeInputChunk("a")).toEqual([{ kind: "zoom", delta: 1 }])
		expect(decodeInputChunk("-")).toEqual([{ kind: "zoom", delta: -1 }])
		expect(decodeInputChunk("z")).toEqual([{ kind: "zoom", delta: -1 }])
	})

	it("maps the vim pan keys", () => {
		expect(decodeInputChunk("hjkl")).toEqual([
			{ kind: "pan", dx: -1, dy: 0 },
			{ kind: "pan", dx: 0, dy: 1 },
			{ kind: "pan", dx: 0, dy: -1 },
			{ kind: "pan", dx: 1, dy: 0 },
		])
	})

	it("separates quit from interrupt", () => {
		expect(decodeInputChunk("q")).toEqual([{ kind: "quit" }])
		expect(decodeInputChunk(ESC)).toEqual([{ kind: "quit" }])
		expect(decodeInputChunk("\u0003")).toEqual([{ kind: "interrupt" }])
	})

	it("ignores unbound keys", () => {
		expect(decodeInputChunk("wxv1")).toEqual([])
	})

	describe("SGR mouse reports", () => {
		it("reads the wheel, zero-indexing the coordinates", () => {
			expect(decodeInputChunk(`${ESC}[<64;21;11M`)).toEqual([{ kind: "wheel", delta: 1, column: 20, row: 10 }])
			expect(decodeInputChunk(`${ESC}[<65;21;11M`)).toEqual([{ kind: "wheel", delta: -1, column: 20, row: 10 }])
		})

		it("reads a left-button press, drag and release", () => {
			expect(decodeInputChunk(`${ESC}[<0;10;5M`)).toEqual([{ kind: "press", column: 9, row: 4 }])
			expect(decodeInputChunk(`${ESC}[<32;12;6M`)).toEqual([{ kind: "drag", column: 11, row: 5 }])
			expect(decodeInputChunk(`${ESC}[<0;12;6m`)).toEqual([{ kind: "release" }])
		})

		it("drops a press from a button it has no use for", () => {
			expect(decodeInputChunk(`${ESC}[<1;10;5M`)).toEqual([])
			expect(decodeInputChunk(`${ESC}[<2;10;5M`)).toEqual([])
		})

		it("decodes a burst of reports arriving in one chunk", () => {
			const chunk = `${ESC}[<0;10;5M${ESC}[<32;11;5M${ESC}[<0;11;5m`

			expect(decodeInputChunk(chunk).map((event) => event.kind)).toEqual(["press", "drag", "release"])
		})
	})

	// The input tail this decoder exists for: an unhandled escape sequence must be consumed whole. Re-scanning its
	// body as characters would read the `q` in a cursor-position report as a quit.
	it("swallows an unrecognized CSI sequence rather than reading its body as keys", () => {
		expect(decodeInputChunk(`${ESC}[200~`)).toEqual([])
		expect(decodeInputChunk(`${ESC}[?1;2q`)).toEqual([])
		expect(decodeInputChunk(`${ESC}[15;3~+`)).toEqual([{ kind: "zoom", delta: 1 }])
	})

	it("keeps a key that follows a mouse report in the same chunk", () => {
		expect(decodeInputChunk(`${ESC}[<64;5;5Mq`)).toEqual([
			{ kind: "wheel", delta: 1, column: 4, row: 4 },
			{ kind: "quit" },
		])
	})
})
