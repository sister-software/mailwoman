/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `release.clean` removes whole generated trees rather than asking TypeScript to enumerate the outputs it still
 *   knows. That distinction removes orphaned files left behind after a source rename or branch switch.
 */

import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { cleanDirectory, cleanFile } from "@mailwoman/core/module/clean"
import { WorkspacePackages, type WorkspacePackage } from "@mailwoman/core/module/workspace"
import { relative, resolvePath } from "path-ts"
import { z } from "zod"

import { defineOperation, OperationEffect } from "#operation"
import { text } from "#operations/inputs"

const directoryNames = ["out", "dist"] as const
const buildMetadataNames = ["tsconfig.tsbuildinfo", "tsconfig.test.tsbuildinfo"] as const

const cleanOutput = z.object({
	dryRun: z.boolean(),
	directories: z.array(z.string()),
	files: z.array(z.string()),
})

/**
 * `release.clean` — remove generated workspace output, build metadata, and Docker's non-workspace TypeScript output. A
 * package name limits the cleanup to one registered workspace; absent means the entire checkout.
 */
export const cleanOperation = defineOperation({
	id: "release.clean",
	description:
		"Remove generated out/dist trees and TypeScript build metadata, including stale outputs unknown to the current compiler (--workspace <package> limits scope).",
	effect: OperationEffect.LocalWrite,
	inputSchema: z.object({ workspace: text }).strict(),
	outputSchema: cleanOutput,
	async run(input, context) {
		const workspaces = await WorkspacePackages.read(context.repoRoot)

		let packageNames: readonly WorkspacePackage[] = workspaces.packageNames

		if (input.workspace) {
			if (!workspaces.validate(input.workspace)) {
				throw new Error(`Unknown workspace package: ${input.workspace}`)
			}

			packageNames = [input.workspace]
		}

		const directoryTargets = packageNames.flatMap((packageName) =>
			directoryNames.map((directoryName) => workspaces.packagePathBuilder(packageName, directoryName).toString())
		)

		const fileTargets = packageNames.flatMap((packageName) =>
			buildMetadataNames.map((fileName) => workspaces.packagePathBuilder(packageName, fileName).toString())
		)

		// `docker` is a root TypeScript project but deliberately not a Yarn workspace: its manifest consumes published npm
		// packages. Preserve the coverage of the former `tsc -b --clean` root script when cleaning the entire checkout.
		if (!input.workspace) {
			directoryTargets.push(resolvePath(context.repoRoot, "docker", "out"))
			directoryTargets.push(resolvePath(context.repoRoot, "docker", "dist"))
			fileTargets.push(resolvePath(context.repoRoot, "docker", "tsconfig.tsbuildinfo"))
			fileTargets.push(resolvePath(context.repoRoot, "docker", "tsconfig.test.tsbuildinfo"))
		}

		const allowedRoots = [...directoryTargets, ...fileTargets]
		const directories: string[] = []
		const files: string[] = []

		for (const target of directoryTargets) {
			const stats = await tryStat(target)

			if (!stats) continue

			const displayPath = relative(context.repoRoot, target)

			context.log(`${context.dryRun ? "Would clean" : "Cleaning"} ${displayPath}`)
			await cleanDirectory(target, { allowedRoots, dryRun: context.dryRun, cachedStats: stats })
			directories.push(displayPath)
		}

		for (const target of fileTargets) {
			const stats = await tryStat(target)

			if (!stats) continue

			const displayPath = relative(context.repoRoot, target)

			context.log(`${context.dryRun ? "Would remove" : "Removing"} ${displayPath}`)
			await cleanFile(target, { allowedRoots, dryRun: context.dryRun, cachedStats: stats })
			files.push(displayPath)
		}

		return { dryRun: context.dryRun, directories, files }
	},
	formatOutput(output) {
		const verb = output.dryRun ? "Would clean" : "Cleaned"
		const directoryNoun = output.directories.length === 1 ? "directory" : "directories"
		const fileNoun = output.files.length === 1 ? "build metadata file" : "build metadata files"

		return `${verb} ${output.directories.length} ${directoryNoun}; ${output.files.length} ${fileNoun}.`
	},
})
