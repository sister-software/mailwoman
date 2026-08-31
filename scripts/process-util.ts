/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Small shared process wrappers for the repository scripts.
 */

import { runFileSync, type RunFileSyncOptions } from "@mailwoman/core/process"
import type { PathBuilderLike } from "path-ts"

/**
 * Run a command with stdin ignored and both output streams captured, answering stdout — the shape every pack / install
 * / inspect step in the release scripts wants. Throws the builtin's error (which carries stdout and stderr) on a
 * non-zero exit.
 */
export function runCaptured(
	file: PathBuilderLike,
	args: readonly PathBuilderLike[],
	cwd: PathBuilderLike,
	options: Pick<RunFileSyncOptions, "maxBuffer"> = {}
): string {
	return runFileSync(file, args, {
		...options,
		cwd: cwd.toString(),
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
	})
}
