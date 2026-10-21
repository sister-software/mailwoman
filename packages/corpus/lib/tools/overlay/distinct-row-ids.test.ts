/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `distinctRowIDs` — a file whose rendered variants share one `source_id` becomes one the split can route.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { afterAll, describe, expect, it } from "vitest"

import { readParquetRows } from "#parquet/readers"
import type { ParquetRow } from "#parquet/schema"
import { writeParquetFile } from "#parquet/writers"
import { distinctRowIDs, ROW_ID_SEPARATOR } from "#tools/overlay/distinct-row-ids"
import { splitOverlaySlice } from "#tools/overlay/split-slice"

const root = await temporaryDirectory("mw-distinct-row-ids-")

afterAll(() => root[Symbol.asyncDispose]())

const FIXTURE_DERIVATION = { extractHash: "fixture", codeHash: "fixture", config: {} }

/**
 * One PT house-venue row: PT declares no holdout, so the hashed place holdout keys it by its venue.
 */
function venueRow(sourceID: string, venue: string): ParquetRow {
	const locality = "Almodôvar"
	const postcode = "7700-014"
	const raw = `${venue}, 8 Cedar Ln, ${locality}, Beja ${postcode}`
	const localityStart = raw.indexOf(locality)
	const postcodeStart = raw.lastIndexOf(postcode)

	return {
		raw,
		tokens: raw.split(" "),
		labels: raw.split(" ").map(() => "O"),
		span_starts: [0, localityStart, postcodeStart],
		span_ends: [venue.length, localityStart + locality.length, raw.length],
		span_tags: ["venue", "locality", "postcode"],
		country: "PT",
		locale: "pt-PT",
		source: "invented-house-venue",
		source_id: sourceID,
		license: "CC-BY-4.0",
		register: null,
		surface: "composed",
		augmentation: null,
		base_source_id: null,
	}
}

describe("distinctRowIDs", () => {
	it("turns a file the split refuses into one it routes, keeping each record's id before the separator", async () => {
		const input = root.path("part-venue.parquet")
		const output = root.path("part-venue.distinct.parquet")

		// Two hundred venues under one record id: the hashed holdout sends about one in fifty out of train.
		const rows = [
			...Array.from({ length: 200 }, (_, index) => venueRow("synth-house-venue-shared", `Venue ${index}`)),
			venueRow("synth-house-venue-alone", "Chez Marcel"),
		]

		await writeParquetFile(rows, input, FIXTURE_DERIVATION)

		await expect(splitOverlaySlice({ input, outputDir: root.path })).rejects.toThrow(/same source_id/)

		const result = await distinctRowIDs({ input, output })

		expect(result).toEqual({ rows: 201, sharedIDs: 1, rewrittenRows: 200 })

		const written = await readParquetRows<ParquetRow>(output)

		expect(written.map((row) => row.raw)).toEqual(rows.map((row) => row.raw))
		expect(new Set(written.map((row) => row.source_id)).size).toBe(201)
		expect(written.at(-1)!.source_id).toBe("synth-house-venue-alone")

		for (const row of written.slice(0, 200)) {
			expect(row.source_id.slice(0, row.source_id.lastIndexOf(ROW_ID_SEPARATOR))).toBe("synth-house-venue-shared")
		}

		const split = await splitOverlaySlice({ input: output, outputDir: root.path })

		expect(split.rows).toBe(201)
		expect(split.counts.val + split.counts.test).toBeGreaterThan(0)
		expect(split.counts.train).toBeGreaterThan(0)
	})

	it("refuses two rows that share both id and text, which a text-derived suffix cannot separate", async () => {
		const input = root.path("part-duplicate.parquet")

		await writeParquetFile([venueRow("dup", "Chez Marcel"), venueRow("dup", "Chez Marcel")], input, FIXTURE_DERIVATION)

		await expect(distinctRowIDs({ input, output: root.path("part-duplicate.out.parquet") })).rejects.toThrow(
			/share both source_id and raw/
		)
	})
})
