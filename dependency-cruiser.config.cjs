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
			name: "no-circular-dependencies",
			comment: "Keep the workspace dependency graph acyclic.",
			severity: "error",
			from: { path: "^(?:packages|scripts)/" },
			to: { circular: true },
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
