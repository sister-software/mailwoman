/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Which cached OpenAddresses extracts the `unit` recipe reads, and the held-out one it never trains on.
 *
 *   Split from the recipe because the two halves read nothing of each other: the sources name a data root and a
 *   cache layout, and the designator synthesis beside them names USPS Pub-28 tables. `module-cohesion` reported the
 *   pair as two declaration communities at modularity 0.54, which is what that reads like from outside.
 *
 *   Vermont is the corpus `defaultHoldout` and appears only as {@link EVAL_SOURCE}. Keeping it in the same file as
 *   the train list is what makes the separation legible: one constant is the training set, the other is the one
 *   state a trained model has never seen.
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
 * OA region is empty for US per-state extracts — the region is implied by the file. Every NON-Vermont state cached.
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
 * Vermont, the corpus holdout. `--golden` reads this and nothing else, so the eval measures designator recognition on
 * addresses no training row came from.
 */
export const EVAL_SOURCE: UnitSource = {
	zip: dataRootPath("oa-cache", "us__vt__statewide.zip"),
	csv: "us/vt/statewide.csv",
	region: "VT",
}
