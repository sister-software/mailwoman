/**
 * @copyright Sister Software
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
			// Disabled: eslint-plugin-headers' header-format rule misbehaves when --fix runs
			// over files that already carry the expected JSDoc copyright header — it stacks
			// duplicate headers instead of recognizing the existing one (e.g. core/resources/db/
			// index.ts grew 10 nested headers before deletion). Until either the plugin is fixed
			// upstream or the shared config moves to a robust matcher, this rule is off so
			// `yarn lint:fix` is safe to run.
			"headers/header-format": "off",
		},
	},
})

export default MailwomanESLintConfig
