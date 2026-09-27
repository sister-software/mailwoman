/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `build_cmd` a script-driven layer build stamps into its manifest, derived from the module
 *   that is running rather than written as a literal. A literal outlives a rename inside every
 *   artifact built before it, where no lint can reach it, and `mailwoman data inventory` then reports
 *   an artifact that cannot be rebuilt from what it says.
 */

import { relative } from "path-ts"

import { fileURLToPath } from "#module/file-url"
import { repoRootPath } from "#paths"

/**
 * The command that reruns the calling script, as a repository-relative `node` invocation.
 *
 * The path is the one the running process loaded, so a source run records `lib/…/x.ts`
 * and a compiled run records `out/…/x.js`.
 * Both resolve under the repository root.
 *
 * @param moduleURL The calling script's `import.meta.url`.
 */
export function scriptBuildCommand(moduleURL: string): string {
	return `node ${relative(repoRootPath(), fileURLToPath(moduleURL))}`
}
