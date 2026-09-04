/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "zod"

import { defineOperation, OperationEffect } from "#operation"
import { flagDefaultOn, list, text } from "#operations/inputs"
import { stageWeightsCache } from "#weights/stage-weights-cache"

/**
 * `release.stage-weights-cache` — writes inside the checkout or the data root. Listed in `registry.ts`; the description
 * on the operation is what `mwops` prints.
 */
export const stageWeightsCacheOperation = defineOperation({
	id: "release.stage-weights-cache",
	description:
		"Assemble a package-shaped weights directory under --out <cacheRoot> so a candidate model is graded as a bundle: --from seeds it, --file name=path (comma list), --omit (comma list) and --card diverge it.",
	effect: OperationEffect.LocalWrite,
	inputSchema: z
		.object({
			out: z.string({ error: "--out <dir> is required" }),
			locale: z.string().default("en-us"),
			from: text,
			file: list,
			omit: list,
			card: text,
			clean: flagDefaultOn,
		})
		.strict(),
	outputSchema: z.object({
		cacheRoot: z.string(),
		packageDir: z.string(),
		linked: z.number(),
		staged: z.array(z.string()),
		omitted: z.array(z.string()),
	}),
	run: (input, context) =>
		stageWeightsCache({
			repoRoot: context.repoRoot,
			out: input.out,
			locale: input.locale,
			...(input.from ? { from: input.from } : {}),
			file: input.file,
			omit: input.omit,
			...(input.card ? { card: input.card } : {}),
			clean: input.clean,
			log: context.log,
		}),
})
