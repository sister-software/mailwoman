/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_census` tool definition provides the agent-facing description and input schema.
 *   Its handler calls the measurement in the package root.
 */

import { z } from "zod"

import { runCensus } from "#census"
import type { DevTool, DevToolDeps } from "#tool-kit"
import { ENGINE_CONFIG_SCHEMA, INPUT_SET_SCHEMA } from "#tool-kit"

export const censusTool = ({ registry }: DevToolDeps): DevTool => ({
	name: "mwdev_census",
	description:
		"Activation-coverage census (#1719): one traced parse per input, aggregated per MECHANISM rather than per " +
		"row. Answers the question outcome tests cannot — did each channel, prior and repair pass signal on ANY " +
		"row — because soft mechanisms are designed to degrade silently, and an inert mechanism keeps every " +
		"outcome green. A mechanism at zero L1 across the set is reported as INERT: every zero needs a row that " +
		"activates it or an allowlisted reason. L2 (moved an outcome) is explicitly not measured here.",
	inputSchema: z.object({
		inputs: INPUT_SET_SCHEMA.optional().describe("Defaults to the full board."),
		config: ENGINE_CONFIG_SCHEMA.optional(),
	}),
	handler: async (args) => runCensus(registry, args),
})
