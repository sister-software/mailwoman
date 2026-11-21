// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Where the text of a license identifier can be read.
 *
 *   An SPDX identifier's text is at SPDX's license list, under the identifier itself.
 *   A `LicenseRef-` this repository defines has no SPDX page, so the URL of the text it
 *   refers to is recorded beside it here, and an identifier without one has no URL.
 */

import { summarizeLicense } from "#license/obligations"
import { licensePageURL } from "#license/stamp"

/**
 * The text each `LicenseRef-` refers to, for the identifiers whose text is published.
 *
 * `LicenseRef-WhosOnFirst-Mixed` points to Who's On First's own license text.
 * That text requires a link back to itself.
 */
const LICENSE_REF_TEXT_URLS: ReadonlyMap<string, () => string> = new Map([
	["LicenseRef-WhosOnFirst-Mixed", () => "https://github.com/whosonfirst-data/whosonfirst-data/blob/master/LICENSE.md"],
	// A US Government work has no copyright under 17 U.S.C. § 105, so its text is that section,
	// as the U.S. Copyright Office publishes Title 17.
	["LicenseRef-USGov-Public-Domain", () => "https://www.copyright.gov/title17/92chap1.html#105"],
	// The license page lives on the docs site.
	// A deployment may configure the site's base URL.
	["LicenseRef-Commercial", () => licensePageURL()],
])

/**
 * The URL of the text of one license identifier, or null when none is recorded.
 *
 * An identifier the obligations table recognizes and that isn't a `LicenseRef-` is an
 * SPDX identifier, and its text is `https://spdx.org/licenses/<identifier>.html`.
 * An unrecognized identifier, such as `NOASSERTION` or a misspelling, has no URL.
 */
export function licenseTextURL(identifier: string): string | null {
	const ref = LICENSE_REF_TEXT_URLS.get(identifier)

	if (ref) return ref()

	if (identifier.startsWith("LicenseRef-") || !summarizeLicense(identifier).recognized) return null

	return `https://spdx.org/licenses/${encodeURIComponent(identifier)}.html`
}
