/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { classifyKindSync } from "./classify.js"
import type { NormalizedInputLite, QueryShapeLike } from "./types.js"

function input(normalized: string): NormalizedInputLite {
	return { raw: normalized, normalized }
}

function shape(opts: Partial<QueryShapeLike> = {}): QueryShapeLike {
	return { knownFormats: [], ...opts }
}

describe("classifyKind — postcode_only", () => {
	it("classifies a bare US ZIP as postcode_only", () => {
		const result = classifyKindSync(
			input("10118"),
			shape({
				knownFormats: [{ format: "us_zip", span: { start: 0, end: 5 }, confidence: 0.6 }],
				characterClass: "numeric",
				totalLength: 5,
				segments: [{ body: "10118", index: 0 }],
			})
		)
		expect(result.kind).toBe("postcode_only")
	})

	it("does NOT classify a ZIP embedded in a longer input as postcode_only", () => {
		const result = classifyKindSync(
			input("350 5th Ave 10118"),
			shape({
				knownFormats: [{ format: "us_zip", span: { start: 12, end: 17 }, confidence: 0.6 }],
				characterClass: "alphanumeric",
				totalLength: 17,
				segments: [{ body: "350 5th Ave 10118", index: 0 }],
			})
		)
		expect(result.kind).not.toBe("postcode_only")
	})

	it("classifies a US ZIP+4 as postcode_only", () => {
		const result = classifyKindSync(
			input("10118-1234"),
			shape({
				knownFormats: [{ format: "us_zip4", span: { start: 0, end: 10 }, confidence: 0.95 }],
				characterClass: "alphanumeric",
				totalLength: 10,
				segments: [{ body: "10118-1234", index: 0 }],
			})
		)
		expect(result.kind).toBe("postcode_only")
	})
})

describe("classifyKind — locality_only", () => {
	it("classifies a single-word locality as locality_only", () => {
		const result = classifyKindSync(
			input("Paris"),
			shape({
				knownFormats: [],
				characterClass: "alpha",
				totalLength: 5,
				segments: [{ body: "Paris", index: 0 }],
			})
		)
		expect(result.kind).toBe("locality_only")
	})

	it("classifies a two-segment short alpha input as locality_only", () => {
		const result = classifyKindSync(
			input("Paris FR"),
			shape({
				knownFormats: [],
				characterClass: "alpha",
				totalLength: 8,
				segments: [
					{ body: "Paris", index: 0 },
					{ body: "FR", index: 1 },
				],
			})
		)
		expect(result.kind).toBe("locality_only")
	})

	it("does NOT classify a long alpha input as locality_only", () => {
		const result = classifyKindSync(
			input("The Magnificent Republic of Eastern Suburbia Hills"),
			shape({
				knownFormats: [],
				characterClass: "alpha",
				totalLength: 50,
				segments: [{ body: "The Magnificent Republic of Eastern Suburbia Hills", index: 0 }],
			})
		)
		expect(result.kind).not.toBe("locality_only")
	})

	it("does NOT classify alphanumeric input as locality_only", () => {
		const result = classifyKindSync(
			input("Apt 4"),
			shape({
				knownFormats: [],
				characterClass: "alphanumeric",
				totalLength: 5,
				segments: [{ body: "Apt 4", index: 0 }],
			})
		)
		expect(result.kind).not.toBe("locality_only")
	})
})

describe("classifyKind — structured_address", () => {
	it("classifies a multi-segment alphanumeric input as structured_address", () => {
		const result = classifyKindSync(
			input("350 5th Ave, New York, NY 10118"),
			shape({
				knownFormats: [{ format: "us_zip", span: { start: 26, end: 31 }, confidence: 0.6 }],
				characterClass: "alphanumeric",
				totalLength: 31,
				segments: [
					{ body: "350 5th Ave", index: 0 },
					{ body: "New York", index: 1 },
					{ body: "NY 10118", index: 2 },
				],
			})
		)
		expect(result.kind).toBe("structured_address")
	})

	it("classifies a single-segment long alphanumeric as structured_address", () => {
		const result = classifyKindSync(
			input("350 5th Ave NYC NY 10118"),
			shape({
				knownFormats: [{ format: "us_zip", span: { start: 19, end: 24 }, confidence: 0.6 }],
				characterClass: "alphanumeric",
				totalLength: 24,
				segments: [{ body: "350 5th Ave NYC NY 10118", index: 0 }],
			})
		)
		expect(result.kind).toBe("structured_address")
	})
})

describe("classifyKind — po_box", () => {
	it("classifies PO Box input as po_box", () => {
		const result = classifyKindSync(
			input("PO Box 1234"),
			shape({
				knownFormats: [{ format: "po_box", span: { start: 0, end: 11 }, confidence: 0.85 }],
				characterClass: "alphanumeric",
				totalLength: 11,
				segments: [{ body: "PO Box 1234", index: 0 }],
			})
		)
		expect(result.kind).toBe("po_box")
	})

	it("classifies French BP variant as po_box", () => {
		const result = classifyKindSync(
			input("BP 42"),
			shape({
				knownFormats: [{ format: "po_box", span: { start: 0, end: 5 }, confidence: 0.85 }],
				characterClass: "alphanumeric",
				totalLength: 5,
				segments: [{ body: "BP 42", index: 0 }],
			})
		)
		expect(result.kind).toBe("po_box")
	})

	it("PO box beats structured_address when both could apply", () => {
		const result = classifyKindSync(
			input("PO Box 1234, San Francisco, CA"),
			shape({
				knownFormats: [{ format: "po_box", span: { start: 0, end: 11 }, confidence: 0.85 }],
				characterClass: "alphanumeric",
				totalLength: 30,
				segments: [
					{ body: "PO Box 1234", index: 0 },
					{ body: "San Francisco", index: 1 },
					{ body: "CA", index: 2 },
				],
			})
		)
		expect(result.kind).toBe("po_box")
	})
})

describe("classifyKind — intersection", () => {
	it("classifies 'Corner of X and Y' as intersection", () => {
		const result = classifyKindSync(
			input("Corner of 5th and Main"),
			shape({
				knownFormats: [],
				characterClass: "alphanumeric",
				totalLength: 22,
				segments: [{ body: "Corner of 5th and Main", index: 0 }],
			})
		)
		expect(result.kind).toBe("intersection")
	})

	it("classifies '5th & 42nd' as intersection", () => {
		const result = classifyKindSync(
			input("5th & 42nd"),
			shape({
				knownFormats: [],
				characterClass: "alphanumeric",
				totalLength: 10,
				segments: [{ body: "5th & 42nd", index: 0 }],
			})
		)
		expect(result.kind).toBe("intersection")
	})

	it("classifies 'Broadway and 42nd Street' as intersection", () => {
		const result = classifyKindSync(
			input("Broadway and 42nd Street"),
			shape({
				knownFormats: [],
				characterClass: "alphanumeric",
				totalLength: 24,
				segments: [{ body: "Broadway and 42nd Street", index: 0 }],
			})
		)
		expect(result.kind).toBe("intersection")
	})
})

describe("classifyKind — landmark", () => {
	it("classifies 'Behind the gas station' as landmark", () => {
		const result = classifyKindSync(
			input("Behind the gas station"),
			shape({
				knownFormats: [],
				characterClass: "alpha",
				totalLength: 22,
				segments: [{ body: "Behind the gas station", index: 0 }],
			})
		)
		expect(result.kind).toBe("landmark")
	})

	it("classifies 'Across from the church' as landmark", () => {
		const result = classifyKindSync(
			input("Across from the church"),
			shape({
				knownFormats: [],
				characterClass: "alpha",
				totalLength: 22,
				segments: [{ body: "Across from the church", index: 0 }],
			})
		)
		expect(result.kind).toBe("landmark")
	})

	it("classifies 'Near the old post office' as landmark", () => {
		const result = classifyKindSync(
			input("Near the old post office"),
			shape({
				knownFormats: [],
				characterClass: "alpha",
				totalLength: 24,
				segments: [{ body: "Near the old post office", index: 0 }],
			})
		)
		expect(result.kind).toBe("landmark")
	})
})

describe("classifyKind — alternatives + confidence ordering", () => {
	it("returns alternatives sorted descending by confidence", () => {
		const result = classifyKindSync(
			input("Paris"),
			shape({
				knownFormats: [],
				characterClass: "alpha",
				totalLength: 5,
				segments: [{ body: "Paris", index: 0 }],
			})
		)
		// Verify the alternatives are sorted descending.
		for (let i = 1; i < result.alternatives.length; i++) {
			expect(result.alternatives[i]?.confidence).toBeLessThanOrEqual(result.alternatives[i - 1]?.confidence ?? 1)
		}
	})

	it("always surfaces vague as a fallback alternative", () => {
		const result = classifyKindSync(
			input("Paris"),
			shape({
				knownFormats: [],
				characterClass: "alpha",
				totalLength: 5,
				segments: [{ body: "Paris", index: 0 }],
			})
		)
		const altKinds = [result.kind, ...result.alternatives.map((a) => a.kind)]
		expect(altKinds).toContain("vague")
	})

	it("top kind confidence ≥ all alternatives", () => {
		const result = classifyKindSync(
			input("350 5th Ave, New York, NY 10118"),
			shape({
				knownFormats: [{ format: "us_zip", span: { start: 26, end: 31 }, confidence: 0.6 }],
				characterClass: "alphanumeric",
				totalLength: 31,
				segments: [
					{ body: "350 5th Ave", index: 0 },
					{ body: "New York", index: 1 },
					{ body: "NY 10118", index: 2 },
				],
			})
		)
		for (const alt of result.alternatives) {
			expect(alt.confidence).toBeLessThanOrEqual(result.confidence)
		}
	})
})

describe("classifyKind — vague fallback", () => {
	it("falls back to vague when no rule fires high", () => {
		const result = classifyKindSync(
			input("???"),
			shape({
				knownFormats: [],
				characterClass: "mixed",
				totalLength: 3,
				segments: [],
			})
		)
		expect(result.kind).toBe("vague")
	})

	it("returns vague with empty input", () => {
		const result = classifyKindSync(
			input(""),
			shape({
				knownFormats: [],
				characterClass: "alpha",
				totalLength: 0,
				segments: [],
			})
		)
		expect(result.kind).toBe("vague")
	})
})
