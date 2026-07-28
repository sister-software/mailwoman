/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file oxlint configuration for the Mailwoman monorepo.
 */

import { createOxlintConfig, DefaultIgnorePatterns } from "@sister.software/oxlint-config"

const config = createOxlintConfig({
	spdxLicenseIdentifier: "AGPL-3.0",
	// Mailwoman ships React (ink) UIs, so keep the React rules the prior shared config applied.
	react: true,
	// Headers were disabled previously because the old eslint-plugin-headers stacked duplicate
	// headers on --fix. That bug is fixed in the new oxlint header plugin, so headers can be safely
	// re-enabled — set `headers: true` (or remove this line) to enforce + autofix them repo-wide.
	// Left off here to match the repo's prior behavior.
	headers: false,
	restrictProcessGlobals: true,
	// A number used as a comparison threshold needs a name; data tables (bbox rows, codepoint
	// ranges, status maps) are left alone, which is why `no-magic-numbers` stays off.
	unnamedThresholds: true,
	// Exported and SCREAMING_CASE module-level constants carry a JSDoc block saying what the value
	// means and where it came from — provenance, not a restatement of the identifier.
	constantDocs: true,
	ignorePatterns: [
		...DefaultIgnorePatterns,
		".pi",
		"**/scratchpad",
		"docs/build",
		"docs/.docusaurus",
		// Python venv + egg-info under corpus-python/ (vendored JS we don't own).
		"**/.venv/**",
		"**/*.egg-info/**",
	],
})

// Mailwoman-specific rule overrides, merged onto the shared base. The factory's `overrides` option
// shallow-spreads, so merge `rules` explicitly to avoid clobbering the base rule set.
export default {
	...config,
	rules: {
		...(config.rules as Record<string, unknown>),
		"guard-for-in": "error",
		"typescript/no-explicit-any": "error",
		"unicorn/no-new-array": "off",
	},
}
