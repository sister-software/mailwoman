/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	assertHeldOutSplit,
	NON_NATIVE_ORDER_SPLIT,
	nonNativeOrderFilterSQL,
	nonNativeOrderGoldenRows,
	nonNativeOrderTupleOf,
	readNonNativeOrderTuples,
	renderPostcodeOrder,
	sampleNonNativeOrderTuples,
	type NonNativeOrderCorpusRow,
	type NonNativeOrderTuple,
} from "#tools/postcode/non-native-order"

/**
 * A corpus row with spans computed from the component texts, so the offsets match `raw`.
 */
function corpusRow(raw: string, components: Array<[tag: string, text: string]>): NonNativeOrderCorpusRow {
	let from = 0
	const starts: number[] = []
	const ends: number[] = []

	for (const [, text] of components) {
		const start = raw.indexOf(text, from)

		starts.push(start)
		ends.push(start + text.length)
		from = start + text.length
	}

	return {
		raw,
		span_tags: components.map(([tag]) => tag),
		span_starts: starts,
		span_ends: ends,
		country: "it",
		source: "openaddresses",
		source_id: "row-1",
	}
}

const roma: NonNativeOrderTuple = {
	house_number: "12",
	street: "Via del Corso",
	locality: "Roma",
	postcode: "00186",
	cc: "IT",
	source: "openaddresses",
	streetFirst: true,
	baseSourceID: "it-1",
}

const saoPaulo: NonNativeOrderTuple = {
	house_number: "1000",
	street: "Av. Paulista",
	locality: "São Paulo",
	postcode: "01310-100",
	cc: "BR",
	source: "openaddresses",
	streetFirst: true,
	baseSourceID: "br-1",
}

const paris: NonNativeOrderTuple = {
	house_number: "8",
	street: "Rue de Rivoli",
	locality: "Paris",
	postcode: "75004",
	cc: "FR",
	source: "ban",
	streetFirst: false,
	baseSourceID: "fr-1",
}

const repeat = (tuple: NonNativeOrderTuple, n = 24): NonNativeOrderTuple[] =>
	Array.from({ length: n }, () => ({ ...tuple }))

describe("the held-out split", () => {
	it("is the test split", () => {
		expect(NON_NATIVE_ORDER_SPLIT).toBe("test")
		expect(() => assertHeldOutSplit("test")).not.toThrow()
	})

	it.each(["train", "val"])("refuses the %s split before opening a file", async (split) => {
		expect(() => assertHeldOutSplit(split)).toThrow(/reads only the test split/)

		await expect(Array.fromAsync(readNonNativeOrderTuples(split, [], ["IT"], ["openaddresses"]))).rejects.toThrow(
			/reads only the test split/
		)
	})
})

describe("nonNativeOrderTupleOf", () => {
	it("rebuilds the components from the spans and records the street-first order", () => {
		const row = corpusRow("Via del Corso 12, 00186 Roma RM", [
			["street", "Via del Corso"],
			["house_number", "12"],
			["postcode", "00186"],
			["locality", "Roma"],
			["region", "RM"],
		])

		expect(nonNativeOrderTupleOf(row)).toEqual({
			house_number: "12",
			street: "Via del Corso",
			locality: "Roma",
			postcode: "00186",
			cc: "IT",
			source: "openaddresses",
			streetFirst: true,
			baseSourceID: "row-1",
		})
	})

	it("records a house-number-first source", () => {
		const row = corpusRow("8 Rue de Rivoli 75004 Paris", [
			["house_number", "8"],
			["street", "Rue de Rivoli"],
			["postcode", "75004"],
			["locality", "Paris"],
		])

		expect(nonNativeOrderTupleOf(row)?.streetFirst).toBe(false)
	})

	it("yields nothing for a row missing one of the four components", () => {
		const row = corpusRow("Via del Corso 12, Roma", [
			["street", "Via del Corso"],
			["house_number", "12"],
			["locality", "Roma"],
		])

		expect(nonNativeOrderTupleOf(row)).toBeNull()
	})

	it("throws on a span triple that is not parallel rather than skipping the row", () => {
		const row = { ...corpusRow("8 Rue", [["house_number", "8"]]), span_ends: [] }

		expect(() => nonNativeOrderTupleOf(row)).toThrow(/parallel/)
	})
})

describe("nonNativeOrderFilterSQL", () => {
	it("escapes literals and requires all four tags", () => {
		const sql = nonNativeOrderFilterSQL(["fr"], ["o'source"])

		expect(sql).toContain("upper(country) IN ('FR')")
		expect(sql).toContain("source IN ('o''source')")
		expect(sql).toContain("list_contains(span_tags, 'postcode')")
	})

	it("refuses an empty country or source set", () => {
		expect(() => nonNativeOrderFilterSQL([], ["ban"])).toThrow(/at least one country and one source/)
	})
})

describe("renderPostcodeOrder", () => {
	const renders = (tuple: NonNativeOrderTuple) => nonNativeOrderGoldenRows(repeat(tuple), 4242).rows

	it("writes an Italian postcode after the locality, where IT's layout writes it before", () => {
		const rows = renders(roma)

		for (const row of rows) {
			expect(row.raw.indexOf("00186")).toBeGreaterThan(row.raw.indexOf("Roma"))
			expect(row.raw.startsWith("Via del Corso")).toBe(true)
		}

		expect(rows.some((row) => row.raw === "Via del Corso 12, Roma 00186")).toBe(true)
	})

	it("writes a Brazilian postcode before the locality, where BR's layout writes it after", () => {
		const rows = renders(saoPaulo)

		for (const row of rows) {
			expect(row.raw.indexOf("01310-100")).toBeLessThan(row.raw.indexOf("São Paulo"))
		}

		expect(rows.some((row) => row.raw === "Av. Paulista 1000, 01310-100 São Paulo")).toBe(true)
	})

	it("keeps the source's house-number-first order", () => {
		const rows = renders(paris)

		expect(rows.every((row) => row.raw.startsWith("8 Rue de Rivoli"))).toBe(true)
		expect(rows.some((row) => row.raw === "8 Rue de Rivoli, Paris 75004")).toBe(true)
	})

	it("writes golden rows whose every component appears verbatim, with the test-split row behind each", () => {
		for (const row of [...renders(roma), ...renders(saoPaulo)]) {
			for (const value of Object.values(row.components)) {
				expect(row.raw).toContain(value)
			}
		}

		expect(renders(roma)[0]).toMatchObject({ country: "IT", source: "openaddresses", baseSourceID: "it-1" })
	})

	it("writes no row for a country libaddressinput does not describe, rather than guessing an order", () => {
		// The UAE states no postcode, and Japan's layout prints no locality field, so neither states an order.
		expect(renderPostcodeOrder({ ...roma, cc: "AE" }, () => 0)).toBeNull()

		expect(nonNativeOrderGoldenRows([{ ...roma, cc: "JP" }, roma], 1)).toMatchObject({
			skipped: 1,
			rows: [{ country: "IT" }],
		})
	})
})

describe("sampleNonNativeOrderTuples", () => {
	const tuple = (cc: string, source: string, locality: string, n: number): NonNativeOrderTuple => ({
		house_number: String(n),
		street: "Main",
		locality,
		postcode: "00000",
		cc,
		source,
		streetFirst: false,
		baseSourceID: `${cc}-${source}-${locality}-${n}`,
	})

	it("caps each (country, source) pair and spreads the cap across localities", async () => {
		const rows = [
			...Array.from({ length: 10 }, (_, n) => tuple("FR", "ban", "Paris", n)),
			...Array.from({ length: 10 }, (_, n) => tuple("FR", "ban", "Lyon", n)),
			tuple("FR", "ban", "Nice", 0),
			...Array.from({ length: 10 }, (_, n) => tuple("FR", "openaddresses", "Paris", n)),
			...Array.from({ length: 10 }, (_, n) => tuple("IT", "openaddresses", "Roma", n)),
		]

		const kept = await sampleNonNativeOrderTuples(rows, { cap: 5, localityQuota: 4 })

		const count = (cc: string, source: string, locality?: string) =>
			kept.filter((t) => t.cc === cc && t.source === source && (!locality || t.locality === locality)).length

		expect(count("FR", "ban")).toBe(5)
		expect(count("FR", "openaddresses")).toBe(4)
		expect(count("IT", "openaddresses")).toBe(4)
		// Every locality is reached before any repeats a third time.
		expect(count("FR", "ban", "Nice")).toBe(1)
		expect(count("FR", "ban", "Paris")).toBe(2)
		expect(count("FR", "ban", "Lyon")).toBe(2)
	})
})
