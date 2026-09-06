/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "zod"

import { defineOperation, OperationEffect } from "#operation"
import { text } from "#operations/inputs"
import { scaffoldWeightsOverlay } from "#weights/scaffold-weights-overlay"

/**
 * `release.scaffold-weights-overlay` — writes inside the checkout or the data root. Listed in `registry.ts`; the
 * description on the operation is what `mwops` prints.
 */
export const scaffoldWeightsOverlayOperation = defineOperation({
	id: "release.scaffold-weights-overlay",
	description:
		"Scaffold a data-only @mailwoman/neural-weights-<locale> overlay (--locale es-ES [--artifact pair-index-es.bin]) and register it in the root workspaces, the release list, release.config.json and the smoke pack set.",
	effect: OperationEffect.LocalWrite,
	inputSchema: z
		.object({ locale: z.string({ error: "--locale is required (e.g. es-ES)" }), artifact: text, base: text })
		.strict(),
	outputSchema: z.object({
		packageDir: z.string(),
		packageName: z.string(),
		version: z.string(),
		artifact: z.string(),
		registered: z.array(z.string()),
	}),
	run: (input, context) =>
		scaffoldWeightsOverlay({
			repoRoot: context.repoRoot,
			locale: input.locale,
			...(input.base ? { base: input.base } : {}),
			...(input.artifact ? { artifact: input.artifact } : {}),
			log: context.log,
		}),
})
