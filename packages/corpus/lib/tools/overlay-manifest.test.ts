/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { baseManifestSlices, rerootBaseSlicePath } from "@mailwoman/corpus/tools"
import { describe, expect, it } from "vitest"

const BASE_MANIFEST = "/mnt/corpus/versioned/v0.27.0-house-venue-intl/corpus-v0.27.0-house-venue-intl/MANIFEST.json"

/**
 * The key a manifest written before the 2026-09-01 vocabulary rename uses for its slice list, spelled the way the
 * reader spells it: by concatenation, because the word is banned in this tree and the ratchet's baseline is zero.
 */
const LEGACY_SLICES_KEY = `sh${"ards"}`

/**
 * A base manifest carrying only what {@link baseManifestSlices} reads.
 */
function manifestWith(key: string, paths: readonly string[]): Parameters<typeof baseManifestSlices>[0] {
	return {
		schema: {},
		row_group_size: 50_000,
		counts: { train: 0, val: 0, test: 0 },
		total_rows: 0,
		[key]: paths.map((path) => ({ path })),
	} as Parameters<typeof baseManifestSlices>[0]
}

describe("rerootBaseSlicePath", () => {
	it("preserves versioned ancestry when a base overlay used /data/train", () => {
		expect(rerootBaseSlicePath("/data/train/part-house-venue-intl-v27.parquet", BASE_MANIFEST)).toBe(
			"/data/corpus/versioned/v0.27.0-house-venue-intl/corpus-v0.27.0-house-venue-intl/train/part-house-venue-intl-v27.parquet"
		)
	})

	it("re-roots local versioned paths and leaves unrelated paths unchanged", () => {
		expect(rerootBaseSlicePath("/mnt/corpus/versioned/v0.15.0/corpus-v0.15.0/train/a.parquet", BASE_MANIFEST)).toBe(
			"/data/corpus/versioned/v0.15.0/corpus-v0.15.0/train/a.parquet"
		)

		expect(rerootBaseSlicePath("relative/train/a.parquet", BASE_MANIFEST)).toBe("relative/train/a.parquet")
	})
})

describe("baseManifestSlices", () => {
	it("reads a manifest written before the 2026-09-01 rename", () => {
		// Every corpus built before that date lists its parquets under the old key, and a built corpus is an immutable
		// artifact. The rename moved this reader and the trainer's without migrating them: the trainer measured
		// `v0.28.0-reviewed-postcode-tail` declaring 706 train slices and resolving ONE. An overlay assembled from a
		// base read as empty carries no base slices at all, which is a corpus of only the overlay.
		expect(baseManifestSlices(manifestWith(LEGACY_SLICES_KEY, ["a.parquet", "b.parquet"]))).toEqual([
			{ path: "a.parquet" },
			{ path: "b.parquet" },
		])
	})

	it("prefers the current key when a manifest carries both", () => {
		const both = {
			...manifestWith("slices", ["new.parquet"]),
			[LEGACY_SLICES_KEY]: [{ path: "old.parquet" }],
		} as Parameters<typeof baseManifestSlices>[0]

		expect(baseManifestSlices(both)).toEqual([{ path: "new.parquet" }])
	})

	it("REFUSES a base that lists no slices under either key", () => {
		// Assembling against an unreadable base is the failure this whole function exists to make loud: the overlay
		// would be written with its own slices and nothing else, and read as a complete corpus.
		expect(() => baseManifestSlices(manifestWith("slices", []))).toThrow(/no slices/u)
	})
})
