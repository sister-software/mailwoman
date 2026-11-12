// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import useDocusaurusContext from "@docusaurus/useDocusaurusContext"

export interface DocusaurusConfigCustomFields {
	buildCommit: string
	buildTime: string
	buildTimeDisplay: string
}

/**
 * Type-safe variant of {@linkcode useDocusaurusContext}.
 */
export function useSiteConfig() {
	const docusaurusContext = useDocusaurusContext()

	const {
		customFields,
		// Consistent casing across the codebase, even though Docusaurus calls it `baseUrl` in the type.
		baseUrl: baseURL,
		...siteConfig
	} = docusaurusContext.siteConfig

	const {
		buildCommit = "?",
		buildTime = "?",
		buildTimeDisplay = "?",
	} = customFields as Partial<DocusaurusConfigCustomFields>

	return {
		...siteConfig,
		baseURL,
		title: siteConfig.title,
		buildCommit,
		buildTimeDisplay,
		buildTime,
	}
}
