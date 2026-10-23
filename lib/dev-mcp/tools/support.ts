/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_support` tool definition provides the agent-facing description and input schema.
 *   Its handler reads the support index in the package root.
 */

import { z } from "zod"

import { runSupport } from "#dev-mcp/support"
import type { DevTool, DevToolDeps } from "#dev-mcp/tool-kit"
import { INPUT_SET_SCHEMA } from "#dev-mcp/tool-kit"

/**
 * Run the `mwdev_support` tool: each row's expected components against the corpus support index.
 */
export const supportTool = (_deps: DevToolDeps): DevTool => ({
	name: "mwdev_support",
	description:
		"DID THE CORPUS TEACH THIS — for each row, the train rows of its country that hold its expected tag set, " +
		"each expected value's rows under its own tag and under every other tag, and for a venue or street the rows " +
		"holding its first and last word. Read from the support index written beside a corpus manifest by " +
		"`support-index.run.ts`, so a board of a thousand rows is two parquet scans rather than an 8-minute pass " +
		"over 700 M rows. An absent index is reported as UNREAD with the build command, never as zero. Read it " +
		"before proposing a corpus overlay or a retrain: a tag set the corpus holds 0 times for the country is a " +
		"corpus finding, and a value the country holds only under another tag is a labeling finding.",
	inputSchema: z.object({
		inputs: INPUT_SET_SCHEMA.optional(),
		manifest: z
			.string()
			.min(1)
			.optional()
			.describe(
				"The corpus MANIFEST.json whose index is read. Defaults to the newest manifest under the data root's " +
					"corpus/versioned directory."
			),
		index_dir: z
			.string()
			.min(1)
			.optional()
			.describe(
				"A support index directory to read instead of the one beside `manifest`, for an index written with " +
					"`--out`. The index's own record states which manifest it counted."
			),
		limit: z.number().int().positive().optional().describe("Read only the first N rows of the set."),
		rows_cap: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Emit at most N rows, zero-support rows first. Every aggregate still covers every probed row."),
	}),
	handler: async (args) => runSupport(args),
})
