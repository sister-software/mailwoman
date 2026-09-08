/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where the docs site lives, for every URL the license posture points at: the well-known key register and the
 *   `/license` page. One derivation, so a configured `MAILWOMAN_DOCS_URL` moves both together.
 */

import { $public } from "#env"
import { withoutTrailingSlashes } from "#strings/format"

/**
 * The docs site when `MAILWOMAN_DOCS_URL` is unset.
 */
export const DEFAULT_DOCS_URL = "https://mailwoman.ai"

/**
 * The docs site's base URL with no trailing slash.
 */
export function docsSiteURL(override: string | undefined = $public.MAILWOMAN_DOCS_URL): string {
	return withoutTrailingSlashes(override ?? DEFAULT_DOCS_URL)
}
