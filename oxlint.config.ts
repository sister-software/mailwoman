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
		// Command modules export these as framework metadata; the
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
			// `LedgerAppendOptions` receives the CLI option bag verbatim — its fields ARE the
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
		"**/.agents/**",
		"**/.claude/**",
		// Python venv + egg-info under corpus-python/ (vendored JS we don't own).
		"**/.venv/**",
		"**/*.egg-info/**",
		// Emscripten-generated single-file artifact (rebuilt by sentencepiece-wasm/build.sh).
		"packages/sentencepiece-wasm/sentencepiece.mjs",
	],
})

// Mailwoman-specific rule overrides, merged onto the shared base. The factory's `overrides` option
// shallow-spreads, so merge `rules` explicitly to avoid clobbering the base rule set.
/**
 * `@mailwoman/neural` is bundled for a browser whole: the demo reaches its web loader, which reaches the classifier and
 * every soft-feature channel behind it. So the browser-reachable set is the package MINUS its Node tier, stated that
 * way round because the Node tier is the short, stable list — an enumeration of the browser half needs an edit every
 * time a module is added, and gets one only if its author remembered this file.
 *
 * A VALUE import of a Node-only module from here breaks the client bundle: webpack follows it eagerly and chokes on
 * `onnxruntime-node`'s binary assets. `import type` is erased before the bundler sees it and stays legal.
 *
 * No node-side check catches a violation: `yarn compile`, the test legs and the gauntlet never bundle. Only the
 * separate docs-build workflow does, which is minutes later and in another run.
 */
const BROWSER_REACHABLE_NEURAL_FILES = ["packages/neural/lib/*.ts"]

/**
 * The Node tier, exempt from the rule below. `index.ts` is the Node entry and re-exports the other three as values;
 * `test/**` and the nested directories fall outside the single-segment glob above on their own.
 */
const NODE_TIER_NEURAL_FILES = [
	"packages/neural/lib/index.ts",
	"packages/neural/lib/env.ts",
	"packages/neural/lib/onnx-runner.ts",
	"packages/neural/lib/scorer.ts",
	"packages/neural/lib/weights.ts",
	"packages/neural/lib/*.test.ts",
	"packages/neural/vitest.config.ts",
]

/**
 * Node-only modules the browser tier must not pull into the bundle.
 *
 * `./onnx-runner.ts` earns its place twice over now that `@mailwoman/neural/onnx-runner` carries a `browser` condition:
 * export conditions do not apply to relative specifiers, so the package-name form is safe and the relative one silently
 * is not. Naming the relative path is what makes that difference visible at the point of the mistake.
 */
const NODE_ONLY_NEURAL_MODULES = [
	"./onnx-runner.ts",
	"./weights.ts",
	"./scorer.ts",
	"onnxruntime-node",
	// `$public` reaches node:util/node:fs/node:path. The `node:*` pattern below cannot catch it: the rule matches
	// specifiers, and this module launders the builtins behind its own name. `./env.ts` extends it and is the same
	// module one hop further away.
	"@mailwoman/core/env",
	"./env.ts",
	"#env",
]

/**
 * Every Node builtin, by specifier prefix. A browser-reachable file importing one of these is a bundle break whatever
 * the module is called.
 */
const NODE_BUILTIN_PATTERN = "node:*"

export default {
	...config,
	// The repo-local plugin (`oxlint.plugin.ts`) rides alongside the bundled Sister Software one.
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
			// `@mailwoman/sqlite` is where a connection comes into being, so it is the one place that names the builtin.
			files: ["packages/sqlite/**/*.ts"],
			rules: {
				"typescript/no-restricted-imports": "off",
			},
		},
		{
			// `packages/core/lib/fs/*` IS the idiom the redirects below point AT, so it is the one place that reaches
			// `node:fs` directly.
			files: ["packages/core/lib/fs/**/*.ts"],
			rules: {
				"typescript/no-restricted-imports": "off",
			},
		},
		{
			// `packages/core/lib/module/*` owns ESM plumbing — package-directory resolution and `file:` URL conversion — and
			// is the one place `node:url` is reached for it.
			files: ["packages/core/lib/module/**/*.ts"],
			rules: {
				"typescript/no-restricted-imports": "off",
				"mailwoman/no-import-meta-resolve": "off",
			},
		},
		{
			// The homes `prefer-home` points at are the one place each shape is typed out: the clock helpers, the seeded
			// generators, and `@mailwoman/spatial`, which owns Earth's radius and every reading of it.
			// The table that names each shape, and its test, spell the constants out by necessity.
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
			// A test file imports the package under test through its public exports and a helper by relative path; the
			// `#` map is the package's private naming and stays inside `lib/`.
			files: ["packages/*/test/**/*.ts", "packages/*/test/**/*.tsx", "docs/test/**/*.ts", "docs/test/**/*.tsx"],
			rules: {
				"mailwoman/no-private-import-in-test": "error",
			},
		},
		{
			// `packages/core/lib/process.ts` is the child-process idiom and the one place `node:child_process` is reached.
			files: ["packages/core/lib/process.ts"],
			rules: {
				"typescript/no-restricted-imports": "off",
			},
		},
		{
			// `core/scripting/arguments.ts` is the argv boundary (`parseArguments`, `cliArguments`) and reaches `node:util`
			// for the one builtin it wraps.
			files: ["packages/core/lib/scripting/arguments.ts"],
			rules: {
				"typescript/no-restricted-imports": "off",
			},
		},
		{
			// The remaining core homes, each the one place its builtin is reached: host facts (`node:os`), a timed wait
			// (`node:timers/promises`), an emitter's next event (`node:events`), digests (`node:crypto`), the compile
			// cache (`node:module`).
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
			// Builtins with no idiom to wrap yet, each reached directly by the one file that needs it: a line reader over
			// a fixed-width feed, a worker's `workerData`, the cluster primary, a test-local HTTP server and the two
			// `https.get` downloads that predate `APIClient`.
			files: [
				"packages/corpus/test/unit/tools/fetch/download.test.ts",
				"packages/corpus/test/unit/tools/fetch/geonames-dump.test.ts",
				"packages/corpus/test/unit/tools/fetch/geonames-postal.test.ts",
				"packages/corpus/test/unit/tools/fetch/state-hi-schools.test.ts",
				"packages/filer/lib/sdk/form499.ts",
				"packages/filer/lib/sdk/provider-list.ts",
				"packages/mailwoman/lib/cli-native/commands/geocode.ts",
				"packages/mailwoman/lib/commands/gazetteer/importance.tsx",
				"packages/mailwoman/lib/commands/serve.tsx",
				"packages/api-kit/test/fixtures/cluster-serve.ts",
				"packages/mailwoman/lib/commands/situs/interpolation.tsx",
				"packages/mailwoman/lib/geocode/worker.ts",
				"packages/mailwoman/lib/test-fixtures/fake-geocode-worker.js",
				"docs/static/examples/mailwoman-server.mjs",
				"docs/plugins/demo-assets/workspace-resolution.ts",
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
		"guard-for-in": "error",
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
		// `split("\n")`/`split("\t")` materializes every segment into one array before the first is
		// read — the whole-buffer parse spliterator exists to avoid. Bounded-input sites keep split
		// behind a scoped disable saying why their bound is durable.
		"mailwoman/prefer-spliterator": "error",
		// A helper shape that already has a home (`HELPER_HOMES` in `oxlint.plugin.ts`) is reported at the copy, with
		// the import that replaces it. The home files themselves are exempted in `overrides`.
		"mailwoman/prefer-home": "error",
		// `JSON.parse` throws on corrupt input and returns `any`, so every direct call site either
		// wraps it in its own try/catch or lets the exception escape untyped. `tryParsingJSON<T>`
		// (`@mailwoman/core/objects`) is the house wrapper: typed result, non-throwing, explicit
		// fallback. Sites where throw-on-corrupt IS the contract — sealed-artifact readers, JSONL
		// bulk loaders that must fail loudly with position info — keep `JSON.parse` behind a scoped
		// disable stating why. Note the wrapper returns the fallback for non-string input, so a
		// `JSON.parse(buffer)` site converts with an explicit `.toString()` or not at all.
		"no-restricted-properties": [
			"error",
			{
				object: "JSON",
				property: "parse",
				message:
					'Prefer `tryParsingJSON` from "@mailwoman/core/objects" — typed, non-throwing, explicit fallback. ' +
					"If a throw on corrupt input is the contract here, import and use `parseJSONStrict` instead.",
			},
		],
		"typescript/no-explicit-any": "error",
		"unicorn/no-new-array": "off",
		// Several suites assert through helpers that throw rather than calling `expect` inline —
		// `expectProposal` in the phrase-grouper catalogue, `assertDownstreamOffsetsSurvive` in the
		// tokenizer suite. Without this the rule reads those tests as asserting nothing.
		"vitest/expect-expect": ["error", { assertFunctionNames: ["expect", "expect*", "assert*"] }],
	},
}
