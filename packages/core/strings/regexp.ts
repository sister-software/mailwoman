/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Regular-expression string helpers.
 */

/**
 * `literal` escaped so that `new RegExp(escapeRegExp(literal))` matches it verbatim.
 */
export function escapeRegExp(literal: string): string {
	return literal.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
