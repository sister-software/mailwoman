import { readLocalJSONFile, pathExists } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import { MailwomanTokenizer, SPACE_SENTINEL } from "@mailwoman/neural/tokenizer"
import { describe, expect, test } from "vitest"

const MODEL_PATH = workspacePath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")
const LARGE_FIXTURE_PATH = workspacePath("neural", "test", "fixtures", "tokenizer-parity-large-v0.1.0.json")

const haveLargeFixture = await pathExists(LARGE_FIXTURE_PATH)

interface FixtureEntry {
	raw: string
	pieces: string[]
	ids: number[]
}

describe.skipIf(!haveLargeFixture)("MailwomanTokenizer — large-scale parity (10k corpus rows)", () => {
	test("byte-for-byte pieces+ids equality across every fixture entry", async () => {
		const fixture = await readLocalJSONFile<FixtureEntry[]>(LARGE_FIXTURE_PATH)
		const tokenizer = await MailwomanTokenizer.loadFromFile(MODEL_PATH)

		let divergences = 0
		const failures: string[] = []
		const MAX_REPORTED = 5

		for (const { raw, pieces: expectedPieces, ids: expectedIDs } of fixture) {
			const result = tokenizer.encode(raw)
			const tsPieces = result.pieces.map((p) => p.piece)
			const piecesMatch = tsPieces.length === expectedPieces.length && tsPieces.every((p, i) => p === expectedPieces[i])
			const idsMatch = result.ids.length === expectedIDs.length && result.ids.every((id, i) => id === expectedIDs[i])

			if (!piecesMatch || !idsMatch) {
				divergences++

				if (failures.length < MAX_REPORTED) {
					failures.push(
						`raw=${stringifyJSON(raw)}\n  expected pieces=${stringifyJSON(expectedPieces)}\n  TS pieces=${stringifyJSON(tsPieces)}\n  expected ids=${stringifyJSON(expectedIDs)}\n  TS ids=${stringifyJSON(result.ids)}`
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

	test("Offset reconstruction is correct on the supported subset (neither byte-fallback nor ZWJ)", async () => {
		const fixture = await readLocalJSONFile<FixtureEntry[]>(LARGE_FIXTURE_PATH)
		const tokenizer = await MailwomanTokenizer.loadFromFile(MODEL_PATH)

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
							`raw=${stringifyJSON(raw)}\n  piece=${stringifyJSON(p.piece)} literal=${stringifyJSON(literal)} start=${p.start} end=${p.end}\n  raw.slice=${stringifyJSON(raw.slice(p.start, p.end))}`
						)
					}

					break
				}
			}
		}

		expect(supported).toBeGreaterThan(fixture.length * 0.95)

		const mismatchRate = mismatches / supported

		if (mismatchRate >= 0.001) {
			throw new Error(
				`${mismatches} of ${supported} supported entries had at least one offset-mismatch (${(mismatchRate * 100).toFixed(3)}%, threshold 0.1%).\nFirst ${failures.length}:\n${failures.join("\n---\n")}`
			)
		}
	})
})
