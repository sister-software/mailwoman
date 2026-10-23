/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_fanout` tool definition provides the agent-facing description and input schema.
 *   Its handler runs the fan-out in the package root.
 */

import { z } from "zod"

import { FANOUT_MAX_ARMS, runFanout } from "#dev-mcp/fanout"
import type { DevTool, DevToolDeps } from "#dev-mcp/tool-kit"
import { ENGINE_CONFIG_SCHEMA, INPUT_SET_SCHEMA } from "#dev-mcp/tool-kit"

/**
 * Run the `mwdev_fanout` tool: one input set through several arms, one stability reading per row.
 */
export const fanoutTool = ({ registry }: DevToolDeps): DevTool => ({
	name: "mwdev_fanout",
	description:
		"IS THIS ROW STABLE — one input set through two to eight mailwoman arms at once, every arm's reading side by " +
		"side on one line per row, and a stability kind: `flip` (the arms grade the row differently), `stable_pass`, " +
		"`stable_fail`, or `ungraded` (the row states no truth, so only the decodes are compared). The summary lists " +
		"the flip set by row id. Read it BEFORE `mwdev_compare` names a regression: a row that flips across staged " +
		"candidates trained on the same data is in the flip set first and a regression second. Arms are mailwoman " +
		"configurations; `candidates` names staged roots under the data root's `candidates/` directory and expands " +
		"each to a `weights_cache` arm. No winner is declared and no rate is claimed — this reports agreement among " +
		"the arms supplied, and the arm list travels beside every count.",
	inputSchema: z.object({
		inputs: INPUT_SET_SCHEMA.optional(),
		arms: z
			.array(
				z.object({
					label: z
						.string()
						.min(1)
						.optional()
						.describe(
							"A short name for the arm in every row; defaults to the weights root's basename, `production` for an empty config, or `arm-N`."
						),
					config: ENGINE_CONFIG_SCHEMA,
				})
			)
			.max(FANOUT_MAX_ARMS)
			.default([])
			.describe(
				"Mailwoman arms, each an EngineConfig with an optional label. Combined with `candidates`; at least two arms in total."
			),
		candidates: z
			.array(z.string().min(1))
			.max(FANOUT_MAX_ARMS)
			.default([])
			.describe(
				"Names of staged roots under `<data root>/candidates/`, such as `v820-base`. Each becomes a " +
					"`weights_cache` arm labeled by its name. A name with no directory is refused by its full path."
			),
		execution_path: z
			.enum(["board-routed", "single-config"])
			.default("board-routed")
			.describe(
				'"board-routed" gives every row its production country overlay, as the board does, and refuses a ' +
					'candidate root that lacks a routed overlay. "single-config" runs every row through one warm session ' +
					"per arm, for staged roots that carry only the base weights."
			),
		limit: z.number().int().positive().optional().describe("Run only the first N rows of the set."),
		rows_cap: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Emit at most N rows, flip set first. Every aggregate still covers every row."),
	}),
	handler: async (args) => runFanout(registry, args),
})
