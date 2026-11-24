// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { Countries, Country } from "@site/src/components/CountryCodes/CountryCodes"
import InteractiveTable from "@site/src/components/InteractiveTable/InteractiveTable"
import MDXComponents from "@theme-original/MDXComponents"

/**
 * The default MDX components plus the country-code abbreviations, available on every page without an import.
 *
 * Every markdown table renders through `InteractiveTable`, which adds sorting and a filter to a long table.
 */
export default {
	...MDXComponents,
	table: InteractiveTable,
	Country,
	Countries,
}
