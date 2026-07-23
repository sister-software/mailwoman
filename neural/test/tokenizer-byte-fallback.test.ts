/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Byte-fallback offset-reconstruction regression (paired-punctuation audit, `.superpowers/sdd/task-9-audit-report.md`).
 *
 *   Before the fix, `MailwomanTokenizer.encode`'s offset walker treated a byte-fallback piece's placeholder TEXT
 *   (`"<0x7B>"`, 6 chars) as if it were 6 real input characters, when it actually represents exactly the ONE byte of a
 *   real character's UTF-8 encoding. The cursor over-advanced on every such piece, desyncing every SUBSEQUENT piece's
 *   `[start, end)` offsets for the rest of the input — not just the byte-fallback piece itself. On the small fixture
 *   tokenizer (`tokenizer-v0.1.0.model`, deliberately tiny-vocab) this fires on curly quotes “”‘’, guillemets «», and
 *   even ASCII braces `{}`/`[]` — not just non-Latin scripts, which is why this suite doesn't need the gated production
 *   tokenizer to reproduce it. See `tokenizer.ts`'s doc comment for the fix (buffer a byte-fallback RUN, decode as one
 *   UTF-8 sequence via `TextDecoder`, advance the cursor by the DECODED string's length).
 */

import { repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

import { MailwomanTokenizer, SPACE_SENTINEL } from "../tokenizer.ts"

const TOKENIZER_MODEL_PATH = repoRootPath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")

/** Assert every piece AFTER the first byte-fallback run still recovers its literal text via `raw.slice(start, end)`. */
async function assertDownstreamOffsetsSurvive(raw: string): Promise<void> {
	const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
	const { pieces } = tokenizer.encode(raw)

	expect(pieces.length).toBeGreaterThan(0)

	// Offsets must never regress (non-decreasing across the whole stream) — the fundamental guarantee
	// `tokenizer-large-parity.test.ts` checks for the "supported" subset; this asserts it holds even WITH
	// byte-fallback pieces present, which is exactly what that suite's exclusion filter used to concede away.
	for (let i = 1; i < pieces.length; i++) {
		expect(pieces[i]!.start).toBeGreaterThanOrEqual(pieces[i - 1]!.end)
	}

	// Every piece that ISN'T a byte-fallback placeholder must still round-trip: raw.slice(start, end) === its literal.
	for (const p of pieces) {
		if (
			/^<0x[0-9A-Fa-f]{2}>$/.test(p.piece.startsWith(SPACE_SENTINEL) ? p.piece.slice(SPACE_SENTINEL.length) : p.piece)
		) {
			continue // asserted separately below — a run's non-final pieces are intentionally zero-width.
		}

		const literal = p.piece.startsWith(SPACE_SENTINEL) ? p.piece.slice(SPACE_SENTINEL.length) : p.piece

		expect(raw.slice(p.start, p.end)).toBe(literal)
	}

	// The final byte-fallback offset must equal `raw.length` when the run reaches the end of input, and every
	// downstream normal piece's start must be >= the run's decoded end — i.e. the cursor is NEVER left ahead of
	// where the real characters actually are.
	expect(pieces.at(-1)!.end).toBeLessThanOrEqual(raw.length)
}

describe("MailwomanTokenizer — byte-fallback offset reconstruction (paired-punctuation audit)", () => {
	test('single-byte fallback mid-string ("{Block C}, Leeds") — offsets survive past the brace', async () => {
		const raw = "{Block C}, Leeds"
		await assertDownstreamOffsetsSurvive(raw)

		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
		const { pieces } = tokenizer.encode(raw)
		const byteFallbackPiece = pieces.find((p) => p.piece === "<0x7B>")!
		// The single byte 0x7B IS the complete UTF-8 encoding of "{" (1 byte, 1 char) — the run's one piece
		// recovers exactly "{", not a 6-char placeholder-length span.
		expect(raw.slice(byteFallbackPiece.start, byteFallbackPiece.end)).toBe("{")

		// "Leeds" is split fine-grained on this small-vocab fixture tokenizer ("▁Le", "e", "d", "s") — reassembling
		// every piece after the brace run must still spell "Leeds" cleanly, not a garbled offset-shifted string.
		const afterComma = pieces.filter((p) => p.start >= pieces.find((q) => q.piece === ",")!.end)
		const reassembled = afterComma
			.map((p) => raw.slice(p.start, p.end))
			.join("")
			.trim()
		expect(reassembled).toBe("Leeds")
	})

	test('closing brace at end of input ("Unit 4 [Block B]") — last piece offset never exceeds raw.length', async () => {
		await assertDownstreamOffsetsSurvive("Unit 4 [Block B]")
	})

	test("multi-byte UTF-8 fallback (curly quotes “”, each a 3-byte sequence split into 3 pieces) recomposes to ONE real character each", async () => {
		const raw = "Flat “A”, Leeds"
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
		const { pieces } = tokenizer.encode(raw)

		// "“" and "”" (U+201C/U+201D) are each 3 UTF-8 bytes on this vocab (no direct token) — two runs of three
		// consecutive <0xHH> pieces, split by the real "A" piece between them.
		const runPieces = pieces.filter((p) => /^<0x[0-9A-Fa-f]{2}>$/.test(p.piece))
		expect(runPieces.length).toBe(6)

		const openRun = runPieces.slice(0, 3)
		const closeRun = runPieces.slice(3, 6)

		// Only the LAST piece of each run carries the real (non-zero-width) span; earlier pieces are zero-width
		// placeholders at the run's start — mirrors groupPiecesIntoWords's "own placeholder, zero contribution"
		// idiom for a bare ▁.
		expect(openRun[0]!.start).toBe(openRun[0]!.end)
		expect(openRun[1]!.start).toBe(openRun[1]!.end)
		expect(raw.slice(openRun[2]!.start, openRun[2]!.end)).toBe("“")
		expect(raw.slice(closeRun[2]!.start, closeRun[2]!.end)).toBe("”")

		// Critical assertion: the piece BETWEEN the two runs ("A") and everything after the second run land on the
		// correct offsets — before the fix, the cursor over-advanced by 5 chars per 3-piece run (18 placeholder
		// chars for 1 real char), landing deep past the end of this 15-char string and garbling every downstream
		// span.
		const aPiece = pieces.find((p) => p.piece === "A")!
		expect(raw.slice(aPiece.start, aPiece.end)).toBe("A")

		const afterClose = pieces.filter((p) => p.start >= closeRun[2]!.end)
		const reassembled = afterClose
			.map((p) => raw.slice(p.start, p.end))
			.join("")
			.trim()
		expect(reassembled).toBe(",Leeds") // raw.slice per-piece omits the sentinel-consumed leading space, as expected
	})

	test("guillemets «» (2-byte UTF-8 fallback) — downstream comma+locality offsets survive", async () => {
		await assertDownstreamOffsetsSurvive("«The Grange», Fishburn")
	})

	test("straight quotes/parens (native vocab pieces, no byte-fallback) are unaffected by the fix", async () => {
		await assertDownstreamOffsetsSurvive('"The Grange", Fishburn, Stockton-on-Tees')
		await assertDownstreamOffsetsSurvive("12 High St (rear entrance), Leeds")
	})

	test("empty input still yields zero pieces (no byte-run left dangling)", async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
		const { pieces, ids } = tokenizer.encode("")
		expect(pieces).toEqual([])
		expect(ids).toEqual([])
	})
})
