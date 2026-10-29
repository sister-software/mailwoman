import { describe, expect, it } from "vitest"

import { readConstraints, type ConstraintDecode } from "#tools/eval-harness/grammar/census/constraints"

/* oxlint-disable sister-software/multiline-statement-padding -- recorded decodes keep setup beside their assertion */

type RecordedToken = [piece: string, start: number, end: number, label: string]

/**
 * A decode as `traceParse` recorded it: the text, then each piece with its offsets and final label.
 */
function recorded(text: string, tokens: RecordedToken[]): ConstraintDecode {
	return {
		text,
		pieces: tokens.map(([piece, start, end]) => ({ piece, start, end })),
		tokens: tokens.map(([, start, end, label]) => ({ start, end, label })),
	}
}

const NO_REGISTRY_HIT = { registry: [], streetAffix: [] }

// shipped 10.7.0 (restaged fp32, en-us package) on the osm-venue-with-address row, reading `1130` as a postcode.
const ZAMIN_SHIPPED = recorded("Zamin Bank Baş Ofis, 1130 Babək prospekti, Bakı", [
	["▁Za", 0, 2, "B-venue"],
	["min", 2, 5, "I-venue"],
	["▁Bank", 6, 10, "I-venue"],
	["▁Ba", 11, 13, "I-venue"],
	["ş", 13, 14, "I-venue"],
	["▁O", 15, 16, "I-venue"],
	["f", 16, 17, "I-venue"],
	["is", 17, 19, "I-venue"],
	[",", 19, 20, "O"],
	["▁1", 21, 22, "B-postcode"],
	["1", 22, 23, "I-postcode"],
	["3", 23, 24, "I-postcode"],
	["0", 24, 25, "I-postcode"],
	["▁", 26, 26, "O"],
	["B", 26, 27, "B-street"],
	["ab", 27, 29, "I-street"],
	["<0xC9>", 29, 29, "O"],
	["<0x99>", 29, 30, "B-street"],
	["k", 30, 31, "I-street"],
	["▁", 32, 32, "O"],
	["pro", 32, 35, "B-street"],
	["sp", 35, 37, "I-street"],
	["ek", 37, 39, "I-street"],
	["ti", 39, 41, "I-street"],
	[",", 41, 42, "O"],
	["▁", 43, 43, "O"],
	["B", 43, 44, "B-locality"],
	["ak", 44, 46, "I-locality"],
	["ı", 46, 47, "I-locality"],
])

// shipped on the photon-district-before-city row: the district and the city decoded as two locality tuples.
const STOKKA_SHIPPED = recorded("Liljeveien 20, Stokka, 4022 Stavanger", [
	["▁Li", 0, 2, "B-street"],
	["l", 2, 3, "I-street"],
	["je", 3, 5, "I-street"],
	["ve", 5, 7, "I-street"],
	["ien", 7, 10, "I-street"],
	["▁2", 11, 12, "B-house_number"],
	["0", 12, 13, "I-house_number"],
	[",", 13, 14, "O"],
	["▁Sto", 15, 18, "B-locality"],
	["kka", 18, 21, "I-locality"],
	[",", 21, 22, "O"],
	["▁4", 23, 24, "B-postcode"],
	["0", 24, 25, "I-postcode"],
	["2", 25, 26, "I-postcode"],
	["2", 26, 27, "I-postcode"],
	["▁Sta", 28, 31, "B-locality"],
	["van", 31, 34, "I-locality"],
	["ger", 34, 37, "I-locality"],
])

// arm B seed 42 on the minimal-pair ladder's comma-free rung: three locality tuples in one phrase.
const KUAT_B42 = recorded("Өтеген батыр Қуат, улица Алибека Нургожа, 17", [
	["▁", 0, 0, "O"],
	["Ө", 0, 1, "B-locality"],
	["те", 1, 3, "I-locality"],
	["ген", 3, 6, "I-locality"],
	["▁", 7, 7, "O"],
	["бат", 7, 10, "B-locality"],
	["ыр", 10, 12, "I-locality"],
	["▁", 13, 13, "O"],
	["Қ", 13, 14, "B-locality"],
	["уа", 14, 16, "I-locality"],
	["т", 16, 17, "I-locality"],
	[",", 17, 18, "O"],
	["▁улица", 19, 24, "B-street"],
	["▁Али", 25, 28, "I-street"],
	["бе", 28, 30, "I-street"],
	["ка", 30, 32, "I-street"],
	["▁Нур", 33, 36, "I-street"],
	["го", 36, 38, "I-street"],
	["жа", 38, 40, "I-street"],
	[",", 40, 41, "O"],
	["▁", 42, 42, "O"],
	["1", 42, 43, "B-house_number"],
	["7", 43, 44, "I-house_number"],
])

// shipped (de-de package) on the §6 board row: the street restarts after `Unter`.
const UNTER_DEN_LINDEN_SHIPPED = recorded("Unter den Linden 77, 10117 Berlin", [
	["▁Unter", 0, 5, "B-street"],
	["▁", 6, 6, "O"],
	["den", 6, 9, "B-street"],
	["▁Linden", 10, 16, "I-street"],
	["▁7", 17, 18, "B-house_number"],
	["7", 18, 19, "I-house_number"],
	[",", 19, 20, "O"],
	["▁10", 21, 23, "B-postcode"],
	["1", 23, 24, "I-postcode"],
	["1", 24, 25, "I-postcode"],
	["7", 25, 26, "I-postcode"],
	["▁Berlin", 27, 33, "B-locality"],
])

const boundaryAt = (reading: ReturnType<typeof readConstraints>, character: number) =>
	reading.boundaries.find((boundary) => boundary.boundaryCharacter === character)

describe("readConstraints", () => {
	it("licenses the Zamin number boundary by its character-class change across a bare piece", () => {
		const reading = readConstraints(ZAMIN_SHIPPED, NO_REGISTRY_HIT)
		const numberBoundary = boundaryAt(reading, 26)

		expect([numberBoundary!.left.tag, numberBoundary!.right.tag]).toEqual(["postcode", "street"])
		expect(numberBoundary!.classification).toEqual(
			expect.objectContaining({ licenses: ["character_class"], segmentVerdict: "licensed" })
		)
		expect(reading.c6Violations).toEqual([])
	})

	it("reports the byte-fallback split inside `Babək` as an unlicensed boundary inside a phrase and a word", () => {
		const reading = readConstraints(ZAMIN_SHIPPED, NO_REGISTRY_HIT)

		expect(reading.c4Violations.map((b) => [b.left.tag, b.right.tag, b.boundaryCharacter, b.insideWord])).toEqual([
			["street", "street", 29, true],
		])
	})

	it("reports the §6 `Unter | den Linden` restart as a C4 violation", () => {
		const reading = readConstraints(UNTER_DEN_LINDEN_SHIPPED, NO_REGISTRY_HIT)

		expect(reading.c4Violations.map((b) => [b.left.tag, b.right.tag, b.boundaryCharacter, b.insideWord])).toEqual([
			["street", "street", 6, false],
		])
	})

	it("sees no boundary between two locality tuples a comma and a postcode separate", () => {
		const reading = readConstraints(STOKKA_SHIPPED, NO_REGISTRY_HIT)

		expect(reading.spans.filter((span) => span.tag === "locality")).toHaveLength(2)
		expect(reading.boundaries.filter((b) => b.left.tag === "locality" && b.right.tag === "locality")).toEqual([])
		expect(reading.c4SegmentViolations).toEqual([])
		expect(reading.c6Violations).toEqual([])
	})

	it("reports locality tuples restarting inside one comma-free segment the grouper proposes no phrase across", () => {
		const reading = readConstraints(KUAT_B42, NO_REGISTRY_HIT)

		expect(reading.c4Violations).toEqual([])
		expect(reading.c4SegmentViolations.map((b) => [b.left.tag, b.right.tag, b.boundaryCharacter])).toEqual([
			["locality", "locality", 7],
			["locality", "locality", 13],
		])
	})

	it("reports C6 when a covering registry entry spans a boundary a nested hit aligns with", () => {
		const reading = readConstraints(KUAT_B42, {
			registry: [
				{
					startPiece: 1,
					endPiece: 11,
					startWord: 0,
					endWord: 3,
					entries: [{ wofID: 1, placetype: "locality", referential: 0.4 }],
				},
				{
					startPiece: 8,
					endPiece: 11,
					startWord: 2,
					endWord: 3,
					entries: [{ wofID: 2, placetype: "locality", referential: 0.6 }],
				},
			],
			streetAffix: [],
		})

		expect(reading.c6Violations).toEqual([expect.objectContaining({ boundary: 8, nestedSide: "right" })])
		expect(reading.c4SegmentViolations.map((b) => b.boundaryCharacter)).toEqual([7])
	})

	it("keeps an unread registry apart from a clear one", () => {
		const reading = readConstraints(UNTER_DEN_LINDEN_SHIPPED, { registry: null, streetAffix: null })

		expect(reading.c6Violations).toBeNull()
		expect(reading.c4Violations).toEqual([])
		expect(reading.c4Unmeasured.map((b) => b.boundaryCharacter)).toEqual([6])
	})
})
