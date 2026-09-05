/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "zod"

import { defineOperation, OperationEffect } from "#operation"
import { flag, text } from "#operations/inputs"
import { smokeGetStarted } from "#release/smoke-get-started"

/**
 * `release.smoke-get-started` — writes only inside a scratch directory (and the data root the caller names for the full
 * leg). Listed in `registry.ts`; the description on the operation is what `mwops` prints.
 */
export const smokeGetStartedOperation = defineOperation({
	id: "release.smoke-get-started",
	description:
		"Cold trial of the get-started pages: pack the closure of mailwoman + neural + the en-us weights, npm install it outside the tree, and run the pages' transcripts (first parse, doctor, shell parse). --full adds the ~1.65 GB candidate pull and the US + FR geocodes; --data-root keeps the pull.",
	effect: OperationEffect.LocalWrite,
	inputSchema: z.object({ full: flag, "data-root": text }).strict(),
	outputSchema: z.object({ packed: z.number(), legs: z.array(z.string()) }),
	run: (input, context) =>
		smokeGetStarted({
			repoRoot: context.repoRoot,
			log: context.log,
			full: input.full,
			...(input["data-root"] ? { dataRoot: input["data-root"] } : {}),
		}),
})
