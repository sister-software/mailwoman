/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The result of one named check, produced by tooling and rendered by the command line.
 */

/**
 * One check-list entry.
 */
export interface Check {
	ok: boolean
	check: string
	detail?: string
}
