// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { createESLintPackageConfig } from "@sister.software/eslint-config"
import html from "eslint-plugin-html"

// @ts-check

/**
 * ESLint configuration for the Mailwoman repo
 */
const MailwomanESLintConfig = createESLintPackageConfig({
	packageTitle: "Mailwoman",
	spdxLicenseIdentifier: "AGPL-3.0",

	overrides: {
		plugins: { html },
		rules: {
			"guard-for-in": "error",
			"@typescript-eslint/no-explicit-any": "error",
			"jsdoc/require-property-description": "off",
			"jsdoc/require-returns-description": "off",
			"jsdoc/require-param-description": "off",
			"jsdoc/require-yields": "off",
		},
	},
})

export default MailwomanESLintConfig
