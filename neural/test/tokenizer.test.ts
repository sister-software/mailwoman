/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tokenizer parity test — the single essential assertion in Phase 3.
 *
 *   Loads `tokenizer-v0.1.0.model` (the same file that Phase 2 used to tokenize the corpus) and a
 *   Python-generated fixture of `(raw, pieces, ids)` triples. Asserts that the TS tokenizer
 *   produces byte-for-byte identical pieces + ids for each raw.
 *
 *   If a single fixture entry diverges, the TS↔Python pipeline is broken and downstream BIO decoding
 *   will produce nonsense. Regenerate the fixture via:
 *
 *   ```
 *   python3 packages/neural/neural/test/fixtures/generate-tokenizer-parity.py \
 *   --model packages/neural/neural/test/fixtures/tokenizer-v0.1.0.model \
 *   --out   packages/neural/neural/test/fixtures/tokenizer-parity-v0.1.0.json
 * ```
 */

import { readFileSync } from "node:fs"

import { repoRootPathBuilder } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

import { MailwomanTokenizer, SPACE_SENTINEL } from "../tokenizer.js"

const MODEL_PATH = String(repoRootPathBuilder("neural", "test", "fixtures", "tokenizer-v0.1.0.model"))
const FIXTURE_PATH = String(repoRootPathBuilder("neural", "test", "fixtures", "tokenizer-parity-v0.1.0.json"))

interface FixtureEntry {
	raw: string
	pieces: string[]
	ids: number[]
}

const fixture: FixtureEntry[] = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"))

describe("MailwomanTokenizer — Python parity", () => {
	test.each(fixture)("pieces+ids match Python for $raw", async ({ raw, pieces: expectedPieces, ids: expectedIds }) => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(MODEL_PATH)
		const result = tokenizer.encode(raw)
		expect(result.pieces.map((p) => p.piece)).toEqual(expectedPieces)
		expect(result.ids).toEqual(expectedIds)
	})
})

describe("MailwomanTokenizer — offset reconstruction", () => {
	test.each(fixture.filter((f) => f.raw.length > 0))(
		"every piece's literal text matches raw.slice(start, end) for $raw",
		async ({ raw }) => {
			const tokenizer = await MailwomanTokenizer.loadFromFile(MODEL_PATH)
			const { pieces } = tokenizer.encode(raw)

			for (const p of pieces) {
				const literal = p.piece.startsWith(SPACE_SENTINEL) ? p.piece.slice(SPACE_SENTINEL.length) : p.piece
				expect(raw.slice(p.start, p.end)).toBe(literal)
			}
		}
	)

	test("offsets are non-decreasing", async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(MODEL_PATH)

		for (const { raw } of fixture) {
			const { pieces } = tokenizer.encode(raw)

			for (let i = 1; i < pieces.length; i++) {
				expect(pieces[i]!.start).toBeGreaterThanOrEqual(pieces[i - 1]!.end)
			}
		}
	})

	test("empty input yields zero pieces", async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(MODEL_PATH)
		const { pieces, ids } = tokenizer.encode("")
		expect(pieces).toEqual([])
		expect(ids).toEqual([])
	})
})
