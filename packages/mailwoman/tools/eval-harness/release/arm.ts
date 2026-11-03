/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The model file a release verdict identifies an arm by.
 */

import { weightsCachePackageDir } from "@mailwoman/neural/weights"

import { HELDOUT_BASE_LOCALE } from "#tools/eval-harness/heldout/per/country"

/**
 * The `model.onnx` of the base locale package under an arm's weights cache root.
 *
 * An arm is the root that holds `node_modules/@mailwoman/neural-weights-*`,
 * as `heldout/per/country.run.ts` scores it and `mwdev_arc` grades it.
 * The verdict records the base package's graph, the one the release candidate's training run produced.
 */
export function releaseArmModelPath(arm: string): string {
	return weightsCachePackageDir(arm, HELDOUT_BASE_LOCALE)("model.onnx").toString()
}
