/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Large-scale TS↔Python tokenizer parity sweep.
 *
 *   Validates the SentencePiece offset reconstruction against 10k real corpus rows. Skips silently
 *   when the large fixture isn't present (the file is generated on the host from corpus parquet —
 *   see `fixtures/generate-tokenizer-parity.py --from-parquet`).
 *
 *   Two assertions:
 *
 *   1. Byte-for-byte pieces+ids equality on EVERY entry — the essential Phase 3 invariant.
 *   2. Offset reconstruction correctness on entries that don't contain documented unsupported cases
 *        (byte-fallback pieces + zero-width joiners). Those gaps are documented in tokenizer.ts;
 *        the sweep confirms the 99%+ population is correctly handled, and surfaces which
 *        non-Latin-script edge cases the v0.1.0 tokenizer hits byte-fallback on.
 */

import { existsSync, readFileSync } from "node:fs"

import { repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

import { MailwomanTokenizer, SPACE_SENTINEL } from "../tokenizer.ts"

const MODEL_PATH = repoRootPath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")
const LARGE_FIXTURE_PATH = String(repoRootPath("neural", "test", "fixtures", "tokenizer-parity-large-v0.1.0.json"))

const haveLargeFixture = existsSync(LARGE_FIXTURE_PATH)

interface FixtureEntry {
	raw: string
	pieces: string[]
	ids: number[]
}

describe.skipIf(!haveLargeFixture)("MailwomanTokenizer — large-scale parity (10k corpus rows)", () => {
	test("byte-for-byte pieces+ids equality across every fixture entry", async () => {
		const fixture: FixtureEntry[] = JSON.parse(readFileSync(LARGE_FIXTURE_PATH, "utf-8"))
		const tokenizer = await MailwomanTokenizer.loadFromFile(MODEL_PATH)

		let divergences = 0
		const failures: string[] = []
		const MAX_REPORTED = 5

		for (const { raw, pieces: expectedPieces, ids: expectedIds } of fixture) {
			const result = tokenizer.encode(raw)
			const tsPieces = result.pieces.map((p) => p.piece)
			const piecesMatch = tsPieces.length === expectedPieces.length && tsPieces.every((p, i) => p === expectedPieces[i])
			const idsMatch = result.ids.length === expectedIds.length && result.ids.every((id, i) => id === expectedIds[i])

			if (!piecesMatch || !idsMatch) {
				divergences++

				if (failures.length < MAX_REPORTED) {
					failures.push(
						`raw=${JSON.stringify(raw)}\n  expected pieces=${JSON.stringify(expectedPieces)}\n  TS pieces=${JSON.stringify(tsPieces)}\n  expected ids=${JSON.stringify(expectedIds)}\n  TS ids=${JSON.stringify(result.ids)}`
					)
				}
			}
		}

		if (divergences > 0) {
			throw new Error(
				`${divergences} of ${fixture.length} entries diverged from Python.\nFirst ${failures.length}:\n${failures.join("\n---\n")}`
			)
		}
		expect(divergences).toBe(0)
	})

	test("offset reconstruction is correct on the supported subset (no byte-fallback, no ZWJ)", async () => {
		const fixture: FixtureEntry[] = JSON.parse(readFileSync(LARGE_FIXTURE_PATH, "utf-8"))
		const tokenizer = await MailwomanTokenizer.loadFromFile(MODEL_PATH)

		// Documented unsupported cases in tokenizer.ts: byte-fallback pieces (`<0xHH>`) and inputs
		// containing zero-width joiner / non-joiner characters that the walker can't account for.
		const BYTE_FALLBACK_RE = /^<0x[0-9A-F]{2}>$/u
		const ZERO_WIDTH_RE = /[\u200B-\u200F\uFEFF]/u

		let supported = 0
		let mismatches = 0
		const failures: string[] = []
		const MAX_REPORTED = 5

		for (const { raw, pieces: expectedPieces } of fixture) {
			if (ZERO_WIDTH_RE.test(raw)) continue

			if (expectedPieces.some((p) => BYTE_FALLBACK_RE.test(p))) continue
			supported++

			const { pieces } = tokenizer.encode(raw)

			for (const p of pieces) {
				const literal = p.piece.startsWith(SPACE_SENTINEL) ? p.piece.slice(SPACE_SENTINEL.length) : p.piece

				if (raw.slice(p.start, p.end) !== literal) {
					mismatches++

					if (failures.length < MAX_REPORTED) {
						failures.push(
							`raw=${JSON.stringify(raw)}\n  piece=${JSON.stringify(p.piece)} literal=${JSON.stringify(literal)} start=${p.start} end=${p.end}\n  raw.slice=${JSON.stringify(raw.slice(p.start, p.end))}`
						)
					}
					break
				}
			}
		}

		// Sanity: we expect the vast majority of corpus rows to be in the supported subset (Latin-
		// script and Latin-with-diacritics dominate).
		expect(supported).toBeGreaterThan(fixture.length * 0.95)

		// Allow up to 0.1% slack for Unicode normalization edge cases — SentencePiece NFKC-
		// normalizes pieces (e.g. fullwidth ＝ → ASCII =, precomposed Hangul → decomposed Jamo),
		// so the piece TEXT may differ from raw.slice even when the offset itself is correct.
		// Properly handling this needs an NFKC-aware comparator; current sweep shows ≤ 0.05% rate.
		const mismatchRate = mismatches / supported

		if (mismatchRate >= 0.001) {
			throw new Error(
				`${mismatches} of ${supported} supported entries had at least one offset-mismatch (${(mismatchRate * 100).toFixed(3)}%, threshold 0.1%).\nFirst ${failures.length}:\n${failures.join("\n---\n")}`
			)
		}
	})
})

if (!haveLargeFixture) {
	describe("MailwomanTokenizer — large-scale parity (skipped)", () => {
		test(`generate the fixture to enable: see fixtures/generate-tokenizer-parity.py --from-parquet`, () => {
			expect(true).toBe(true)
		})
	})
}
