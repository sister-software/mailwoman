/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One shared name fold for the resolver's commune reconciliation, the street tier's locality
 *   comparison and span-rescore's key guards; its own module because those would otherwise import
 *   each other for it.
 */

/**
 * Case/diacritic-insensitive fold for commune-name comparison: marks are deleted, never spaced, so
 * `Besançon` does not key as `besanc on`; a letter with no decomposition is dropped rather than
 * folded.
 */
export function foldName(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replaceAll(/\p{M}/gu, "")
		.replaceAll(/[^a-z0-9 ]/g, " ")
		.replaceAll(/\s+/g, " ")
		.trim()
}
