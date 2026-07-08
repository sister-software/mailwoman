#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Download + alphabetize libpostal's `resources/dictionaries` — the per-language abbreviation,
 *   street-type, and synonym tables the normalizer expands against. Shallow-clones
 *   {@link https://github.com/openvenues/libpostal openvenues/libpostal}, sorts each dictionary file
 *   in place, and copies the `dictionaries/` tree next to this script.
 *
 *   Replaces the bash `resources-download.sh`. `git clone` runs through zx's `$` (no clean native
 *   equivalent); everything else is `node:fs` / `node:os`. Sorting is done in-process with a plain
 *   code-point `Array.sort()`, which matches `LC_ALL=C sort` byte order — deterministic and free of
 *   the shell `sort`'s locale dependency (the original relied on the ambient locale).
 *
 *   ## Usage
 *
 *   ```sh
 *   node core/data/libpostal/resources-download.ts
 *   node core/data/libpostal/resources-download.ts --force   # overwrite an existing ./dictionaries
 *   ```
 *
 *   ## Flags
 *
 *   - `--force` — delete an existing `./dictionaries` directory instead of erroring out
 */

///<reference types="node" />

import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { resourceDictionaryPathBuilder, runIfScript } from "@mailwoman/core/utils"
import { $ } from "zx"

const REPO_URL = "https://github.com/openvenues/libpostal.git"
const DICTIONARIES_DIR = String(resourceDictionaryPathBuilder("libpostal"))

function parseCLIArgs() {
	const { values } = parseArgs({
		options: {
			force: { type: "boolean", default: false },
		},
	})

	return { force: values.force! }
}

/** Whether a path exists and is a directory. */
async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory()
	} catch {
		return false
	}
}

/**
 * Sort a single dictionary file in place by code point (matching `LC_ALL=C sort`). Blank lines sort to the top, exactly
 * as `sort` orders empty strings; a trailing newline is preserved.
 */
async function sortFileInPlace(path: string): Promise<void> {
	const text = await readFile(path, "utf8")
	const hadTrailingNewline = text.endsWith("\n")
	const lines = text.split("\n")

	// Drop the empty element produced by a trailing newline so it isn't re-sorted as a blank line.
	if (hadTrailingNewline) {
		lines.pop()
	}
	lines.sort()
	await writeFile(path, lines.join("\n") + (hadTrailingNewline ? "\n" : ""))
}

async function main(): Promise<void> {
	const { force } = parseCLIArgs()

	// Guard the destination exactly as the bash version did: refuse to clobber unless --force.
	if (await isDirectory(DICTIONARIES_DIR)) {
		if (force) {
			process.stderr.write("Warning: The dictionaries directory already exists. Deleting it due to --force flag.\n")
			await rm(DICTIONARIES_DIR, { recursive: true, force: true })
		} else {
			process.stderr.write(
				"Error: The dictionaries directory already exists. Please remove it first or use the --force flag.\n"
			)
			process.exitCode = 1

			return
		}
	}

	const tempDir = await mkdtemp(join(tmpdir(), "libpostal-"))

	try {
		const cloneDir = join(tempDir, "libpostal")
		await $`git clone --depth 1 ${REPO_URL} ${cloneDir}`

		const sourceDicts = join(cloneDir, "resources", "dictionaries")

		// Alphabetize the contents of each dictionary file in place.
		for (const entry of await readdir(sourceDicts, { withFileTypes: true })) {
			if (entry.isFile()) {
				await sortFileInPlace(join(sourceDicts, entry.name))
			}
		}

		// Copy the (now-sorted) dictionaries tree next to this script.
		await cp(sourceDicts, DICTIONARIES_DIR, { recursive: true })
	} finally {
		await rm(tempDir, { recursive: true, force: true })
	}
}

runIfScript(import.meta, main)
