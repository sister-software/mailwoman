/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { resolvePath } from "path-ts"
import { z } from "zod"

import { defineOperation, OperationEffect } from "#operation"
import { text } from "#operations/inputs"
import { fetchHFWeights, reportHFMaterialization } from "#weights/fetch-hf-weights"

/**
 * `release.fetch-hf-weights` — writes inside the checkout or the data root. Listed in `registry.ts`; the description on
 * the operation is what `mwops` prints.
 */
export const fetchHFWeightsOperation = defineOperation({
	id: "release.fetch-hf-weights",
	description:
		"Materialize a release's weights artifacts from the public Hugging Face bucket into the checkout (or --into <root>); --version names another bucket directory than the base model card's.",
	effect: OperationEffect.LocalWrite,
	inputSchema: z.object({ into: text, version: text }).strict(),
	outputSchema: z.object({
		version: z.string(),
		base: z.string(),
		downloaded: z.number(),
		written: z.number(),
		bytes: z.number(),
		checksumVerified: z.number(),
		checksumUndeclared: z.array(z.string()),
	}),
	async run(input, context) {
		const destRoot = input.into ? String(resolvePath(context.repoRoot, input.into)) : context.repoRoot

		const report = await fetchHFWeights(destRoot, {
			repoRoot: context.repoRoot,
			...(input.version ? { version: input.version } : {}),
			log: context.log,
		})

		reportHFMaterialization(report, context.log)

		return report
	},
})
