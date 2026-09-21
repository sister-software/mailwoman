/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Filesystem existence for the docs checks, on node builtins.
 *
 *   `@mailwoman/core/fs/readers` exports this, and the checks may not reach it: the Docs workflow runs
 *   `check/docs-structure.ts` before `yarn install`, so no workspace specifier resolves. One copy lives here rather
 *   than one per check.
 */

// repo-health-ignore private-name-shadows-export -- see the header: this module cannot reach the core export.
/* oxlint-disable typescript/no-restricted-imports -- runs before `yarn install`; see above */
import { stat } from "node:fs/promises"

/* oxlint-enable typescript/no-restricted-imports */

/**
 * Whether anything is at `target` — a file or a directory alike.
 *
 * A directory counts, because both callers treat one as a valid target: a markdown link to a
 * folder reaches its index page, and a citation naming a directory names something that exists.
 */
export async function pathExists(target: string): Promise<boolean> {
	try {
		await stat(target)

		return true
	} catch {
		return false
	}
}
