/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "zod"

import { defineOperation, OperationEffect } from "#release-kit/operation"
import { text } from "#release-kit/operations/inputs"
import { type SurfaceResult, verifyReleaseMetadata } from "#release-kit/release/verify-metadata"

const surfaceResult: z.ZodType<SurfaceResult> = z.object({ surface: z.string(), ok: z.boolean(), message: z.string() })

/**
 * `release.verify-metadata` — reads and makes no change.
 */
export const verifyMetadata = defineOperation({
	id: "release.verify-metadata",
	description:
		"Check that the shipped model's version has propagated to the eval ledger, the releases matrix and the status page; one actionable remediation per stale surface.",
	effect: OperationEffect.Read,
	inputSchema: z.object({ card: text, ledger: text, releases: text, status: text }).strict(),
	outputSchema: z.object({ modelVersion: z.string(), surfaces: z.array(surfaceResult) }),
	run: (input, context) =>
		verifyReleaseMetadata({
			repoRoot: context.repoRoot,
			...(input.card ? { card: input.card } : {}),
			...(input.ledger ? { ledger: input.ledger } : {}),
			...(input.releases ? { releases: input.releases } : {}),
			...(input.status ? { status: input.status } : {}),
			log: context.log,
		}),
})
