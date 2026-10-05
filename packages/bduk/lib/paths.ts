/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where BDUK's release downloads live under the data root.
 *
 *   A source download sits at the data root's top level, outside the `db/` group that holds built layers.
 *   One directory holds each release by its OMR month, and one directory below it holds each region: the
 *   region's archive as published and its extracted CSV files.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * The directory inside a region's directory that holds the archive's extracted CSV files.
 */
export const BDUK_EXTRACTED_DIRECTORY = "csv"

/**
 * `<dataRoot>/bduk`.
 */
export function bdukReleaseRoot(dataRoot: PathBuilderLike): PathBuilder {
	return PathBuilder.from(dataRoot)("bduk")
}

/**
 * `$MAILWOMAN_DATA_ROOT/bduk`, read when a path is requested.
 *
 * `bdukReleasePath("2026-05", "london", BDUK_EXTRACTED_DIRECTORY)` is the London
 * region's extracted files of the May 2026 release.
 *
 * @see {@link bdukReleaseRoot} for another data root.
 */
export const bdukReleasePath: PathBuilder = bdukReleaseRoot(dataRootPath())
