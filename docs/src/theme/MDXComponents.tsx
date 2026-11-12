// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { Countries, Country } from "@site/src/components/CountryCodes/CountryCodes"
import MDXComponents from "@theme-original/MDXComponents"

/**
 * The default MDX components plus the country-code abbreviations, available on every page without an import.
 */
export default {
	...MDXComponents,
	Country,
	Countries,
}
