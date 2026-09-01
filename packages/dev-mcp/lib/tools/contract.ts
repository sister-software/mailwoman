/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_contract` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The measurement lives in `../contract-report.ts`.
 */

import { z } from "zod"

import { runContractCensus } from "#contract-report"
import type { DevTool, DevToolDeps } from "#tool-kit"
import { ENGINE_CONFIG_SCHEMA, INPUT_SET_SCHEMA } from "#tool-kit"

export const contractTool = ({ registry }: DevToolDeps): DevTool => ({
	name: "mwdev_contract",
	description:
		"DOES THE TREE OBEY ITS OWN CONTRACT — `validateTree`'s two structural invariants, run at board scale. A parse " +
		"can match every asserted component and still be incoherent: a `house_number` or `street_suffix` floating with " +
		"no `street` anywhere, an `attention` with no `venue`. Those orphan fragments are the signature of an " +
		"overconfident hallucination, and no outcome test sees them — a component-match harness never looks at the " +
		"edges. Sibling to `mwdev_census`, one seam " +
		"over: that asks whether a parse-path MECHANISM signals on any row, this asks whether a decoder CONTRACT " +
		"breaks on any row. A ZERO MEANS OPPOSITE THINGS FOR THE TWO CHECKS and they are never summed — `illegal-edge` " +
		"is enforced by the tree builder at construction, so zero is the designed state and any count is a builder " +
		"regression; `stranded-dependent` is real model behaviour, so its zero is ambiguous until you know the tag " +
		"appeared at all, and every stranding count is therefore reported beside how many rows produced that tag. " +
		"Duplicate tags are diagnostic rather than violations: the report groups their row counts by tag and by " +
		"sibling, nested, or separate-branch topology, with row IDs and full inputs, without changing validateTree.",
	inputSchema: z.object({
		inputs: INPUT_SET_SCHEMA.optional().describe(
			"Defaults to the full board. Needs no truth of any kind — the contract is a claim a tree settles about " +
				"ITSELF, so a literal set or an untruthed corpus is measurable here where it is not elsewhere."
		),
		config: ENGINE_CONFIG_SCHEMA.optional().describe(
			"Pair with `weights_cache` to ask whether a CANDIDATE model produces more structurally incoherent trees " +
				"than the shipped one — a question the component floors cannot answer."
		),
		limit: z.number().int().positive().optional().describe("First N rows of the resolved set."),
	}),
	handler: async (args) => runContractCensus(registry, args),
})
