/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "zod"

import { defineOperation, OperationEffect } from "#operation"
import { releaseGeneratedSurfaces } from "#release/generated-surfaces"

const surfaceState = z.object({ file: z.string(), changed: z.boolean() })

/**
 * `release.generated-surfaces` — writes inside the checkout or the data root. Listed in `registry.ts`; the description
 * on the operation is what `mwops` prints.
 */
export const generatedSurfaces = defineOperation({
	id: "release.generated-surfaces",
	description:
		"Regenerate every version-stamped generated document (the man page, the docs CLI reference) after a version bump. Requires a compiled tree.",
	effect: OperationEffect.LocalWrite,
	inputSchema: z.object({}).strict(),
	outputSchema: z.object({ surfaces: z.array(surfaceState) }),
	async run(_input, context) {
		return { surfaces: await releaseGeneratedSurfaces(context.repoRoot, context.log) }
	},
})
