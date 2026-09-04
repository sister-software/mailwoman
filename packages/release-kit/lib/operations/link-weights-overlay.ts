/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "zod"

import { defineOperation, OperationEffect } from "#operation"
import { flag, text } from "#operations/inputs"
import { linkWeightsOverlay } from "#weights/link-weights-overlay"

/**
 * `release.link-weights-overlay` — writes inside the checkout or the data root. Listed in `registry.ts`; the
 * description on the operation is what `mwops` prints.
 */
export const linkWeightsOverlayOperation = defineOperation({
	id: "release.link-weights-overlay",
	description:
		"Populate $MAILWOMAN_DATA_ROOT/weights/<locale>/ from release.config.json — the writer half of resolveWeights' overlay rung. --plan (or --dry-run) reports and changes nothing.",
	effect: OperationEffect.LocalWrite,
	inputSchema: z.object({ plan: flag, locale: text }).strict(),
	outputSchema: z.object({
		plan: z.boolean(),
		locales: z.array(z.string()),
		linked: z.number(),
		missing: z.number(),
		mismatched: z.number(),
		unrecorded: z.number(),
	}),
	run: (input, context) =>
		linkWeightsOverlay({
			repoRoot: context.repoRoot,
			plan: input.plan || context.dryRun,
			...(input.locale ? { locale: input.locale } : {}),
			log: context.log,
		}),
})
