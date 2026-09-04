/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { resolvePath } from "path-ts"
import { z } from "zod"

import { defineOperation, OperationEffect } from "#operation"
import { flag, text } from "#operations/inputs"
import { releasePreflight, WEIGHTS_SOURCES, type WeightsSource } from "#release/preflight"

/**
 * `release.preflight` — writes inside the checkout or the data root. Listed in `registry.ts`; the description on the
 * operation is what `mwops` prints.
 */
export const preflight = defineOperation({
	id: "release.preflight",
	description:
		"Stage the tracked tree in an isolated root, materialize the weights there (--source repo|hf), then pack and audit every release workspace. No git, npm, R2 or Hugging Face writes.",
	effect: OperationEffect.LocalWrite,
	inputSchema: z
		.object({
			source: z.enum(WEIGHTS_SOURCES).default("repo"),
			version: text,
			staging: text,
			keep: flag,
		})
		.strict(),
	outputSchema: z.object({
		source: z.enum(WEIGHTS_SOURCES),
		stagingRoot: z.string(),
		publishCount: z.number(),
		releaseListProblems: z.array(z.string()),
		audited: z.number(),
		failed: z.array(z.string()),
		elapsedSeconds: z.number(),
		verdict: z.enum(["PASS", "FAIL"]),
	}),
	async run(input, context) {
		const source: WeightsSource = input.source

		const report = await releasePreflight({
			repoRoot: context.repoRoot,
			source,
			...(input.version ? { version: input.version } : {}),
			// Absolute, because the pack runs with each staged workspace as its cwd and would otherwise write the
			// tarball relative to THAT directory while the audit looks relative to this one.
			...(input.staging ? { staging: String(resolvePath(context.repoRoot, input.staging)) } : {}),
			keep: input.keep,
			log: context.log,
		})

		if (report.verdict === "FAIL") {
			throw new Error(
				`release preflight FAILED (--source ${report.source}): ${report.failed.length} of ${report.audited} workspaces did not pack to a tarball honoring their manifest` +
					(report.releaseListProblems.length ? `, ${report.releaseListProblems.length} release-list problem(s)` : "")
			)
		}

		return report
	},
})
