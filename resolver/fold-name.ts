/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One shared name fold, used by the resolver's commune reconciliation and by the street tier's
 *   locality comparison. Its own module because both would otherwise import each other for it.
 */

/**
 * Case/diacritic-insensitive fold for commune-name comparison (#1058) — mirrors span-rescore's `norm`.
 */
export function foldName(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replaceAll(/[^a-z0-9 ]/g, " ")
		.replaceAll(/\s+/g, " ")
		.trim()
}
