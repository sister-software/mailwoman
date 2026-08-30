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
		// A codemod's fixtures ARE the shape it rewrites, so they are data rather than source. Linting the forbidden
		// form out of an `input.ts` would leave the codemod asserting a transformation nothing still needs.
		"codemods/*/tests/**",
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
const BROWSER_REACHABLE_NEURAL_FILES = ["packages/neural/*.ts"]

/**
 * The Node tier, exempt from the rule below. `index.ts` is the Node entry and re-exports the other three as values;
 * `test/**` and the nested directories fall outside the single-segment glob above on their own.
 */
const NODE_TIER_NEURAL_FILES = [
	"packages/neural/index.ts",
	"packages/neural/onnx-runner.ts",
	"packages/neural/scorer.ts",
	"packages/neural/weights.ts",
	"packages/neural/*.test.ts",
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
	// specifiers, and this module launders the builtins behind its own name.
	"@mailwoman/core/env",
]

/**
 * Every Node builtin, by specifier prefix. A browser-reachable file importing one of these is a bundle break whatever
 * the module is called.
 */
const NODE_BUILTIN_PATTERN = "node:*"

/**
 * `mkdtemp` answers a STRING, so nothing owns the directory and nothing removes it. A 2026-08-29 census of the 205 call
 * sites outside `@mailwoman/platform` found 89 that never removed theirs — 43%, and none of them looked wrong at the
 * call site, because a leaked scratch directory has no symptom a test can see.
 *
 * `@mailwoman/core/fs/temporary` answers a handle instead, rooted at `$MAILWOMAN_TEMP_ROOT` rather than the operating
 * system's `tmpdir()`: `path`, `resolve(...)`, `use(...)` for whatever must be released before the directory goes, and
 * `move()`/`moveWith(...)` for a factory handing one to a caller that outlives it. Reaching the builtin through the
 * platform mirror is the correct FIRST hop and the wrong LAST one, which is why this names the second.
 */
const TEMPORARY_DIRECTORY_REDIRECTS = ["@mailwoman/platform/fs", "@mailwoman/platform/fs/promises"].map((name) => ({
	name,
	importNames: ["mkdtemp", "mkdtempSync", "mkdtempDisposable", "mkdtempDisposableSync"],
	message:
		"A temporary directory is owned, not named. Use `await temporaryDirectory(prefix)` from " +
		"`@mailwoman/core/fs/temporary` and bind it with `await using`, so the directory is removed when the scope " +
		"ends. It carries `resolve(...)` for a path inside it, `use(...)` for a resource that must be released first, " +
		"and `moveWith(...)` for a fixture handed to a longer-lived scope. Where the lifetime is a suite rather than a " +
		"scope, register it on a file-level `AsyncDisposableStack` that one `afterAll` disposes.",
}))

/**
 * `@mailwoman/platform/fs` and `/fs/promises` mirror `node:fs` one name for one name, because a mirror that omitted a
 * builtin would lie about the runtime. `@mailwoman/core/fs/*` is the house idiom over that mirror, and after the
 * 2026-08-30 migration it is the only importer left — the same posture `@mailwoman/platform/sqlite` has toward
 * `@mailwoman/sqlite`.
 *
 * Both surfaces exist, and the name carries the contract on each: `statPath` raises where `tryStat` answers null,
 * `removePath` raises where `removePathIfPresent` forgives, `makeDirectories` is idempotent where
 * `makeDirectoryExclusive` raises EEXIST — which is what holds a lock. Reach for `readers`/`writers` first;
 * `readers-sync`/`writers-sync` are for the slots whose caller is synchronous and not ours to change.
 */
const FILESYSTEM_MIRROR_REDIRECT = ["@mailwoman/platform/fs", "@mailwoman/platform/fs/promises"].map((name) => ({
	name,
	allowTypeImports: true,
	message:
		"`@mailwoman/core/fs` is the house filesystem surface, and the only importer of this mirror. Use " +
		"`@mailwoman/core/fs/readers` + `/writers` (asynchronous, preferred), `/readers-sync` + `/writers-sync` where " +
		"the caller is synchronous and not yours to change, `/streams` for `createReadStream`/`createWriteStream`, or " +
		"`/temporary` for a scratch directory. Every helper takes a `PathBuilderLike` and states its contract in its " +
		"name. File-DESCRIPTOR work has no helper yet and is the one reason to reach past this.",
}))

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
			files: ["packages/platform/**/*.ts"],
			rules: {
				"sister-software/require-constant-doc": "off",
				"typescript/no-restricted-imports": "off",
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
			// `packages/core/fs/*` IS the idiom the redirects below point AT, so it is the one place that reaches the
			// `node:fs` mirror directly.
			files: ["packages/core/fs/**/*.ts"],
			rules: {
				"typescript/no-restricted-imports": "off",
			},
		},
		{
			// These workspaces do not depend on `@mailwoman/core`, so for them the mirror IS the filesystem surface.
			// Three of them say so at the call site, next to a `JSON.parse` that reaches for no wrapper for the same
			// reason. The dependency is what the exemption buys back: `@mailwoman/core` ships ~9 MB of libpostal + WOF
			// data under `packages/core/data/`, and npm installs a tarball whether or not a subpath import touches it —
			// so adding it to a small alias table or a point-in-polygon lookup is a shipped-artifact cost, not a style
			// one. `@mailwoman/platform` itself is already exempt above, and must be: it declares NO dependencies, and
			// core depends on IT.
			files: [
				"packages/api-kit/openapi.ts",
				"packages/nuts-lookup/build.ts",
				"packages/timezone-lookup/build.ts",
				"packages/un-locode-lookup/build.ts",
				"packages/variant-aliases/lookup.ts",
			],
			rules: {
				"typescript/no-restricted-imports": "off",
			},
		},
		{
			// File-DESCRIPTOR work no helper covers: a `FileHandle` held across calls, and a log opened in append mode for
			// a child's stdio. A handle is OWNED, and moving ownership is not a rename — so these keep the mirror, and
			// each says so in place. The two shapes that DID have an idiom left this list: a positional header peek is
			// `readFileRange`, and a chunked hash is `md5File`.
			files: [
				"corpus-python/scripts/train_with_resume.ts",
				"packages/bdc/sdk/build-bdc.ts",
				"packages/core/tools/generate-language-types.ts",
				"packages/corpus/src/tools/fetch/geonames-dump.ts",
				"packages/map-tui/tile-source.ts",
			],
			rules: {
				"typescript/no-restricted-imports": "off",
			},
		},
		{
			// A codemod reads argument COUNTS to tell one builtin overload from another. `args.length === 3` is an arity,
			// not a tuned threshold, and naming each one costs a constant per overload and explains nothing.
			files: ["codemods/**/*.ts"],
			rules: {
				"sister-software/no-unnamed-threshold": "off",
			},
		},
	],
	rules: {
		...(config.rules as Record<string, unknown>),
		"guard-for-in": "error",
		"mailwoman/no-database-boundary-cast": "error",
		"mailwoman/no-database-handle-cast": "error",
		"mailwoman/no-sync-fs-in-async": "error",
		"mailwoman/require-database-schema-argument": "error",
		"mailwoman/require-disable-reason": "error",
		"typescript/no-restricted-imports": [
			"error",
			{
				paths: [...TEMPORARY_DIRECTORY_REDIRECTS, ...FILESYSTEM_MIRROR_REDIRECT],
				patterns: [
					{
						group: [NODE_BUILTIN_PATTERN],
						message:
							"Node builtins are isolated behind @mailwoman/platform. Import the matching platform subpath instead — " +
							"and where the subpath carries a house idiom (a scratch directory, a database connection), reach for " +
							"the idiom rather than the raw builtin it is built on.",
					},
					{
						group: ["@mailwoman/platform/sqlite"],
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
