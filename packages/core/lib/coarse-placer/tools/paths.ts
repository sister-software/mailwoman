/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The default artifact and dataset locations the coarse-placer tools share. One spelling each, so
 *   a relocated artifact is a one-line change rather than a sweep of every tool's option default.
 */

import { type PathBuilderLike, resolvePath } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { pathExists } from "#fs/readers"
import { corePackagePath, dataRootPath, repoRootPath } from "#utils"

/**
 * The Latin off-map test sets, one per outlier builder. Each builder writes its own file so neither replaces the
 * other's rows; readers take the union through {@linkcode readLatinOffmapRows}.
 */
export const LATIN_OFFMAP_TEST_FILES = ["test-latin-offmap-overture.jsonl", "test-latin-offmap-oa.jsonl"] as const

/**
 * Read every Latin off-map test set present in `dataDir`, tagging each row with the file it came from. Refuses an empty
 * union: a missing test set would otherwise read as a perfect off-map score.
 */
export async function readLatinOffmapRows<T>(dataDir: PathBuilderLike): Promise<Array<T & { sourceFile: string }>> {
	const rows: Array<T & { sourceFile: string }> = []
	const present: string[] = []

	for (const file of LATIN_OFFMAP_TEST_FILES) {
		const path = resolvePath(dataDir, file)

		if (!(await pathExists(path))) continue

		present.push(file)

		for await (const row of JSONSpliterator.fromAsync<T>(path)) {
			rows.push({ ...row, sourceFile: file })
		}
	}

	if (!present.length) {
		throw new Error(
			`No Latin off-map test set in ${String(dataDir)}: expected ${LATIN_OFFMAP_TEST_FILES.join(" or ")}. Run build-outlier-latin or build-outlier-oa first.`
		)
	}

	return rows
}

/**
 * Dataset dir: `{train,val,test}.jsonl` + the Latin off-map test sets ({@linkcode LATIN_OFFMAP_TEST_FILES}).
 */
export function defaultDataDir(): PathBuilderLike {
	return repoRootPath("data", "coarse-placer")
}

/**
 * The fp32 training-output artifact dir.
 */
export function defaultModelDir(): PathBuilderLike {
	return dataRootPath("coarse-placer", "model")
}

/**
 * The int8 quantized artifact dir.
 */
export function defaultInt8Dir(): PathBuilderLike {
	return dataRootPath("coarse-placer", "model-int8")
}

/**
 * The DEPLOYED placer bundled in `@mailwoman/core` (`core/data/coarse-placer`), NOT the `$MAILWOMAN_DATA_ROOT` training
 * output — for probes that must match the runtime.
 */
export function shippedModelDir(): string {
	return corePackagePath("data", "coarse-placer")
}
