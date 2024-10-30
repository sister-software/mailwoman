/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createESLintPackageConfig } from "@sister.software/eslint-config"
import html from "eslint-plugin-html"

// @ts-check

/**
 * ESLint configuration for the Mailwoman repo
 */
const MailwomanESLintConfig = createESLintPackageConfig({
	copyrightHolder: "Teffen Ellis",
	packageTitle: "Mailwoman",
	spdxLicenseIdentifier: "AGPL-3.0",

	overrides: {
		plugins: { html },
		rules: {
			"@typescript-eslint/no-require-imports": "off",
			"no-prototype-builtins": "off",
			"jsdoc/require-property-description": "off",
			"jsdoc/require-returns-description": "off",
			"jsdoc/require-param-description": "off",
		},
	},
})

export default MailwomanESLintConfig
