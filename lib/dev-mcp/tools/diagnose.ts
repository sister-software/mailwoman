/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_diagnose` tool definition provides the agent-facing description and input schema.
 *   Its handler calls the diagnosis in the package root.
 */

import { z } from "zod"

import { COUNTERFACTUAL_FULL_RUN_MAX_ROWS, DIAGNOSE_SHAPES, runDiagnose } from "#dev-mcp/diagnose"
import type { DevTool, DevToolDeps } from "#dev-mcp/tool-kit"
import { ENGINE_CONFIG_SCHEMA, INPUT_SET_SCHEMA } from "#dev-mcp/tool-kit"

export const diagnoseTool = async ({ registry }: DevToolDeps): Promise<DevTool> => ({
	name: "mwdev_diagnose",
	description:
		"Per-row MECHANISM ACCOUNT (#1722), measured on the ONE-config out-of-the-box path (the #1669 caveat on " +
		"mwdev_run applies). What the pipeline did, assembled from its own boundaries \u2014 kind verdict, " +
		"known formats, priors, repairs and decode confidence; the three-state evidence channels; every backend " +
		"lookup with its checks, candidate count and the rank the pick started at; admin coherence, lineage and " +
		"tier \u2014 plus the smallest single-setting flip that moves the answer. Rows are classified into " +
		`mechanism-state shapes (${DIAGNOSE_SHAPES.join(", ")}) by TRANSPARENT stage-fact predicates, and the ` +
		"result says so: this is uncalibrated v1, every predicate ships beside its count, and a row that fails " +
		"its expectation while matching no shape is reported `unclassified` rather than forced into the nearest " +
		"one. Aggregation is BY SHAPE with each class's n, never by raw row count. " +
		'`account: "constraints"` is a second account: it parses each row as the held-out battery grades it ' +
		"(NeuralAddressClassifier.parse with postcodeRepair and the row's country, on the locale package the held-out " +
		"rule names, from `config.weights_cache` when set), and reports whether the decode violates C4 or C6 of " +
		"decoder-grammar.mdx §5, with the span, the runner-up and the decoder's term margins behind each violation. " +
		"It reads `rows` when given, otherwise `inputs`, ignores every other config pin, and changes no decode.",
	inputSchema: z.object({
		account: z
			.enum(["mechanism", "constraints"])
			.default("mechanism")
			.describe('"mechanism" is the per-row mechanism account; "constraints" is the C4/C6 constraint account.'),
		rows: z
			.array(
				z.object({
					id: z.string().optional(),
					input: z.string().min(1),
					country: z.string().length(2).optional(),
					expected: z.string().optional().describe("Echoed beside the observed reading; nothing is graded."),
				})
			)
			.min(1)
			.optional()
			.describe('Rows for `account: "constraints"`, each with the country the battery passes as its locale hint.'),
		inputs: INPUT_SET_SCHEMA.optional(),
		config: ENGINE_CONFIG_SCHEMA.optional(),
		counterfactuals: z
			.boolean()
			.default(true)
			.describe(
				"Re-run each row under one flipped setting at a time and report the flips that moved the answer. " +
					`Above ${COUNTERFACTUAL_FULL_RUN_MAX_ROWS} rows this narrows to rows that matched a non-clean ` +
					"shape, and the result says so \u2014 a clean row's settings are then unmeasured, not inert."
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
				"Cap on the PER-ROW accounts in the reply — the aggregates (by_shape, counterfactual_settings, summary) " +
					"still cover every evaluated row. The emitted rows lead with the non-clean ones and `rows_omitted` " +
					"says what it left out. Use for large sets where the census is the point and the row dump is not."
			),
		execution_path: z
			.enum(["single-config", "board-routed"])
			.default("single-config")
			.describe(
				'"single-config" runs every row through the one engine `config` describes, which is also the engine ' +
					'the counterfactual sweep flips. "board-routed" runs each row under its country\'s weights overlay and ' +
					"country scope, as the board does, so a GB row's lookups are scoped to GB; a row whose country has no " +
					"overlay runs on the base weights with no country scope, each account records which engine read it, " +
					"and the counterfactual sweep covers the base-engine rows only."
			),
	}),
	handler: async (args) => runDiagnose(registry, args),
})
