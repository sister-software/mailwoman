/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Runs a child process for the release and client-generation tooling.
 */

import { spawnProcessSync } from "@mailwoman/core/process"
import { CommandError } from "@mailwoman/core/scripting/command"
import { childEnv } from "@mailwoman/core/scripting/utils"
import type { PathBuilderLike } from "path-ts"

/**
 * Runs a child process with inherited stdio, throwing when it fails to launch or exits nonzero.
 */
export function runProcessOrFail(
	cmd: string,
	args: readonly string[],
	options: { cwd?: PathBuilderLike; echo?: boolean } = {}
): void {
	if (options.echo) {
		console.error(`  $ ${cmd} ${args.join(" ")}${options.cwd ? `  (in ${options.cwd})` : ""}`)
	}

	const result = spawnProcessSync(cmd, [...args], { stdio: "inherit", env: childEnv(), cwd: options.cwd })

	if (result.error) {
		throw new CommandError(`${cmd} ${args.join(" ")} → failed to launch: ${result.error.message}`, {
			cause: result.error,
		})
	}

	if (result.status !== 0) {
		throw new CommandError(`${cmd} ${args.join(" ")} → exit ${result.status}`)
	}
}
