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

import type { RepoContext } from "#check"

/**
 * A `RepoContext` for the checkout at `repoRoot` (default: the repository this module sits in).
 *
 * The file listing is `trackedFiles` from `@mailwoman/core/git` directly. A `listTrackedFiles` wrapper stood here and
 * returned that call unchanged, which is a second public name for one function and exactly what `export-name-affix`
 * reports.
 */
export async function collectRepoContext(repoRoot = String(repoRootPath())): Promise<RepoContext> {
	return { repoRoot, trackedFiles: await trackedFiles(repoRoot) }
}
