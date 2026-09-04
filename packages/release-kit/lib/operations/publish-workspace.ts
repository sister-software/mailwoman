/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one npm write. Plan → execute: `--plan <file>` names a plan `release.plan --json` wrote, and the operation
 *   refuses when HEAD is dirty, HEAD moved, or the recomputed digest differs. release-it's per-workspace
 *   `publishCommand` hook has no plan to hand over, so `--allow-unplanned` keeps that path runnable — loudly.
 */

import { z } from "zod"

import { defineOperation, OperationEffect } from "#operation"
import { flag, text } from "#operations/inputs"
import { publishWorkspace, releaseItWorkspaceEnvironment } from "#pack/publish-workspace"
import { assertPlanHolds } from "#release/plan"

/**
 * `release.publish-workspace` — writes to an external system and is reachable only through the plan → execute contract.
 * Listed in `registry.ts`; the description on the operation is what `mwops` prints.
 */
export const publishWorkspaceOperation = defineOperation({
	id: "release.publish-workspace",
	description:
		"Pack one workspace with the publish exports map injected, audit the tarball, and npm publish it. Requires --plan <file> from `release plan --json`, or --allow-unplanned for release-it's hook.",
	effect: OperationEffect.ExternalWrite,
	inputSchema: z
		.object({
			/**
			 * `./<workspace>`; defaults to the plugin's `RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE`.
			 */
			workspace: text,
			plan: text,
			"allow-unplanned": flag,
			tag: text,
			access: text,
		})
		.strict(),
	outputSchema: z.object({
		workspace: z.string(),
		outcome: z.enum(["published", "skipped-weights", "already-published", "dry-run"]),
		tarballAudit: z.string().optional(),
		planDigest: z.string().optional(),
	}),
	async run(input, context) {
		const environment = releaseItWorkspaceEnvironment()
		const workspacePath = input.workspace ?? environment.workspacePath

		if (!workspacePath) {
			throw new Error("publish-workspace: --workspace ./<path> or RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE is required")
		}

		let planDigest: string | undefined

		if (input.plan) {
			planDigest = (await assertPlanHolds(context.repoRoot, input.plan)).planDigest
			context.log(`publish-workspace: plan ${planDigest} holds for ${workspacePath}`)
		} else if (input["allow-unplanned"]) {
			context.log(
				`publish-workspace: WARNING — publishing ${workspacePath} WITHOUT a release plan (--allow-unplanned). ` +
					"HEAD, version and artifact set are unverified against a sealed plan; this path exists for release-it's per-workspace hook only."
			)
		} else {
			throw new Error(
				"publish-workspace: refusing to publish without a plan. Pass --plan <file> written by `mwops release plan --json`, or --allow-unplanned to publish from release-it's hook."
			)
		}

		const report = await publishWorkspace({
			repoRoot: context.repoRoot,
			workspacePath,
			tag: input.tag ?? environment.tag,
			access: input.access ?? environment.access,
			otp: environment.otp,
			dryRun: context.dryRun || environment.dryRun,
			log: context.log,
		})

		return { ...report, ...(planDigest ? { planDigest } : {}) }
	},
})
