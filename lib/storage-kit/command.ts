/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { runProcess, type ProcessResult } from "@mailwoman/core/process"

/**
 * Exit status a shell reports for a command it cannot find.
 */
const COMMAND_NOT_FOUND = 127

/**
 * Run a host command and resolve with its result whatever its exit status.
 *
 * A command that cannot start resolves with exit status 127 and the spawn error
 * as its stderr, as a shell reports it, so a probe for an optional tool such as
 * `sg_vpd` reads a failed check rather than raising.
 */
export async function runHostCommand(file: string, args: readonly string[]): Promise<ProcessResult> {
	try {
		return await runProcess(file, args, { reject: false })
	} catch (error) {
		return {
			command: [file, ...args].join(" "),
			exitCode: COMMAND_NOT_FOUND,
			signal: null,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		}
	}
}
