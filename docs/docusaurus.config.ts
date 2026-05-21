import type * as Preset from "@docusaurus/preset-classic"
import type { Config, Plugin } from "@docusaurus/types"
import { createRequire } from "node:module"
import { dirname, resolve as resolvePath } from "node:path"
import { themes as prismThemes } from "prism-react-renderer"
import webpack from "webpack"

// This runs in Node.js — don't use client-side code here (browser APIs, JSX...)

/**
 * Resolve a workspace package to its compiled `out/index.js` entry. Docusaurus's bundler trips on
 * yarn-workspace symlinks AND on the package-export indirection for our nested mailwoman packages —
 * alias straight to the compiled file. Sub-entrypoints (`./fts`, `./weights`, …) get their own
 * aliases below.
 */
const requireFromDocs = createRequire(import.meta.url)
function resolveWorkspaceEntry(packageName: string): string {
	const pkgJson = requireFromDocs.resolve(`${packageName}/package.json`)
	return resolvePath(dirname(pkgJson), "out", "index.js")
}

const workspaceAliases: Record<string, string> = {}
// Webpack's alias rules treat a bare key as a PREFIX match unless suffixed with `$` — without it,
// `@mailwoman/core/decoder` would rewrite to `<alias>/decoder` and break. Use `$` for exact-only.
for (const pkg of ["@mailwoman/neural-web", "@mailwoman/resolver-wof-wasm", "@mailwoman/core"]) {
	try {
		workspaceAliases[`${pkg}$`] = resolveWorkspaceEntry(pkg)
	} catch {
		// Best-effort: missing aliases just fall back to default resolution.
	}
}
// Map `@mailwoman/neural/browser` directly — the bare `@mailwoman/neural` import is intentionally
// NOT aliased so anything that reaches for it accidentally fails loudly instead of pulling
// onnxruntime-node into the browser bundle.
try {
	const neuralDir = dirname(requireFromDocs.resolve("@mailwoman/neural/package.json"))
	workspaceAliases["@mailwoman/neural/browser"] = resolvePath(neuralDir, "out", "browser.js")
} catch {
	// neural not installed
}
// @mailwoman/core has sub-entrypoints the bundler needs to follow through transitively from
// the neural / resolver packages. Map them explicitly to their compiled directory entries.
const coreDir = (() => {
	try {
		return dirname(requireFromDocs.resolve("@mailwoman/core/package.json"))
	} catch {
		return null
	}
})()
if (coreDir) {
	// Directory-style sub-entrypoints (export from `./out/<sub>/index.js`).
	for (const sub of [
		"decoder",
		"resolver",
		"classification",
		"tokenization",
		"parser",
		"solver",
		"formatter",
		"types",
		"resources",
	]) {
		workspaceAliases[`@mailwoman/core/${sub}`] = resolvePath(coreDir, "out", sub, "index.js")
	}
	// File-style sub-entrypoints (export from `./out/<path>.js`). environment/load is a single file.
	workspaceAliases["@mailwoman/core/environment/load"] = resolvePath(coreDir, "out", "environment", "load.js")
	workspaceAliases["@mailwoman/core/kysley/dialect"] = resolvePath(coreDir, "out", "kysley", "dialect.js")
}

/** Webpack alias plugin so dynamic `import("@mailwoman/...")` from the demo page resolves. */
function workspaceAliasPlugin(): Plugin {
	return {
		name: "workspace-alias",
		configureWebpack() {
			return {
				plugins: [
					// Stub `node:*` builtins to empty modules. Webpack 5 surfaces `UnhandledSchemeError`
					// for the `node:` URI scheme even on browser targets where the imports are dead
					// code (gated behind `typeof process === 'object'` checks in isomorphic deps like
					// sentencepiece-js + onnxruntime-web).
					new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
						resource.request = require.resolve("./src/empty-shim.js")
					}),
				],
				resolve: {
					alias: workspaceAliases,
					// Stub Node-only built-ins for browser bundling. @sctg/sentencepiece-js +
					// onnxruntime-web + @sqlite.org/sqlite-wasm all carry isomorphic code that branches
					// on `typeof window` / `process` — the Node branch references `fs` / `path` / etc.
					// at parse time, even though runtime never enters those branches in a browser.
					fallback: {
						fs: false,
						path: false,
						module: false,
						url: false,
						crypto: false,
						stream: false,
						buffer: false,
						worker_threads: false,
						util: false,
						perf_hooks: false,
						"node:fs": false,
						"node:path": false,
						"node:module": false,
						"node:url": false,
						"node:crypto": false,
						"node:stream": false,
						"node:buffer": false,
						"node:worker_threads": false,
						"node:util": false,
						"node:perf_hooks": false,
						"node:os": false,
						"node:child_process": false,
						"node:fs/promises": false,
					},
				},
				// onnxruntime-web + sqlite-wasm both ship `.wasm` + `.mjs` assets the bundler should
				// emit as-is. Mark them as static so webpack doesn't try to transform them.
				module: {
					rules: [
						{
							test: /\.wasm$/,
							type: "asset/resource",
						},
					],
				},
			}
		},
	}
}

const config: Config = {
	title: "Mailwoman",
	tagline: "TypeScript-first address parser + geocoder. Runs in Node and the browser.",
	favicon: "img/favicon.ico",

	future: {
		v4: true,
		// @docusaurus/faster is installed but its rspack bundler chokes on `node:` prefixed imports
		// from isomorphic deps (sentencepiece-js, onnxruntime-web). Explicitly disable so standard
		// webpack stays in charge. The other speedups (swc loader / minimizer, lightningcss, mdx
		// cache) are stable on this build and worth keeping.
		faster: {
			rspackBundler: false,
			rspackPersistentCache: false,
		},
	},

	url: "https://mailwoman.sister.software",
	baseUrl: "/",

	organizationName: "sister-software",
	projectName: "mailwoman",

	onBrokenLinks: "throw",

	i18n: {
		defaultLocale: "en",
		locales: ["en"],
	},

	plugins: [workspaceAliasPlugin],

	presets: [
		[
			"classic",
			{
				docs: {
					path: "articles",
					routeBasePath: "docs",
					sidebarPath: "./sidebars.ts",
					editUrl: "https://github.com/sister-software/mailwoman/tree/main/docs/",
				},
				// Blog is disabled until we have actual posts to ship; re-enable by passing
				// `{ showReadingTime: true, ... }` once the changelog/post pipeline is real.
				blog: false,
				theme: {
					customCss: "./src/css/custom.css",
				},
			} satisfies Preset.Options,
		],
	],

	themeConfig: {
		colorMode: {
			respectPrefersColorScheme: true,
		},
		navbar: {
			title: "Mailwoman",
			logo: {
				alt: "Mailwoman Logo",
				src: "img/logo.svg",
			},
			items: [
				{
					type: "docSidebar",
					sidebarId: "tutorialSidebar",
					position: "left",
					label: "Docs",
				},
				{
					href: "https://github.com/sister-software/mailwoman",
					label: "GitHub",
					position: "right",
				},
			],
		},
		footer: {
			style: "dark",
			links: [
				{
					title: "Docs",
					items: [
						{ label: "Plan", to: "/docs/plan" },
						{ label: "Eval reports", to: "/docs/evals/stage1-coarse-v0.1.0-vs-golden-v0.1.2" },
					],
				},
				{
					title: "More",
					items: [
						{ label: "GitHub", href: "https://github.com/sister-software/mailwoman" },
						{ label: "npm", href: "https://www.npmjs.com/package/mailwoman" },
					],
				},
			],
			copyright: `Copyright © ${new Date().getFullYear()} Sister Software.`,
		},
		prism: {
			theme: prismThemes.github,
			darkTheme: prismThemes.dracula,
		},
	} satisfies Preset.ThemeConfig,
}

export default config
