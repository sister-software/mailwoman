// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import type { PathBuilderLike } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

import {
	assertNoVersionCollision,
	buildHeldoutDatasetManifest,
	compareHeldoutDatasets,
	mergeHeldoutCollections,
	readHeldoutDatasetManifest,
	readHeldoutDatasetRows,
	restampHeldoutDataset,
	reviseHeldoutDataset,
	writeHeldoutDataset,
} from "#tools/eval-harness/heldout/dataset/manifest"
import { COUNTY_IN_LOCALITY_SLOT } from "#tools/eval-harness/heldout/dataset/relabel"
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

	it("derives different versions for two row sets drawn under equal settings and counts", () => {
		const first = build([row("a1", "US", "oa-us", "12 Main St")])
		const relabeled = build([{ ...row("a1", "US", "oa-us", "12 Main St"), span_tags: ["house_number", "venue"] }])
		const retexted = build([row("a1", "US", "oa-us", "12 Main Street")])

		expect(new Set([first.version, relabeled.version, retexted.version]).size).toBe(3)
		expect(relabeled.cells).toEqual(first.cells)
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

const write = (path: PathBuilderLike, rows: HeldoutRow[], datasetID = "heldout-fixture") =>
	writeHeldoutDataset(path, {
		datasetID,
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

describe("writeHeldoutDataset and readHeldoutDatasetRows", () => {
	it("round-trips the rows and refuses a rows file whose sha256 changed", async () => {
		const path = directory.path("fixture.json")
		const rows = [row("a1", "US", "oa-us"), row("f1", "FR", "ban")]

		await write(path, rows)

		expect((await readHeldoutDatasetRows(path)).rows).toEqual(rows)

		const rowsPath = directory.path("fixture.rows.jsonl")

		await writeLocalTextFile(`${await readLocalTextFile(rowsPath)}\n`, rowsPath)
		await expect(readHeldoutDatasetRows(path)).rejects.toThrow(/sha256/u)
	})

	it("refuses a manifest whose recorded version differs from the version its rows give, naming both", async () => {
		const path = directory.path("pinned.json")
		const written = await write(path, [row("a1", "US", "oa-us")], "pinned")

		await writeLocalJSONFile({ ...written, version: "0123456789abcdef" }, path)

		await expect(readHeldoutDatasetManifest(path)).rejects.toThrow(
			new RegExp(`records version 0123456789abcdef; .* give ${written.version}`, "u")
		)
	})
})

describe("assertNoVersionCollision", () => {
	it("refuses a collection whose version a sibling holds over other rows, and admits equal rows", async () => {
		const sibling = await temporaryDirectory("mw-heldout-collision-")

		try {
			const first = await write(sibling.path("first.json"), [row("a1", "US", "oa-us")], "first")

			await expect(
				assertNoVersionCollision(sibling.path("second.json"), {
					datasetID: "second",
					version: first.version,
					rowsFile: { ...first.rowsFile, sha256: "c".repeat(64) },
				})
			).rejects.toThrow(/two different row sets share one version/u)

			await expect(write(sibling.path("again.json"), [row("a1", "US", "oa-us")], "again")).resolves.toMatchObject({
				version: first.version,
			})
		} finally {
			await sibling[Symbol.asyncDispose]()
		}
	})
})

describe("restampHeldoutDataset", () => {
	it("rewrites a version 1 manifest and the confirmation set that excludes it", async () => {
		const devPath = directory.path("restamp-dev.json")
		const confirmPath = directory.path("restamp-confirm.json")
		const dev = await write(devPath, [row("d1", "US", "oa-us")], "restamp-dev")

		await writeLocalJSONFile({ ...dev, schemaVersion: 1, version: "1111111111111111" }, devPath)

		const confirm = await writeHeldoutDataset(confirmPath, {
			datasetID: "restamp-confirm",
			createdAt: "2026-10-20T00:00:00.000Z",
			drawnFrom: { manifest: "/data/MANIFEST.json", sha256: "a".repeat(64), corpusVersion: null, files: [] },
			sampling: { ...sampling(2), excludes: { datasetID: "restamp-dev", version: "1111111111111111" } },
			cells: cells([row("c1", "US", "oa-us")]),
			rows: [row("c1", "US", "oa-us")],
		})

		await writeLocalJSONFile({ ...confirm, schemaVersion: 1, version: "2222222222222222" }, confirmPath)

		await expect(readHeldoutDatasetManifest(devPath)).rejects.toThrow(/version 1 held-out dataset manifest/u)
		await expect(restampHeldoutDataset(confirmPath, null)).rejects.toThrow(/excludes restamp-dev@1111111111111111/u)

		const restampedDev = await restampHeldoutDataset(devPath, null)

		expect(restampedDev.previous).toBe("1111111111111111")
		expect(restampedDev.manifest.version).toBe(dev.version)

		const restampedConfirm = await restampHeldoutDataset(confirmPath, restampedDev.manifest)

		expect(restampedConfirm.manifest.sampling.excludes).toEqual({ datasetID: "restamp-dev", version: dev.version })
		expect((await readHeldoutDatasetRows(confirmPath)).manifest.version).toBe(restampedConfirm.manifest.version)
	})
})

describe("mergeHeldoutCollections", () => {
	it("joins two collections' rows and sums their cells, and refuses a row identity both hold", async () => {
		const main = await write(directory.path("merge-main.json"), [row("m1", "US", "oa-us")], "merge-main")

		const probes = await write(
			directory.path("merge-probes.json"),
			[row("p1", "US", "invented-po-box-cedex")],
			"merge-probes"
		)

		const merged = mergeHeldoutCollections([
			{ path: "merge-main.json", manifest: main, rows: [row("m1", "US", "oa-us")] },
			{ path: "merge-probes.json", manifest: probes, rows: [row("p1", "US", "invented-po-box-cedex")] },
		])

		expect(merged.rows.map((r) => r.source_id)).toEqual(["m1", "p1"])
		expect(merged.counts).toEqual([{ country: "US", kind: "address", available: 200, sampled: 2 }])
		expect(merged.dataset.map((d) => d.datasetID)).toEqual(["merge-main", "merge-probes"])

		expect(() =>
			mergeHeldoutCollections([
				{ path: "a.json", manifest: main, rows: [row("m1", "US", "oa-us")] },
				{ path: "b.json", manifest: probes, rows: [row("m1", "US", "oa-us")] },
			])
		).toThrow(/merge-probes and merge-main both hold row oa-us:m1/u)
	})
})

describe("reviseHeldoutDataset", () => {
	const county = (sourceID: string, locality: string): HeldoutRow => {
		const raw = `12 Main St, ${locality}`

		return {
			raw,
			span_starts: [0, 3, 12],
			span_ends: [2, 10, raw.length],
			span_tags: ["house_number", "street", "locality"],
			country: "US",
			source: "usgov-nad",
			source_id: sourceID,
			group: sourceID,
		}
	}

	it("writes a new collection that records its source, its rule and every changed row, leaving the source", async () => {
		const sourcePath = directory.path("revise-source.json")
		const source = await write(sourcePath, [county("n1", "CARTER COUNTY"), county("n2", "ARDMORE")], "revise")
		const sourceText = await readLocalTextFile(sourcePath)
		const outPath = directory.path("revise-source.v2.json")

		const revised = await reviseHeldoutDataset(sourcePath, outPath, {
			rule: COUNTY_IN_LOCALITY_SLOT.rule,
			annotation: `relabel:${COUNTY_IN_LOCALITY_SLOT.id}`,
			revise: COUNTY_IN_LOCALITY_SLOT.revise,
			sourceExcludes: null,
			excludes: null,
			createdAt: "2026-11-17T00:00:00.000Z",
		})

		expect(revised.datasetID).toBe("revise")
		expect(revised.version).not.toBe(source.version)

		expect(revised.revision).toEqual({
			from: {
				datasetID: "revise",
				version: source.version,
				manifest: sourcePath.toString(),
				rowsSHA256: source.rowsFile.sha256,
			},
			rule: COUNTY_IN_LOCALITY_SLOT.rule,
			rows: [{ rowID: "usgov-nad:n1", before: ["locality=CARTER COUNTY"], after: ["subregion=CARTER COUNTY"] }],
		})

		expect(
			revised.rows.map((entry) => entry.annotation.endsWith("+relabel:county-in-locality-slot-subregion"))
		).toEqual([true, false])

		const reread = await readHeldoutDatasetRows(outPath)

		expect(reread.manifest.version).toBe(revised.version)
		expect(reread.rows[0]!.span_tags).toEqual(["house_number", "street", "subregion"])
		expect(await readLocalTextFile(sourcePath)).toBe(sourceText)
	})

	it("refuses a revision that changes no row", async () => {
		const sourcePath = directory.path("revise-none.json")

		await write(sourcePath, [county("n3", "ARDMORE")], "revise-none")

		await expect(
			reviseHeldoutDataset(sourcePath, directory.path("revise-none.v2.json"), {
				rule: "r",
				annotation: "a",
				revise: (r) => r,
				sourceExcludes: null,
				excludes: null,
				createdAt: "2026-11-17T00:00:00.000Z",
			})
		).rejects.toThrow(/changes no row/u)
	})
})
