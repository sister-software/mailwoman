/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "zod"

import { defineOperation, OperationEffect } from "#operation"
import { flag } from "#operations/inputs"
import { prepareReleaseVersion } from "#release/prepare-version"

/**
 * `release.prepare-version` — writes inside the checkout or the data root. Listed in `registry.ts`; the description on
 * the operation is what `mwops` prints.
 */
export const prepareVersion = defineOperation({
	id: "release.prepare-version",
	description:
		"Write the target version (patch|minor|major|x.y.z) into the root package.json, every release workspace, and release.config.json. No git, no npm. --check-only resolves and validates without writing.",
	effect: OperationEffect.LocalWrite,
	inputSchema: z
		.object({
			version: z.string({ error: "--version is required (patch | minor | major | x.y.z)" }),
			"check-only": flag,
		})
		.strict(),
	outputSchema: z.object({
		currentVersion: z.string(),
		resolvedVersion: z.string(),
		filesWritten: z.number(),
	}),
	run: (input, context) =>
		prepareReleaseVersion({
			repoRoot: context.repoRoot,
			version: input.version,
			checkOnly: input["check-only"] || context.dryRun,
			log: context.log,
		}),
})
