/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file oxlint configuration for the Mailwoman monorepo.
 */

import { createOxlintConfig, DefaultIgnorePatterns } from "@sister.software/oxlint-config"

import { JSON_PARSE, JSON_STRINGIFY, restrictedPropertiesExcept } from "./config/oxlint/restricted-properties.ts"

const config = createOxlintConfig({
	spdxLicenseIdentifier: "AGPL-3.0",
	// Mailwoman ships Ink UIs, so the React rules stay on.
	react: true,
	headers: false,
	restrictProcessGlobals: true,
	// A number used as a comparison threshold needs a name.
	// `no-magic-numbers` stays off so that data tables are left alone.
	unnamedThresholds: true,
	// Only exported constants need a JSDoc block.
	// A local constant's name usually says enough.
	constantDocs: {
		scope: "exported",
		// Command modules export these as framework metadata, and `description` is the `--help` text.
		ignoreNames: ["description", "args", "options", "alias", "isDefault"],
	},
	// An acronym is capitalized as a whole camelCase component, as in `parseJSON` and `POILookup`.
	// These entries extend the shipped list with this project's acronyms.
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
		// An entry here exempts every future declaration of the name.
		// Prefer a scoped disable comment.
		ignoreNames: [
			// These classes implement Kysely's interfaces and match its `Sqlite*` class names.
			"SqliteAdapter",
			"SqliteDialect",
			"SqliteDialectConfig",
			"SqliteDriver",
			// `LedgerAppendOptions` receives the CLI options unchanged, so its field matches the `--run-id` flag.
			"runId",
		],
	},
	ignorePatterns: [
		// The default `**/coverage` pattern would also ignore source directories named
		// `coverage`, so only the root coverage directory is ignored.
		...DefaultIgnorePatterns.filter((pattern) => pattern !== "**/coverage"),
		"/coverage/",
		".pi",
		"**/scratchpad",
		"docs/build",
		"docs/.docusaurus",
		"**/.agents/**",
		"**/.claude/**",
		// Python virtual environments can contain third-party JavaScript.
		"**/.venv/**",
		"**/*.egg-info/**",
		// sentencepiece-wasm/build.sh generates this file with Emscripten.
		"packages/sentencepiece-wasm/sentencepiece.mjs",
	],
})

/**
 * Files in `@mailwoman/neural` that the docs demo bundles for the browser.
 *
 * The set is the package minus its Node tier, because the Node tier is the shorter, stable list.
 * A value import of a Node-only module from these files breaks the webpack build.
 *
 * `import type` stays legal because it is erased before bundling.
 * Only the docs build bundles this package, so the lint rule is the earliest check.
 */
const BROWSER_REACHABLE_NEURAL_FILES = ["packages/neural/lib/*.ts"]

/**
 * Node-tier files of `@mailwoman/neural`, which are exempt from the browser import rule.
 *
 * `index.ts` is the Node entry.
 * Nested directories already fall outside the single-segment glob above.
 */
const NODE_TIER_NEURAL_FILES = [
	"packages/neural/lib/index.ts",
	"packages/neural/lib/env.ts",
	"packages/neural/lib/onnx/runner/index.ts",
	"packages/neural/lib/scorer.ts",
	"packages/neural/lib/weights/index.ts",
	"packages/neural/lib/*.test.ts",
	"packages/neural/vitest.config.ts",
]

/**
 * Node-only modules that the browser tier must not import as values.
 *
 * Export conditions do not apply to relative specifiers.
 * `@mailwoman/neural/onnx-runner` resolves to a browser build, but `./onnx-runner.ts` does not.
 */
const NODE_ONLY_NEURAL_MODULES = [
	"./onnx-runner.ts",
	"./weights.ts",
	"./scorer.ts",
	"onnxruntime-node",
	// `@mailwoman/core/env` imports Node builtins, which the `node:*` pattern cannot see.
	// `./env.ts` and `#env` extend it.
	"@mailwoman/core/env",
	"./env.ts",
	"#env",
]

/**
 * Specifier pattern that matches every Node builtin.
 */
const NODE_BUILTIN_PATTERN = "node:*"

/**
 * Oxlint config for the monorepo.
 *
 * It adds the repo-local plugin and Mailwoman rules to the shared config.
 *
 * The shared factory's `overrides` option spreads shallowly, so this object
 * merges `overrides` and `rules` itself.
 */
export default {
	...config,
	jsPlugins: [...((config.jsPlugins as string[] | undefined) ?? []), "./oxlint.plugin.ts"],
	overrides: [
		...((config.overrides as unknown[] | undefined) ?? []),
		{
			files: BROWSER_REACHABLE_NEURAL_FILES,
			excludeFiles: NODE_TIER_NEURAL_FILES,
			rules: {
				"typescript/no-restricted-imports": [
					"error",
					{
						patterns: [
							{
								group: [NODE_BUILTIN_PATTERN],
								allowTypeImports: true,
								message:
									"A Node builtin cannot be imported from the browser tier of @mailwoman/neural — the bundler " +
									"follows it into the client graph. Use `import type` (erased), or reach it through an " +
									"`import(/* webpackIgnore: true */ …)` inside the Node-only code path.",
							},
						],
						paths: NODE_ONLY_NEURAL_MODULES.map((name) => ({
							name,
							allowTypeImports: true,
							message:
								`${name} is Node-only and this file is in the browser tier of @mailwoman/neural. A value import ` +
								`pulls it into the client bundle. Use \`import type\` (erased), or reach it through a ` +
								`\`import(/* webpackIgnore: true */ …)\` inside the Node-only code path.`,
						})),
					},
				],
			},
		},
		{
			// `@mailwoman/sqlite` opens connections, so it may import `node:sqlite`.
			files: ["packages/sqlite/**/*.ts"],
			rules: {
				"typescript/no-restricted-imports": "off",
			},
		},
		{
			// The import rule redirects `node:fs` to these wrappers, so they may import it.
			files: ["packages/core/lib/fs/**/*.ts"],
			rules: {
				"typescript/no-restricted-imports": "off",
			},
		},
		{
			// This file holds the JSON wrappers that the rule recommends.
			files: ["packages/core/lib/json.ts"],
			rules: {
				"no-restricted-properties": restrictedPropertiesExcept(JSON_PARSE, JSON_STRINGIFY),
			},
		},
		{
			// These files cannot depend on `@mailwoman/core`.
			// The `docs/static` scripts run without a monorepo install, and the leaf
			// packages avoid pulling in core's shipped data.
			// Only `JSON.stringify` is allowed here.
			// Each `JSON.parse` site keeps its own disable comment.
			files: [
				"docs/static/**/*.mjs",
				"packages/ancestrie/**/*.ts",
				"packages/annotations/**/*.ts",
				"packages/un-locode-lookup/**/*.ts",
			],
			rules: {
				"no-restricted-properties": restrictedPropertiesExcept(JSON_STRINGIFY),
			},
		},
		{
			// These modules resolve package directories and convert `file:` URLs with `node:url`.
			files: ["packages/core/lib/module/**/*.ts"],
			rules: {
				"typescript/no-restricted-imports": "off",
				"mailwoman/no-import-meta-resolve": "off",
			},
		},
		{
			// `prefer-home` points at these files, and the plugin and its test spell out the same shapes.
			files: [
				"packages/core/lib/utils/time.ts",
				"packages/core/lib/random.ts",
				"packages/core/lib/git.ts",
				"packages/spatial/**/*.ts",
				"oxlint.plugin.ts",
				"oxlint.plugin.test.ts",
			],
			rules: {
				"mailwoman/prefer-home": "off",
			},
		},
		{
			// Tests import the package through its public exports.
			// The `#` import map is private to `lib/`.
			files: [
				"packages/*/test/**/*.ts",
				"packages/*/test/**/*.tsx",
				"packages/corpus/lib/**/*.test.ts",
				"packages/corpus/lib/**/*.test.tsx",
				"docs/test/**/*.ts",
				"docs/test/**/*.tsx",
			],
			rules: {
				"mailwoman/no-private-import-in-test": "error",
			},
		},
		{
			// This file wraps `node:child_process` for the rest of the repo.
			files: ["packages/core/lib/process.ts"],
			rules: {
				"typescript/no-restricted-imports": "off",
			},
		},
		{
			// This file wraps `parseArgs` from `node:util`.
			files: ["packages/core/lib/scripting/arguments.ts"],
			rules: {
				"typescript/no-restricted-imports": "off",
			},
		},
		{
			// These core modules wrap `node:os`, `node:timers/promises`, `node:events`,
			// `node:crypto` and `node:module`.
			files: [
				"packages/core/lib/utils/system.ts",
				"packages/core/lib/utils/sleep.ts",
				"packages/core/lib/utils/events.ts",
				"packages/core/lib/hash.ts",
				"packages/core/lib/module/runtime.ts",
				"packages/core/lib/crypto/**/*.ts",
			],
			rules: {
				"typescript/no-restricted-imports": "off",
			},
		},
		{
			// Corpus tests sit beside their modules and start local HTTP and TCP servers.
			files: ["packages/corpus/lib/**/*.test.ts", "packages/corpus/lib/**/*.test.tsx"],
			rules: {
				"typescript/no-restricted-imports": "off",
			},
		},
		{
			// These files use builtins that core does not wrap yet, such as readline,
			// worker_threads, cluster, http and https.
			files: [
				"packages/filer/lib/sdk/form499/index.ts",
				"packages/filer/lib/sdk/provider-list.ts",
				"packages/mailwoman/lib/cli/native/commands/geocode.ts",
				"packages/mailwoman/lib/commands/gazetteer/importance.tsx",
				"packages/mailwoman/lib/commands/serve.tsx",
				"packages/api-kit/test/fixtures/cluster-serve.ts",
				"packages/mailwoman/lib/commands/situs/interpolation/index.tsx",
				"packages/mailwoman/lib/geocode/worker.ts",
				"packages/mailwoman/lib/test-fixtures/fake-geocode-worker.js",
				"docs/static/examples/mailwoman-server.mjs",
				"docs/plugins/runtime-assets/workspace/resolution.ts",
				"packages/map-tui/test/unit/tile-source.test.ts",
				"packages/neural/test/integration/browser-slo.test.ts",
				"packages/resolver-wof-sqlite/test/integration/lookup-readonly-open.test.ts",
				"packages/tiger/lib/tools/serve-range.ts",
			],
			rules: {
				"typescript/no-restricted-imports": "off",
			},
		},
	],
	rules: {
		...(config.rules as Record<string, unknown>),
		// The reflow puts each sentence on its own line and wraps only sentences longer than 90 columns.
		// A line may reach 120 columns to avoid splitting a parenthetical.
		// `tabWidth` matches oxfmt's two-column tab.
		"mailwoman/comment-reflow": ["warn", { printWidth: 120, targetWidth: 90, tabWidth: 2, paragraphSentences: 2 }],
		"guard-for-in": "error",
		// The shared base only warns, and the shared tsconfig disables `noUnusedLocals`,
		// so this rule is promoted to an error.
		// Setting a severity alone would drop the base's options, so they are repeated here.
		// Prefix a deliberately unused binding with `_`.
		"no-unused-vars": [
			"error",
			{
				args: "all",
				argsIgnorePattern: "^_",
				caughtErrors: "all",
				caughtErrorsIgnorePattern: "^_",
				destructuredArrayIgnorePattern: "^_",
				varsIgnorePattern: "^_",
				ignoreRestSiblings: true,
			},
		],
		"mailwoman/no-cross-package-reexport": "error",
		"mailwoman/no-database-boundary-cast": "error",
		"mailwoman/no-database-handle-cast": "error",
		"mailwoman/no-import-meta-dirname-walk": "error",
		"mailwoman/no-import-meta-resolve": "error",
		"mailwoman/no-relative-dynamic-import": "error",
		"mailwoman/no-sync-fs-in-async": "error",
		"mailwoman/require-database-schema-argument": "error",
		"mailwoman/require-disable-reason": "error",
		"typescript/no-restricted-imports": [
			"error",
			{
				patterns: [
					{
						group: [NODE_BUILTIN_PATTERN],
						message:
							"`@mailwoman/core` is the only package that reaches a Node builtin, and each has a home there: `node:fs` → " +
							"`@mailwoman/core/fs/*` (`/temporary` for a scratch directory), `node:path` → `path-ts`, `node:url` → " +
							"`import.meta.dirname` / `@mailwoman/core/module/file-url`, `node:child_process` → `@mailwoman/core/process`, " +
							"`parseArgs` → `@mailwoman/core/scripting/arguments`, `node:crypto` → `@mailwoman/core/hash`, `node:os` → " +
							"`@mailwoman/core/utils/system`, `node:timers/promises` → `@mailwoman/core/utils/sleep`, `node:events` → " +
							"`@mailwoman/core/utils/events`, `node:stream` → `@mailwoman/core/fs/streams`, `node:zlib` → " +
							"`@mailwoman/core/fs/compression`, `node:sqlite` → `@mailwoman/sqlite`.",
					},
					{
						group: ["node:sqlite"],
						message:
							"A caller says WHICH FILE and WHICH SCHEMA; opening the connection is the library's job. Use " +
							"`new DatabaseClient<Schema>(path)` (@mailwoman/sqlite/client), or `openBuiltClient` " +
							"(@mailwoman/sqlite/sealed) for a sealed artifact. Handing construction to callers is what let one " +
							"database be described by two schemas with nothing making them agree, and split ownership so the " +
							"first `destroy()` closed the connection under the other holder. `exec`, `prepare` and `function` " +
							"reach the same connection for the statements Kysely does not model.",
					},
				],
			},
		],
		// `split("\n")` builds the whole array before the first segment is read.
		// A site with bounded input may keep `split` behind a scoped disable that explains the bound.
		"mailwoman/prefer-spliterator": "error",
		// This rule reports a copy of a helper listed in `HELPER_HOMES` in `oxlint.plugin.ts`.
		"mailwoman/prefer-home": "error",
		// Direct `JSON.parse` calls should use `tryParsingJSON<T>` from `@mailwoman/core/objects`,
		// which returns a typed result or a fallback.
		// A site that must throw on corrupt input keeps `JSON.parse` behind a scoped disable.
		// The wrapper returns the fallback for non-string input, so convert a buffer with `.toString()` first.
		//
		// An override lifts one entry by calling `restrictedPropertiesExcept` with that entry.
		// Setting the rule to `"off"` would lift every entry.
		"no-restricted-properties": restrictedPropertiesExcept(),
		"typescript/no-explicit-any": "error",
		"unicorn/no-new-array": "off",
		// Some suites assert through helpers named `expect*` or `assert*` that throw on failure.
		"vitest/expect-expect": ["error", { assertFunctionNames: ["expect", "expect*", "assert*"] }],
	},
}
