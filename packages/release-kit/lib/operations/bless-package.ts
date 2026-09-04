/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "zod"

import { defineOperation, OperationEffect } from "#operation"
import { flag, list, text } from "#operations/inputs"
import { blessPackages } from "#release/bless-package"
import { assertPlanHolds } from "#release/plan"

const blessedPackage = z.object({ name: z.string(), published: z.boolean(), trusted: z.boolean() })

/**
 * `release.bless-package` — writes to an external system and is reachable only through the plan → execute contract.
 * Listed in `registry.ts`; the description on the operation is what `mwops` prints.
 */
export const blessPackage = defineOperation({
	id: "release.bless-package",
	description:
		"First publish + trusted-publisher configuration for one or more workspaces (--dirs a,b) through the npm CLI's own 2FA handshake. Requires --plan <file>, or --allow-unplanned.",
	effect: OperationEffect.ExternalWrite,
	inputSchema: z
		.object({
			dirs: list,
			plan: text,
			"allow-unplanned": flag,
			version: text,
			file: z.string().default("publish.yml"),
			env: text,
			provider: z.string().default("github"),
			"no-trust": flag,
		})
		.strict(),
	outputSchema: z.object({ blessed: z.array(blessedPackage), planDigest: z.string().optional() }),
	async run(input, context) {
		let planDigest: string | undefined

		if (input.plan) {
			planDigest = (await assertPlanHolds(context.repoRoot, input.plan)).planDigest
			context.log(`bless-package: plan ${planDigest} holds`)
		} else if (input["allow-unplanned"]) {
			context.log(
				"bless-package: WARNING — blessing WITHOUT a release plan (--allow-unplanned). HEAD, version and artifact set are unverified against a sealed plan."
			)
		} else if (!context.dryRun) {
			throw new Error(
				"bless-package: refusing to publish without a plan. Pass --plan <file> written by `mwops release plan --json`, or --allow-unplanned."
			)
		}

		const report = await blessPackages({
			repoRoot: context.repoRoot,
			dirs: input.dirs,
			...(input.version ? { version: input.version } : {}),
			file: input.file,
			...(input.env ? { env: input.env } : {}),
			provider: input.provider,
			noTrust: input["no-trust"],
			dryRun: context.dryRun,
			log: context.log,
		})

		return { ...report, ...(planDigest ? { planDigest } : {}) }
	},
})
