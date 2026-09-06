/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "zod"

/**
 * Public environment variables related to evaluation tooling.
 */
export const PublicEvaluationEnvSchema = z.object({
	MAILWOMAN_WOF_GLOBAL_DB: z.string().optional().meta({
		title: "Evaluation global admin database",
		description: "Admin gazetteer override used by the default-country evaluation panel.",
	}),
	MAILWOMAN_DIAG_INTERP: z.string().optional().meta({
		title: "Interpolation diagnostics",
		description: "Set to `1` to emit interpolation coverage diagnostics during resolver evaluation.",
	}),
	MAILWOMAN_DUMP_MISS_TAG: z.string().optional().meta({
		title: "Dump missed tag",
		description: "Tag whose false negatives and mislabels are printed by per-locale evaluation tooling.",
	}),
	MAILWOMAN_WORD_CONSISTENCY: z.string().optional().meta({
		title: "Word consistency mode",
		description: "Evaluation override controlling the word-consistency healing behavior used by neural parsing.",
	}),
	MAILWOMAN_COLD_START_FULL: z.string().optional().meta({
		title: "Full cold-start test",
		description: "Enables the with-data cold-start suite that pulls candidate data and boots all drop-in servers.",
	}),
	MAILWOMAN_COLD_START_DATA_ROOT: z.string().optional().meta({
		title: "Cold-start data root",
		description: "Existing populated data root reused by the conditional full cold-start suite.",
	}),
})

/**
 * Secrets used only by evaluation tooling. Never log their values.
 */
export const PrivateEvaluationEnvSchema = z.object({
	/**
	 * Per-run secret salting the published case identifiers of a controlled premise-linkage evaluation (`mailwoman eval
	 * premise-linkage`). A secret rather than config: two reports salted alike can be joined row for row into a longer
	 * record of the same premises, which is the linkage the identifier exists to prevent.
	 */
	MAILWOMAN_PREMISE_LINKAGE_SALT: z.string().optional().meta({
		title: "Premise-linkage salt",
		description: "Per-run secret used to salt published case identifiers in controlled premise-linkage evaluations.",
	}),
})
