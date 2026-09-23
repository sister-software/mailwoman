#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwops` binary: argv in, exit code out. Everything else is `dispatch.ts`, so the routing is testable without a
 *   process.
 *
 *   Elevation lives at the entry point. `storage prepare` writes a partition table and `/etc/fstab`, so
 *   it needs root — and acquiring root means re-exec'ing, which replaces the process. That is a property of an entry
 *   point, and a capability deep in a call graph should leave it alone. The wrapper resolves the
 *   privilege once, elevates if the requested operation declares a host write, and hands dispatch a plain boolean.
 */

import { trackedFiles } from "@mailwoman/core/git"
import { repoRootPath } from "@mailwoman/core/paths"
import { cliArguments } from "@mailwoman/core/scripting/arguments"
import { runCLICommand } from "@mailwoman/core/scripting/command"
import { findStorageOperation, StorageEffect } from "@mailwoman/storage-kit"
import { ensureRoot, isRoot } from "@mailwoman/storage-kit/sudo"

import { dispatch } from "#dispatch"

const repoRoot = String(repoRootPath())
const args = [...cliArguments()]

/**
 * Acquire root before dispatching, when the requested operation declares a host write.
 *
 * `--dry-run` describes the work without doing it, so it stays unprivileged.
 */
async function elevateIfNeeded(argv: readonly string[]): Promise<void> {
	const [verb, name] = argv

	if (verb !== "storage" || !name) return

	if (argv.includes("--dry-run")) return

	const operation = findStorageOperation(name)

	if (operation?.effect === StorageEffect.HostWrite) {
		await ensureRoot()
	}
}

await elevateIfNeeded(args)

process.exitCode =
	(await runCLICommand(() =>
		dispatch(args, {
			stdout: (text) => process.stdout.write(text),
			stderr: (text) => process.stderr.write(text),
			repoRoot,
			trackedFiles: () => trackedFiles(repoRoot),
			root: isRoot(),
		})
	)) ?? 0
