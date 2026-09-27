/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The one place a `RepoContext` is collected from a live checkout. Adapters and tests call this rather than spawning
 *   `git ls-files` themselves, so every check reads the same file set.
 */

import { trackedFiles } from "@mailwoman/core/git"
import { repoRootPath } from "@mailwoman/core/paths"
import type { PathBuilderLike } from "path-ts"

import type { RepoContext } from "#check"

/**
 * A `RepoContext` for the checkout at `repoRoot` (default: the repository this module sits in).
 *
 * The file listing is `trackedFiles` from `@mailwoman/core/git` directly.
 * A wrapper here that returned that call unchanged would be a second public name
 * for one function, which `export-name-affix` reports.
 */
export async function collectRepoContext(repoRoot: PathBuilderLike = repoRootPath()): Promise<RepoContext> {
	return { repoRoot: repoRoot.toString(), trackedFiles: await trackedFiles(repoRoot) }
}
