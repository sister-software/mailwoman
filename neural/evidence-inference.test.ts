/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   TS↔Python EVIDENCE-CHANNEL painter parity (Option-A Phase 2). The fixture
 *   (`test/fixtures/evidence-parity-v2.json`, regenerate via `generate-evidence-parity.py`) carries
 *   mini street-type + locality-surface lexicons and per-piece features painted by corpus-python's
 *   REAL painter; this test replays the same lexicons + piece offsets through the generic TS painter
 *   (`buildGazetteerFeatures`) and asserts byte equality. Train and inference must share one
 *   computation — this is the fence.
 *
 *   The probe set deliberately carries the classes that have bitten: hyphen/apostrophe folds (a
 *   Phase-1 defect made them unreachable keys), uppercase-gated short codes, homograph bits,
 *   longest-first multi-token matches, the lowercase register (operator doctrine), negatives.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { buildGazetteerFeatures, parseGazetteerLexicon } from "./gazetteer-inference.ts"
import type { TokenizedPiece } from "./tokenizer.ts"

interface FixtureCase {
	raw: string
	pieces: Array<{ piece: string; start: number; end: number }>
	street: { features: number[][]; confidence: number[] }
	locality: { features: number[][]; confidence: number[] }
}

interface Fixture {
	street_lexicon: Parameters<typeof parseGazetteerLexicon>[0]
	locality_lexicon: Parameters<typeof parseGazetteerLexicon>[0]
	cases: FixtureCase[]
}

const fixture: Fixture = JSON.parse(
	readFileSync(join(import.meta.dirname, "test", "fixtures", "evidence-parity-v2.json"), "utf8")
)

const toPieces = (c: FixtureCase): TokenizedPiece[] =>
	c.pieces.map((p) => ({ piece: p.piece, id: 0, start: p.start, end: p.end }))

describe("evidence-channel painter parity (TS ↔ corpus-python)", () => {
	const street = parseGazetteerLexicon(fixture.street_lexicon)
	const locality = parseGazetteerLexicon(fixture.locality_lexicon)

	it("fixture is present and non-trivial", () => {
		expect(fixture.cases.length).toBeGreaterThanOrEqual(10)
	})

	for (const c of fixture.cases) {
		it(`paints ${JSON.stringify(c.raw)} identically on both channels`, () => {
			const pieces = toPieces(c)
			const s = buildGazetteerFeatures(c.raw, pieces, street)
			const l = buildGazetteerFeatures(c.raw, pieces, locality)

			expect(s.features).toEqual(c.street.features)
			expect(s.confidence).toEqual(c.street.confidence)
			expect(l.features).toEqual(c.locality.features)
			expect(l.confidence).toEqual(c.locality.confidence)
		})
	}
})
