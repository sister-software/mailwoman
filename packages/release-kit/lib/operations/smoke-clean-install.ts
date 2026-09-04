/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "zod"

import { defineOperation, OperationEffect } from "#operation"
import { smokeCleanInstall } from "#release/smoke-clean-install"

/**
 * `release.smoke-clean-install` — writes inside the checkout or the data root. Listed in `registry.ts`; the description
 * on the operation is what `mwops` prints.
 */
export const smokeCleanInstallOperation = defineOperation({
	id: "release.smoke-clean-install",
	description:
		"Pack every published workspace, npm install the tarballs into a throwaway project with no hoisting, and run the compiled CLI plus every entrypoint import. Run after `yarn compile`.",
	effect: OperationEffect.LocalWrite,
	inputSchema: z.object({}).strict(),
	outputSchema: z.object({ packed: z.number(), mcpTools: z.number(), standaloneLeaves: z.array(z.string()) }),
	run: (_input, context) => smokeCleanInstall({ repoRoot: context.repoRoot, log: context.log }),
})
