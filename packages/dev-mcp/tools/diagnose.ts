/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_diagnose` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The measurement itself lives in the package root; this file is the CONTRACT, and the description is the
 *   load-bearing half of it.
 */

import { z } from "zod"

import { COUNTERFACTUAL_FULL_RUN_MAX_ROWS, DIAGNOSE_SHAPES, runDiagnose } from "../diagnose.ts"
import type { DevTool, DevToolDeps } from "../tool-kit.ts"
import { ENGINE_CONFIG_SCHEMA, INPUT_SET_SCHEMA } from "../tool-kit.ts"

export const diagnoseTool = ({ registry }: DevToolDeps): DevTool => ({
	name: "mwdev_diagnose",
	description:
		"Per-row MECHANISM ACCOUNT (#1722), measured on the ONE-config out-of-the-box path (the #1669 caveat on " +
		"mwdev_run applies). What the pipeline did, assembled from its own seams \u2014 kind verdict, " +
		"known formats, priors, repairs and decode confidence; the three-state evidence channels; every backend " +
		"lookup with its gates, candidate count and the rank the pick started at; admin coherence, lineage and " +
		"tier \u2014 plus the smallest single-lever flip that moves the answer. Rows are classified into " +
		`mechanism-state shapes (${DIAGNOSE_SHAPES.join(", ")}) by TRANSPARENT seam-fact predicates, and the ` +
		"result says so: this is uncalibrated v1, every predicate ships beside its count, and a row that fails " +
		"its expectation while matching no shape is reported `unclassified` rather than forced into the nearest " +
		"one. Aggregation is BY SHAPE with each class's n, never by raw row count.",
	inputSchema: z.object({
		inputs: INPUT_SET_SCHEMA.optional(),
		config: ENGINE_CONFIG_SCHEMA.optional(),
		counterfactuals: z
			.boolean()
			.default(true)
			.describe(
				"Re-run each row under one flipped lever at a time and report the flips that moved the answer. " +
					`Above ${COUNTERFACTUAL_FULL_RUN_MAX_ROWS} rows this narrows to rows that matched a non-clean ` +
					"shape, and the result says so \u2014 a clean row's levers are then unmeasured, not inert."
			),
		limit: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Cap on rows accounted for. Never the default; reported against the set's real n."),
		rows_cap: z
			.number()
			.int()
			.positive()
			.optional()
			.describe(
				"Cap on the PER-ROW accounts in the reply — the aggregates (by_shape, counterfactual_levers, summary) " +
					"still cover every evaluated row. The emitted slice leads with non-clean rows and `rows_omitted` " +
					"says what it left out. Use for large sets where the census is the point and the row dump is not."
			),
	}),
	handler: async (args) => runDiagnose(registry, args),
})
