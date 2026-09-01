/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Executable dependency boundaries for the Mailwoman monorepo.
 */

module.exports = {
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
				"SCOPED BY PACKAGE, NOT BY FOLDER NAME, and that is the whole design. The obvious rule — 'nothing outside " +
				"tools/ may import tools/' — was written first and produced 38 violations, every one of them correct " +
				"behaviour: 33 are `mailwoman/lib/commands/*` calling the command's own library half, which is the " +
				"documented CLI architecture, and 3 are `dev-mcp`, where `tools/` means MCP TOOL DEFINITIONS rather " +
				"than build tooling. `tools/` carries at least four senses across the tree, so it cannot carry this " +
				"rule. Package identity can: these five ship to a browser or answer a request, and nothing else does.",
			severity: "error",
			from: { path: "^packages/(?:react|neural-web|tile-worker|api|fastify)/" },
			to: { path: "^packages/[^/]+/lib/(?:tools|sdk)/" },
		},
		{
			name: "no-circular-dependencies",
			comment:
				"Keep the workspace dependency graph acyclic. A cycle that closes only through a dynamic `import()` or a " +
				"type-only edge is not an evaluation cycle — a lazy import is how a module keeps a Node-only loader out of " +
				"the browser graph while still offering a one-call factory — so those edges do not count.",
			severity: "error",
			from: { path: "^(?:packages|scripts)/" },
			to: { circular: true, viaOnly: { dependencyTypesNot: ["dynamic-import", "type-only"] } },
		},
	],
	options: {
		doNotFollow: { path: "(?:^|/)(?:out|node_modules|sentencepiece[.]mjs)(?:/|$)" },
		enhancedResolveOptions: {
			conditionNames: ["node", "import", "default"],
			exportsFields: ["exports"],
		},
		exclude: "(?:^|/)(?:out|node_modules|sentencepiece[.]mjs)(?:/|$)",
		includeOnly: "^(?:packages|scripts)/",
		preserveSymlinks: false,
		progress: { type: "none" },
		tsConfig: { fileName: "tsconfig.json" },
	},
}
