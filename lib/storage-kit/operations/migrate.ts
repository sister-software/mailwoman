/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `storage.migrate` — move one data-root directory to another volume and leave a symbolic link at its path.
 *
 *   Every step checks the previous one before the next starts, and the original is deleted last, after a checksum
 *   comparison of every file and a read through the new link.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { isDirectory, isSymbolicLink, pathExists } from "@mailwoman/core/fs/readers/stat"
import { createSymbolicLink, movePath } from "@mailwoman/core/fs/writers"
import { relative, resolvePath } from "path-ts"
import { z } from "zod"

import { runHostCommand } from "#storage-kit/command"
import { defineOperation, StorageEffect } from "#storage-kit/operation"

/**
 * The suffix the original takes between the link replacing it and its deletion.
 */
const MIGRATED_SUFFIX = ".migrated"

/**
 * The `rsync` flags that keep a tree as it is: permissions, times, owners and links,
 * hard links, ACLs and extended attributes.
 */
const PRESERVE_TREE = ["--archive", "--hard-links", "--acls", "--xattrs"]

const migrateInput = z
	.object({
		source: z.string().min(1),
		to: z.string().min(1),
		keep: z.boolean().default(false),
	})
	.strict()

const migrateOutput = z.object({
	source: z.string(),
	destination: z.string(),
	steps: z.array(z.string()),
	kept: z.string().nullable(),
})

/**
 * The mount point that holds `path`, as the kernel reports it.
 *
 * A systemd automount stacks its `autofs` mount under the filesystem it mounts, and `findmnt`
 * prints one line per stacked mount, so the last line holds the mount the path resolves through.
 */
async function mountTarget(path: string): Promise<string | null> {
	const probe = await runHostCommand("findmnt", ["--noheadings", "--output", "TARGET", "--target", path])

	if (probe.exitCode !== 0) return null

	return /([^\n]+)\s*$/u.exec(probe.stdout)?.[1]?.trim() ?? null
}

/**
 * Runs `rsync` and throws with its stderr when it exits non-zero.
 */
async function rsync(args: readonly string[], step: string): Promise<string> {
	const result = await runHostCommand("rsync", args)

	if (result.exitCode !== 0) {
		throw new Error(`${step}: rsync exited ${result.exitCode}: ${result.stderr.trim()}`)
	}

	return result.stdout
}

/**
 * Throws unless an itemized `rsync` dry run listed no difference.
 */
function assertNoDifferences(itemized: string, step: string): void {
	const lines = itemized.match(/^.*\S.*$/gmu)

	if (lines) {
		throw new Error(`${step}: ${lines.length} entries differ, first: ${lines[0]}`)
	}
}

/**
 * `storage.migrate` — copy a data-root directory to another volume, verify it, and link it into place.
 */
export const migrateOperation = defineOperation({
	id: "storage.migrate",
	description:
		"Move one data-root directory to another mounted volume, verify every file's checksum, and leave a symbolic link at its path.",
	effect: StorageEffect.DataWrite,
	options: {
		source: { type: "string" },
		to: { type: "string" },
		keep: { type: "boolean" },
	},
	inputSchema: migrateInput,
	outputSchema: migrateOutput,
	async run(input, context) {
		const source = resolvePath(input.source).toString()
		const root = dataRootPath().toString()
		const within = relative(root, source)

		if (!within || within.startsWith("..")) {
			throw new Error(`${source} is outside the data root ${root}`)
		}

		if (await isSymbolicLink(source)) throw new Error(`${source} is already a symbolic link`)

		if (!(await isDirectory(source))) throw new Error(`${source} is not a directory`)

		const volume = resolvePath(input.to).toString()

		if ((await mountTarget(volume)) !== volume) throw new Error(`${volume} is not a mount point`)

		if ((await mountTarget(source)) === volume) throw new Error(`${source} is already on ${volume}`)

		const destination = resolvePath(volume, within).toString()
		const aside = `${source}${MIGRATED_SUFFIX}`

		if (await pathExists(aside))
			throw new Error(`${aside} exists from an earlier migration; remove or restore it first`)

		const steps: string[] = []

		const step = (line: string) => {
			steps.push(line)
			context.log(line)
		}

		if (context.dryRun) {
			step(`would copy ${source}/ to ${destination}/, compare checksums, link ${source} -> ${destination}`)

			return { source, destination, steps, kept: null }
		}

		await rsync([...PRESERVE_TREE, "--partial", "--mkpath", `${source}/`, `${destination}/`], "copy")
		step(`copied ${source}/ to ${destination}/`)

		assertNoDifferences(
			await rsync(
				[...PRESERVE_TREE, "--checksum", "--dry-run", "--itemize-changes", `${source}/`, `${destination}/`],
				"checksum"
			),
			"checksum"
		)

		step("every file's checksum matches")

		await movePath(source, aside)
		await createSymbolicLink(destination, source, "dir")
		step(`linked ${source} -> ${destination}; original at ${aside}`)

		// A metadata dry run through the link compares every name, size and modification
		// time without reading contents again.
		assertNoDifferences(
			await rsync([...PRESERVE_TREE, "--dry-run", "--itemize-changes", `${source}/`, `${aside}/`], "read through link"),
			"read through link"
		)

		step("the link lists the same entries as the original")

		if (input.keep) {
			step(`kept ${aside}`)

			return { source, destination, steps, kept: aside }
		}

		// The host's `rm` removes a tree of millions of files outside the Node heap.
		// Node's recursive `rm` grows the heap with the tree and runs out of memory on the WOF clones.
		const removal = await runHostCommand("rm", ["-r", "--one-file-system", "--", aside])

		if (removal.exitCode !== 0) throw new Error(`remove: rm exited ${removal.exitCode}: ${removal.stderr.trim()}`)

		step(`removed ${aside}`)

		return { source, destination, steps, kept: null }
	},
	formatOutput(output) {
		return [`${output.source} -> ${output.destination}`, ...output.steps.map((line) => `  ${line}`)].join("\n")
	},
})
