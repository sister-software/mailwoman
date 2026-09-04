/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "zod"

import { defineOperation, OperationEffect } from "#operation"
import { flag } from "#operations/inputs"
import { checkReleaseParity, type ParityCheck } from "#release/check-parity"

const parityCheck: z.ZodType<ParityCheck> = z.object({
	name: z.string(),
	value: z.string(),
	ok: z.boolean(),
	expected: z.string(),
})

/**
 * `release.check-parity` — reads and changes nothing. Listed in `registry.ts`; the description on the operation is what
 * `mwops` prints.
 */
export const checkParity = defineOperation({
	id: "release.check-parity",
	description:
		"Compare the demo manifest and the docs releases matrix against npm latest and the shipped model card; --warn-only downgrades a mismatch to a warning.",
	effect: OperationEffect.Read,
	inputSchema: z.object({ "warn-only": flag }).strict(),
	outputSchema: z.object({
		npmLatest: z.string(),
		cardModelVersion: z.string(),
		checks: z.array(parityCheck),
		drift: z.boolean(),
	}),
	run: (input, context) =>
		checkReleaseParity({ repoRoot: context.repoRoot, warnOnly: input["warn-only"], log: context.log }),
})
