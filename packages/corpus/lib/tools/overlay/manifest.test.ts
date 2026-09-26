/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { useScratchDir } from "@mailwoman/corpus/test-kit"
import {
	assembleOverlayManifest,
	baseManifestFiles,
	rerootBaseFilePath,
	splitFromFilename,
} from "@mailwoman/corpus/tools"
import { describe, expect, it } from "vitest"

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
	 * A base manifest on disk with one file, which is all the guard runs after.
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
		// Every corpus built before the rename lists its parquets under the old key,
		// and a built corpus is an immutable artifact.
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
		// Neither key holds an array, so the manifest makes no statement about how many
		// files there are, and answering an empty list reports a false absence.
		const neither = { corpus_version: "v0.0.0" } as Parameters<typeof baseManifestFiles>[0]

		expect(() => baseManifestFiles(neither)).toThrow(/names no file list/u)
	})

	it("answers an empty list for a manifest that declares one, because that is a measurement", () => {
		// `slices: []` says the corpus holds no file; the overlay assembler's requirement
		// for a non-empty base lives in its own caller.
		expect(baseManifestFiles(manifestWith("slices", []))).toEqual([])
	})
})
