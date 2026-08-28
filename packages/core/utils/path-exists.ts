/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Does a path exist — the predicate every cached acquisition asks before it transfers anything.
 *
 *   `stat`-AND-SWALLOW RATHER THAN `existsSync`, because the callers are async and a synchronous probe on a
 *   cache root holding hundreds of vintages blocks the loop for no gain. The rejection is swallowed WHOLE:
 *   a permission error and a missing file both answer `false`, which is what a caller deciding whether to
 *   re-download wants — it will create or overwrite either way, and a thrown `EACCES` there reads as a
 *   transfer failure rather than as a cache miss.
 */

import { stat } from "node:fs/promises"

/**
 * Whether `path` names something on disk.
 *
 * @returns `true` when `stat` resolves, `false` for every rejection — a missing file and an unreadable one are the same
 *   answer to the question "must I fetch this?".
 */
export async function pathExists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false
	)
}
