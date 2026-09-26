/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Which cached OpenAddresses extracts the `unit` recipe reads, and the held-out one it never trains on.
 *
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import type { PathBuilderLike } from "path-ts"

/**
 * A cached OpenAddresses extract: the zip, the CSV member, and the implied (file-level) region.
 */
export interface UnitSource {
	zip: PathBuilderLike
	csv: string
	region: string
}

/**
 * Every non-Vermont state cached; `region` is implied by the file.
 */
export const TRAIN_SOURCES: readonly UnitSource[] = [
	{ zip: dataRootPath("oa-cache", "us__ca__berkeley.zip"), csv: "us/ca/berkeley.csv", region: "CA" },
	{ zip: dataRootPath("oa-cache", "us__ca__marin.zip"), csv: "us/ca/marin.csv", region: "CA" },
	{ zip: dataRootPath("oa-cache", "us__dc__statewide.zip"), csv: "us/dc/statewide.csv", region: "DC" },
	{ zip: dataRootPath("oa-cache", "us__ia__statewide.zip"), csv: "us/ia/statewide.csv", region: "IA" },
	{ zip: dataRootPath("oa-cache", "us__il__cook.zip"), csv: "us/il/cook.csv", region: "IL" },
	{ zip: dataRootPath("oa-cache", "us__mt__statewide.zip"), csv: "us/mt/statewide.csv", region: "MT" },
	{ zip: dataRootPath("oa-cache", "us__sd__statewide.zip"), csv: "us/sd/statewide.csv", region: "SD" },
]

/**
 * Vermont, the corpus holdout — `--golden` reads this and no other source.
 */
export const EVAL_SOURCE: UnitSource = {
	zip: dataRootPath("oa-cache", "us__vt__statewide.zip"),
	csv: "us/vt/statewide.csv",
	region: "VT",
}
