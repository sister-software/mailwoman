/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The half of the activity lexicon's audit that needs artifacts the vocabulary itself does not depend on.
 *
 *   `@mailwoman/activity-lexicon` declares zero dependencies, so it can check that a derived form's base is
 *   present and that a citation is not empty, and nothing more. The claims that matter most are the ones
 *   pointing OUTSIDE it: a committed query row, a synonym in the committed POI taxonomy, a clause of the
 *   compiled concept's own description. Those are checked here, where all three artifacts are held.
 *
 *   An attestation nobody can check is indistinguishable from an invented one, which is the whole reason the
 *   lexicon replaced a table whose provenance read `AUTHORED FOR ONE EXPERIMENT`.
 */

import { readActivityLexicon } from "@mailwoman/activity-lexicon"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/utils"
import type { CompiledGeographicModel } from "@mailwoman/geographic-model"
import { POI_BOARD_FIXTURES, type POIBoardFixture } from "mailwoman/eval-harness/poi-board"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

const lexicon = readActivityLexicon()

const board = new Map(
	(await Array.fromAsync(JSONSpliterator.fromAsync<POIBoardFixture>(POI_BOARD_FIXTURES))).map((row) => [row.id, row])
)

const { readCompiledGeographicModel } = await import("@mailwoman/geographic-model/scripts/build-artifact")
const model: CompiledGeographicModel = readCompiledGeographicModel()

interface CuratedOverlay {
	synonyms: Array<{ phrase: string; categoryID: string; locales?: string[] }>
}

const overlay = await readLocalJSONFile<CuratedOverlay>(
	repoRootPath("packages", "poi-taxonomy", "data", "curated-overlay.json")
)

/**
 * Split a `<file>#<record>` reference. Both halves are required: the file is what a reader greps, the record is what a
 * test resolves.
 */
function splitReference(reference: string): { file: string; record: string } {
	const index = reference.lastIndexOf("#")

	return { file: reference.slice(0, index), record: reference.slice(index + 1) }
}

describe("every committed-query attestation resolves to the row it names", () => {
	const cited = lexicon.phrases.filter((entry) => entry.attestation.kind === "committed-query")

	it("cites at least one row, or nothing anchors the lexicon", () => {
		expect(cited.length).toBeGreaterThan(0)
	})

	for (const entry of cited) {
		const attestation = entry.attestation

		if (attestation.kind !== "committed-query") continue

		it(`${entry.phrase} → ${attestation.reference}`, () => {
			const { file, record } = splitReference(attestation.reference)

			expect(file).toBe("packages/mailwoman/eval-harness/fixtures/poi-board.jsonl")

			const row = board.get(record)

			expect(row, `board row ${record} is not committed`).toBeDefined()
			expect(row!.query).toBe(attestation.detail)
		})
	}
})

describe("every regional-register attestation copies the locales of the record it names", () => {
	for (const entry of lexicon.phrases) {
		const attestation = entry.attestation

		if (attestation.kind !== "regional-register") continue

		it(`${entry.phrase} → ${attestation.reference}`, () => {
			const { file, record } = splitReference(attestation.reference)

			expect(file).toBe("packages/poi-taxonomy/data/curated-overlay.json")

			const synonym = overlay.synonyms.find((candidate) => candidate.phrase === record)

			expect(synonym, `curated synonym ${record} is not committed`).toBeDefined()
			expect(entry.locales).toEqual(synonym!.locales)

			for (const tag of synonym!.locales ?? []) {
				expect(attestation.detail).toContain(tag)
			}
		})
	}
})

describe("every concept-description attestation quotes the compiled description verbatim", () => {
	for (const entry of lexicon.phrases) {
		const attestation = entry.attestation

		if (attestation.kind !== "concept-description") continue

		it(`${entry.phrase} → ${attestation.reference}`, () => {
			const concept = model.concepts.find((candidate) => String(candidate.id) === attestation.reference)

			expect(concept, `the compiled model carries no concept ${attestation.reference}`).toBeDefined()
			expect(concept!.description).toContain(attestation.detail)
		})
	}
})

describe("every declared activity is an activity the compiled model carries", () => {
	for (const entry of lexicon.phrases) {
		it(`${entry.phrase} → ${entry.activity}`, () => {
			const concept = model.concepts.find((candidate) => String(candidate.id) === entry.activity)

			expect(concept).toBeDefined()
			expect(String(concept!.kind)).toBe("activity")
		})
	}
})
