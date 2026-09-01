/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The default artifact and dataset locations the coarse-placer tools share. One spelling each, so
 *   a relocated artifact is a one-line change rather than a sweep of every tool's option default.
 */

import type { PathBuilderLike } from "path-ts"

import { corePackagePath, dataRootPath, repoRootPath } from "#utils"

/**
 * Dataset dir: `{train,val,test}.jsonl` + `test-latin-offmap.jsonl`.
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
