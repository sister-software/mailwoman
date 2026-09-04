/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { resolvePath } from "path-ts"
import { z } from "zod"

import { defineOperation, OperationEffect } from "#operation"
import { text } from "#operations/inputs"
import { copyWeights } from "#weights/copy-weights"

/**
 * `release.copy-weights` — writes inside the checkout or the data root. Listed in `registry.ts`; the description on the
 * operation is what `mwops` prints.
 */
export const copyWeightsOperation = defineOperation({
	id: "release.copy-weights",
	description:
		"Materialize every weights workspace's binaries and soft-feed artifacts from this machine's data root into the checkout (or --into <root>). Skipped under MAILWOMAN_SKIP_WEIGHTS_COPY.",
	effect: OperationEffect.LocalWrite,
	inputSchema: z.object({ into: text }).strict(),
	outputSchema: z.object({ skipped: z.boolean(), workspaces: z.array(z.string()) }),
	run: (input, context) =>
		copyWeights({
			repoRoot: context.repoRoot,
			destRoot: input.into ? String(resolvePath(context.repoRoot, input.into)) : context.repoRoot,
			log: context.log,
		}),
})
