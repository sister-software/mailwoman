/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Executable dependency boundaries for the Mailwoman monorepo.
 * @import { IConfiguration } from 'dependency-cruiser'
 */

// oxlint-disable no-restricted-imports -- No workspace imports in the linter itself.

/// <reference types="node" />

/**
 * Generated trees, excluded from the cruise and never followed into.
 *
 * `out/` is tsc's emit and `dist/` an app's Vite output — bundled chunks whose
 * cycles are the bundler's, not the source graph's.
 * `public/sqlite/` is the range worker and sqlite-wasm runtime staged by
 * `@mailwoman/site-kit/vite/stage-sqlite-runtime`; it is gitignored, and the readers load it by URL.
 *
 * `packages/react/tokens/index.ts` is the TypeScript companion `styleframe build` writes
 * beside the CSS it compiles, and `.gitignore` carries the reason nothing imports it:
 * consumers read `tokens/index.css` and `tokens/tokens.json`, and both of those are committed.
 * The cruise reads the filesystem rather than the index, so on any tree where that build
 * has run the file is an orphan by construction, and a fresh checkout never has it.
 */
const GENERATED_TREES =
	"(?:^|/)(?:out|dist|node_modules|public/sqlite|sentencepiece[.]mjs)(?:/|$)|^packages/react/tokens/index[.]ts$"

/**
 * Modules an external runner, a bundler, or an export condition loads BY path,
 * so no import names them and `no-orphans` cannot see the edge.
 *
 * Each entry states who does the loading.
 */
const LOADED_WITHOUT_AN_IMPORT = [
	// Test-runner and build-tool configs.
	// The preset exempts babel and webpack by name; these are the ones this repository runs.
	// `.storybook/main.ts` sits under a dotted directory, which the preset's dotfile pattern
	// (`(^|/)\.[^/]+\.(js|cjs|mjs|ts|json)$`) matches only as a dotted file.
	"(^|/)(?:vitest|vitest[.]node|vite|playwright|styleframe)[.]config[.](?:js|cjs|mjs|ts)$",
	"(^|/)[.]storybook/",
	// Playwright specs: the runner collects them from disk by glob.
	"(^|/)test/browser/[^/]+[.]spec[.]ts$",
	// A worker script must be a real file on disk for the runtime to spawn by path.
	// `packages/mailwoman/lib/geocode/stream.test.ts` hands this one to a worker, and
	// `@mailwoman/site-kit/vite/pwa` names `lib/service-worker.ts` as the `injectManifest` entry.
	"(^|/)lib/test-fixtures/[^/]+-worker[.](?:js|ts)$",
	"(^|/)lib/service-worker[.]ts$",
	// The `browser` condition's target for a subpath whose `node` condition resolves elsewhere.
	// This cruise declares `conditionNames: ["node", "import", "default"]`, so the browser
	// half is a real entry point that nothing in the Node graph can reach.
	// `@mailwoman/neural`'s `./onnx-runner` is the case.
	"(^|/)lib/onnx/runner/browser[.]ts$",
]

/**
 * Directories inside `lib/` whose role is acquisition, build tooling or the CLI
 * rather than the package's library.
 *
 * Any package's `sdk`, `tools`, `scripts`, `commands`, `cli` and `dev-tools`
 * directories hold one of those roles, and so do the named `mailwoman` directories
 * for its CLI views, evaluation harness and build pipelines.
 *
 * Each directory's own module beside it (`lib/sdk.ts` beside `lib/sdk/`) belongs to it.
 * `dev-mcp` and `mcp` use `tools` for MCP tool definitions, which are their library.
 */
const ROLE_DIRECTORIES =
	"^packages/[^/]+/(?:sdk|tools|cli)/|" +
	"^packages/[^/]+/lib/(?:sdk|tools|scripts|commands|cli|dev-tools)(?:/|[.]tsx?$)|" +
	"^packages/[^/]+/lib/.*/(?:sdk|tools|scripts|commands|cli|dev-tools)(?:/|[.]tsx?$)|" +
	"^packages/mailwoman/lib/(?:debug-view|doctor|eval-harness|gazetteer-pipeline|coverage|release-tools|tiles)(?:/|[.]tsx?$)"

const LIBRARY_TOOLS = "^packages/(?:dev-mcp|mcp)/lib/tools(?:/|[.]tsx?$)"

/**
 * Packages whose whole `lib/` is tooling: the development and release servers, the repository checks,
 * the operator CLI, build helpers, the planetary data pipeline, the reference geocoder clients
 * the evaluations call, and the training-corpus build kit, whose recipes read acquired sources.
 * They may import any role.
 */
const TOOLING_PACKAGES =
	"^packages/(?:dev-mcp|ops-cli|release-kit|release-mcp|repo-health|storage-kit|site-kit|astrogeology|geocode-oracle|corpus)/"

/**
 * @type {IConfiguration}
 */
const config = {
	extends: ["dependency-cruiser/configs/recommended-strict"],
	forbidden: [
		{
			name: "no-cross-workspace-relative-import",
			comment: "Cross-workspace imports use the target package's public exports, never its filesystem internals.",
			severity: "error",
			from: { path: "^packages/([^/]+)/" },
			to: {
				path: "^packages/(?!$1/)[^/]+/",
				dependencyTypes: ["local", "localmodule"],
			},
		},
		{
			name: "no-production-to-test-kit",
			comment: "Production modules must not acquire a runtime dependency on fixtures or test helpers.",
			severity: "error",
			from: { path: "^packages/", pathNot: "(?:^|/)(?:test|test-kit|[^/]+[.](?:test|stories)[.])" },
			to: { path: "(?:^|/)(?:test|test-kit)(?:/|$)" },
		},
		{
			name: "no-serve-package-to-build-tooling",
			comment:
				"The browser and request-path packages must not reach `lib/tools/` or `lib/sdk/` in ANY workspace. " +
				"Those directories shell out to binaries (`spatial/lib/tools/ogr.ts`: 'OGR IS BUILD TOOLING, NEVER A " +
				"SERVE DEPENDENCY'), open build databases, and fetch multi-gigabyte archives; one `export *` is all it " +
				"takes for a barrel to drag that into a bundle. " +
				"SCOPED BY PACKAGE, NOT BY FOLDER NAME, and that is the whole design. The obvious rule — 'no code outside " +
				"tools/ may import tools/' — was written first and produced 38 violations, every one of them correct " +
				"behaviour: 33 are `mailwoman/lib/commands/*` calling the command's own library half, which is the " +
				"documented CLI architecture, and 3 are `dev-mcp`, where `tools/` means MCP TOOL DEFINITIONS rather " +
				"than build tooling. `tools/` carries at least four senses across the tree, so it cannot carry this " +
				"rule. Package identity can: these six ship to a browser or answer a request, and nothing else does. " +
				"`mcp` earned its place by failing this rule: `mcp/lib/cli.ts` took four symbols " +
				"(`familyRollup`, `filerLookup`, `toFRN`, `FRN`) from `@mailwoman/filer/sdk`, a barrel that " +
				"`export *`s seventeen modules, so an MCP request path carried the SEC and CORES HTTP clients and the " +
				"EDGAR ingest along to reach three functions. Those three moved to the filer package root and the " +
				"import now names them.",
			severity: "error",
			from: { path: "^packages/(?:react|tile-worker|api|fastify|mcp|earth|planetary)/" },
			// The directory's own module sits beside it (`lib/sdk.ts` beside `lib/sdk/`),
			// so the pattern names both.
			// `mcp/lib/tools.ts` is `mcp`'s MCP tool definitions, a module with no directory beside it.
			to: { path: "^packages/[^/]+/lib/(?:tools|sdk)(?:/|\\.tsx?$)", pathNot: "^packages/mcp/lib/tools\\.ts$" },
		},
		{
			name: "no-library-to-role-directory",
			comment:
				"A package's library in `lib/` never imports acquisition, build tooling or the CLI, in its own package or another. " +
				"Those layers import the library. Under the `./*` export pattern every module in `lib/` is public API, " +
				"so a library module that reaches `sdk/` or `tools/` publishes that dependency (#2404).",
			severity: "error",
			// A test ships in no tarball, and a test that builds its fixture through `sdk/` is test setup.
			from: { path: "^packages/[^/]+/lib/", pathNot: [ROLE_DIRECTORIES, TOOLING_PACKAGES, "[.]test[.]tsx?$"] },
			to: { path: ROLE_DIRECTORIES, pathNot: [LIBRARY_TOOLS] },
		},
		{
			name: "no-app-factory-to-mailwoman",
			comment:
				"An HTTP surface's app factory — `lib/app.ts`, `lib/routes.ts`, `lib/schema.ts`, `lib/engine.ts` and the " +
				"format/projection modules beside them — is engine-agnostic: tests inject a fixture engine, and the engine " +
				"stamp arrives as an option value. Only the bin (`lib/cli.ts`) may reach the `mailwoman` package, which " +
				"carries the CLI, the model loader and the resolver graph. `nominatim`, `photon` and `libpostal` list " +
				"`mailwoman` as a dependency for their bins, so nothing but this rule stops a factory from importing it.",
			severity: "error",
			from: {
				path: "^packages/(?:api|nominatim|photon|libpostal)/lib/(?:app|routes|schema|engine|format|projection)[.]ts$",
			},
			to: { path: "^packages/mailwoman/" },
		},
		{
			name: "no-circular",
			comment:
				"Keep the workspace dependency graph acyclic. A cycle that closes only through a dynamic `import()` or a " +
				"type-only edge is not an evaluation cycle — a lazy import is how a module keeps a Node-only loader out of " +
				"the browser graph while still offering a one-call factory — so those edges do not count. " +
				"`type-only` and `type-import` are SEPARATE dependency types and both are needed: `type-only` is " +
				'`import type { X } from "y"`, `type-import` is a type-position `typeof import("y").f`. ' +
				"`classifier/index.ts` reaches its loader through the second form to type a re-exported factory's " +
				"parameters, so naming only `type-only` leaves that cycle reported.",
			severity: "error",
			from: { path: "^packages/" },
			to: { circular: true, viaOnly: { dependencyTypesNot: ["dynamic-import", "type-only", "type-import"] } },
		},
		{
			name: "no-orphans",
			comment:
				"An orphan module is unreachable: nothing imports it and it imports nothing. Either it is dead and can " +
				"go, or something loads it by path rather than by import — and then this config says who, by name, in " +
				"`LOADED_WITHOUT_AN_IMPORT`. This rule REPLACES the preset's by name; the first four patterns below " +
				"are the preset's own, carried forward because a replacement does not inherit them.",
			severity: "error",
			from: {
				orphan: true,
				pathNot: [
					"(^|/)[.][^/]+[.](js|cjs|mjs|ts|json)$",
					"[.]d[.](c|m)?ts$",
					"(^|/)tsconfig[.]json$",
					"(^|/)(?:babel|webpack)[.]config[.](?:js|cjs|mjs|ts|json)$",
					...LOADED_WITHOUT_AN_IMPORT,
				],
			},
			to: {},
		},
	],
	options: {
		doNotFollow: { path: GENERATED_TREES },
		enhancedResolveOptions: {
			conditionNames: ["node", "import", "default"],
			exportsFields: ["exports"],
		},
		exclude: GENERATED_TREES,
		includeOnly: "^packages/",
		preserveSymlinks: false,
		progress: { type: "none" },
		tsConfig: { fileName: "tsconfig.json" },
		// Type-only imports are erased at compile time, so the default (false) hides
		// every edge into a `types.ts` and reports it as an orphan.
		// It also makes `no-circular`'s `dependencyTypesNot: ["type-only"]` inert,
		// since no type-only edge exists to exclude. 48 modules / 63 dependencies -> 76 /
		// 138 across locale-hint, query-shape, normalize and variant-aliases alone.
		tsPreCompilationDeps: true,
	},
}

export default config
