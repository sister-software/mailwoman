/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { decodeInputChunk, type MapTUIInput } from "#input"

function eventsOf(chunk: string): MapTUIInput[] {
	return decodeInputChunk(chunk).events
}

const ESC = "\u001B"
const BEL = "\u0007"

describe("decodeInputChunk", () => {
	it("maps the cursor keys to unit pan directions", () => {
		expect(eventsOf(`${ESC}[A`)).toEqual([{ kind: "pan", dx: 0, dy: -1 }])
		expect(eventsOf(`${ESC}[B`)).toEqual([{ kind: "pan", dx: 0, dy: 1 }])
		expect(eventsOf(`${ESC}[C`)).toEqual([{ kind: "pan", dx: 1, dy: 0 }])
		expect(eventsOf(`${ESC}[D`)).toEqual([{ kind: "pan", dx: -1, dy: 0 }])
	})

	// A terminal left in application-cursor mode sends ESC O A for the same key.
	it("accepts application-mode cursor keys", () => {
		expect(eventsOf(`${ESC}OA`)).toEqual([{ kind: "pan", dx: 0, dy: -1 }])
	})

	it("maps both zoom vocabularies", () => {
		expect(eventsOf("+")).toEqual([{ kind: "zoom", delta: 1 }])
		expect(eventsOf("=")).toEqual([{ kind: "zoom", delta: 1 }])
		expect(eventsOf("a")).toEqual([{ kind: "zoom", delta: 1 }])
		expect(eventsOf("-")).toEqual([{ kind: "zoom", delta: -1 }])
		expect(eventsOf("z")).toEqual([{ kind: "zoom", delta: -1 }])
	})

	it("maps the vim pan keys", () => {
		expect(eventsOf("hjkl")).toEqual([
			{ kind: "pan", dx: -1, dy: 0 },
			{ kind: "pan", dx: 0, dy: 1 },
			{ kind: "pan", dx: 0, dy: -1 },
			{ kind: "pan", dx: 1, dy: 0 },
		])
	})

	it("separates quit from interrupt", () => {
		expect(eventsOf("q")).toEqual([{ kind: "quit" }])
		// An ESC whose next byte cannot continue a sequence is the Esc KEY,
		// so this chunk quits twice — once for the Esc, once for the `q`.
		expect(eventsOf(`${ESC}q`)).toEqual([{ kind: "quit" }, { kind: "quit" }])
		expect(eventsOf("\u0003")).toEqual([{ kind: "interrupt" }])
	})

	it("ignores unbound keys", () => {
		expect(eventsOf("wxv1")).toEqual([])
	})

	describe("SGR mouse reports", () => {
		it("reads the wheel, zero-indexing the coordinates", () => {
			expect(eventsOf(`${ESC}[<64;21;11M`)).toEqual([{ kind: "wheel", delta: 1, column: 20, row: 10 }])
			expect(eventsOf(`${ESC}[<65;21;11M`)).toEqual([{ kind: "wheel", delta: -1, column: 20, row: 10 }])
		})

		it("reads a left-button press, drag and release", () => {
			expect(eventsOf(`${ESC}[<0;10;5M`)).toEqual([{ kind: "press", column: 9, row: 4 }])
			expect(eventsOf(`${ESC}[<32;12;6M`)).toEqual([{ kind: "drag", column: 11, row: 5 }])
			expect(eventsOf(`${ESC}[<0;12;6m`)).toEqual([{ kind: "release" }])
		})

		it("drops a press from a button it has no use for", () => {
			expect(eventsOf(`${ESC}[<1;10;5M`)).toEqual([])
			expect(eventsOf(`${ESC}[<2;10;5M`)).toEqual([])
		})

		it("decodes a burst of reports arriving in one chunk", () => {
			const chunk = `${ESC}[<0;10;5M${ESC}[<32;11;5M${ESC}[<0;11;5m`

			expect(eventsOf(chunk).map((event) => event.kind)).toEqual(["press", "drag", "release"])
		})
	})

	// An unhandled escape sequence must be consumed whole, because re-scanning its body
	// as characters would read the `q` in a cursor-position report as a quit.
	it("swallows an unrecognized CSI sequence rather than reading its body as keys", () => {
		expect(eventsOf(`${ESC}[200~`)).toEqual([])
		expect(eventsOf(`${ESC}[?1;2q`)).toEqual([])
		expect(eventsOf(`${ESC}[15;3~+`)).toEqual([{ kind: "zoom", delta: 1 }])
	})

	it("keeps a key that follows a mouse report in the same chunk", () => {
		expect(eventsOf(`${ESC}[<64;5;5Mq`)).toEqual([{ kind: "wheel", delta: 1, column: 4, row: 4 }, { kind: "quit" }])
	})

	describe("escape sequences the decoder has no rule for", () => {
		it("swallows an SS3 function key instead of quitting", () => {
			// F1..F4 on xterm are ESC O P..S.
			for (const final of ["P", "Q", "R", "S"]) {
				expect(eventsOf(`${ESC}O${final}`)).toEqual([])
			}

			expect(eventsOf(`${ESC}OP+`)).toEqual([{ kind: "zoom", delta: 1 }])
		})

		it("swallows an OSC reply the terminal sent unasked", () => {
			// These terminal replies are not keypresses, including the `q` inside a DCS body.
			expect(eventsOf(`${ESC}]11;rgb:1e1e/1e1e/1e1e${BEL}`)).toEqual([])
			expect(eventsOf(`${ESC}]52;c;cXVpdA==${ESC}\\`)).toEqual([])
			expect(eventsOf(`${ESC}P1$r0q${ESC}\\+`)).toEqual([{ kind: "zoom", delta: 1 }])
		})
	})

	describe("sequences split across stdin chunks", () => {
		it("holds a trailing ESC rather than reading it as the Esc key", () => {
			const first = decodeInputChunk(ESC)

			expect(first.events).toEqual([])
			expect(first.pending).toBe(ESC)

			expect(decodeInputChunk("[A", first.pending).events).toEqual([{ kind: "pan", dx: 0, dy: -1 }])
		})

		it("reassembles a mouse report the kernel split in two", () => {
			const first = decodeInputChunk(`${ESC}[<32;12`)

			expect(first.events).toEqual([])
			expect(first.pending).toBe(`${ESC}[<32;12`)

			const second = decodeInputChunk(";6M", first.pending)

			expect(second.events).toEqual([{ kind: "drag", column: 11, row: 5 }])
			expect(second.pending).toBe("")
		})

		it("stops holding a fragment that has stopped being plausible", () => {
			// An unterminated string sequence would otherwise grow the held fragment for the life
			// of the process, so dropping it emits no event rather than reading its body as keys.
			const runaway = decodeInputChunk(`${ESC}]52;c;${"A".repeat(70_000)}`)

			expect(runaway.events).toEqual([])
			expect(runaway.pending).toBe("")
		})

		it("holds every family's fragment, and keeps the events before it", () => {
			for (const fragment of [`${ESC}O`, `${ESC}[`, `${ESC}[<0;1`, `${ESC}]11;rgb:`]) {
				const decoded = decodeInputChunk(`+${fragment}`)

				expect(decoded.events).toEqual([{ kind: "zoom", delta: 1 }])
				expect(decoded.pending).toBe(fragment)
			}
		})
	})
})
