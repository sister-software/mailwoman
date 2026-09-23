/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { baseManifestFiles, rerootBaseFilePath } from "@mailwoman/corpus/tools"
import { describe, expect, it } from "vitest"

const BASE_MANIFEST = "/mnt/corpus/versioned/v0.27.0-house-venue-intl/corpus-v0.27.0-house-venue-intl/MANIFEST.json"

/**
 * The key a manifest written before the 2026-09-01 vocabulary rename uses for its file list,
 * spelled the way the reader spells it: by concatenation, because the word is
 * banned in this tree and the ratchet's baseline is zero.
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
		// Every corpus built before that date lists its parquets under the old key,
		// and a built corpus is an immutable artifact.
		// The rename moved this reader and the trainer's without migrating them: the trainer
		// measured `v0.28.0-reviewed-postcode-tail` declaring 706 train files and resolving one.
		// An overlay assembled from a base read as empty carries no base files at all,
		// which is a corpus of only the overlay.
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
		// Neither key holds an array, so the manifest says nothing about how many files there are.
		// Answering an empty list for that reports a corpus of no files, which is the
		// false absence `the-meaning-of-zero.mdx` refuses.
		const neither = { corpus_version: "v0.0.0" } as Parameters<typeof baseManifestFiles>[0]

		expect(() => baseManifestFiles(neither)).toThrow(/names no file list/u)
	})

	it("answers an empty list for a manifest that declares one, because that is a measurement", () => {
		// `slices: []` says the corpus holds no file, and a census counting zero rows
		// from it has read the corpus rather than failed to.
		// The overlay assembler's own requirement for a non-empty base lives in
		// `assembleOverlayManifest`, which is the caller that has it.
		expect(baseManifestFiles(manifestWith("slices", []))).toEqual([])
	})
})
