#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwops` binary: argv in, exit code out. Everything else is `dispatch.ts`, so the routing is testable without a
 *   process.
 *
 *   The checkout-locality guard runs before anything else loads. A worktree without its own install resolves
 *   `@mailwoman/*` from the checkout above it, and every operation here reads or writes through
 *   `repoRootPath`. The guard is the one static import beyond the command runner, so a worktree whose
 *   tool graph wouldn't load against the other checkout's packages still reaches it.
 *
 *   Elevation lives at the entry point. `storage prepare` writes a partition table and `/etc/fstab`, so
 *   it needs root — and acquiring root means re-exec'ing. Re-exec replaces the process.
 *   Re-execution belongs at an entry point. A capability deep in a call graph shouldn't manage it.
 *   The wrapper resolves the privilege once and elevates if the requested operation declares a host write.
 *   It hands dispatch a plain boolean.
 */

import { assertCheckoutLocality } from "@mailwoman/core/module/checkout-locality"
import { runCLICommand } from "@mailwoman/core/scripting/command"

process.exitCode =
	(await runCLICommand(async () => {
		await assertCheckoutLocality(import.meta.dirname)

		const [{ trackedFiles }, { repoRootPath }, { cliArguments }, { dispatch }, storage, sudo] = await Promise.all([
			import("@mailwoman/core/git"),
			import("@mailwoman/core/paths"),
			import("@mailwoman/core/scripting/arguments"),
			import("#ops-cli/dispatch"),
			import("#storage-kit"),
			import("#storage-kit/sudo"),
		])

		const repoRoot = repoRootPath()
		const args = [...cliArguments()]

		// Acquire root before dispatching, when the requested operation declares a host write.
		// `--dry-run` describes the work without doing it, so it stays unprivileged.
		const argv: readonly string[] = args
		const [verb, name] = argv

		if (
			verb === "storage" &&
			name &&
			!argv.includes("--dry-run") &&
			storage.findStorageOperation(name)?.effect === storage.StorageEffect.HostWrite
		) {
			await sudo.ensureRoot()
		}

		return dispatch(args, {
			stdout: (text) => process.stdout.write(text),
			stderr: (text) => process.stderr.write(text),
			repoRoot,
			trackedFiles: () => trackedFiles(repoRoot),
			root: sudo.isRoot(),
		})
	})) ?? 0
