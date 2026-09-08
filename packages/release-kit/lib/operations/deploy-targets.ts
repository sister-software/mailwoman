/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { changedFiles } from "@mailwoman/core/git"
import { z } from "zod"

import {
	affectedDeployTargets,
	allDeployTargets,
	DEPLOY_TARGET_IDS,
	type DeploySelection,
	type DeployTargetID,
} from "#deploy/targets"
import { defineOperation, OperationEffect } from "#operation"
import { list, text } from "#operations/inputs"

const deployTargetID = z.enum(DEPLOY_TARGET_IDS as [DeployTargetID, ...DeployTargetID[]])

const matrixEntry = z.object({
	id: deployTargetID,
	worker: z.string(),
	workspace: z.string(),
	cwd: z.string(),
	build: z.string(),
	body: z.string(),
	deployArgs: z.string(),
	receipt: z.string(),
	/**
	 * The reasons joined, so every matrix value is a string the workflow can print and key on.
	 */
	reasons: z.string(),
})

function toMatrix(selections: DeploySelection[]): z.infer<typeof matrixEntry>[] {
	return selections.map(({ target, reasons }) => ({ ...target, reasons: reasons.join(", ") }))
}

/**
 * The deploy workflow's first job: which Workers a push reaches. `--targets` names them outright (`all`, or a
 * comma-separated list of ids) for a hand deploy; otherwise `--base` and `--head` bound the diff.
 */
export const deployTargets = defineOperation({
	id: "release.deploy-targets",
	description:
		"The Cloudflare Workers a change reaches, as a job matrix: --base and --head bound the diff, or --targets names them (all, or a comma-separated list).",
	effect: OperationEffect.Read,
	inputSchema: z.object({ base: text, head: text, targets: list }).strict(),
	outputSchema: z.object({
		changed: z.array(z.string()),
		include: z.array(matrixEntry),
		ids: z.array(deployTargetID),
	}),
	async run(input, context) {
		if (input.targets.length) {
			const selections =
				input.targets.length === 1 && input.targets[0] === "all"
					? allDeployTargets()
					: allDeployTargets().filter(({ target }) => input.targets.includes(target.id))

			const unknown = input.targets.filter((id) => id !== "all" && !DEPLOY_TARGET_IDS.includes(id as DeployTargetID))

			if (unknown.length) {
				throw new Error(
					`deploy targets: unknown target(s) ${unknown.join(", ")}; known: ${DEPLOY_TARGET_IDS.join(", ")}`
				)
			}

			return { changed: [], include: toMatrix(selections), ids: selections.map(({ target }) => target.id) }
		}

		if (!input.base) throw new Error("deploy targets: --base <commit> is required without --targets")

		const changed = await changedFiles(context.repoRoot, input.base, input.head ?? "HEAD")
		const selections = await affectedDeployTargets(context.repoRoot, changed)

		for (const { target, reasons } of selections) {
			context.log(`${target.id}: ${reasons.join(", ")}`)
		}

		return { changed, include: toMatrix(selections), ids: selections.map(({ target }) => target.id) }
	},
})
