/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Whether a GeoNames fold output predates the admin database it was folded from.
 *
 *   A fold output (`<admin>-geonames.db`) is a copy of the admin database with the alias fold applied, and a candidate
 *   table built from it inherits every coordinate the copy carried. A later admin rebuild leaves the standing fold
 *   holding the old points, and a build that reads the fold directly reproduces them, silently, because the fold is a
 *   valid admin database. The staleness is a fact of two mtimes, so this module refuses it rather than leaving it to a
 *   board compare.
 */

import type { PathBuilderLike } from "path-ts"

/**
 * The admin database a fold output was made from, by name: `<x>-geonames.db`
 * or `<x>-geonames-<stamp>.db` → `<x>.db`.
 *
 * Null when the path does not look like a fold output.
 */
export function foldSourceAdminPath(foldPath: PathBuilderLike): string | null {
	const match = /^(.*)-geonames(?:-[^/]*)?\.db$/u.exec(foldPath.toString())

	return match ? `${match[1]}.db` : null
}

export interface FoldStaleness {
	foldPath: string
	adminPath: string
	foldModified: Date
	adminModified: Date
}

/**
 * The staleness verdict for a fold output: the admin database it derives from
 * was modified after the fold was written.
 *
 * Null when the fold is at least as new as its source, or when `adminModified` is absent (no source found).
 */
export function foldStaleness(
	foldPath: PathBuilderLike,
	adminPath: PathBuilderLike,
	foldModified: Date,
	adminModified: Date | null
): FoldStaleness | null {
	if (!adminModified || adminModified.getTime() <= foldModified.getTime()) return null

	return { foldPath: foldPath.toString(), adminPath: adminPath.toString(), foldModified, adminModified }
}

/**
 * The refusal a build prints for a stale fold: both timestamps and the action,
 * since the fix is a flag on the same command.
 */
export function foldStalenessMessage(staleness: FoldStaleness): string {
	return (
		`gazetteer build candidate: ${staleness.foldPath} was folded ${staleness.foldModified.toISOString()}, before its ` +
		`admin database ${staleness.adminPath} was last modified (${staleness.adminModified.toISOString()}). A candidate ` +
		"table built from it carries the admin database's OLD coordinates. Re-fold from the admin database (`--fold`, with " +
		"`--admin` naming the admin database and `--fold-out` the fresh fold), or pass `--allow-stale-fold` to build from " +
		"this copy on purpose."
	)
}
