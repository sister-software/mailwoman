import type * as Preset from "@docusaurus/preset-classic"
import type { Config, Plugin } from "@docusaurus/types"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve as resolvePath } from "node:path"
import { themes as prismThemes } from "prism-react-renderer"
import webpack from "webpack"

// This runs in Node.js — don't use client-side code here (browser APIs, JSX...)

/**
 * Resolve a workspace package's entry file. Prefer the source `index.ts` so `yarn build` works
 * standalone — without this fallback the alias points at `out/index.js`, which only exists after a
 * root-level `yarn compile` (tsc -b). swc-loader transpiles the source files inline, so going
 * direct to TS costs nothing at build time and removes the precompile dependency.
 *
 * `./fts`, `./weights`, etc. get their own per-subpath aliases below.
 */
const requireFromDocs = createRequire(import.meta.url)
function resolveWorkspaceEntry(packageName: string): string {
	const pkgJson = requireFromDocs.resolve(`${packageName}/package.json`)
	const dir = dirname(pkgJson)
	const sourceEntry = resolvePath(dir, "index.ts")
	if (existsSync(sourceEntry)) return sourceEntry
	return resolvePath(dir, "out", "index.js")
}
/** Same fallback logic for sub-entrypoints (single-file). */
function resolveWorkspaceFile(packageDir: string, sub: string): string {
	const sourceEntry = resolvePath(packageDir, `${sub}.ts`)
	if (existsSync(sourceEntry)) return sourceEntry
	return resolvePath(packageDir, "out", `${sub}.js`)
}
/** Same fallback logic for directory-style sub-entrypoints (./sub/index.{ts,js}). */
function resolveWorkspaceDir(packageDir: string, sub: string): string {
	const sourceEntry = resolvePath(packageDir, sub, "index.ts")
	if (existsSync(sourceEntry)) return sourceEntry
	return resolvePath(packageDir, "out", sub, "index.js")
}

const workspaceAliases: Record<string, string> = {}
// Webpack's alias rules treat a bare key as a PREFIX match unless suffixed with `$` — without it,
// `@mailwoman/core/decoder` would rewrite to `<alias>/decoder` and break. Use `$` for exact-only.
for (const pkg of [
	"@mailwoman/neural-web",
	"@mailwoman/resolver-wof-wasm",
	"@mailwoman/core",
	"@mailwoman/query-shape",
	"@mailwoman/kind-classifier",
]) {
	try {
		workspaceAliases[`${pkg}$`] = resolveWorkspaceEntry(pkg)
	} catch {
		// Best-effort: missing aliases just fall back to default resolution.
	}
}
// `@mailwoman/cartographer` has a heavy barrel (TIGER + BDC + HSPA pull shapefile-parser etc.,
// which is Node-only). Alias only the browser-safe sub-entrypoints so importing the barrel by
// accident fails loudly instead of dragging Node modules into the demo bundle.
const cartographerDir = (() => {
	try {
		return dirname(requireFromDocs.resolve("@mailwoman/cartographer/package.json"))
	} catch {
		return null
	}
})()
if (cartographerDir) {
	workspaceAliases["@mailwoman/cartographer/base"] = resolveWorkspaceDir(cartographerDir, "base")
	workspaceAliases["@mailwoman/cartographer/styles"] = resolveWorkspaceDir(cartographerDir, "styles")
}
// Map `@mailwoman/neural/browser` directly — the bare `@mailwoman/neural` import is intentionally
// NOT aliased so anything that reaches for it accidentally fails loudly instead of pulling
// onnxruntime-node into the browser bundle.
try {
	const neuralDir = dirname(requireFromDocs.resolve("@mailwoman/neural/package.json"))
	workspaceAliases["@mailwoman/neural/browser"] = resolveWorkspaceFile(neuralDir, "browser")
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
		workspaceAliases[`@mailwoman/core/${sub}`] = resolveWorkspaceDir(coreDir, sub)
	}
	// File-style sub-entrypoints (single file). environment/load + kysley/dialect.
	workspaceAliases["@mailwoman/core/environment/load"] = resolveWorkspaceFile(coreDir, "environment/load")
	workspaceAliases["@mailwoman/core/kysley/dialect"] = resolveWorkspaceFile(coreDir, "kysley/dialect")
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
					// Workspace TS sources use ESM-style `.js` import specifiers (e.g.
					// `import "./lookup.js"`). When the alias points at a `.ts` file, webpack still
					// resolves relative imports literally — it needs to know `.js` *might* mean `.ts`.
					extensionAlias: {
						".js": [".ts", ".js"],
					},
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

	themes: ["@docusaurus/theme-mermaid"],

	markdown: {
		mermaid: true,
	},

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
				blog: {
					path: "blog",
					routeBasePath: "blog",
					blogTitle: "Mailwoman log",
					blogDescription: "Iteration notes, ship retrospectives, design log entries.",
					showReadingTime: true,
					postsPerPage: 10,
					feedOptions: {
						type: ["rss", "atom"],
						title: "Mailwoman log",
						copyright: `Copyright © ${new Date().getFullYear()} Sister Software.`,
					},
				},
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
					to: "/demo",
					label: "Demo",
					position: "left",
				},
				{
					type: "docSidebar",
					sidebarId: "tutorialSidebar",
					position: "left",
					label: "Docs",
				},
				{
					to: "/blog",
					label: "Log",
					position: "left",
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
					title: "Try it",
					items: [
						{ label: "Demo", to: "/demo" },
						{ label: "Log", to: "/blog" },
					],
				},
				{
					title: "Docs",
					items: [
						{ label: "Plan", to: "/docs/plan" },
						{ label: "Eval reports", to: "/docs/evals/stage1-coarse-v0.1.0-vs-golden-v0.1.2" },
						{ label: "Retrospectives", to: "/docs/retrospectives" },
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
