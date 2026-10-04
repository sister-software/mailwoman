/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { realPath } from "@mailwoman/core/fs/readers/stat"
import { spawnProcessSync } from "@mailwoman/core/process"

/**
 * Whether the current process holds root.
 */
export function isRoot(): boolean {
	return process.getuid?.() === 0
}

/**
 * If not already root, re-exec this entry point under `sudo` and exit with the child's status, resolving
 * symlinks so the argv path matches the absolute one pinned in `/etc/sudoers.d/mailwoman-storage`.
 */
export async function ensureRoot(): Promise<void> {
	if (isRoot()) return

	// oxlint-disable-next-line sister-software/no-process-globals -- re-exec needs this entry point's own argv.
	const [execPath, scriptPath, ...rest] = process.argv

	if (!execPath || !scriptPath) {
		throw new Error("ensureRoot: process.argv is missing the node or script path")
	}

	const result = spawnProcessSync(
		"sudo",
		// oxlint-disable-next-line sister-software/no-process-globals -- the child re-runs this exact interpreter.
		[execPath, ...process.execArgv, await realPath(scriptPath), ...rest],
		{
			stdio: "inherit",
			// oxlint-disable-next-line sister-software/no-process-globals -- the elevated child inherits the operator's environment.
			env: process.env,
		}
	)

	process.exit(result.status ?? 1)
}
