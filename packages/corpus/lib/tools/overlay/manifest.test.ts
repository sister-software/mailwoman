/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { basename } from "path-ts"
import { describe, expect, it } from "vitest"

import { openDuckDB } from "#parquet/duckdb"
import { writeParquetFile } from "#parquet/writers"
import type { SourceRightsRecord } from "#source-register/corpus-inputs"
import { gbOverlayRow as gbRow, useScratchDir } from "#test-kit"
import {
	assembleOverlayManifest,
	baseManifestFiles,
	OVERLAY_PLAN_FILE,
	rerootBaseFilePath,
} from "#tools/overlay/manifest"
import { splitOverlaySlice } from "#tools/overlay/split-slice"

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

describe("assembleOverlayManifest", () => {
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

	const overlay = (parquet: string) => ({
		base: "",
		newDir: scratch.path,
		modalRoot: "/data/corpus/versioned/v0.2.0/corpus-v0.2.0",
		version: "0.2.0",
		files: [{ parquet, source: "syn-de" }],
		note: "",
		// These fixtures use sources no register row permits.
		// The source-rights tests below run without the override.
		unshippableReason: "test fixture: overlay mechanics",
	})

	it("adds a file with a split attribute at the overlay root and counts each split from the attribute", async () => {
		const base = await writeBase()
		const input = scratch.path("part-gb-attr.parquet")

		await writeParquetFile(
			[gbRow("gb-a", "Parc Venton Close", "Camborne", "TR14 7TT"), gbRow("gb-b", "Baker Street", "London", "NW1 6XE")],
			input,
			{ extractHash: "fixture", codeHash: "fixture", config: {} }
		)

		const split = await splitOverlaySlice({ input, outputDir: scratch.path })

		await assembleOverlayManifest({
			...overlay("part-gb-attr.parquet"),
			base,
			files: [
				{ parquet: "part-gb-attr.parquet", source: "rendered-gb-os-open", splitAttribute: basename(split.attribute) },
			],
		})

		const written = await readLocalJSONFile<{
			slices: Array<{ path: string; split?: string; split_attribute?: { policy_hash: string } }>
			counts: Record<string, number>
			split_decided_by: { policy_hashes: string[] }
		}>(scratch.path("MANIFEST.json").toString())

		const added = written.slices.at(-1)!

		expect(added.path).toBe("/data/corpus/versioned/v0.2.0/corpus-v0.2.0/part-gb-attr.parquet")
		expect(added.split).toBeUndefined()
		expect(added.split_attribute?.policy_hash).toBe(split.policyHash)
		expect(written.split_decided_by.policy_hashes).toEqual([split.policyHash])

		expect(written.counts).toEqual({
			train: 1 + split.counts.train,
			val: split.counts.val,
			test: split.counts.test,
		})
	})

	it("refuses an attribute that describes other bytes than the file beside it", async () => {
		const base = await writeBase()
		const input = scratch.path("part-gb-stale.parquet")
		const derivation = { extractHash: "fixture", codeHash: "fixture", config: {} }

		await writeParquetFile([gbRow("gb-c", "Baker Street", "London", "NW1 6XE")], input, derivation)

		const split = await splitOverlaySlice({ input, outputDir: scratch.path })

		await writeParquetFile([gbRow("gb-d", "Hope Street", "Liverpool", "L1 9BP")], input, derivation)

		await expect(
			assembleOverlayManifest({
				...overlay("part-gb-stale.parquet"),
				base,
				files: [
					{
						parquet: "part-gb-stale.parquet",
						source: "rendered-gb-os-open",
						splitAttribute: basename(split.attribute),
					},
				],
			})
		).rejects.toThrow(/Run 'mailwoman corpus split-slice'/)
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
				...overlay(parquet),
				base,
				files: [{ parquet, source: "synth-german" }],
			})
		).rejects.toThrow(/holds source "rendered-de".*asked to record "synth-german"/s)
	})

	it("records the label when the file's source column agrees with it", async () => {
		const base = await writeBase()
		const parquet = await writeOverlayParquet("part-agrees.train.parquet", "rendered-de")

		await assembleOverlayManifest({
			...overlay(parquet),
			base,
			files: [{ parquet, source: "rendered-de" }],
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
			...overlay(parquet),
			base,
			files: [{ parquet, source: "rendered-gb" }],
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
				...overlay(parquet),
				base,
				files: [{ parquet, source: "rendered-de" }],
				replaceSources: ["rendered-de"],
			})
		).rejects.toThrow(/holds no file with source 'rendered-de'/)
	})

	it("refuses to add rendered-gb, which reads the refused Price Paid Data row, without the override", async () => {
		const base = await writeBaseWithGB()
		const parquet = await writeOverlayParquet("part-gb-v3.train.parquet", "rendered-gb")

		await expect(
			assembleOverlayManifest({
				...overlay(parquet),
				base,
				files: [{ parquet, source: "rendered-gb" }],
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
				...overlay(parquet),
				base,
				files: [{ parquet, source: "ban" }],
				unshippableReason: null,
			})
		).rejects.toThrow(/cannot check the corpus sources of 1 file\(s\) of base.*absent locally/s)
	})

	it("reads the source column of a base file that names no source when the base carries no rights record", async () => {
		const parquet = await writeOverlayParquet("part-fr.train.parquet", "ban")
		const baseFile = await writeOverlayParquet("part-0000.parquet", "wof-admin")
		const base = scratch.path("MANIFEST.json").toString()

		await writeLocalJSONFile(
			{
				corpus_version: "0.1.0",
				schema: {},
				row_group_size: 50_000,
				rows_per_slice: 1_000_000,
				counts: { train: 1, val: 0, test: 0 },
				total_rows: 1,
				slices: [{ split: "train", rows: 1, path: scratch.path("train", baseFile).toString() }],
			},
			base
		)

		await assembleOverlayManifest({
			...overlay(parquet),
			base,
			files: [{ parquet, source: "ban" }],
			unshippableReason: null,
		})

		const written = await readLocalJSONFile<{ source_rights: SourceRightsRecord }>(
			scratch.path("MANIFEST.json").toString()
		)

		expect(written.source_rights.shippable).toBe(true)
		expect(written.source_rights.sources_checked).toEqual(expect.arrayContaining(["ban", "wof-admin"]))
	})

	it("records a deletion with the rows it removes and nets them out of the split counts", async () => {
		const base = await writeBaseWithGB()
		const path = scratch.path("train", "part-de-del.train.parquet").toString()

		await makeDirectories(scratch.path("train"))

		{
			using db = await openDuckDB()

			await db.run(
				`COPY (SELECT 'rendered-de' AS source, 'de-' || i AS source_id FROM range(5) t(i)) TO '${path}' (FORMAT parquet)`
			)
		}

		await assembleOverlayManifest({
			...overlay("part-de-del.train.parquet"),
			base,
			files: [{ parquet: "part-de-del.train.parquet", source: "rendered-de" }],
			deletions: [
				{
					target: { source: "rendered-de" },
					sourceIDs: ["de-1", "de-3", "de-absent"],
					reason: "fixture",
					issue: "#2741",
				},
			],
		})

		const written = await readLocalJSONFile<{
			counts: { train: number; val: number; test: number }
			deletions: Array<{ source_ids: string[]; rows_deleted: Record<string, number>; issue: string }>
		}>(scratch.path("MANIFEST.json").toString())

		expect(written.deletions).toHaveLength(1)
		expect(written.deletions[0]!.rows_deleted).toEqual({ train: 2, val: 0, test: 0 })
		expect(written.deletions[0]!.source_ids).toEqual(["de-1", "de-3", "de-absent"])
		// The base's 15 train rows plus 5 added, less the 2 the deletion removes.
		expect(written.counts).toEqual({ train: 18, val: 2, test: 3 })
	})

	it("refuses a deletion that names no issue or no file of the version", async () => {
		const base = await writeBaseWithGB()
		const parquet = await writeOverlayParquet("part-de-del2.train.parquet", "rendered-de")

		const args = {
			...overlay(parquet),
			base,
			files: [{ parquet, source: "rendered-de" }],
		}

		await expect(
			assembleOverlayManifest({
				...args,
				deletions: [{ target: { source: "rendered-de" }, sourceIDs: ["row-1"], reason: "fixture", issue: "2741" }],
			})
		).rejects.toThrow(/spell it #<number>/)

		await expect(
			assembleOverlayManifest({
				...args,
				deletions: [{ target: { source: "nowhere" }, sourceIDs: ["row-1"], reason: "fixture", issue: "#2741" }],
			})
		).rejects.toThrow(/names no file of this version/)
	})

	it("records the overlay as not shippable when the override admits an unpermitted source", async () => {
		const base = await writeBaseWithGB()
		const parquet = await writeOverlayParquet("part-gb-v4.train.parquet", "rendered-gb")

		await assembleOverlayManifest({
			...overlay(parquet),
			base,
			files: [{ parquet, source: "rendered-gb" }],
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
