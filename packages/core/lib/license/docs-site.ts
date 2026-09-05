/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where the docs site lives, for every URL the license posture points at: the well-known key register and the
 *   `/license` page. One derivation, so a configured `MAILWOMAN_DOCS_URL` moves both together.
 */

import { $public } from "#env"

/**
 * The docs site when `MAILWOMAN_DOCS_URL` is unset.
 */
export const DEFAULT_DOCS_URL = "https://mailwoman.ai"

/**
 * An origin with its trailing slashes removed, so a path can be appended by concatenation. A loop rather than
 * `/\/+$/u`: the input is configuration, and a regex anchored after a repeated class backtracks in time quadratic in
 * the run of slashes it is handed.
 */
export function withoutTrailingSlashes(url: string): string {
	let end = url.length

	while (end > 0 && url[end - 1] === "/") {
		end -= 1
	}

	return url.slice(0, end)
}

/**
 * The docs site's base URL with no trailing slash.
 */
export function docsSiteURL(override: string | undefined = $public.MAILWOMAN_DOCS_URL): string {
	return withoutTrailingSlashes(override ?? DEFAULT_DOCS_URL)
}
