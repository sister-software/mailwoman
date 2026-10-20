/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   MCP interface for the control-first candidate model grading protocol.
 */

import { z } from "zod"

import { renderArc, runArc, summarizeArc } from "#dev-mcp/arc"
import type { DevTool, DevToolDeps } from "#dev-mcp/tool-kit"
import { INPUT_SET_SCHEMA } from "#dev-mcp/tool-kit"

export const arcTool = async ({ registry }: DevToolDeps): Promise<DevTool> => ({
	name: "mwdev_arc",
	description:
		"Grade a candidate model the way a candidate model has to be graded: self-control, then null, then candidate, " +
		"in that order, with the controls able to invalidate the result. Use this instead of `mwdev_compare` whenever " +
		"the thing under test is WEIGHTS. A bare candidate-vs-shipped compare answers a different question than the " +
		"one being asked and answers it confidently — eight runs were graded that way on 2026-08-23 and every " +
		"regression count was inflated by the cost of fine-tuning at all, which the null leg measured at 10 of 649 " +
		"rows with NO new data. This tool subtracts that and refuses to attribute anything when the self-control is " +
		"dirty. Training attribution and release eligibility are separate answers: release eligibility is read only " +
		"from the release verdict `release/evaluate.run.ts` wrote for this candidate's model.onnx sha256 and the " +
		"current release spec version, a mismatched verdict is refused, and a missing one is insufficient evidence. " +
		"Board regressions are reported as findings with their addresses and never decide release eligibility. " +
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
				"The null arm: same base, same steps, same seed, same brake, NO added extract. This is the placebo, and " +
					"it is what makes a regression count attributable. One ~13-minute run amortizes over every candidate " +
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
		release_verdict: z
			.string()
			.optional()
			.describe(
				"The verdict JSON `release/evaluate.run.ts` wrote for this candidate. Its artifacts.candidate must equal " +
					"the sha256 of <candidate>/model.onnx and its specVersion the release spec's. Omitted, release " +
					"eligibility is insufficient_evidence."
			),
		release_spec: z
			.string()
			.optional()
			.describe("The release-requirement spec the verdict must match. Defaults to the current committed spec."),
		inputs: INPUT_SET_SCHEMA.optional().describe("Defaults to the full regression board."),
		locale: z.string().optional(),
	}),
	handler: async (args) => {
		const arc = await runArc(registry, {
			candidate: args["candidate"] as string,
			...(args["shape"] ? { shape: args["shape"] as "fine-tune" | "from-scratch" } : {}),
			...(args["control"] ? { control: args["control"] as string } : {}),
			...(args["null"] ? { null: args["null"] as string } : {}),
			...(args["release_verdict"] ? { releaseVerdict: args["release_verdict"] as string } : {}),
			...(args["release_spec"] ? { releaseSpec: args["release_spec"] as string } : {}),
			...(args["inputs"] === undefined ? {} : { inputs: args["inputs"] }),
			...(args["locale"] ? { locale: args["locale"] as string } : {}),
		})

		return {
			...arc,
			rendered: renderArc(arc),
			summary: summarizeArc(arc),
		}
	},
})
