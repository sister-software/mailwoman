/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"

/**
 * The committed release-requirement specification that release eligibility
 * and the coverage funnel read when no other is named.
 *
 * A new specification version moves this path in the same change.
 *
 * Resolved from the package root because `tsc` does not emit `.json` specs into `out/`.
 */
export const CURRENT_RELEASE_SPEC: string = resolvePackagePath(
	"mailwoman",
	"tools",
	"eval-harness",
	"release",
	"specs",
	"release-requirements.v4.json"
)
