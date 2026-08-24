/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_compare` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The measurement itself lives in the package root; this file is the CONTRACT, and the description is the
 *   load-bearing half of it.
 */

import { z } from "zod"

import { ARM_SPEC_SCHEMA } from "../arms.ts"
import { runCompare } from "../compare.ts"
import type { DevTool, DevToolDeps } from "../tool-kit.ts"
import { INPUT_SET_SCHEMA } from "../tool-kit.ts"

export const compareTool = ({ registry }: DevToolDeps): DevTool => ({
	name: "mwdev_compare",
	description:
		"Run one input set through two arms and diff them. Board model grading should use execution_path " +
		'"board-routed", which selects each row\'s production country overlay and refuses candidate artifacts outside ' +
		"the supplied weights cache. An arm is a mailwoman configuration, an ALREADY-RUNNING " +
		"external geocoder (Pelias / Photon / Nominatim — this server never starts one), a reference geocoder " +
		"(Census free, Google billed and opt-in only), or a stored past run replayed by run_id. Reports what CHANGED " +
		"separately from what IMPROVED, checks that only the declared lever moved, and states the smallest effect this " +
		"many rows could have detected. A cross-engine comparison is graded on the pre-registered distance protocol " +
		"(top-1, 1/5/25km, a no-result a miss at every threshold) and claims parity only against the pre-registered " +
		"±5pp equivalence bound. An oracle arm is NEVER graded — a reference geocoder is not truth here.",
	inputSchema: z.object({
		inputs: INPUT_SET_SCHEMA.optional(),
		arm_a: ARM_SPEC_SCHEMA.optional().describe("Baseline. Omit for the production mailwoman defaults."),
		arm_b: ARM_SPEC_SCHEMA.describe("The arm under test."),
		variable: z
			.array(z.string())
			.min(1)
			.describe(
				'Which keys you intend to differ, in EngineConfig\'s vocabulary (e.g. ["gazetteer_prior"]), or ' +
					'["engine"] across geocoders. Checked against what actually differs; a mismatch warns and marks the ' +
					"result ambiguous."
			),
		grade: z
			.enum(["auto", "truth", "diff-only"])
			.default("auto")
			.describe(
				'"auto" grades where the set carries truth. "truth" REFUSES where it does not, rather than quietly ' +
					"describing differences instead."
			),
		grade_threshold_km: z
			.number()
			.positive()
			.optional()
			.describe("Cross-engine only: which distance threshold rows are graded at. Defaults to 25km."),
		execution_path: z
			.enum(["single-config", "board-routed"])
			.default("single-config")
			.describe(
				'Use "board-routed" for board model grading so every row receives its production country overlay. ' +
					"Candidate caches must contain every routed overlay and their shared base weights."
			),
		stratify_by: z.enum(["country", "address_kind", "status", "truth_tolerance_m", "truth_type"]).optional(),
	}),
	handler: async (args) => runCompare(registry, args),
})
