/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `buildSupportIndex` and `querySupport`: a corpus's train shapes and surfaces, counted once and read per row.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { afterAll, describe, expect, it } from "vitest"

import type { ParquetRow } from "#parquet/schema"
import { writeParquetFile } from "#parquet/writers"
import {
	buildSupportIndex,
	foldSurfaceSQL,
	querySupport,
	readSupportIndexRecord,
	renderSupportRow,
	supportIndexDirectoryFor,
	unclassifiedTags,
} from "#tools/support-index"

const root = await temporaryDirectory("mw-support-index-")

afterAll(() => root[Symbol.asyncDispose]())

const FIXTURE_DERIVATION = { extractHash: "fixture", codeHash: "fixture", config: {} }

/**
 * A row whose parts are joined with `, `, each part labeled with its tag.
 */
function row(
	sourceID: string,
	country: string,
	parts: ReadonlyArray<readonly [tag: string, text: string]>
): ParquetRow {
	const starts: number[] = []
	const ends: number[] = []
	const tags: string[] = []
	let raw = ""

	for (const [tag, text] of parts) {
		if (raw) {
			raw += ", "
		}

		starts.push(raw.length)
		raw += text
		ends.push(raw.length)
		tags.push(tag)
	}

	return {
		raw,
		tokens: raw.split(" "),
		labels: raw.split(" ").map(() => "O"),
		span_starts: starts,
		span_ends: ends,
		span_tags: tags,
		country,
		locale: country === "GB" ? "en-GB" : "en-US",
		source: "wof-admin",
		source_id: sourceID,
		license: "CC-BY-4.0",
		register: null,
		surface: "composed",
		augmentation: null,
		base_source_id: null,
	}
}

describe("tag classes", () => {
	it("classifies every component tag as closed or open", () => {
		expect(unclassifiedTags()).toEqual([])
	})

	it("folds in SQL with a whitespace collapse and a lower-case", () => {
		expect(foldSurfaceSQL("x")).toBe("lower(trim(regexp_replace(nfc_normalize(x), '\\s+', ' ', 'g')))")
	})
})

describe("buildSupportIndex and querySupport", () => {
	const trainFile = root.path("train.parquet")
	const testFile = root.path("test.parquet")
	const manifest = root.path("MANIFEST.json")

	it("counts train rows by tag set and by surface, skipping held-out files and deleted ids", async () => {
		await writeParquetFile(
			[
				row("t-1", "GB", [
					["venue", "Little Britain Lake"],
					["locality", "Uxbridge"],
				]),
				row("t-2", "GB", [
					["street", "Lake Road"],
					["locality", "Uxbridge"],
				]),
				row("t-3", "GB", [
					["locality", "Uxbridge"],
					["region", "Greater London"],
				]),
				row("t-4", "US", [
					["venue", "Lake Arrowhead Lodge"],
					["locality", "Lake Arrowhead"],
					["region", "CA"],
				]),
				// Folds onto the t-1..t-3 locality.
				row("t-5", "GB", [
					["locality", "UXBRIDGE"],
					["postcode", "UB8 2NA"],
				]),
				// Deleted below, so read by no count.
				row("t-6", "GB", [["locality", "Uxbridge"]]),
			],
			trainFile,
			FIXTURE_DERIVATION
		)

		await writeParquetFile(
			[
				row("x-1", "GB", [
					["venue", "Black Park Lake"],
					["locality", "Uxbridge"],
				]),
			],
			testFile,
			FIXTURE_DERIVATION
		)

		await writeLocalJSONFile(
			{
				corpus_version: "fixture",
				files: [
					{ path: trainFile.toString(), split: "train" },
					{ path: testFile.toString(), split: "test" },
				],
				deletions: [
					{
						target: { path: trainFile.toString() },
						source_ids: ["t-6"],
						reason: "fixture",
						issue: "#1",
						rows_deleted: { train: 1, val: 0, test: 0 },
					},
				],
			},
			manifest
		)

		const record = await buildSupportIndex(manifest.toString())
		const indexDir = supportIndexDirectoryFor(manifest.toString())

		expect(record.files_listed).toBe(2)
		expect(record.files_read).toBe(1)
		expect(record.files_held_out).toBe(1)
		expect(record.train_rows).toBe(5)
		expect(record.corpus_version).toBe("fixture")
		await expect(readSupportIndexRecord(indexDir)).resolves.toEqual(record)

		const [lake, arrowhead, unknownCountry, absent] = await querySupport(indexDir, [
			{
				id: "gb-vob-little-britain-lake",
				country: "GB",
				components: { venue: "Little Britain Lake", locality: "Uxbridge" },
			},
			{ id: "us-arrowhead", country: "US", components: { locality: "Lake Arrowhead", region: "CA" } },
			{ id: "no-country", country: null, components: { locality: "Uxbridge" } },
			{ id: "gb-absent", country: "GB", components: { locality: "Nowhere", region: "Uxbridge" } },
		])

		expect(lake!.tag_set).toBe("locality|venue")
		expect(lake!.shape_rows).toBe(1)
		expect(lake!.shape_sources).toEqual([{ source: "wof-admin", rows: 1 }])

		const [venue, locality] = lake!.components

		expect(locality).toMatchObject({ kind: "closed", own_rows: 4, under_tags: { locality: 4 } })
		expect(venue!.kind).toBe("open")
		expect(venue!.own_rows).toBeNull()

		expect(venue!.words).toEqual([
			{ position: "first", word: "Little", under: { "venue/first": 1 } },
			// `Lake` closes one GB venue and opens one GB street.
			{ position: "last", word: "Lake", under: { "venue/last": 1, "street/first": 1 } },
		])

		expect(arrowhead!.shape_rows).toBe(0)
		expect(arrowhead!.components[0]).toMatchObject({ own_rows: 1, under_tags: { locality: 1 } })
		expect(arrowhead!.components[1]).toMatchObject({ own_rows: 1, under_tags: { region: 1 } })

		expect(unknownCountry!.shape_rows).toBeNull()
		expect(unknownCountry!.components[0]).toMatchObject({ own_rows: 0, under_tags: {} })
		expect(unknownCountry!.rendered).toContain("rows unread (no country)")

		// A value present under another tag reads as 0 under its own and lists the other.
		expect(absent!.components[0]).toMatchObject({ own_rows: 0, under_tags: {} })
		expect(absent!.components[1]).toMatchObject({ tag: "region", own_rows: 0, under_tags: { locality: 4 } })
		expect(absent!.rendered).toContain('region "Uxbridge": region 0, locality 4')
	})

	it("refuses a manifest file that records no split", async () => {
		const unsplit = root.path("UNSPLIT.json")

		await writeLocalJSONFile({ files: [{ path: trainFile.toString() }] }, unsplit)

		await expect(
			buildSupportIndex(unsplit.toString(), { outDir: root.path("unsplit-index").toString() })
		).rejects.toThrow(/neither a split/)
	})

	it("refuses a query against a directory with no finished record", async () => {
		await expect(querySupport(root.path("missing").toString(), [])).rejects.toThrow(/holds no SUPPORT_INDEX.json/)
	})
})

describe("renderSupportRow", () => {
	it("puts the tag set, its rows and each component's reading on one line", () => {
		const line = renderSupportRow({
			id: "gb-vob-little-britain-lake",
			country: "GB",
			tag_set: "locality|venue",
			shape_rows: 0,
			shape_sources: [],
			components: [
				{
					tag: "venue",
					value: "Little Britain Lake",
					kind: "open",
					own_rows: null,
					under_tags: {},
					words: [
						{ position: "first", word: "Little", under: { "venue/first": 12, "street/first": 405 } },
						{ position: "last", word: "Lake", under: { "venue/last": 1, street_suffix: 25_789 } },
					],
				},
				{
					tag: "locality",
					value: "Uxbridge",
					kind: "closed",
					own_rows: 310_890,
					under_tags: { locality: 310_890, street: 2177 },
					words: [],
				},
				{ tag: "attention", value: "x", kind: "unindexed", own_rows: null, under_tags: {}, words: [] },
			],
		})

		expect(line).toBe(
			"gb-vob-little-britain-lake · GB locality|venue rows 0 · " +
				'venue "Little Britain Lake": first "Little" → street/first 405, venue/first 12; last "Lake" → street_suffix 25789, venue/last 1 · ' +
				'locality "Uxbridge": locality 310890, street 2177 · ' +
				'attention "x": tag unindexed'
		)
	})
})
