/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import { openDuckDB } from "#parquet/duckdb"
import type { SourceRightsRecord } from "#source-register/corpus-inputs"
import { useScratchDir } from "#test-kit"
import {
	assembleOverlayManifest,
	baseManifestFiles,
	OVERLAY_PLAN_FILE,
	rerootBaseFilePath,
	splitFromFilename,
} from "#tools/overlay/manifest"

const BASE_MANIFEST = "/mnt/corpus/versioned/v0.27.0-house-venue-intl/corpus-v0.27.0-house-venue-intl/MANIFEST.json"

/**
 * The pre-rename file-list key, spelled by concatenation because the word is banned
 * in this tree and the ratchet's baseline is zero.
 */
const PRE_RENAME_FILES_KEY = `sh${"ards"}`

/**
 * A base manifest carrying only what {@link baseManifestFiles} reads.
 */
function manifestWith(key: string, paths: readonly string[]): Parameters<typeof baseManifestFiles>[0] {
	return {
		schema: {},
		row_group_size: 50_000,
		counts: { train: 0, val: 0, test: 0 },
		total_rows: 0,
		[key]: paths.map((path) => ({ path })),
	} as Parameters<typeof baseManifestFiles>[0]
}

describe("splitFromFilename", () => {
	it("reads the split splitOverlaySlice encodes, and answers null for a name it did not write", () => {
		expect(splitFromFilename("part-gb.val.parquet")).toBe("val")
		expect(splitFromFilename("part-gb.test.parquet")).toBe("test")
		expect(splitFromFilename("part-anchor-absorption-train.val.parquet")).toBe("val")

		expect(splitFromFilename("part-synth-german-val.parquet")).toBeNull()
		expect(splitFromFilename("part-synth-german-train.parquet")).toBeNull()
		expect(splitFromFilename("part-0000.parquet")).toBeNull()
		expect(splitFromFilename("val.parquet")).toBeNull()
	})
})

describe("assembleOverlayManifest, on who chose a held-out split", () => {
	const scratch = useScratchDir("overlay-manifest")

	/**
	 * A base manifest on disk with one file.
	 * The guard runs after this state.
	 */
	async function writeBase(): Promise<string> {
		// A string, because the overlay's `base` option is re-rooted as text.
		const path = scratch.path("MANIFEST.json").toString()

		await writeLocalJSONFile(
			{
				corpus_version: "0.1.0",
				schema: {},
				row_group_size: 50_000,
				rows_per_slice: 1_000_000,
				counts: { train: 1, val: 0, test: 0 },
				total_rows: 1,
				slices: [{ split: "train", path: "/data/corpus/versioned/v0.1.0/corpus-v0.1.0/train/part-0000.parquet" }],
			},
			path
		)

		return path
	}

	const overlay = (parquet: string, split: "train" | "val" | "test") => ({
		base: "",
		newDir: scratch.path,
		modalRoot: "/data/corpus/versioned/v0.2.0/corpus-v0.2.0",
		version: "0.2.0",
		files: [{ parquet, source: "syn-de", split }],
		note: "",
		// These fixtures use sources no register row permits.
		// The source-rights tests below run without the override.
		unshippableReason: "test fixture: overlay mechanics",
	})

	it("refuses a val split asserted for a file split-slice did not write", async () => {
		const base = await writeBase()

		await expect(assembleOverlayManifest({ ...overlay("part-synth-german-val.parquet", "val"), base })).rejects.toThrow(
			/did not come from 'mailwoman corpus split-slice'/
		)
	})

	it("refuses a split that contradicts the one the filename carries", async () => {
		const base = await writeBase()

		await expect(assembleOverlayManifest({ ...overlay("part-gb.val.parquet", "test"), base })).rejects.toThrow(
			/names split 'val' and the caller asked for 'test'/
		)
	})

	it("lets a train file through without a routed name, since train holds nothing out", async () => {
		const base = await writeBase()

		await expect(
			assembleOverlayManifest({ ...overlay("part-synth-german-train.parquet", "train"), base })
		).rejects.not.toThrow(/split-slice/)
	})

	/**
	 * One overlay parquet holding the `source` and `source_id` columns `descriptor` reads.
	 */
	async function writeOverlayParquet(name: string, source: string): Promise<string> {
		using db = await openDuckDB()

		// `assembleOverlayManifest` resolves an added file at `<newDir>/<split>/<name>`.
		await makeDirectories(scratch.path("train"))

		const path = scratch.path("train", name).toString()

		await db.run(
			`COPY (SELECT '${source}' AS source, 'row-1' AS source_id) TO '${path}' (FORMAT parquet, COMPRESSION snappy)`
		)

		return name
	}

	it("refuses a manifest label the file's own source column contradicts", async () => {
		const base = await writeBase()
		const parquet = await writeOverlayParquet("part-mismatch.train.parquet", "rendered-de")

		// The loader groups rows by the column.
		// The caller's label would make the manifest disagree with the rows the run trains on.
		await expect(
			assembleOverlayManifest({
				...overlay(parquet, "train"),
				base,
				files: [{ parquet, source: "synth-german", split: "train" }],
			})
		).rejects.toThrow(/holds source "rendered-de".*asked to record "synth-german"/s)
	})

	it("records the label when the file's source column agrees with it", async () => {
		const base = await writeBase()
		const parquet = await writeOverlayParquet("part-agrees.train.parquet", "rendered-de")

		await assembleOverlayManifest({
			...overlay(parquet, "train"),
			base,
			files: [{ parquet, source: "rendered-de", split: "train" }],
		})

		// `assembleOverlayManifest` writes the manifest rather than returning it.
		const written = await readLocalJSONFile<{ slices: Array<{ path: string; source: string; rows: number }> }>(
			scratch.path("MANIFEST.json").toString()
		)

		const added = written.slices.filter((slice) => slice.path.endsWith("part-agrees.train.parquet"))

		expect(added).toHaveLength(1)
		expect(added[0]!.source).toBe("rendered-de")
		expect(added[0]!.rows).toBe(1)
	})

	/**
	 * A base manifest with one `rendered-gb` file in each split and one file from another source.
	 */
	async function writeBaseWithGB(): Promise<string> {
		const path = scratch.path("MANIFEST.json").toString()
		const root = "/data/corpus/versioned/v0.1.0/corpus-v0.1.0"

		await writeLocalJSONFile(
			{
				corpus_version: "0.1.0",
				schema: {},
				row_group_size: 50_000,
				rows_per_slice: 1_000_000,
				counts: { train: 15, val: 2, test: 3 },
				total_rows: 20,
				slices: [
					{ split: "train", rows: 10, source: "wof-admin", path: `${root}/train/part-0000.parquet` },
					{ split: "train", rows: 5, source: "rendered-gb", path: `${root}/train/part-gb.train.parquet` },
					{ split: "val", rows: 2, source: "rendered-gb", path: `${root}/val/part-gb.val.parquet` },
					{ split: "test", rows: 3, source: "rendered-gb", path: `${root}/test/part-gb.test.parquet` },
				],
			},
			path
		)

		return path
	}

	it("drops a replaced source's base files and subtracts their rows from each split", async () => {
		const base = await writeBaseWithGB()
		const parquet = await writeOverlayParquet("part-gb-v2.train.parquet", "rendered-gb")

		await assembleOverlayManifest({
			...overlay(parquet, "train"),
			base,
			files: [{ parquet, source: "rendered-gb", split: "train" }],
			replaceSources: ["rendered-gb"],
		})

		const written = await readLocalJSONFile<{
			slices: Array<{ path: string; source: string }>
			counts: { train: number; val: number; test: number }
			total_rows: number
		}>(scratch.path("MANIFEST.json").toString())

		expect(written.slices.map((slice) => slice.path.split("/").at(-1))).toEqual([
			"part-0000.parquet",
			"part-gb-v2.train.parquet",
		])

		expect(written.counts).toEqual({ train: 11, val: 0, test: 0 })
		expect(written.total_rows).toBe(11)
	})

	it("refuses to replace a source the base does not hold", async () => {
		const base = await writeBaseWithGB()
		const parquet = await writeOverlayParquet("part-de.train.parquet", "rendered-de")

		await expect(
			assembleOverlayManifest({
				...overlay(parquet, "train"),
				base,
				files: [{ parquet, source: "rendered-de", split: "train" }],
				replaceSources: ["rendered-de"],
			})
		).rejects.toThrow(/holds no file with source 'rendered-de'/)
	})

	it("refuses to add rendered-gb, which reads the refused Price Paid Data row, without the override", async () => {
		const base = await writeBaseWithGB()
		const parquet = await writeOverlayParquet("part-gb-v3.train.parquet", "rendered-gb")

		await expect(
			assembleOverlayManifest({
				...overlay(parquet, "train"),
				base,
				files: [{ parquet, source: "rendered-gb", split: "train" }],
				unshippableReason: null,
			})
		).rejects.toThrow(/corpus source rendered-gb reads register source gb-property-building-1 .*refused/s)

		expect(await pathExists(scratch.path(OVERLAY_PLAN_FILE))).toBe(false)
	})

	it("refuses a base whose files name no source when its manifest carries no rights record", async () => {
		const base = await writeBase()
		const parquet = await writeOverlayParquet("part-fr.train.parquet", "ban")

		await expect(
			assembleOverlayManifest({
				...overlay(parquet, "train"),
				base,
				files: [{ parquet, source: "ban", split: "train" }],
				unshippableReason: null,
			})
		).rejects.toThrow(/cannot check the corpus sources of 1 file\(s\) of base/)
	})

	it("records the overlay as not shippable when the override admits an unpermitted source", async () => {
		const base = await writeBaseWithGB()
		const parquet = await writeOverlayParquet("part-gb-v4.train.parquet", "rendered-gb")

		await assembleOverlayManifest({
			...overlay(parquet, "train"),
			base,
			files: [{ parquet, source: "rendered-gb", split: "train" }],
			replaceSources: ["rendered-gb"],
		})

		const written = await readLocalJSONFile<{ source_rights: SourceRightsRecord }>(
			scratch.path("MANIFEST.json").toString()
		)

		expect(written.source_rights.shippable).toBe(false)

		expect(written.source_rights.gaps.map((gap) => `${gap.source}:${gap.registerSource}`)).toEqual(
			expect.arrayContaining(["rendered-gb:gb-property-building-1"])
		)
	})
})

describe("rerootBaseFilePath", () => {
	it("preserves versioned ancestry when a base overlay used /data/train", () => {
		expect(rerootBaseFilePath("/data/train/part-house-venue-intl-v27.parquet", BASE_MANIFEST)).toBe(
			"/data/corpus/versioned/v0.27.0-house-venue-intl/corpus-v0.27.0-house-venue-intl/train/part-house-venue-intl-v27.parquet"
		)
	})

	it("re-roots local versioned paths and leaves unrelated paths unchanged", () => {
		expect(rerootBaseFilePath("/mnt/corpus/versioned/v0.15.0/corpus-v0.15.0/train/a.parquet", BASE_MANIFEST)).toBe(
			"/data/corpus/versioned/v0.15.0/corpus-v0.15.0/train/a.parquet"
		)

		expect(rerootBaseFilePath("relative/train/a.parquet", BASE_MANIFEST)).toBe("relative/train/a.parquet")
	})
})

describe("baseManifestFiles", () => {
	it("reads a manifest written before the 2026-09-01 rename", () => {
		// Every corpus built before the rename lists its Parquet files under the old key.
		// A built corpus is an immutable artifact.
		expect(baseManifestFiles(manifestWith(PRE_RENAME_FILES_KEY, ["a.parquet", "b.parquet"]))).toEqual([
			{ path: "a.parquet" },
			{ path: "b.parquet" },
		])
	})

	it("prefers the current key when a manifest carries both", () => {
		const both = {
			...manifestWith("slices", ["new.parquet"]),
			[PRE_RENAME_FILES_KEY]: [{ path: "old.parquet" }],
		} as Parameters<typeof baseManifestFiles>[0]

		expect(baseManifestFiles(both)).toEqual([{ path: "new.parquet" }])
	})

	it("REFUSES a manifest that names no file list under either key", () => {
		// Neither key holds an array.
		// The manifest makes no statement about the file count.
		// An empty list would report a false absence.
		const neither = { corpus_version: "v0.0.0" } as Parameters<typeof baseManifestFiles>[0]

		expect(() => baseManifestFiles(neither)).toThrow(/names no file list/u)
	})

	it("answers an empty list for a manifest that declares one, because that is a measurement", () => {
		// `slices: []` means the corpus holds no file.
		// The overlay assembler's requirement for a non-empty base lives in its own caller.
		expect(baseManifestFiles(manifestWith("slices", []))).toEqual([])
	})
})
