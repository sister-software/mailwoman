/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_arc` tool definition. The protocol lives in `../arc.ts`; this file is the CONTRACT, and the description
 *   is the load-bearing half — it is what stops the next agent reaching for a bare two-arm compare.
 */

import { z } from "zod"

import { renderArc, runArc } from "../arc.ts"
import type { DevTool, DevToolDeps } from "../tool-kit.ts"
import { INPUT_SET_SCHEMA } from "../tool-kit.ts"

export const arcTool = ({ registry }: DevToolDeps): DevTool => ({
	name: "mwdev_arc",
	description:
		"Grade a candidate model the way a candidate model has to be graded: self-control, then null, then candidate, " +
		"in that order, with the controls able to invalidate the result. Use this instead of `mwdev_compare` whenever " +
		"the thing under test is WEIGHTS. A bare candidate-vs-shipped compare answers a different question than the " +
		"one being asked and answers it confidently — eight runs were graded that way on 2026-08-23 and every " +
		"regression count was inflated by the cost of fine-tuning at all, which the null leg measured at 10 of 649 " +
		"rows with NO new data. This tool subtracts that, refuses to attribute anything when the self-control is " +
		"dirty, and checks the D-rule (no regression on FR/GB/DE ships default-on, whatever the net says). " +
		"Legs run sequentially — three concurrent board runs saturate the host.",
	inputSchema: z.object({
		candidate: z
			.string()
			.describe("Package-shaped weights directory for the candidate — the model actually under test."),
		control: z
			.string()
			.optional()
			.describe(
				"A staged copy of the SHIPPED weights, run through the identical candidate path. Expect 0 differing " +
					"rows; anything else means the rig is noisy and no number from this session is evidence. Dereference " +
					"symlinks when staging — a directory pointing back at the shipped artifacts passes for the wrong reason. " +
					"Omitting this does not skip the check silently; the result says the rig was never shown to be quiet."
			),
		null: z
			.string()
			.optional()
			.describe(
				"The null arm: same base, same steps, same seed, same brake, NO added shard. This is the placebo, and " +
					"it is what makes a regression count attributable. One ~13-minute run amortises over every candidate " +
					"on that base. Omitting it marks the candidate's regressions as a GROSS upper bound."
			),
		shape: z
			.enum(["fine-tune", "from-scratch"])
			.optional()
			.describe(
				"How the candidate was trained. Decides whether an absent null leg is MISSING or INAPPLICABLE: a " +
					"from-scratch run inherits no base, so there is no fine-tune tax to subtract and shipped is already the " +
					"right baseline. Defaults to fine-tune, which is the shape that needs the null."
			),
		inputs: INPUT_SET_SCHEMA.optional().describe("Defaults to the 649-row board."),
		locale: z.string().optional(),
	}),
	handler: async (args) => {
		const arc = await runArc(registry, {
			candidate: args["candidate"] as string,
			...(args["shape"] ? { shape: args["shape"] as "fine-tune" | "from-scratch" } : {}),
			...(args["control"] ? { control: args["control"] as string } : {}),
			...(args["null"] ? { null: args["null"] as string } : {}),
			...(args["inputs"] === undefined ? {} : { inputs: args["inputs"] }),
			...(args["locale"] ? { locale: args["locale"] as string } : {}),
		})

		return {
			...arc,
			rendered: renderArc(arc),
			summary:
				`${arc.verdict.toUpperCase()}. Candidate net ${arc.candidate.net} ` +
				`(${arc.candidate.improved} improved, ${arc.candidate.regressed} regressed)` +
				(arc.attributableNet === undefined
					? ", with no null leg to attribute it against — treat as an upper bound. "
					: `, of which net ${arc.attributableNet} is attributable to the lever rather than to the fine-tune. `) +
				arc.reasons.join(" "),
		}
	},
})
