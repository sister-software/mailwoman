// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The stages of the geocode path.
 *
 *   Each one runs through `runStage` in `@mailwoman/core/pipeline`, which times it,
 *   checks the request's abort signal before it, and hands it the request's trace.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { type PipelineStage, StageID, treeRewriteStage } from "@mailwoman/core/pipeline"
import type { QueryShape } from "@mailwoman/postcode/recognizer/query-shape"

import { recognizeBarePostcode } from "#geocode/tree-reads"
import { repairPostcodeContradiction } from "#postcode-repair"
import { recognizeUSRegions } from "#region-recognition"
import { repairStrandedAffix } from "#stranded-affix-repair"

const REGION_RECOGNITION_STAGE = treeRewriteStage(StageID.RegionRecognition, recognizeUSRegions)
const BARE_POSTCODE_STAGE = treeRewriteStage(StageID.BarePostcode, recognizeBarePostcode)

const STRANDED_AFFIX_STAGE = treeRewriteStage(StageID.StrandedAffix, (tree) => {
	repairStrandedAffix(tree)

	return tree
})

/**
 * The four tree rewrites that follow the decode, in the order they run.
 *
 * - A state the decode read as a locality becomes a region with its city under it.
 * - A lone value in an unambiguous postcode format becomes a postcode.
 * - A postcode the query shape recognized replaces the street or house-number reading over the same span.
 * - A street affix with no street joins the place name it abuts.
 *
 * Each writes a `tree-rewrite` record to the trace when it changes the tree.
 */
export function postDecodeRepairStages(queryShape: QueryShape): readonly PipelineStage<AddressTree, AddressTree>[] {
	return [
		REGION_RECOGNITION_STAGE,
		BARE_POSTCODE_STAGE,
		treeRewriteStage(StageID.PostcodeContradiction, (tree) => {
			repairPostcodeContradiction(tree, queryShape)

			return tree
		}),
		STRANDED_AFFIX_STAGE,
	]
}
