/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `release.clean` removes whole generated trees rather than asking TypeScript to enumerate the outputs it still
 *   knows. That distinction removes orphaned files left behind after a source rename or branch switch.
 *
 *   A retired workspace is the case the registered list cannot reach. Removing a workspace takes its manifest and its
 *   source, and leaves the `out/` tree and `tsconfig.tsbuildinfo` that `tsc` had already written beside them. Those
 *   sit under a directory `packages/*` still matches, so `sherif` reports it and nothing cleans it. A full clean now
 *   sweeps those directories too, and the sweep removes only generated names and then the directory itself, once
 *   nothing else is left in it.
 */

import { tryStat } from "@mailwoman/core/fs/readers/stat"
import { removeDirectory } from "@mailwoman/core/fs/writers"
import { assertDirectoryIsUntracked, cleanDirectory, cleanFile } from "@mailwoman/core/module/clean"
import { WorkspacePackages, type WorkspacePackage } from "@mailwoman/core/module/workspace"
import { retiredWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { relative, resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"
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
 * `release.clean` — remove generated workspace output, build metadata,
 * and Docker's non-workspace TypeScript output.
 *
 * A package name limits the cleanup to one registered workspace.
 * Absent means the entire checkout.
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

		// `docker` is a root TypeScript project but deliberately not a Yarn workspace:
		// its manifest consumes published npm packages.
		// Preserve the coverage of the former `tsc -b --clean` root script when cleaning the entire checkout.
		if (!input.workspace) {
			directoryTargets.push(resolvePath(context.repoRoot, "docker", "out"))
			directoryTargets.push(resolvePath(context.repoRoot, "docker", "dist"))
			fileTargets.push(resolvePath(context.repoRoot, "docker", "tsconfig.tsbuildinfo"))
			fileTargets.push(resolvePath(context.repoRoot, "docker", "tsconfig.test.tsbuildinfo"))
		}

		// A retired workspace is swept separately from the registered ones,
		// because `cleanDirectory` recreates what it empties.
		// That is right for a workspace whose `out/` is about to be written again,
		// and it would leave exactly the empty shell this sweep exists to remove.
		const retired = input.workspace ? [] : await retiredWorkspaceDirectories(context.repoRoot)
		const retiredRoots = retired.map((directory) => resolvePath(context.repoRoot, directory).toString())

		const allowedRoots = [...directoryTargets, ...fileTargets, ...retiredRoots]
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

		for (const root of retiredRoots) {
			for (const directoryName of directoryNames) {
				const target = resolvePath(root, directoryName)
				const stats = await tryStat(target)

				if (!stats) continue

				assertDirectoryIsUntracked(target, allowedRoots)

				const displayPath = relative(context.repoRoot, target)

				context.log(`${context.dryRun ? "Would clean" : "Cleaning"} ${displayPath}`)

				if (!context.dryRun) {
					await removeDirectory(target, stats)
				}

				directories.push(displayPath)
			}

			for (const fileName of buildMetadataNames) {
				const target = resolvePath(root, fileName)
				const stats = await tryStat(target)

				if (!stats) continue

				const displayPath = relative(context.repoRoot, target)

				context.log(`${context.dryRun ? "Would remove" : "Removing"} ${displayPath}`)
				await cleanFile(target, { allowedRoots, dryRun: context.dryRun, cachedStats: stats })
				files.push(displayPath)
			}

			// The shell goes only when the generated names were all it held.
			// A dry run has removed nothing, so the reading discounts the names it would have taken.
			const generated = new Set<string>([...directoryNames, ...buildMetadataNames])

			const remaining = (
				await Globerator.from("*", { cwd: root, withFileTypes: true, onlyFiles: false }).toArray()
			).filter((dirent) => !(context.dryRun && generated.has(dirent.name)))

			if (remaining.length) continue

			assertDirectoryIsUntracked(root, allowedRoots)

			const displayPath = relative(context.repoRoot, root)

			context.log(`${context.dryRun ? "Would remove" : "Removing"} ${displayPath}`)

			if (!context.dryRun) {
				await removeDirectory(root)
			}

			directories.push(displayPath)
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
