/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_reliability` tool definition — the description an agent reads, the input schema, and the handler
 *   wiring. The measurement lives in `../reliability-report.ts`.
 */

import { z } from "zod"

import { ReliabilitySurface, runReliability } from "#reliability-report"
import { ComponentAggregate, UnassertedPolicy } from "#reliability-surfaces"
import type { DevTool, DevToolDeps } from "#tool-kit"
import { ENGINE_CONFIG_SCHEMA, INPUT_SET_SCHEMA } from "#tool-kit"

export const reliabilityTool = ({ registry }: DevToolDeps): DevTool => ({
	name: "mwdev_reliability",
	description:
		"DOES A CONFIDENCE MEAN ANYTHING. Every other measurement here asks whether an ANSWER is right and collapses " +
		"the confidence away before grading; this asks whether the number attached to the answer predicts that. The " +
		"two are independent — a surface can be accurate and uninformative (everything at 0.99, right 80% of the " +
		"time) or inaccurate and well-calibrated, and only the second is safe to check on. Reports the reliability " +
		"curve (per-bin count, mean confidence, accuracy, SIGNED gap, plus ECE and MCE, which disagree on purpose: a " +
		"rare badly-calibrated bin barely moves ECE and dominates MCE) AND a threshold table, because they answer " +
		"different questions — a well-calibrated surface can still have no threshold worth setting. Empty bins are " +
		"kept: a surface that is never unsure is itself the finding.",
	inputSchema: z.object({
		surface: z
			.enum([ReliabilitySurface.Decode, ReliabilitySurface.CoarsePlacer])
			.default(ReliabilitySurface.Decode)
			.describe(
				"`decode` — the per-token softmax folded to the assembled COMPONENT and graded against an input set's " +
					"component labels with the harness's own case-folded rule. `coarse_placer` — the placer's own probability against a held-out country label, with " +
					"`abstainBelow` forced to 0, since the production threshold censors exactly the rows the curve is about. " +
					"They are separate heads over separate features: a correction fitted to one does nothing for the other."
			),
		inputs: INPUT_SET_SCHEMA.optional().describe(
			"`decode` only. Defaults to the full board. Rows carrying no component truth are EXCLUDED and itemized " +
				"rather than counted as wrong — the golden and parity sets carry the most truth per row."
		),
		config: ENGINE_CONFIG_SCHEMA.optional().describe(
			"`decode` only. `trace` is forced on regardless, since the per-token softmax is the measurement. Pair with " +
				"`weights_cache` to ask whether a CANDIDATE model's confidences are better calibrated than the shipped one's."
		),
		aggregate: z
			.enum([ComponentAggregate.Min, ComponentAggregate.Mean])
			.default(ComponentAggregate.Min)
			.describe(
				"`decode` only — how a component's confidence is folded out of its tokens. `min` is the weakest link, the " +
					"reading a check should use. `mean` is what `AddressNode.confidence` already reports, so calibrate against " +
					"it when the consumer reads the tree. They diverge most on long spans."
			),
		corpus: z
			.string()
			.optional()
			.describe(
				"`coarse_placer` only. Defaults to the held-out `data/coarse-placer/test.jsonl`, held out from BOTH training " +
					"and the `val` split the temperature was fit on. That split is a LOCAL artifact, not tracked in git; its " +
					"absence is reported as absence. Pointing this at `val` or `train` makes the curve the fit reporting on " +
					"itself, with no other symptom."
			),
		bins: z.number().int().min(2).max(50).default(10).describe("Equal-width bins over [0, 1]."),
		thresholds: z
			.array(z.number().min(0).max(1))
			.optional()
			.describe("Check positions for the threshold table. Defaults to a spread from 0.5 to 0.99."),
		stratify: z
			.array(z.string())
			.optional()
			.describe(
				"Stratum keys to curve separately. `decode`: tag, country, address_kind. `coarse_placer`: expected. An " +
					"unknown key is ignored rather than returning one group named `(unset)`."
			),
		unasserted: z
			.enum([UnassertedPolicy.Exclude, UnassertedPolicy.Wrong])
			.default(UnassertedPolicy.Exclude)
			.describe(
				"`decode` only — what to do with a produced component no truth row mentions. `exclude` counts it in a " +
					"separate cohort; `wrong` grades it as a hallucination, which is sound ONLY against a corpus asserting " +
					"every component. None wired here does — the board asserts a median of ONE key per row, golden 4, parity " +
					"2, against the ~7 a full US address has — so on these corpora `wrong` measures the corpus, not the model."
			),
		limit: z.number().int().positive().optional().describe("`decode` only — first N rows of the resolved set."),
	}),
	handler: async (args) => runReliability(registry, args),
})
