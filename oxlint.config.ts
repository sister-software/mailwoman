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
	// Exported module-level constants carry a JSDoc block saying what the value means and where it came
	// from — provenance, not a restatement of the identifier. Scoped to EXPORTED only: on the local
	// SCREAMING_CASE constants the name is usually the documentation already (`STREET_TYPES_FILENAME`,
	// `SVG_WIDTH`), and requiring a sentence there produces restatements, which cost the next reader
	// more than the missing comment did. Public surface is where a reader has no other context.
	constantDocs: {
		scope: "exported",
		// Pastel command modules must export these, and the framework gives each its meaning — the
		// `description` string IS the `--help` text. A JSDoc block above them can only restate it.
		ignoreNames: ["description", "args", "options", "alias", "isDefault"],
	},
	// An acronym is capitalized as a whole camelCase component: `parseJSON`, `POILookup`,
	// `createWOFResolver`. The shipped list covers general programming vocabulary; everything below is
	// this project's own, and the list is worth widening on sight — `outHtml` sat in three sibling
	// files for months because a hand-maintained list only contains the acronyms someone thought to add.
	acronymCasing: {
		extraAcronyms: [
			"BIO",
			"CRF",
			"DMS",
			"FST",
			"GBT",
			"GERS",
			"MCP",
			"MGRS",
			"NUTS",
			"NZ",
			"ONNX",
			"OSM",
			"POI",
			"WOF",
			"ZCTA",
		],
		// Names whose casing is not ours to choose. Prefer a scoped disable comment at the one site
		// that needs it — an entry here silently covers every future declaration of the same name.
		ignoreNames: [
			// kysely's own dialect classes are `SqliteAdapter`/`SqliteDialect`/`SqliteDriver`; ours
			// implement its interfaces and read as a matched pair only if they follow suit.
			"SqliteAdapter",
			"SqliteDialect",
			"SqliteDialectConfig",
			"SqliteDriver",
			// `LedgerAppendOptions` receives the Pastel option bag verbatim — its fields ARE the
			// `--run-id` flag names, and the house form is derived at the boundary.
			"runId",
		],
	},
	ignorePatterns: [
		...DefaultIgnorePatterns,
		".pi",
		"**/scratchpad",
		"docs/build",
		"docs/.docusaurus",
		// Python venv + egg-info under corpus-python/ (vendored JS we don't own).
		"**/.venv/**",
		"**/*.egg-info/**",
		// Emscripten-generated single-file artifact (rebuilt by sentencepiece-wasm/build.sh).
		"sentencepiece-wasm/sentencepiece.mjs",
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
		// Several suites assert through helpers that throw rather than calling `expect` inline —
		// `expectProposal` in the phrase-grouper catalogue, `assertDownstreamOffsetsSurvive` in the
		// tokenizer suite. Without this the rule reads those tests as asserting nothing.
		"vitest/expect-expect": ["error", { assertFunctionNames: ["expect", "expect*", "assert*"] }],
	},
}
