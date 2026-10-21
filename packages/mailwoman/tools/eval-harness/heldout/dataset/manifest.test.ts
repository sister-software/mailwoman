import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { afterAll, describe, expect, it } from "vitest"

import {
	buildHeldoutDatasetManifest,
	compareHeldoutDatasets,
	readHeldoutDatasetRows,
	writeHeldoutDataset,
} from "#tools/eval-harness/heldout/dataset/manifest"
import type { HeldoutCellCount, HeldoutRow } from "#tools/eval-harness/heldout/per/country"

const directory = await temporaryDirectory("mw-heldout-dataset-")

afterAll(() => directory[Symbol.asyncDispose]())

const row = (sourceID: string, country: string, source: string, raw = "12 Main St", group = sourceID): HeldoutRow => ({
	raw,
	span_starts: [0, 3],
	span_ends: [2, raw.length],
	span_tags: ["house_number", "street"],
	country,
	source,
	source_id: sourceID,
	group,
})

const sampling = (perCountry: number) => ({
	method: "per-record-id-country-kind-hash-order" as const,
	perCountry,
	seed: null,
	order: "hash(raw), source, source_id",
	engine: "duckdb v1.4.0",
})

const cells = (rows: readonly HeldoutRow[]): HeldoutCellCount[] => {
	const counts = new Map<string, HeldoutCellCount>()

	for (const r of rows) {
		const cell = counts.get(r.country!) ?? {
			country: r.country!,
			kind: "address",
			available: 100,
			sampled: 0,
		}

		cell.sampled++
		counts.set(r.country!, cell)
	}

	return [...counts.values()]
}

const build = (rows: HeldoutRow[], perCountry = 2, sha256 = "a".repeat(64)) =>
	buildHeldoutDatasetManifest({
		datasetID: "heldout-fixture",
		createdAt: "2026-10-20T00:00:00.000Z",
		drawnFrom: {
			manifest: "/data/MANIFEST.json",
			sha256,
			corpusVersion: "v0.8.0-fixture",
			files: [],
		},
		sampling: sampling(perCountry),
		cells: cells(rows),
		rows,
		rowsFilePath: "fixture.rows.jsonl",
	})

describe("buildHeldoutDatasetManifest", () => {
	it("records identity, group, a spans hash and annotation provenance per row", () => {
		const manifest = build([row("a1", "US", "oa-us"), row("a1~lower", "US", "oa-us", "12 main st", "a1")])

		expect(manifest.rows.map((entry) => [entry.rowID, entry.group, entry.annotation])).toEqual([
			["oa-us:a1", "a1", "corpus-alignment:v0.8.0-fixture:oa-us"],
			["oa-us:a1~lower", "a1", "corpus-alignment:v0.8.0-fixture:oa-us"],
		])

		expect(manifest.rows[0]!.spansSHA256).not.toBe(manifest.rows[1]!.spansSHA256)
		expect(manifest.rowsFile.sha256).toMatch(/^[0-9a-f]{64}$/u)
	})

	it("derives a new version from a changed sampling rule, source set or drawn-from corpus", () => {
		const rows = [row("a1", "US", "oa-us")]
		const base = build(rows)

		expect(build(rows).version).toBe(base.version)
		expect(build(rows, 3).version).not.toBe(base.version)
		expect(build(rows, 2, "b".repeat(64)).version).not.toBe(base.version)
		expect(build([...rows, row("f1", "FR", "ban")]).version).not.toBe(base.version)
	})

	it("refuses rows that share an identity", () => {
		expect(() => build([row("a1", "US", "oa-us"), row("a1", "US", "oa-us")])).toThrow(/share/u)
	})
})

describe("compareHeldoutDatasets", () => {
	it("reports added and removed countries, changed sources and changed row counts", () => {
		const from = build([row("a1", "US", "oa-us"), row("a2", "US", "oa-us"), row("d1", "DE", "oa-de")])
		const to = build([row("a1", "US", "oa-us", "12 Main Street"), row("f1", "FR", "ban"), row("f2", "FR", "ban")], 3)

		const comparison = compareHeldoutDatasets(from, to)

		expect(comparison.sameVersion).toBe(false)
		expect(comparison.samplingChanged).toBe(true)
		expect(comparison.drawnFromChanged).toBe(false)
		expect(comparison.countries).toEqual({ added: ["FR"], removed: ["DE"] })

		expect(comparison.sources).toEqual({
			added: ["ban"],
			removed: ["oa-de"],
			changed: [{ source: "oa-us", from: 2, to: 1 }],
		})

		expect(comparison.cells).toEqual([
			{ cell: "DE/address", from: 1, to: 0 },
			{ cell: "FR/address", from: 0, to: 2 },
			{ cell: "US/address", from: 2, to: 1 },
		])

		expect(comparison.rows).toEqual({
			added: 2,
			removed: 2,
			annotationChanged: ["oa-us:a1"],
			groupChanged: [],
		})
	})
})

describe("writeHeldoutDataset and readHeldoutDatasetRows", () => {
	it("round-trips the rows and refuses a rows file whose sha256 changed", async () => {
		const path = directory.path("fixture.json")
		const rows = [row("a1", "US", "oa-us"), row("f1", "FR", "ban")]

		await writeHeldoutDataset(path, {
			datasetID: "heldout-fixture",
			createdAt: "2026-10-20T00:00:00.000Z",
			drawnFrom: {
				manifest: "/data/MANIFEST.json",
				sha256: "a".repeat(64),
				corpusVersion: null,
				files: [],
			},
			sampling: sampling(2),
			cells: cells(rows),
			rows,
		})

		expect((await readHeldoutDatasetRows(path)).rows).toEqual(rows)

		const rowsPath = directory.path("fixture.rows.jsonl")

		await writeLocalTextFile(`${await readLocalTextFile(rowsPath)}\n`, rowsPath)
		await expect(readHeldoutDatasetRows(path)).rejects.toThrow(/sha256/u)
	})
})
