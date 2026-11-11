/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { OperationEffect } from "@mailwoman/core/scripting"
import { z } from "zod"

import { defineOperation } from "#release-kit/operation"
import { flag, text } from "#release-kit/operations/inputs"
import { smokeGetStarted } from "#release-kit/release/smoke/get-started"

/**
 * `release.smoke-get-started` — writes only inside a scratch directory
 * (and the data root the caller names for the full leg).
 *
 * Listed in `registry.ts`; the description on the operation is what `mwops` prints.
 */
export const smokeGetStartedOperation = defineOperation({
	id: "release.smoke-get-started",
	description:
		"Cold trial of the first-parse tutorial and CLI: pack mailwoman, neural, and en-us weights; install the tarballs outside the tree; run the tutorial script, doctor, and shell parse. --full adds the candidate pull and US and FR geocodes; --data-root keeps the pull.",
	effect: OperationEffect.LocalWrite,
	options: { full: { type: "boolean" }, "data-root": { type: "string" } },
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
