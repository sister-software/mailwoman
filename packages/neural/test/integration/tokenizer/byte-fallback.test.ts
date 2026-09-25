import { workspacePath } from "@mailwoman/core/paths"
import { MailwomanTokenizer, SPACE_SENTINEL } from "@mailwoman/neural/tokenizer"
import { describe, expect, test } from "vitest"

const TOKENIZER_MODEL_PATH = workspacePath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")

async function assertDownstreamOffsetsSurvive(raw: string): Promise<void> {
	const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
	const { pieces } = tokenizer.encode(raw)

	expect(pieces.length).toBeGreaterThan(0)

	for (let i = 1; i < pieces.length; i++) {
		expect(pieces[i]!.start).toBeGreaterThanOrEqual(pieces[i - 1]!.end)
	}

	for (const p of pieces) {
		if (
			/^<0x[0-9A-Fa-f]{2}>$/.test(p.piece.startsWith(SPACE_SENTINEL) ? p.piece.slice(SPACE_SENTINEL.length) : p.piece)
		) {
			continue
		}

		const literal = p.piece.startsWith(SPACE_SENTINEL) ? p.piece.slice(SPACE_SENTINEL.length) : p.piece

		expect(raw.slice(p.start, p.end)).toBe(literal)
	}

	expect(pieces.at(-1)!.end).toBeLessThanOrEqual(raw.length)
}

describe("MailwomanTokenizer — byte-fallback offset reconstruction (paired-punctuation audit)", () => {
	test('single-byte fallback mid-string ("{Block C}, Leeds") — offsets survive past the brace', async () => {
		const raw = "{Block C}, Leeds"
		await assertDownstreamOffsetsSurvive(raw)

		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
		const { pieces } = tokenizer.encode(raw)
		const byteFallbackPiece = pieces.find((p) => p.piece === "<0x7B>")!

		expect(raw.slice(byteFallbackPiece.start, byteFallbackPiece.end)).toBe("{")

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

		const runPieces = pieces.filter((p) => /^<0x[0-9A-Fa-f]{2}>$/.test(p.piece))
		expect(runPieces).toHaveLength(6)

		const openRun = runPieces.slice(0, 3)
		const closeRun = runPieces.slice(3, 6)

		expect(openRun[0]!.start).toBe(openRun[0]!.end)
		expect(openRun[1]!.start).toBe(openRun[1]!.end)
		expect(raw.slice(openRun[2]!.start, openRun[2]!.end)).toBe("“")
		expect(raw.slice(closeRun[2]!.start, closeRun[2]!.end)).toBe("”")

		const aPiece = pieces.find((p) => p.piece === "A")!
		expect(raw.slice(aPiece.start, aPiece.end)).toBe("A")

		const afterClose = pieces.filter((p) => p.start >= closeRun[2]!.end)

		const reassembled = afterClose
			.map((p) => raw.slice(p.start, p.end))
			.join("")
			.trim()

		expect(reassembled).toBe(",Leeds")
	})

	test("guillemets «» (2-byte UTF-8 fallback) — downstream comma+locality offsets survive", async () => {
		await assertDownstreamOffsetsSurvive("«The Grange», Fishburn")
	})

	test("Straight quotes/parens (native vocab pieces without byte-fallback) are unaffected by the fix", async () => {
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

async function encodeToTuples(raw: string): Promise<Array<[string, number, number]>> {
	const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_MODEL_PATH)
	const { pieces } = tokenizer.encode(raw)

	return pieces.map((p) => [p.piece, p.start, p.end])
}

describe("MailwomanTokenizer — per-character byte-fallback run splitting (CJK residual)", () => {
	test("東京都渋谷区 — a multi-character run splits at UTF-8 character boundaries without offset collapse", async () => {
		const tuples = await encodeToTuples("東京都渋谷区")

		expect(tuples).toEqual([
			["▁", 0, 0],
			["東", 0, 1],
			["<0xE4>", 1, 1],
			["<0xBA>", 1, 1],
			["<0xAC>", 1, 2],
			["<0xE9>", 2, 2],
			["<0x83>", 2, 2],
			["<0xBD>", 2, 3],
			["<0xE6>", 3, 3],
			["<0xB8>", 3, 3],
			["<0x8B>", 3, 4],
			["谷", 4, 5],
			["区", 5, 6],
		])
	})

	test("mixed Latin + CJK — offsets stay aligned through the run and beyond", async () => {
		const raw = "1 Chome 東京都 Tokyo"
		const tuples = await encodeToTuples(raw)

		expect(tuples).toEqual([
			["▁1", 0, 1],
			["▁Cho", 2, 5],
			["me", 5, 7],
			["▁", 8, 8],
			["東", 8, 9],
			["<0xE4>", 9, 9],
			["<0xBA>", 9, 9],
			["<0xAC>", 9, 10],
			["<0xE9>", 10, 10],
			["<0x83>", 10, 10],
			["<0xBD>", 10, 11],
			["▁T", 12, 13],
			["ok", 13, 15],
			["yo", 15, 17],
		])
	})

	test("single-character run (curly quotes) — the split is a no-op, pre-split behavior preserved exactly", async () => {
		const tuples = await encodeToTuples("Flat “A”")

		expect(tuples).toEqual([
			["▁Flat", 0, 4],
			["▁", 5, 5],
			["<0xE2>", 5, 5],
			["<0x80>", 5, 5],
			["<0x9C>", 5, 6],
			["A", 6, 7],
			["<0xE2>", 7, 7],
			["<0x80>", 7, 7],
			["<0x9D>", 7, 8],
		])
	})

	test("emoji (4-byte UTF-8, one character, TWO UTF-16 code units) — the segment spans both code units", async () => {
		const raw = "Cafe 🚀 Leeds"
		const tuples = await encodeToTuples(raw)

		expect(tuples).toEqual([
			["▁Ca", 0, 2],
			["fe", 2, 4],
			["▁", 5, 5],
			["<0xF0>", 5, 5],
			["<0x9F>", 5, 5],
			["<0x9A>", 5, 5],
			["<0x80>", 5, 7],
			["▁Le", 8, 10],
			["e", 10, 11],
			["d", 11, 12],
			["s", 12, 13],
		])

		expect(raw.slice(5, 7)).toBe("🚀")
	})
})
